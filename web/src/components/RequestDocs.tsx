import { useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import { scanFile } from '../lib/redaction'
import type { RequestDocument } from '../lib/types'

interface Pending { name: string; message: string; ok: boolean }

/** Upload area for redacted documents. Files that look identifying are never stored. */
export default function RequestDocs({ requestId, ensureRequest, docs, onChange }: {
  requestId: string | null
  ensureRequest: () => Promise<string | null>
  docs: RequestDocument[]
  onChange: (requestId: string) => void
}) {
  const input = useRef<HTMLInputElement>(null)
  const [results, setResults] = useState<Pending[]>([])
  const [busy, setBusy] = useState(false)

  async function onFiles(files: FileList | null) {
    if (!files?.length) return
    setBusy(true)
    const id = requestId ?? (await ensureRequest())
    if (!id) { setBusy(false); return }
    const out: Pending[] = []
    for (const file of Array.from(files)) {
      const scan = await scanFile(file)
      if (!scan.ok) { out.push({ name: file.name, message: scan.message, ok: false }); continue }
      const safeName = file.name.replace(/[^\w.-]+/g, '_')
      const path = `${id}/${Date.now()}-${safeName}`
      const up = await supabase.storage.from('request-docs').upload(path, file, { contentType: file.type || 'application/pdf' })
      if (up.error) { out.push({ name: file.name, message: up.error.message, ok: false }); continue }
      const ins = await supabase.from('request_documents').insert({
        request_id: id, storage_path: path, file_name: file.name, scan_notes: scan.checked ? null : scan.message,
      })
      out.push({ name: file.name, message: ins.error ? ins.error.message : scan.message, ok: !ins.error })
    }
    setResults(out.filter((r) => !r.ok || r.message.startsWith('No readable')))
    setBusy(false)
    if (input.current) input.current.value = ''
    onChange(id)
  }

  async function remove(d: RequestDocument) {
    await supabase.storage.from('request-docs').remove([d.storage_path])
    await supabase.from('request_documents').delete().eq('id', d.id)
    onChange(d.request_id)
  }

  return (
    <section className="card" aria-labelledby="docs-head">
      <div>
        <h2 id="docs-head" className="eyebrow">Documents</h2>
        <p className="small muted" style={{ margin: '4px 0 0' }}>
          Upload the advisory form and needs analysis with name, NRIC, date of birth, address and contact details
          already removed. Each file is checked before it is stored.
        </p>
      </div>
      <div className="row">
        <input ref={input} type="file" accept="application/pdf,.pdf" multiple aria-label="Upload redacted PDFs"
          onChange={(e) => onFiles(e.target.files)} disabled={busy} />
        {busy && <span className="small muted">Checking…</span>}
      </div>
      <ul className="filelist">
        {docs.map((d) => (
          <li key={d.id}>
            <span style={{ fontWeight: 500 }}>{d.file_name}</span>
            <span className="row" style={{ gap: 12 }}>
              {d.scan === 'reported'
                ? <span className="pill bad">Reported by approver · hidden</span>
                : d.scan_notes
                  ? <span className="pill warn">Not checked · {d.scan_notes}</span>
                  : <span className="pill ok">Checked · nothing identifying found</span>}
              <button className="linkbtn danger" onClick={() => remove(d)}>Remove</button>
            </span>
          </li>
        ))}
        {results.map((r, i) => (
          <li key={'r' + i} style={{ borderColor: r.ok ? undefined : '#E8B4B4' }}>
            <span style={{ fontWeight: 500 }}>{r.name}</span>
            <span className={`small`} style={{ color: r.ok ? 'var(--warn)' : 'var(--bad)', fontWeight: 600 }}>{r.message}</span>
          </li>
        ))}
      </ul>
    </section>
  )
}
