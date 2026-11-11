import { useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import { fmtDateTime, says } from '../lib/options'
import type { RequestDocument } from '../lib/types'
import { uploadDocuments } from '../lib/documents'

/** A list of files of one kind, with upload and download. */
export default function Files({ title, hint, requestId, kind, docs, canUpload, userId, onChange }: {
  title: string; hint?: string; requestId: string; kind: 'attachment' | 'pi_output'
  docs: RequestDocument[]; canUpload: boolean; userId: string; onChange: () => void
}) {
  const input = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const mine = docs.filter((d) => d.kind === kind)

  async function onFiles(files: FileList | null) {
    if (!files?.length) return
    setBusy(true); setError('')
    const errors = await uploadDocuments(requestId, kind, Array.from(files))
    if (errors.length) setError(errors.join(' · '))
    setBusy(false)
    if (input.current) input.current.value = ''
    onChange()
  }

  async function open(d: RequestDocument) {
    const { data, error } = await supabase.storage.from('request-docs').createSignedUrl(d.storage_path, 60)
    if (error || !data) { setError(error?.message ?? 'Could not open the file'); return }
    await supabase.rpc('log_document_view', { p_document: d.id })
    window.open(data.signedUrl, '_blank', 'noopener')
  }

  async function remove(d: RequestDocument) {
    setError('')
    const { error } = await supabase.rpc('remove_document', { p_document: d.id })
    if (error) setError(says(error.message))
    // Supabase only allows deleting files through the Storage API, once the file is off the request.
    else await supabase.storage.from('request-docs').remove([d.storage_path])
    onChange()
  }

  return (
    <section className="card" aria-label={title}>
      <div>
        <h2 className="eyebrow">{title}</h2>
        {hint && <p className="small muted" style={{ margin: '4px 0 0' }}>{hint}</p>}
      </div>
      {canUpload && (
        <div className="row">
          <input ref={input} type="file" multiple aria-label={`Upload ${title.toLowerCase()}`} onChange={(e) => onFiles(e.target.files)} disabled={busy} />
          {busy && <span className="small muted">Uploading…</span>}
        </div>
      )}
      {error && <div className="error" role="alert">{error}</div>}
      <ul className="filelist">
        {mine.map((d) => (
          <li key={d.id}>
            <span><button className="linkbtn" onClick={() => open(d)}>{d.file_name}</button>
              <span className="small muted"> · {fmtDateTime(d.uploaded_at)}</span></span>
            {canUpload && d.uploaded_by === userId && <button className="linkbtn danger" onClick={() => remove(d)}>Remove</button>}
          </li>
        ))}
        {!mine.length && <li className="muted small">None yet</li>}
      </ul>
    </section>
  )
}
