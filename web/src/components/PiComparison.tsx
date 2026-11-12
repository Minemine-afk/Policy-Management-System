import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import { says } from '../lib/options'
import { FIELDS, SECTIONS, extract, labelWith, readPdf, type Found } from '../lib/piExtract'
import { TEMPLATE_URL, buildWorkbook, preloadExcel, commonCurrency, isComparisonFile, type ExportColumn } from '../lib/piExcel'
import { buildPack, packFileName, packState, preloadPdf, sha256 } from '../lib/piPdf'
import { findIssueDate, showDate, toDmy } from '../lib/piIssueDate'
import { fillFromForm, isFromForm } from '../lib/formFill'
import type { PiRequest, RequestDocument } from '../lib/types'

interface Column {
  fileName: string
  found: Record<string, Found>
  values: Record<string, string>
  notes: string[]
  discounted: boolean
  /** The PI's issue date, DD/MM/YYYY ("" when not found), and where it was found. */
  issueDate: string
  issueFound: { value: string; page: number; line: string } | null
  error?: string
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
    runs.push(j > i ? `${ps[i]}–${ps[j]}` : String(ps[i]))
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
    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} took longer than ${ms / 1000} seconds`)), ms) }),
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

  // Read the request's PIs whenever the set of PI PDFs changes (or "Read again").
  // Fetch the Excel tool now, while it matches this page (see preloadExcel).
  useEffect(() => { preloadExcel().catch(() => {}); preloadPdf().catch(() => {}) }, [])
  useEffect(() => {
    if (!key) { setCols([]); return }
    let cancelled = false
    const list = docs.filter((d) => key.split(',').includes(d.id)).sort((a, b) => key.indexOf(a.id) - key.indexOf(b.id))
    ;(async () => {
      setChecked(false); setSaved(''); setError('')
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
          const { found, notes, discounted } = extract(pages, doc.file_name)
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
            { gender: req.gender, smoker: req.smoker, age_band: req.age_band })
          const issueFound = findIssueDate(pages)
          out.push({ fileName: doc.file_name, found: filled.found, notes: [...notes, ...filled.notes], discounted, values: filled.values,
            issueDate: issueFound?.value ?? '', issueFound })
        } catch (e) {
          out.push(failed(doc.file_name, 'Could not read this PDF: ' + (e as Error).message))
        }
      }
      if (!cancelled) { setCols(out); setProgress(null) }
    })()
    return () => { cancelled = true }
    // docs changes on every reload of the request; only a different set of PI PDFs needs a new read
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, run])

  const setValue = (i: number, k: string, v: string) => {
    setChecked(false); setSaved('')
    setCols((cs) => cs.map((c, j) => (j === i ? { ...c, values: { ...c.values, [k]: v } } : c)))
  }
  const setIssueDate = (i: number, v: string) => {
    setChecked(false); setSaved('')
    setCols((cs) => cs.map((c, j) => (j === i ? { ...c, issueDate: v } : c)))
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
    if (!res.ok) throw new Error(`Could not load the Excel template (${res.status}).`)
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
      const path = `${req.id}/${Date.now()}-${packName}`
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
      setSaved(`Saved ${packName} (${(blob.size / 1024 / 1024).toFixed(1)} MB, fingerprint ${hash.slice(0, 12)}…). The introducer gets this one PDF when you mark the request completed.`)
      onSaved()
    } catch (e) { setError((e as Error).message) }
    setSaving(false)
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
        They are read in your browser by fixed rules (no AI), scanned pages with OCR, and nothing is sent anywhere. Fields that can't be read are left
        blank for you to fill; client details the PI doesn't show come from the request form. Check each value against the PDF,
        then save the PI pack: one PDF with the comparison and every PI, which is all the introducer receives. It can be printed but not edited.
        {pdfs.length > MAX && ` Only the first ${MAX} of the ${pdfs.length} PDFs are compared.`}
      </p>
      {!key && <div className="small muted">Upload the PI PDFs above and they are read here straight away.</div>}

      {progress && (
        <div className="progress" role="status" aria-label="Reading PIs">
          <div className="row between small">
            <span>Reading PI {progress.file + 1} of {progress.files}: {progress.name}
              {progress.ocr ? ` · scanned page ${Math.floor(progress.page) + 1} of ${progress.pages}, reading it with OCR (slower)`
                : progress.pages ? ` · page ${Math.floor(progress.page)} of ${progress.pages}` : ' · downloading'}</span>
            <strong>{pct}%</strong>
          </div>
          <progress max={100} value={pct} aria-label={`${pct}% read`} />
          <span className="small muted">A PI is stopped if nothing happens for {READ_LIMIT_MS / 1000} seconds. Scanned pages are read with OCR, which takes several seconds each (the first one also downloads the OCR engine, about 28 MB).</span>
        </div>
      )}

      {!progress && cols.length > 0 && (
        <>
          <div className="row between">
            <h3 className="small" style={{ margin: 0 }}>Check the values</h3>
            <span className="small muted">{missing ? `${missing} empty ${missing === 1 ? 'cell' : 'cells'} (shaded) to fill or leave blank` : 'Every field has a value'}</span>
          </div>
          <div className="tablewrap">
            <table className="compare" aria-label="Extracted values">
              <thead>
                <tr>
                  <th>Field</th>
                  {cols.map((c, i) => (
                    <th key={i}>
                      PI{i + 1}
                      <div className="small muted" style={{ fontWeight: 400, marginTop: 4 }}>{c.fileName}</div>
                      {!c.error && (
                        <label className="small" style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 400, marginTop: 6 }}>
                          Currency
                          <input type="text" aria-label={`Policy Currency for PI ${i + 1}`} value={c.values.currency ?? ''} maxLength={3} placeholder="?"
                            style={{ width: 70, height: 30 }} className={c.values.currency ? '' : 'empty-cell'}
                            onChange={(e) => setValue(i, 'currency', e.target.value.toUpperCase())} />
                        </label>
                      )}
                      {!c.error && (
                        <label className="small" style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 400, marginTop: 6 }}>
                          Issue date
                          <input type="text" aria-label={`PI issue date for PI ${i + 1}`} value={c.issueDate} placeholder="DD/MM/YYYY" maxLength={10}
                            style={{ width: 124, height: 30 }} className={!c.issueDate ? 'empty-cell' : c.issueDate.trim() && !toDmy(c.issueDate) ? 'empty-cell' : c.issueDate !== (c.issueFound?.value ?? '') ? 'edited-cell' : ''}
                            title={c.issueFound ? `Page ${c.issueFound.page}: ${c.issueFound.line}` : 'Not found in the PI: the comparison date is used if no PI has one'}
                            onChange={(e) => setIssueDate(i, e.target.value)} />
                        </label>
                      )}
                      {!c.error && c.issueDate && toDmy(c.issueDate) && <div className="small muted" style={{ fontWeight: 400 }}>{showDate(toDmy(c.issueDate))}{c.issueFound && c.issueDate === c.issueFound.value ? `, page ${c.issueFound.page}` : ''}</div>}
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
                            return (
                              <td key={i} className={!c.values[f.key] ? 'empty-cell' : edited ? 'edited-cell' : ''}>
                                <input type="text" aria-label={`${label} for PI ${i + 1}`} value={c.values[f.key] ?? ''}
                                  onChange={(e) => setValue(i, f.key, e.target.value)} />
                                {(f.kind === 'money' || f.kind === 'sum') && !currency && cur && c.values[f.key] && c.values[f.key] !== 'NA' && <div className="small">in {cur}</div>}
                                {f.key === 'base_premium' && c.discounted && <div className="pill warn" style={{ margin: '4px 0 2px', fontSize: 12 }}>After discount</div>}
                                <div className="small muted" title={fd?.line ?? ''}>
                                  {edited ? 'Changed by hand' : isFromForm(fd) ? 'From the request form (not in the PI)' : /^Calculated:/.test(fd?.line ?? '') ? 'Calculated from the PI (see notes)' : fd?.page ? `Page ${fd.page}: “${(fd.line ?? '').slice(0, 48)}${(fd.line ?? '').length > 48 ? '…' : ''}”` : fd?.value ? (f.section === 'riders' ? 'No such rider in the PI' : f.key === 'campaigns' ? 'No discount in the PI' : f.kind === 'cover' ? 'Not mentioned in the PI' : 'From the PI') : 'Not found'}
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
                      <td key={i} aria-label={`Notes for PI ${i + 1}`}>
                        {c.notes.length ? <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>{c.notes.map((n) => <li key={n}>{n}</li>)}</ul> : <span className="small muted">None</span>}
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
          {pdfs.length > MAX && <div className="small muted">The PI pack includes all {pdfs.length} PI PDFs; the comparison shows the first {MAX}.</div>}
        </>
      )}
    </section>
  )
}
