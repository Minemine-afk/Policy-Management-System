import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import { says } from '../lib/options'
import { FIELDS, extract, readPdf, type Found } from '../lib/piExtract'
import { TEMPLATE_URL, buildWorkbook, isComparisonFile } from '../lib/piExcel'
import type { PiRequest, RequestDocument } from '../lib/types'

interface Column {
  fileName: string
  found: Record<string, Found>
  values: Record<string, string>
  notes: string[]
  discounted: boolean
  error?: string
}

interface Progress { file: number; files: number; name: string; page: number; pages: number; ocr: boolean }

const failed = (fileName: string, error: string): Column => ({ fileName, found: {}, values: {}, notes: [], discounted: false, error })

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

/** Ops and bsd: reads the request's uploaded PI PDFs into the comparison Excel template, right on the request page. */
export default function PiComparison({ req, docs, userId, isBsd, onSaved }: {
  req: PiRequest; docs: RequestDocument[]; userId: string; isBsd: boolean; onSaved: () => void
}) {
  const pdfs = useMemo(() => docs.filter((d) => d.kind === 'pi_output' && d.file_name.toLowerCase().endsWith('.pdf')), [docs])
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
            notes.push(`Scanned ${skipped.length === 1 ? 'page' : 'pages'} ${pageList(skipped)} ${skipped.length === 1 ? 'was' : 'were'} not read, because all six values were found before ${skipped.length === 1 ? 'it' : 'them'}.`)
          }
          out.push({ fileName: doc.file_name, found, notes, discounted, values: Object.fromEntries(FIELDS.map((f) => [f.key, found[f.key]?.value ?? ''])) })
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

  const missing = cols.reduce((n, c) => n + FIELDS.filter((f) => !c.values[f.key]).length, 0)
  const canSave = (isBsd || req.assignee_id === userId) && ['assigned', 'in_progress'].includes(req.status)
  const fileName = `${req.ref}-pi-comparison.xlsx`
  const hasSaved = docs.some((d) => d.kind === 'pi_output' && isComparisonFile(d.file_name))
  const pct = progress ? Math.round(((progress.file + (progress.pages ? progress.page / progress.pages : 0)) / progress.files) * 100) : 100

  async function makeBlob() {
    const res = await fetch(TEMPLATE_URL)
    if (!res.ok) throw new Error(`Could not load the Excel template (${res.status}).`)
    return buildWorkbook(cols.map((c) => ({
      fileName: c.fileName, values: c.values, notes: c.notes,
      edited: Object.fromEntries(FIELDS.map((f) => [f.key, (c.found[f.key]?.value ?? '') !== (c.values[f.key] ?? '')])),
      pages: Object.fromEntries(FIELDS.map((f) => [f.key, c.found[f.key]?.page ?? null])),
    })), await res.arrayBuffer())
  }

  // Saves the Excel onto the request with the PIs, replacing an earlier saved comparison.
  // The introducer gets it with the PIs when the request is completed.
  async function saveToRequest() {
    setError(''); setSaved(''); setSaving(true)
    try {
      const blob = await makeBlob()
      const old = docs.filter((d) => d.kind === 'pi_output' && isComparisonFile(d.file_name) && d.uploaded_by === userId)
      const path = `${req.id}/${Date.now()}-${fileName}`
      const up = await supabase.storage.from('request-docs').upload(path, blob, { contentType: blob.type })
      if (up.error) throw new Error(says(up.error.message))
      const ins = await supabase.rpc('add_document', { p_request: req.id, p_kind: 'pi_output', p_path: path, p_name: fileName })
      if (ins.error) { await supabase.storage.from('request-docs').remove([path]); throw new Error(says(ins.error.message)) }
      for (const d of old) {
        const rm = await supabase.rpc('remove_document', { p_document: d.id })
        if (!rm.error) await supabase.storage.from('request-docs').remove([d.storage_path])
      }
      setSaved(`Saved ${fileName}. The introducer gets it with the PIs when you mark the request completed.`)
      onSaved()
    } catch (e) { setError((e as Error).message) }
    setSaving(false)
  }

  async function exportXlsx() {
    setError('')
    try {
      const blob = await makeBlob()
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = fileName
      a.click()
      setTimeout(() => URL.revokeObjectURL(a.href), 5000)
    } catch (e) { setError((e as Error).message) }
  }

  return (
    <section className="card" aria-label="PI comparison">
      <div className="row between">
        <h2 className="eyebrow">PI comparison{hasSaved ? ' · saved to this request' : ''}</h2>
        {!progress && cols.length > 0 && <button className="btn small" onClick={() => setRun((n) => n + 1)}>Read the PIs again</button>}
      </div>
      <p className="small muted" style={{ margin: 0 }}>
        The first three PI PDFs uploaded above fill PI1, PI2 and PI3 of the comparison Excel template, in upload order.
        They are read in your browser by fixed rules (no AI), scanned pages with OCR, and nothing is sent anywhere. Fields that can't be read are left
        blank for you to fill. Check each value against the PDF, correct it if needed, then save it to this request.
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
                      {c.error && <div className="error">{c.error}</div>}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {FIELDS.map((f) => (
                  <tr key={f.key}>
                    <td><strong>{f.label}</strong></td>
                    {cols.map((c, i) => {
                      const fd = c.found[f.key]
                      const edited = (fd?.value ?? '') !== (c.values[f.key] ?? '')
                      return (
                        <td key={i} className={!c.values[f.key] ? 'empty-cell' : edited ? 'edited-cell' : ''}>
                          <input type="text" aria-label={`${f.label} for PI ${i + 1}`} value={c.values[f.key] ?? ''}
                            onChange={(e) => setValue(i, f.key, e.target.value)} />
                          {f.key === 'monthly_premium' && c.discounted && <div className="pill warn" style={{ margin: '4px 0 2px', fontSize: 12 }}>After discount</div>}
                          <div className="small muted" title={fd?.line ?? ''}>
                            {edited ? 'Changed by hand' : fd?.page ? `Page ${fd.page}: “${(fd.line ?? '').slice(0, 48)}${(fd.line ?? '').length > 48 ? '…' : ''}”` : 'Not found'}
                          </div>
                        </td>
                      )
                    })}
                  </tr>
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
          {error && <div className="error" role="alert">{error}</div>}
          {saved && <div className="notice" role="status">{saved}</div>}
          <div className="row">
            {canSave && <button className="btn primary" disabled={!checked || saving} onClick={saveToRequest}>{saving ? 'Saving…' : `Save to ${req.ref} for the introducer`}</button>}
            <button className={canSave ? 'btn' : 'btn primary'} disabled={!checked} onClick={exportXlsx}>Export to Excel</button>
          </div>
        </>
      )}
    </section>
  )
}
