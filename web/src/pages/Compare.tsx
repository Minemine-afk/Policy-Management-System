import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
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

const failed = (fileName: string, error: string): Column => ({ fileName, found: {}, values: {}, notes: [], discounted: false, error })

const MAX = 3

async function toColumn(fileName: string, data: ArrayBuffer): Promise<Column> {
  try {
    const pages = await readPdf(data)
    if (!pages.some((p) => p.lines.length)) return failed(fileName, 'No text found. This may be a scanned image, which needs OCR. Type the values in by hand.')
    const { found, notes, discounted } = extract(pages, fileName)
    return { fileName, found, notes, discounted, values: Object.fromEntries(FIELDS.map((f) => [f.key, found[f.key]?.value ?? ''])) }
  } catch (e) {
    return failed(fileName, 'Could not read this PDF: ' + (e as Error).message)
  }
}

export default function Compare() {
  const { profile } = useAuth()
  const [params] = useSearchParams()
  const requestId = params.get('request')
  const [req, setReq] = useState<PiRequest | null>(null)
  const [cols, setCols] = useState<Column[]>([])
  const [busy, setBusy] = useState(false)
  const [checked, setChecked] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState('')
  const [saving, setSaving] = useState(false)

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
          : failed(doc.file_name, dl.error?.message ?? 'Download failed'))
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
    setCols(out); setBusy(false); setSaved('')
  }

  const setValue = (i: number, key: string, v: string) => {
    setChecked(false); setSaved('')
    setCols((cs) => cs.map((c, j) => (j === i ? { ...c, values: { ...c.values, [key]: v } } : c)))
  }

  const missing = cols.reduce((n, c) => n + FIELDS.filter((f) => !c.values[f.key]).length, 0)

  const canSave = !!req && !!profile && req.assignee_id === profile.id && ['assigned', 'in_progress'].includes(req.status)
  const fileName = `${req ? req.ref + '-' : ''}pi-comparison.xlsx`

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
    if (!req || !profile) return
    setError(''); setSaved(''); setSaving(true)
    try {
      const blob = await makeBlob()
      const old = await supabase.from('request_documents').select('*').eq('request_id', req.id).eq('kind', 'pi_output')
      const path = `${req.id}/${Date.now()}-${fileName}`
      const up = await supabase.storage.from('request-docs').upload(path, blob, { contentType: blob.type })
      if (up.error) throw new Error(up.error.message)
      const ins = await supabase.rpc('add_document', { p_request: req.id, p_kind: 'pi_output', p_path: path, p_name: fileName })
      if (ins.error) { await supabase.storage.from('request-docs').remove([path]); throw new Error(ins.error.message) }
      for (const d of ((old.data as RequestDocument[]) ?? []).filter((x) => isComparisonFile(x.file_name) && x.uploaded_by === profile.id)) {
        await supabase.rpc('remove_document', { p_document: d.id })
      }
      setSaved(`Saved ${fileName} to ${req.ref}. The introducer gets it with the PIs when you mark the request completed.`)
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
          Add the three PI PDFs you generated. They fill PI1, PI2 and PI3 of the comparison Excel template, in the order added.
          The text is read in your browser by fixed rules (no AI), and nothing is sent anywhere. Fields that can't be read
          are left blank for you to fill. Check each value against the PDF, correct it if needed, then export.
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
                          {f.key === 'monthly_premium' && c.discounted && <div className="pill warn" style={{ margin: "4px 0 2px", fontSize: 12 }}>After discount</div>}
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
          {saved && <div className="notice" role="status">{saved} <Link to={`/requests/${req?.id}`}>Back to {req?.ref}</Link></div>}
          <div className="row">
            {canSave && <button className="btn primary" disabled={!checked || saving} onClick={saveToRequest}>{saving ? 'Saving…' : `Save to ${req?.ref} for the introducer`}</button>}
            <button className={canSave ? 'btn' : 'btn primary'} disabled={!checked} onClick={exportXlsx}>Export to Excel</button>
          </div>
        </section>
      )}
    </main>
  )
}
