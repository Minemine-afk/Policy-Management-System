import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { FIELDS, detectInsurer, extractFields, readPdf, type Found } from '../lib/piExtract'
import { buildWorkbook } from '../lib/piExcel'
import type { PiRequest, RequestDocument } from '../lib/types'

interface Column {
  fileName: string
  insurer: string
  found: Record<string, Found>
  values: Record<string, string>
  error?: string
}

const MAX = 3

async function toColumn(fileName: string, data: ArrayBuffer): Promise<Column> {
  try {
    const lines = await readPdf(data)
    if (!lines.length) return { fileName, insurer: '', found: {}, values: {}, error: 'No text found. This may be a scanned image, which needs OCR.' }
    const insurer = detectInsurer(lines, fileName)
    const found = extractFields(lines, insurer)
    return { fileName, insurer, found, values: Object.fromEntries(FIELDS.map((f) => [f.key, found[f.key]?.value ?? ''])) }
  } catch (e) {
    return { fileName, insurer: '', found: {}, values: {}, error: 'Could not read this PDF: ' + (e as Error).message }
  }
}

export default function Compare() {
  const [params] = useSearchParams()
  const requestId = params.get('request')
  const [req, setReq] = useState<PiRequest | null>(null)
  const [cols, setCols] = useState<Column[]>([])
  const [busy, setBusy] = useState(false)
  const [checked, setChecked] = useState(false)
  const [error, setError] = useState('')

  // Opened from a request: load its uploaded PIs straight away.
  useEffect(() => {
    if (!requestId) return
    let cancelled = false
    ;(async () => {
      const r = await supabase.from('pi_requests').select('*').eq('id', requestId).maybeSingle()
      setReq((r.data as PiRequest) ?? null)
      const d = await supabase.from('request_documents').select('*').eq('request_id', requestId).eq('kind', 'pi_output').order('uploaded_at')
      const docs = ((d.data as RequestDocument[]) ?? []).filter((x) => x.file_name.toLowerCase().endsWith('.pdf')).slice(0, MAX)
      if (!docs.length || cancelled) return
      setBusy(true)
      const out: Column[] = []
      for (const doc of docs) {
        const dl = await supabase.storage.from('request-docs').download(doc.storage_path)
        out.push(dl.data ? await toColumn(doc.file_name, await dl.data.arrayBuffer())
          : { fileName: doc.file_name, insurer: '', found: {}, values: {}, error: dl.error?.message ?? 'Download failed' })
      }
      if (!cancelled) { setCols(out); setBusy(false) }
    })()
    return () => { cancelled = true }
  }, [requestId])

  async function addFiles(files: FileList | null) {
    if (!files?.length) return
    setBusy(true); setChecked(false)
    const out = [...cols]
    for (const f of Array.from(files)) {
      if (out.length >= MAX) break
      out.push(await toColumn(f.name, await f.arrayBuffer()))
    }
    setCols(out); setBusy(false)
  }

  const setValue = (i: number, key: string, v: string) => {
    setChecked(false)
    setCols((cs) => cs.map((c, j) => (j === i ? { ...c, values: { ...c.values, [key]: v } } : c)))
  }
  const setInsurer = (i: number, v: string) => setCols((cs) => cs.map((c, j) => (j === i ? { ...c, insurer: v } : c)))

  const missing = cols.reduce((n, c) => n + FIELDS.filter((f) => !c.values[f.key]).length, 0)

  async function exportXlsx() {
    setError('')
    try {
      const title = `PI comparison${req ? ' · ' + req.ref : ''}`
      const blob = await buildWorkbook(cols.map((c) => ({
        fileName: c.fileName, insurer: c.insurer, values: c.values,
        edited: Object.fromEntries(FIELDS.map((f) => [f.key, (c.found[f.key]?.value ?? '') !== (c.values[f.key] ?? '')])),
        pages: Object.fromEntries(FIELDS.map((f) => [f.key, c.found[f.key]?.page ?? null])),
      })), title)
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = `${req ? req.ref + '-' : ''}pi-comparison.xlsx`
      a.click()
      setTimeout(() => URL.revokeObjectURL(a.href), 5000)
    } catch (e) { setError((e as Error).message) }
  }

  return (
    <main className="page wide">
      <div className="row between">
        <div>
          {req && <p className="muted small" style={{ margin: 0 }}><Link to={`/requests/${req.id}`}>{req.ref}</Link> / Compare PIs</p>}
          <h1>Compare PIs</h1>
        </div>
        {cols.length > 0 && <button className="btn" onClick={() => { setCols([]); setChecked(false) }}>Start again</button>}
      </div>

      <section className="card">
        <p className="small muted" style={{ margin: 0 }}>
          Add up to three PI PDFs. The text is read in your browser and nothing is sent anywhere. Values are suggestions:
          check each one against the PDF, correct it if needed, then export.
        </p>
        {cols.length < MAX && (
          <div className="row">
            <input type="file" accept="application/pdf,.pdf" multiple aria-label="Add PI PDFs" disabled={busy}
              onChange={(e) => { addFiles(e.target.files); e.target.value = '' }} />
            {busy && <span className="small muted">Reading…</span>}
          </div>
        )}
      </section>

      {cols.length > 0 && (
        <section className="card" aria-label="Extracted values">
          <div className="row between">
            <h2 className="eyebrow">Check the values</h2>
            <span className="small muted">{missing ? `${missing} empty ${missing === 1 ? 'cell' : 'cells'} (shaded) to fill or leave blank` : 'Every field has a value'}</span>
          </div>
          <div className="tablewrap">
            <table className="compare">
              <thead>
                <tr>
                  <th>Field</th>
                  {cols.map((c, i) => (
                    <th key={i}>
                      <input type="text" aria-label={`Insurer for PI ${i + 1}`} value={c.insurer} placeholder="Insurer"
                        onChange={(e) => setInsurer(i, e.target.value)} />
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
                          <div className="small muted" title={fd?.line ?? ''}>
                            {edited ? 'Changed by hand' : fd?.page ? `Page ${fd.page}: “${(fd.line ?? '').slice(0, 48)}${(fd.line ?? '').length > 48 ? '…' : ''}”` : 'Not found'}
                          </div>
                        </td>
                      )
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <label className="row" style={{ gap: 10 }}>
            <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} style={{ width: 20, height: 20 }} />
            <span>I have checked these values against the PDFs</span>
          </label>
          {error && <div className="error" role="alert">{error}</div>}
          <div><button className="btn primary" disabled={!checked} onClick={exportXlsx}>Export to Excel</button></div>
        </section>
      )}
    </main>
  )
}
