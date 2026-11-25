import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import { says } from '../lib/options'
import { FIELDS, SECTIONS, extract, labelWith, readPdf, type Found, type Page } from '../lib/piExtract'
import { applyLearned, learn } from '../lib/piTeach'
import { AI_FIELDS, blankKeys } from '../lib/piAi'
import { AI_MODELS } from '../lib/aiConfig'
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
  error?: string
}

/** How sure the reader is of a cell, so ops check only the uncertain ones. Sure = the reader's rules for this layout,
 *  from the PDF's own text, passing its cross-checks; Learned = a place ops taught; Check = anything else (general
 *  rules, OCR, a failed cross-check, a calculation). Nothing for a value typed by hand or taken from the request form. */
function confidence(fd: Found | undefined, ocrPages: number[] | undefined): { level: 'Sure' | 'Learned' | 'Check' | 'AI'; why: string } | null {
  if (!fd?.value) return null
  if (fd.ai) return { level: 'AI', why: "Filled by the free AI helper (it ran in this browser) in a cell the reader's rules left blank. It passed checks against the PI's text, but AI can still be wrong: check it against the PI." }
  if (fd.learned) return { level: 'Learned', why: 'Read from a place ops taught for this insurer when they saved an earlier comparison. Check it against the PI.' }
  if (fd.guess) return { level: 'Check', why: "This PI's layout is new to the reader: this value was read by general rules. Check it against the PI." }
  if (fd.check) return { level: 'Check', why: 'This value fails a cross-check (see the notes). Check it against the PI.' }
  if (/^Calculated:/.test(fd.line ?? '')) return { level: 'Check', why: 'Calculated from other values, as the PI does not show it. Check it.' }
  if (fd.page && ocrPages?.includes(fd.page)) return { level: 'Check', why: `Read with OCR from scanned page ${plain(fd.page)}. Check it against the PI.` }
  return { level: 'Sure', why: "Read by the reader's rules for this layout from the PDF's own text." }
}

interface Progress { file: number; files: number; name: string; page: number; pages: number; ocr: boolean }

const failed = (fileName: string, error: string): Column => ({ fileName, found: {}, values: {}, notes: [], discounted: false, issueDate: '', issueFound: null, error })

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
      for (const [i, doc] of list.entries()) {
        if (cancelled) return
        setProgress({ file: i, files: list.length, name: doc.file_name, page: 0, pages: 0, ocr: false })
        try {
          const dl = await withLimit(supabase.storage.from('request-docs').download(doc.storage_path), READ_LIMIT_MS, 'Downloading')
          if (!dl.data) { out.push(failed(doc.file_name, dl.error?.message ?? 'Download failed')); continue }
          files.current.set(doc.id, dl.data)
          const ocrPages = new Set<number>()
          const pages = await readPdf(await dl.data.arrayBuffer(), (page, total, ocr) => {
            if (ocr) ocrPages.add(Math.floor(page) + 1)
            if (!cancelled) setProgress({ file: i, files: list.length, name: doc.file_name, page, pages: total, ocr })
          }, READ_LIMIT_MS)
          if (!pages.some((p) => p.lines.length)) {
            out.push(failed(doc.file_name, 'No text could be read, even with OCR. Type the values in by hand.'))
            continue
          }
          const read = extract(pages, doc.file_name)
          const { notes, discounted } = read
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
          // Client particulars the PI doesn't show come from the request form (never the client's real name).
          const filled = fillFromForm(found, Object.fromEntries(FIELDS.map((f) => [f.key, found[f.key]?.value ?? ''])),
            { gender: req.gender, smoker: req.smoker, age_band: req.age_band, date_of_birth: req.date_of_birth, residency: req.residency })
          const issueFound = findIssueDate(pages)
          out.push({ fileName: doc.file_name, found: filled.found, notes: [...notes, ...filled.notes], discounted, values: filled.values,
            issueDate: issueFound?.value ?? '', issueFound, pages, ocrPages: [...ocrPages] })
        } catch (e) {
          out.push(failed(doc.file_name, 'Could not read this PDF: ' + (e as Error).message))
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
  // Cells the AI may fill: left blank by the reader and not typed in by hand.
  const aiTodo = (c: Column) => (c.error || !c.pages ? [] : blankKeys(c.found).filter((k) => !(c.values[k] ?? '').trim()))
  const aiCells = cols.reduce((n, c) => n + aiTodo(c).length, 0)
  // Blank cells the AI helper never fills (covers, riders, client details…), named so ops know why there is no button for them.
  const aiKeys = new Set(AI_FIELDS.map((f) => f.key))
  const otherBlanks = [...new Set(cols.flatMap((c) => FIELDS.filter((f) => f.section !== 'meta' && !aiKeys.has(f.key) && !(c.values[f.key] ?? '').trim()).map((f) => f.label)))]
  const noWasm = typeof WebAssembly === 'undefined'

  async function fillWithAi() {
    setAiState({ busy: true, text: 'Starting the AI helper…', error: '' })
    try {
      const { askAi } = await import('../lib/aiModel')
      let filled = 0
      for (const [i, c] of cols.entries()) {
        const keys = aiTodo(c)
        if (!keys.length) continue
        const res = await askAi(c.pages!, keys, c.values, (p) => setAiState({ busy: true, error: '',
          text: p.stage === 'download' ? `Downloading the AI model, first time only: ${plain(Math.round((p.pct ?? 0) * 100))}%`
            : `The AI (${p.model}) is reading PI${plain(i + 1)} (${c.fileName})${p.device === 'wasm' ? ' on the processor, which can take a few minutes' : ''}…` }))
        const got = Object.keys(res.found)
        filled += got.length
        const names = (ks: string[]) => ks.map((k) => FIELDS.find((f) => f.key === k)?.label ?? k).join(', ')
        setCols((cs) => cs.map((col, j) => {
          if (j !== i) return col
          const found = { ...col.found }, values = { ...col.values }
          for (const k of got) if (!(values[k] ?? '').trim()) { found[k] = res.found[k]; values[k] = res.found[k].value }
          const notes = [...col.notes]
          if (got.length) notes.push(`The free AI helper filled ${fmtNum(got.length)} blank ${got.length === 1 ? 'cell' : 'cells'} (${names(got)}), tagged "AI": check ${got.length === 1 ? 'it' : 'them'} against the PI.`)
          if (res.dropped.length) notes.push(`The AI's answers for ${names([...new Set(res.dropped)])} did not match the PI's text, so they were left blank.`)
          return { ...col, found, values, notes }
        }))
      }
      setChecked(false); setSaved('')
      setAiState({ busy: false, error: '', text: filled ? `The AI filled ${fmtNum(filled)} of ${fmtNum(aiCells)} blank ${aiCells === 1 ? 'cell' : 'cells'}, tagged “AI”. Check them against the PIs.` : 'The AI found nothing it could confirm in the PI text: the blank cells stay blank.' })
    } catch (e) {
      setAiState({ busy: false, text: '', error: 'The AI helper could not run in this browser: ' + (e as Error).message + '. Fill the blank cells by hand.' })
    }
  }

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
          <div className="row between">
            <h3 className="small" style={{ margin: 0 }}>Check the values</h3>
            <span className="small muted">{missing ? `${fmtNum(missing)} empty ${missing === 1 ? 'cell' : 'cells'} (shaded) to fill or leave blank` : 'Every field has a value'}</span>
          </div>
          {(missing > 0 || aiState.text || aiState.error) && (
            <div className="row" style={{ gap: 10, flexWrap: 'wrap' }} aria-label="AI helper">
              {aiCells > 0 && noWasm && <span className="error small" role="note">The free AI helper can't run in this browser (no WebAssembly). Please use an up-to-date Chrome or Edge.</span>}
              {aiCells === 0 && !aiState.busy && !aiState.text && (
                <span className="small muted" role="note">
                  Free AI helper: nothing for it to fill here. It only fills the {fmtNum(AI_FIELDS.length)} plan fields (insurer, plan name, terms, cover age, sums assured, premiums).
                  {otherBlanks.length > 0 && ` The blank ${otherBlanks.length === 1 ? 'cell' : 'cells'} left (${otherBlanks.slice(0, 4).join(', ')}${otherBlanks.length > 4 ? ` and ${fmtNum(otherBlanks.length - 4)} more` : ''}) ${otherBlanks.length === 1 ? 'is' : 'are'} not something it fills: usually the PI doesn't mention ${otherBlanks.length === 1 ? 'it' : 'them'}. Check the PI and type the value, for example Included or NA.`}
                </span>
              )}
              {aiCells > 0 && !noWasm && (
                <button className="btn small" disabled={aiState.busy} onClick={fillWithAi}
                  title={`A free, open AI model (${fmtNum(AI_FIELDS.length)} plan fields: names, terms, sums assured, premiums) runs in this browser: the PI never leaves this computer. The first time, the browser downloads the model (about ${fmtNum(AI_MODELS.small.mb / 1000, 1)} GB) and keeps it for next time.`}>
                  {aiState.busy ? 'AI helper working…' : `Fill ${fmtNum(aiCells)} blank ${aiCells === 1 ? 'cell' : 'cells'} with the free AI helper`}
                </button>
              )}
              {aiState.text && <span className="small" role="status">{aiState.text}</span>}
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
                                  {edited ? 'Changed by hand' : fd?.ai ? `AI${fd.page ? `, page ${plain(fd.page)}` : ''}: “${(fd.line ?? '').slice(0, 44)}${(fd.line ?? '').length > 44 ? '…' : ''}”` : isFromForm(fd) ? 'From the request form (not in the PI)' : /^Calculated:/.test(fd?.line ?? '') ? 'Calculated from the PI (see notes)' : fd?.page ? `Page ${plain(fd.page)}: “${(fd.line ?? '').slice(0, 48)}${(fd.line ?? '').length > 48 ? '…' : ''}”` : fd?.value ? (f.section === 'riders' ? 'No such rider in the PI' : f.key === 'campaigns' ? 'No discount in the PI' : f.kind === 'cover' ? 'Not mentioned in the PI' : 'From the PI') : aiKeys.has(f.key) ? 'Not found' : 'Not found: check the PI and type it (the AI helper does not fill this)'}
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
