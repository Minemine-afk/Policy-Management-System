import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { sayError } from '../lib/update'
import { supabase } from '../lib/supabase'
import { says } from '../lib/options'
import { FIELDS, SECTIONS, ReadStopped, extract, labelWith, readPdf, type Found, type Page } from '../lib/piExtract'
import { applyLearned, learn } from '../lib/piTeach'
import { blankKeys, pictureCrossChecks, pictureKeys } from '../lib/piAi'
import { AI_MODELS, AI_STOPPED, AI_SWITCHED, AI_SWITCH_TEXT } from '../lib/aiConfig'
import { aiElapsed, aiHow } from '../lib/aiSay'
import { loadRules, saveRules, type SavedRule } from '../lib/teach'
import { TEMPLATE_URL, buildWorkbook, preloadExcel, commonCurrency, isComparisonFile, type ExportColumn } from '../lib/piExcel'
import { buildPack, packFileName, packState, preloadPdf, sha256 } from '../lib/piPdf'
import { findIssueDate, showDate, toDmy } from '../lib/piIssueDate'
import { fillFromForm, isFromForm } from '../lib/formFill'
import type { PiRequest, RequestDocument } from '../lib/types'
import { AmountInput } from './ui'
import { fmtNum, groupMoneyInText, plain } from '../lib/num'

interface Column {
  fileName: string
  /** The request document it was read from (its PDF stays in memory, for the AI helper's page pictures). */
  docId?: string
  found: Record<string, Found>
  values: Record<string, string>
  notes: string[]
  discounted: boolean
  /** The PI's issue date, DD/MM/YYYY ("" when not found), and where it was found. */
  issueDate: string
  issueFound: { value: string; page: number; line: string } | null
  /** The PI as read, kept in memory only, to learn from when the comparison is saved. */
  pages?: Page[]
  /** Pages read with OCR (scanned): values from them are tagged "Check". */
  ocrPages?: number[]
  /** Reading stopped part-way: `pages` holds only the pages read before it. */
  partial?: boolean
  error?: string
}

/** How sure the reader is of a cell, so ops check only the uncertain ones. Sure = the reader's rules for this layout,
 *  from the PDF's own text, passing its cross-checks; Learned = a place ops taught; Check = anything else (general
 *  rules, OCR, a failed cross-check, a calculation). Nothing for a value typed by hand or taken from the request form. */
function confidence(fd: Found | undefined, ocrPages: number[] | undefined): { level: 'Sure' | 'Learned' | 'Check' | 'AI'; why: string } | null {
  if (!fd?.value) return null
  if (fd.picture) return { level: 'AI', why: "Read by the free AI helper (it ran in this browser) from a picture of the page, because the reader got no text from it. The AI read the page's words out first and the value passed the same checks against them, but a read-out can be wrong: check it against the PDF." }
  if (fd.ai) return { level: 'AI', why: "Filled by the free AI helper (it ran in this browser) in a cell the reader's rules left blank. It passed checks against the PI's text, but AI can still be wrong: check it against the PI." }
  if (fd.learned) return { level: 'Learned', why: 'Read from a place ops taught for this insurer when they saved an earlier comparison. Check it against the PI.' }
  if (fd.guess) return { level: 'Check', why: "This PI's layout is new to the reader: this value was read by general rules. Check it against the PI." }
  if (fd.check) return { level: 'Check', why: 'This value fails a cross-check (see the notes). Check it against the PI.' }
  if (/^Calculated:/.test(fd.line ?? '')) return { level: 'Check', why: 'Calculated from other values, as the PI does not show it. Check it.' }
  if (fd.page && ocrPages?.includes(fd.page)) return { level: 'Check', why: `Read with OCR from scanned page ${plain(fd.page)}. Check it against the PI.` }
  return { level: 'Sure', why: "Read by the reader's rules for this layout from the PDF's own text." }
}

interface Progress { file: number; files: number; name: string; page: number; pages: number; ocr: boolean }

const failed = (fileName: string, error: string, docId?: string): Column => ({ fileName, docId, found: {}, values: {}, notes: [], discounted: false, issueDate: '', issueFound: null, error })

const MAX = 3

/** "6–27" for a run of pages, "3, 5" otherwise. */
function pageList(ps: number[]): string {
  const runs: string[] = []
  for (let i = 0; i < ps.length; i++) {
    let j = i
    while (j + 1 < ps.length && ps[j + 1] === ps[j] + 1) j++
    runs.push(j > i ? `${plain(ps[i])}–${plain(ps[j])}` : String(ps[i]))
    i = j
  }
  return runs.join(', ')
}
/** A PI is given up on when its download, or its reading, makes no progress for this long. */
export const READ_LIMIT_MS = 60_000

function withLimit<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    p,
    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} took longer than ${fmtNum(ms / 1000)} seconds`)), ms) }),
  ]).finally(() => clearTimeout(timer))
}

/** Ops and bsd: reads the request's uploaded PI PDFs into the comparison, right on the request page, and saves the
 *  PI pack (one restricted PDF: the comparison, then every PI) that the introducer gets on completion. */
export default function PiComparison({ req, docs, userId, isBsd, onSaved }: {
  req: PiRequest; docs: RequestDocument[]; userId: string; isBsd: boolean; onSaved: () => void
}) {
  const pack = useMemo(() => packState(docs), [docs])
  const pdfs = pack.pdfs
  // The PI files as downloaded, to put them in the pack without downloading them again.
  const files = useRef(new Map<string, Blob>())
  const toRead = pdfs.slice(0, MAX)
  const key = toRead.map((d) => d.id).join(',')
  const [cols, setCols] = useState<Column[]>([])
  const [progress, setProgress] = useState<Progress | null>(null)
  const [run, setRun] = useState(0)
  const [checked, setChecked] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState('')
  const [saving, setSaving] = useState(false)
  // Places the reader learned from earlier saved comparisons (null while loading).
  const [rules, setRules] = useState<SavedRule[] | null>(null)
  const [teachReady, setTeachReady] = useState(true)
  // The optional AI helper: fills blank cells, in this browser (see lib/piAi.ts).
  const [aiState, setAiState] = useState<{ busy: boolean; text: string; error: string }>({ busy: false, text: '', error: '' })
  // Whether the AI can use this computer's graphics chip: page pictures are read only then (see aiModel.aiOnGraphics).
  const [graphics, setGraphics] = useState(false)
  useEffect(() => { import('../lib/aiModel').then((m) => m.aiOnGraphics()).then(setGraphics).catch(() => {}) }, [])
  useEffect(() => () => { import('../lib/aiModel').then((m) => m.releaseAi()).catch(() => {}) }, [])
  useEffect(() => {
    let gone = false
    loadRules().then((r) => { if (!gone) { setRules(r.rules); setTeachReady(r.ready && !r.error) } })
    return () => { gone = true }
  }, [])

  // Read the request's PIs whenever the set of PI PDFs changes (or "Read again").
  // Fetch the Excel tool now, while it matches this page (see preloadExcel).
  useEffect(() => { preloadExcel().catch(() => {}); preloadPdf().catch(() => {}) }, [])
  useEffect(() => {
    if (!key) { setCols([]); return }
    if (!rules) return
    let cancelled = false
    const list = docs.filter((d) => key.split(',').includes(d.id)).sort((a, b) => key.indexOf(a.id) - key.indexOf(b.id))
    ;(async () => {
      setChecked(false); setSaved(''); setError(''); setAiState({ busy: false, text: '', error: '' })
      const out: Column[] = []
      // Client particulars the PI doesn't show come from the request form (never the client's real name), also for a
      // PI that could not be read at all.
      const form = { gender: req.gender, smoker: req.smoker, age_band: req.age_band, date_of_birth: req.date_of_birth, residency: req.residency }
      const withForm = (c: Column): Column => {
        const filled = fillFromForm(c.found, Object.fromEntries(FIELDS.map((f) => [f.key, c.found[f.key]?.value ?? ''])), form)
        return { ...c, found: filled.found, values: filled.values, notes: [...c.notes, ...filled.notes] }
      }
      for (const [i, doc] of list.entries()) {
        if (cancelled) return
        setProgress({ file: i, files: list.length, name: doc.file_name, page: 0, pages: 0, ocr: false })
        let stopped = ''
        try {
          const dl = await withLimit(supabase.storage.from('request-docs').download(doc.storage_path), READ_LIMIT_MS, 'Downloading')
          if (!dl.data) { out.push(withForm(failed(doc.file_name, dl.error?.message ?? 'Download failed'))); continue }
          files.current.set(doc.id, dl.data)
          const ocrPages = new Set<number>()
          let pages: Page[]
          try {
            pages = await readPdf(await dl.data.arrayBuffer(), (page, total, ocr) => {
              if (ocr) ocrPages.add(Math.floor(page) + 1)
              if (!cancelled) setProgress({ file: i, files: list.length, name: doc.file_name, page, pages: total, ocr })
            }, READ_LIMIT_MS)
          } catch (e) {
            // Stopped part-way (too slow, or OCR failed): the pages read before it are still used.
            const got = e instanceof ReadStopped ? e.pages.filter((p) => p.lines.length) : []
            if (!got.length) throw e
            pages = (e as ReadStopped).pages
            const last = pages[pages.length - 1]?.page ?? 0
            stopped = `Reading stopped after page ${plain(last)}: ${(e as Error).message.replace(/\. Reload the page.*$/, '')}. Values on later pages are missing: press "Read the PIs again", or use the AI helper.`
          }
          if (!pages.some((p) => p.lines.length)) {
            out.push(withForm(failed(doc.file_name, 'No text could be read, even with OCR.', doc.id)))
            continue
          }
          const read = extract(pages, doc.file_name)
          const { notes, discounted } = read
          if (stopped) notes.unshift(stopped)
          // Blanks (and general-rule guesses) filled from places ops taught for this insurer.
          const taught = applyLearned(read.found, pages, rules)
          const found = taught.found
          notes.push(...taught.notes)
          if (ocrPages.size) {
            const list = [...ocrPages].join(', ')
            notes.unshift(`Scanned ${ocrPages.size === 1 ? 'page' : 'pages'} ${list} read with OCR: check every value from ${ocrPages.size === 1 ? 'it' : 'them'} against the PDF.`)
          }
          const skipped = pages.filter((p) => p.skipped).map((p) => p.page)
          if (skipped.length) {
            notes.push(`Scanned ${skipped.length === 1 ? 'page' : 'pages'} ${pageList(skipped)} ${skipped.length === 1 ? 'was' : 'were'} not read, because the main values were found before ${skipped.length === 1 ? 'it' : 'them'}.`)
          }
          const issueFound = findIssueDate(pages)
          out.push(withForm({ fileName: doc.file_name, docId: doc.id, found, notes, discounted, values: {},
            issueDate: issueFound?.value ?? '', issueFound, pages, ocrPages: [...ocrPages], partial: !!stopped }))
        } catch (e) {
          out.push(withForm(failed(doc.file_name, sayError(e, (x) => 'Could not read this PDF: ' + x.message), files.current.has(doc.id) ? doc.id : undefined)))
        }
      }
      if (!cancelled) { setCols(out); setProgress(null) }
    })()
    return () => { cancelled = true }
    // docs changes on every reload of the request; only a different set of PI PDFs needs a new read
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, run, rules !== null])

  const setValue = (i: number, k: string, v: string) => {
    setChecked(false); setSaved('')
    setCols((cs) => cs.map((c, j) => (j === i ? { ...c, values: { ...c.values, [k]: v } } : c)))
  }
  const setIssueDate = (i: number, v: string) => {
    setChecked(false); setSaved('')
    setCols((cs) => cs.map((c, j) => (j === i ? { ...c, issueDate: v } : c)))
  }
  // Cells the AI may fill: left blank by the reader (and the request form) and not typed in by hand.
  const hasText = (c: Column) => !!c.pages?.some((p) => p.lines.length)
  // Page pictures help where the text is missing or poor: no text at all, reading stopped part-way, or scanned pages.
  const hasFile = (c: Column) => !!c.docId && files.current.has(c.docId)
  const canPicture = (c: Column) => graphics && hasFile(c) && (!hasText(c) || !!c.partial)
  const blanks = (c: Column) => blankKeys(c.found).filter((k) => !(c.values[k] ?? '').trim())
  const aiTodo = (c: Column) => (hasText(c) ? blanks(c) : canPicture(c) ? pictureKeys(blanks(c)) : [])
  const aiCells = cols.reduce((n, c) => n + aiTodo(c).length, 0)
  // PIs that could not be read at all: the rules have no text from them; the AI can only look at their page pictures.
  const unread = cols.map((c, i) => ({ c, i })).filter(({ c }) => c.error)
  const noWasm = typeof WebAssembly === 'undefined'

  async function fillWithAi() {
    setAiState({ busy: true, text: 'Starting the AI helper…', error: '' })
    try {
      const { askAi, readOutPicture } = await import('../lib/aiModel')
      const { pagePictures, picturePages } = await import('../lib/piPictures')
      let filled = 0, fromPictures = 0, model = '', pre = ''
      for (const [i, c] of cols.entries()) {
        const keys = aiTodo(c)
        if (!keys.length) continue
        const text = hasText(c)
        const got: Record<string, Found> = {}
        const dropped: string[] = []
        const say = (what: string) => (p: { stage: string; pct?: number; device?: string; model?: string; tokens?: number }) => {
          if (p.model) model = p.model
          if (p.stage === 'switch') pre = AI_SWITCHED
          setAiState({ busy: true, error: '',
            text: p.stage === 'download' ? `${pre}Downloading the AI model, first time only: ${plain(Math.round((p.pct ?? 0) * 100))}%`
              : p.stage === 'switch' ? AI_SWITCH_TEXT
                : `${pre}The AI${model ? ` (${model})` : ''} is ${what} of PI${plain(i + 1)} (${c.fileName})${aiHow(p)}…` })
        }
        if (text) {
          const res = await askAi(c.pages!, keys, c.values, say('reading the text'))
          Object.assign(got, res.found); dropped.push(...res.dropped)
        }
        // No text (or reading stopped part-way): the AI reads out the page pictures the reader could not get, then is
        // asked about that text, with the same checks.
        const rest = pictureKeys(keys.filter((k) => !got[k]))
        if (rest.length && canPicture(c)) {
          const done = new Set((c.pages ?? []).filter((p) => p.lines.length).map((p) => p.page))
          setAiState({ busy: true, error: '', text: `Drawing the pages of PI${plain(i + 1)} for the AI…` })
          const pics = (await pagePictures(await files.current.get(c.docId!)!.arrayBuffer(), picturePages(99, text, done, (globalThis as { __AI_FORCE?: { picturePages?: number } }).__AI_FORCE?.picturePages)))
          const read: Page[] = []
          for (const pic of pics) read.push(await readOutPicture(pic.images, pic.page, say(`reading the picture of page ${plain(pic.page)} (of ${plain(pics.length)})`)))
          if (read.some((p) => p.lines.length)) {
            const all = [...(c.pages ?? []).filter((p) => p.lines.length), ...read].sort((x, y) => x.page - y.page)
            const res = await askAi(all, rest, { ...c.values, ...Object.fromEntries(Object.entries(got).map(([k, v]) => [k, v.value])) }, say('reading the pictures'))
            const fromRead = new Set(read.map((p) => p.page))
            for (const [k, v] of Object.entries(res.found)) {
              got[k] = fromRead.has(v.page ?? -1) ? { ...v, picture: true } : v
              if (got[k].picture) fromPictures++
            }
            dropped.push(...res.dropped)
            // Values from page pictures must also fit with each other and with the rest.
            const pic = Object.fromEntries(Object.entries(got).filter(([, v]) => v.picture))
            const before = Object.keys(pic).length
            pictureCrossChecks(pic, dropped, { ...c.values, ...Object.fromEntries(Object.entries(got).filter(([, v]) => !v.picture).map(([k, v]) => [k, v.value])) })
            for (const k of Object.keys(got)) if (got[k].picture && !pic[k]) delete got[k]
            fromPictures -= before - Object.keys(pic).length
          }
        }
        const keys2 = Object.keys(got)
        filled += keys2.length
        const names = (ks: string[]) => ks.map((k) => FIELDS.find((f) => f.key === k)?.label ?? k).join(', ')
        setCols((cs) => cs.map((col, j) => {
          if (j !== i) return col
          const found = { ...col.found }, values = { ...col.values }
          for (const k of keys2) if (!(values[k] ?? '').trim()) { found[k] = got[k]; values[k] = got[k].value }
          const notes = [...col.notes]
          if (keys2.length) notes.push(`The free AI helper filled ${fmtNum(keys2.length)} blank ${keys2.length === 1 ? 'cell' : 'cells'} (${names(keys2)}), tagged "AI": check ${keys2.length === 1 ? 'it' : 'them'} against the PI.`)
          const pic = keys2.filter((k) => got[k].picture)
          if (pic.length) notes.push(`${names(pic)}: read by the AI from page pictures (the reader got no text from ${pic.length === 1 ? 'that page' : 'those pages'}). Check ${pic.length === 1 ? 'it' : 'each one'} against the PDF.`)
          const bad = [...new Set(dropped)].filter((k) => !got[k])
          if (bad.length) notes.push(`The AI's answers for ${names(bad)} did not pass the checks${text ? " against the PI's text" : ''}, so they were left blank.`)
          return { ...col, found, values, notes }
        }))
      }
      setChecked(false); setSaved('')
      setAiState({ busy: false, error: '', text: filled ? `The AI filled ${fmtNum(filled)} of ${fmtNum(aiCells)} blank ${aiCells === 1 ? 'cell' : 'cells'}${fromPictures ? ` (${fmtNum(fromPictures)} from page pictures)` : ''}, tagged “AI”. Check them against the PIs.` : 'The AI found nothing it could confirm in the PIs: the blank cells stay blank.' })
    } catch (e) {
<<<<<<< HEAD
      if ((e as Error)?.message === AI_STOPPED) { setAiState({ busy: false, error: '', text: 'AI helper stopped. Cells it had already filled are kept; press the button to run it again.' }); return }
=======
>>>>>>> origin/claude/project-thread-emib86
      setAiState({ busy: false, text: '', error: sayError(e, (x) => 'The AI helper could not run in this browser: ' + x.message + '. Fill the blank cells by hand.') })
    }
  }

  const stopAi = () => { import('../lib/aiModel').then((m) => m.releaseAi()).catch(() => {}) }
  // While the AI works, the time so far is shown: a sign of life even while it reads a long PI before answering.
  const [aiSecs, setAiSecs] = useState(0)
  useEffect(() => {
    if (!aiState.busy) return
    const t0 = Date.now()
    setAiSecs(0)
    const t = setInterval(() => setAiSecs(Math.round((Date.now() - t0) / 1000)), 1000)
    return () => clearInterval(t)
  }, [aiState.busy])

  const badDates = cols.filter((c) => c.issueDate.trim() && !toDmy(c.issueDate)).length

  const currency = commonCurrency(cols)
  const missing = cols.reduce((n, c) => n + FIELDS.filter((f) => f.section !== 'meta' && !c.values[f.key]).length, 0)
  const canSave = (isBsd || req.assignee_id === userId) && ['assigned', 'in_progress'].includes(req.status)
  const fileName = `${req.ref}-pi-comparison.xlsx`
  const packName = packFileName(req.ref)
  const hasSaved = !!pack.pack
  const pct = progress ? Math.round(((progress.file + (progress.pages ? progress.page / progress.pages : 0)) / progress.files) * 100) : 100

  const exportCols = (): ExportColumn[] => cols.map((c) => ({
    fileName: c.fileName, values: c.values, notes: c.notes, issueDate: toDmy(c.issueDate),
    edited: Object.fromEntries(FIELDS.map((f) => [f.key, (c.found[f.key]?.value ?? '') !== (c.values[f.key] ?? '')])),
    pages: Object.fromEntries(FIELDS.map((f) => [f.key, c.found[f.key]?.page ?? null])),
    fromForm: Object.fromEntries(FIELDS.map((f) => [f.key, isFromForm(c.found[f.key]) && (c.found[f.key]?.value ?? '') === (c.values[f.key] ?? '')])),
  }))

  async function makeExcel() {
    const res = await fetch(TEMPLATE_URL)
    if (!res.ok) throw new Error(`Could not load the Excel template (${plain(res.status)}).`)
    return buildWorkbook(exportCols(), await res.arrayBuffer())
  }

  // The pack: the comparison, then every PI PDF on the request (also those after the first three), in upload order.
  async function makePack() {
    const pis = []
    for (const d of pdfs) {
      let blob = files.current.get(d.id)
      if (!blob) {
        const dl = await supabase.storage.from('request-docs').download(d.storage_path)
        if (!dl.data) throw new Error(`Could not download ${d.file_name}: ${dl.error?.message ?? 'download failed'}`)
        blob = dl.data
        files.current.set(d.id, blob)
      }
      pis.push({ name: d.file_name, data: await blob.arrayBuffer() })
    }
    return buildPack(exportCols(), pis, req.ref)
  }

  const download = (blob: Blob, name: string) => {
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = name
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 5000)
  }

  // Saves the PI pack onto the request, replacing earlier packs (and comparison Excel files) this user saved.
  // The introducer gets only this PDF when the request is completed.
  async function saveToRequest() {
    setError(''); setSaved(''); setSaving(true)
    try {
      const blob = await makePack()
      const hash = await sha256(blob)
      const old = docs.filter((d) => d.kind === 'pi_output' && (pack.isPack(d) || isComparisonFile(d.file_name)) && d.uploaded_by === userId)
      const path = `${req.id}/${plain(Date.now())}-${packName}`
      const up = await supabase.storage.from('request-docs').upload(path, blob, { contentType: 'application/pdf' })
      if (up.error) throw new Error(says(up.error.message))
      const ins = await supabase.rpc('add_pi_pack', { p_request: req.id, p_path: path, p_name: packName, p_sha256: hash, p_docs: pdfs.map((d) => d.id) })
      if (ins.error) {
        await supabase.storage.from('request-docs').remove([path])
        throw new Error(/add_pi_pack|schema cache/i.test(ins.error.message) ? 'The database needs an update first: run supabase/cloud/1j-upgrade.sql in Supabase.' : says(ins.error.message))
      }
      for (const d of old) {
        const rm = await supabase.rpc('remove_document', { p_document: d.id })
        if (!rm.error) await supabase.storage.from('request-docs').remove([d.storage_path])
      }
      setSaved(`Saved ${packName} (${fmtNum(blob.size / 1024 / 1024, 1)} MB, fingerprint ${hash.slice(0, 12)}…). The introducer gets this one PDF when you mark the request completed.${await teach()}`)
      onSaved()
    } catch (e) { setError((e as Error).message) }
    setSaving(false)
  }

  // Teach the reader: where each value ops filled in or corrected sits in its PI, so the next PI of that insurer is
  // read with it. Only label words and positions are saved, never the values. A failure here never stops the save.
  async function teach(): Promise<string> {
    if (!teachReady) return ''
    try {
      const learned = cols.filter((c) => !c.error && c.pages).flatMap((c) => learn(c.pages!, c.values, c.found, c.values.insurer ?? ''))
      if (!learned.length) return ''
      const { added, error } = await saveRules(learned)
      if (error) return ` The reader could not learn from it: ${says(error)}`
      if (!added) return ''
      const who = [...new Set(learned.map((r) => r.insurer))].join(', ')
      return ` The reader learned ${fmtNum(added)} new ${added === 1 ? 'place' : 'places'} for ${who}, used on the next PI from ${learned.length > 1 && who.includes(',') ? 'these insurers' : 'this insurer'}.`
    } catch { return '' }
  }

  async function exportPdf() {
    setError('')
    try { download(await makePack(), packName) } catch (e) { setError((e as Error).message) }
  }

  async function exportXlsx() {
    setError('')
    try { download(await makeExcel(), fileName) } catch (e) { setError((e as Error).message) }
  }

  return (
    <section className="card" aria-label="PI comparison">
      <div className="row between">
        <h2 className="eyebrow">PI comparison{hasSaved ? (pack.current ? ' · PI pack saved to this request' : ' · the saved PI pack is out of date (the PIs changed)') : ''}</h2>
        {!progress && cols.length > 0 && <button className="btn small" onClick={() => setRun((n) => n + 1)}>Read the PIs again</button>}
      </div>
      <p className="small muted" style={{ margin: 0 }}>
        The first three PI PDFs uploaded above fill PI1, PI2 and PI3 of the comparison, in upload order.
        They are read in your browser by fixed rules (no AI), scanned pages with OCR, and nothing is sent anywhere.
        For cells left blank, you can ask the free AI helper, which also runs in your browser (tagged “AI”). Fields that can't be read are left
        blank for you to fill; client details the PI doesn't show come from the request form. Check each value against the PDF,
        then save the PI pack: one PDF with the comparison and every PI, which is all the introducer receives. It can be printed but not edited.
        Saving also teaches the reader where the values you typed sit in a PI layout it doesn't know (only the words beside
        them, never the values), and your corrections and NAs, so the next PI from that insurer fills in more (tagged “Learned”).
        Each value is tagged: “Sure” (the reader's rules, from the PDF's own text), “Learned”, “AI”, or “Check” (new layout,
        scanned page, calculated, or failing a cross-check). Check those first.
        {pdfs.length > MAX && ` Only the first ${fmtNum(MAX)} of the ${fmtNum(pdfs.length)} PDFs are compared.`}
      </p>
      {!key && <div className="small muted">Upload the PI PDFs above and they are read here straight away.</div>}

      {progress && (
        <div className="progress" role="status" aria-label="Reading PIs">
          <div className="row between small">
            <span>Reading PI {plain(progress.file + 1)} of {plain(progress.files)}: {progress.name}
              {progress.ocr ? ` · scanned page ${plain(Math.floor(progress.page) + 1)} of ${plain(progress.pages)}, reading it with OCR (slower)`
                : progress.pages ? ` · page ${plain(Math.floor(progress.page))} of ${plain(progress.pages)}` : ' · downloading'}</span>
            <strong>{plain(pct)}%</strong>
          </div>
          <progress max={100} value={pct} aria-label={`${plain(pct)}% read`} />
          <span className="small muted">A PI is stopped if nothing happens for {fmtNum(READ_LIMIT_MS / 1000)} seconds. Scanned pages are read with OCR, which takes several seconds each (the first one also downloads the OCR engine, about 28 MB, or 36 MB on hard-to-read scans).</span>
        </div>
      )}

      {!progress && cols.length > 0 && (
        <>
          {unread.map(({ c, i }) => (
            <div key={i} className="error" role="alert">
              {canPicture(c)
                ? `PI${plain(i + 1)} (${c.fileName}) could not be read: ${c.error} Its client details come from the request form. The free AI helper can look at its page pictures for the rest: press the AI helper button below, then check each value it fills against the PDF.`
                : hasFile(c)
                  ? `PI${plain(i + 1)} (${c.fileName}) could not be read: ${c.error} Only its client details come from the request form. The free AI helper can read page pictures of a PI like this, but only on a computer whose graphics chip the browser can use (for example Intel Iris Xe in an up-to-date Chrome or Edge): on this one it would take over 10 minutes a page. Press "Read the PIs again", or type its values from the PDF.`
                  : `PI${plain(i + 1)} (${c.fileName}) could not be read: ${c.error} Only its client details come from the request form: the AI helper has nothing to look at either, as the PDF could not be downloaded. Press "Read the PIs again", or type its values from the PDF.`}
            </div>
          ))}
          <div className="row between">
            <h3 className="small" style={{ margin: 0 }}>Check the values</h3>
            <span className="small muted">{missing ? `${fmtNum(missing)} empty ${missing === 1 ? 'cell' : 'cells'} (shaded) to fill or leave blank` : 'Every field has a value'}</span>
          </div>
          {(missing > 0 || aiState.text || aiState.error) && (
            <div className="row" style={{ gap: 10, flexWrap: 'wrap' }} aria-label="AI helper">
              {aiCells > 0 && noWasm && <span className="error small" role="note">The free AI helper can't run in this browser (no WebAssembly). Please use an up-to-date Chrome or Edge.</span>}
              {aiCells === 0 && !aiState.busy && !aiState.text && (
                <span className="small muted" role="note">
                  {cols.every((c) => !hasText(c) && !canPicture(c))
                    ? 'Free AI helper: no PI could be read, so it has no text to work with.'
                    : `Free AI helper: nothing left for it to fill.${missing ? ' Check the PI for the blank cells left and type them, for example Included or NA.' : ''}`}
                </span>
              )}
              {aiCells > 0 && !noWasm && (
                <button className="btn small" disabled={aiState.busy} onClick={fillWithAi}
                  title={`A free, open AI model runs in this browser and reads the PI's text, and its page pictures where the text is missing or scanned: the PI never leaves this computer. The first time, the browser downloads the model (about ${fmtNum(AI_MODELS.small.mb / 1000, 1)} GB) and keeps it for next time.`}>
                  {aiState.busy ? 'AI helper working…' : `Fill ${fmtNum(aiCells)} blank ${aiCells === 1 ? 'cell' : 'cells'} with the free AI helper`}
                </button>
              )}
              {aiState.busy && <button className="btn small" onClick={stopAi} title="Stops the AI helper. Cells it has already filled are kept.">Stop the AI helper</button>}
              {aiState.text && <span className="small" role="status">{aiState.text}</span>}
              {aiState.busy && <span className="small muted" aria-label="Time so far">{aiElapsed(aiSecs)} so far</span>}
              {aiState.error && <span className="error small" role="alert">{aiState.error}</span>}
              {aiCells > 0 && !aiState.busy && !aiState.text && <span className="small muted">Runs in your browser, nothing is sent. First use downloads about {fmtNum(AI_MODELS.small.mb / 1000, 1)} GB.</span>}
            </div>
          )}
          <div className="tablewrap">
            <table className="compare" aria-label="Extracted values">
              <thead>
                <tr>
                  <th>Field</th>
                  {cols.map((c, i) => (
                    <th key={i}>
                      PI{plain(i + 1)}
                      <div className="small muted" style={{ fontWeight: 400, marginTop: 4 }}>{c.fileName}</div>
                      {!c.error && (
                        <label className="small" style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 400, marginTop: 6 }}>
                          Currency
                          <input type="text" aria-label={`Policy Currency for PI ${plain(i + 1)}`} value={c.values.currency ?? ''} maxLength={3} placeholder="?"
                            style={{ width: 70, height: 30 }} className={c.values.currency ? '' : 'empty-cell'}
                            onChange={(e) => setValue(i, 'currency', e.target.value.toUpperCase())} />
                        </label>
                      )}
                      {!c.error && (
                        <label className="small" style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 400, marginTop: 6 }}>
                          Issue date
                          <input type="text" aria-label={`PI issue date for PI ${plain(i + 1)}`} value={c.issueDate} placeholder="DD/MM/YYYY" maxLength={10}
                            style={{ width: 124, height: 30 }} className={!c.issueDate ? 'empty-cell' : c.issueDate.trim() && !toDmy(c.issueDate) ? 'empty-cell' : c.issueDate !== (c.issueFound?.value ?? '') ? 'edited-cell' : ''}
                            title={c.issueFound ? `Page ${plain(c.issueFound.page)}: ${c.issueFound.line}` : 'Not found in the PI: the comparison date is used if no PI has one'}
                            onChange={(e) => setIssueDate(i, e.target.value)} />
                        </label>
                      )}
                      {!c.error && c.issueDate && toDmy(c.issueDate) && <div className="small muted" style={{ fontWeight: 400 }}>{showDate(toDmy(c.issueDate))}{c.issueFound && c.issueDate === c.issueFound.value ? `, page ${plain(c.issueFound.page)}` : ''}</div>}
                      {c.error && <div className="error">{c.error}</div>}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {SECTIONS.map((sec) => (
                  <Fragment key={sec.key}>
                    <tr className="section-row"><th colSpan={cols.length + 1} scope="colgroup">{sec.label}</th></tr>
                    {FIELDS.filter((f) => f.section === sec.key).map((f) => {
                      const label = labelWith(f, currency)
                      return (
                        <tr key={f.key}>
                          <td><strong>{label}</strong></td>
                          {cols.map((c, i) => {
                            const fd = c.found[f.key]
                            const edited = (fd?.value ?? '') !== (c.values[f.key] ?? '')
                            const cur = (c.values.currency ?? '').toUpperCase()
                            const conf = !edited && !isFromForm(fd) && c.values[f.key] ? confidence(fd, c.ocrPages) : null
                            return (
                              <td key={i} className={!c.values[f.key] ? 'empty-cell' : edited ? 'edited-cell' : conf && conf.level !== 'Sure' ? 'guess-cell' : ''}>
                                {f.kind === 'money' || f.kind === 'sum'
                                  ? <AmountInput allowText aria-label={`${label} for PI ${plain(i + 1)}`} value={c.values[f.key] ?? ''}
                                    onValue={(v) => setValue(i, f.key, v)} />
                                  : <input type="text" aria-label={`${label} for PI ${plain(i + 1)}`} value={c.values[f.key] ?? ''}
                                    onChange={(e) => setValue(i, f.key, e.target.value)} />}
                                {(f.kind === 'money' || f.kind === 'sum') && !currency && cur && c.values[f.key] && c.values[f.key] !== 'NA' && <div className="small">in {cur}</div>}
                                {conf && <div className={`pill ${conf.level === 'Sure' ? 'ok' : 'info'}`} style={{ margin: '4px 0 2px', fontSize: 12 }} title={conf.why}>{conf.level}</div>}
                                {f.key === 'base_premium' && c.discounted && <div className="pill warn" style={{ margin: '4px 0 2px', fontSize: 12 }}>After discount</div>}
                                <div className="small muted" title={fd?.line ?? ''}>
                                  {edited ? 'Changed by hand' : fd?.picture ? `AI, from the picture of page ${plain(fd.page ?? 0)}: “${(fd.line ?? '').slice(0, 36)}${(fd.line ?? '').length > 36 ? '…' : ''}”` : fd?.ai ? `AI${fd.page ? `, page ${plain(fd.page)}` : ''}: “${(fd.line ?? '').slice(0, 44)}${(fd.line ?? '').length > 44 ? '…' : ''}”` : isFromForm(fd) ? 'From the request form (not in the PI)' : c.error ? 'This PI could not be read (see the top): type it from the PDF' : /^Calculated:/.test(fd?.line ?? '') ? 'Calculated from the PI (see notes)' : fd?.page ? `Page ${plain(fd.page)}: “${(fd.line ?? '').slice(0, 48)}${(fd.line ?? '').length > 48 ? '…' : ''}”` : fd?.value ? (f.section === 'riders' ? 'No such rider in the PI' : f.key === 'campaigns' ? 'No discount in the PI' : f.kind === 'cover' ? 'Not mentioned in the PI' : 'From the PI') : 'Not found'}
                                </div>
                              </td>
                            )
                          })}
                        </tr>
                      )
                    })}
                  </Fragment>
                ))}
                {cols.some((c) => c.notes.length > 0) && (
                  <tr>
                    <td><strong>Notes</strong></td>
                    {cols.map((c, i) => (
                      <td key={i} aria-label={`Notes for PI ${plain(i + 1)}`}>
                        {c.notes.length ? <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>{c.notes.map((n) => <li key={n}>{groupMoneyInText(n)}</li>)}</ul> : <span className="small muted">None</span>}
                      </td>
                    ))}
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <label className="row" style={{ gap: 10 }}>
            <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} style={{ width: 20, height: 20 }} />
            <span>I have checked these values against the PDFs</span>
          </label>
          {badDates > 0 && <div className="error">Type issue dates as DD/MM/YYYY, or leave them blank.</div>}
          {error && <div className="error" role="alert">{error}</div>}
          {saved && <div className="notice" role="status">{saved}</div>}
          <div className="row">
            {canSave && <button className="btn primary" disabled={!checked || saving || badDates > 0} onClick={saveToRequest}>{saving ? 'Making the PI pack…' : `Save PI pack to ${req.ref} for the introducer`}</button>}
            <button className={canSave ? 'btn' : 'btn primary'} disabled={!checked || badDates > 0} onClick={exportPdf}>Export comparison (PDF)</button>
            <button className="btn" disabled={!checked || badDates > 0} onClick={exportXlsx} title="For ops and BSD only: introducers never receive the Excel file">Export to Excel</button>
          </div>
          {pdfs.length > MAX && <div className="small muted">The PI pack includes all {fmtNum(pdfs.length)} PI PDFs; the comparison shows the first {fmtNum(MAX)}.</div>}
        </>
      )}
    </section>
  )
}
