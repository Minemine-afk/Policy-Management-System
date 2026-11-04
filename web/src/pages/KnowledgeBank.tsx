import { useEffect, useState, type FormEvent } from 'react'
import { useSearchParams } from 'react-router-dom'
import * as pdfjs from 'pdfjs-dist'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { KB_TYPES, fmtDate } from '../lib/options'
import type { KbDocument } from '../lib/types'
import '../lib/redaction' // sets up the PDF worker

export async function openKbDocument(d: KbDocument) {
  if (!d.storage_path) return
  const { data, error } = await supabase.storage.from('kb').createSignedUrl(d.storage_path, 60)
  if (error || !data) { alert(error?.message ?? 'Could not open the file'); return }
  window.open(data.signedUrl, '_blank', 'noopener')
}

async function pdfText(file: File) {
  try {
    const doc = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise
    const parts: string[] = []
    for (let i = 1; i <= Math.min(doc.numPages, 200); i++) {
      const c = await (await doc.getPage(i)).getTextContent()
      parts.push(c.items.map((it) => ('str' in it ? it.str : '')).join(' '))
    }
    return parts.join('\n').slice(0, 500_000)
  } catch { return '' }
}

export default function KnowledgeBank() {
  const { has } = useAuth()
  const canEdit = has('content_editor') || has('admin')
  const [params] = useSearchParams()
  const [rows, setRows] = useState<KbDocument[]>([])
  const [q, setQ] = useState('')
  const [type, setType] = useState('')
  const [tag, setTag] = useState('')
  const [allTags, setAllTags] = useState<string[]>([])
  const [selected, setSelected] = useState<string | null>(params.get('doc'))
  const [uploading, setUploading] = useState(false)
  const [form, setForm] = useState({ title: '', doc_type: 'Product', insurer: '', tags: '', description: '' })
  const [file, setFile] = useState<File | null>(null)
  const [error, setError] = useState('')

  async function load() {
    let query = supabase.from('kb_documents').select('id,title,doc_type,insurer,tags,description,storage_path,file_name,version,archived,updated_at')
    if (q.trim()) query = query.textSearch('search', q.trim(), { type: 'websearch', config: 'english' })
    if (type) query = query.eq('doc_type', type)
    if (tag) query = query.contains('tags', [tag])
    const { data } = await query.order('updated_at', { ascending: false }).limit(100)
    setRows((data as KbDocument[]) ?? [])
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { const t = setTimeout(load, 250); return () => clearTimeout(t) }, [q, type, tag])
  useEffect(() => {
    supabase.from('kb_documents').select('tags').then(({ data }) =>
      setAllTags([...new Set((data ?? []).flatMap((d) => d.tags as string[]))].sort()))
  }, [rows.length])

  async function upload(e: FormEvent) {
    e.preventDefault()
    setError('')
    let storage_path: string | null = null, body_text = ''
    if (file) {
      storage_path = `${crypto.randomUUID()}/${file.name.replace(/[^\w.-]+/g, '_')}`
      const up = await supabase.storage.from('kb').upload(storage_path, file)
      if (up.error) { setError(up.error.message); return }
      if (file.name.toLowerCase().endsWith('.pdf')) body_text = await pdfText(file)
      else if (file.type.startsWith('text/')) body_text = await file.text()
    }
    const { error } = await supabase.from('kb_documents').insert({
      title: form.title, doc_type: form.doc_type, insurer: form.insurer || null, description: form.description || null,
      tags: form.tags.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean),
      storage_path, file_name: file?.name ?? null, body_text: body_text || form.description,
    })
    if (error) { setError(error.message); return }
    setUploading(false); setFile(null); setForm({ title: '', doc_type: 'Product', insurer: '', tags: '', description: '' })
    load()
  }

  async function archive(d: KbDocument) {
    await supabase.from('kb_documents').update({ archived: !d.archived, updated_at: new Date().toISOString() }).eq('id', d.id)
    load()
  }

  return (
    <main className="page">
      <div className="row between">
        <div>
          <h1>Knowledge bank</h1>
          <p className="small muted" style={{ margin: '4px 0 0' }}>Product guides, onboarding and process documents. Search looks inside PDFs.</p>
        </div>
        {canEdit && <button className="btn primary" onClick={() => setUploading(!uploading)}>Upload document</button>}
      </div>

      {uploading && (
        <form className="card" onSubmit={upload} aria-label="Upload document">
          <div className="grid">
            <label className="field">Title<input type="text" required value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></label>
            <label className="field">Type<select value={form.doc_type} onChange={(e) => setForm({ ...form, doc_type: e.target.value })}>{KB_TYPES.map((t) => <option key={t}>{t}</option>)}</select></label>
            <label className="field">Insurer (optional)<input type="text" value={form.insurer} onChange={(e) => setForm({ ...form, insurer: e.target.value })} /></label>
            <label className="field">Tags (comma separated)<input type="text" value={form.tags} onChange={(e) => setForm({ ...form, tags: e.target.value })} placeholder="term, ci" /></label>
          </div>
          <p className="small muted" style={{ margin: 0 }}>Tag <code>term</code> or <code>ci</code> to show the document in the request form's "Relevant documents" panel.</p>
          <label className="field">Description<textarea rows={2} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></label>
          <label className="field">File<input type="file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></label>
          {error && <div className="error">{error}</div>}
          <div className="row"><button className="btn primary">Save</button><button type="button" className="btn" onClick={() => setUploading(false)}>Cancel</button></div>
        </form>
      )}

      <div className="card">
        <div className="grid">
          <label className="field">Search<input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="e.g. critical illness exclusions" /></label>
          <label className="field">Type<select value={type} onChange={(e) => setType(e.target.value)}><option value="">All types</option>{KB_TYPES.map((t) => <option key={t}>{t}</option>)}</select></label>
          <label className="field">Tag<select value={tag} onChange={(e) => setTag(e.target.value)}><option value="">All tags</option>{allTags.map((t) => <option key={t}>{t}</option>)}</select></label>
        </div>
        <ul className="filelist">
          {rows.map((d) => (
            <li key={d.id} style={d.id === selected ? { borderColor: 'var(--brand)', borderWidth: 2 } : undefined} onClick={() => setSelected(d.id)}>
              <div style={{ flex: '1 1 300px' }}>
                <div style={{ fontWeight: 600 }}>{d.title}{d.archived && <span className="pill grey" style={{ marginLeft: 8 }}>Archived</span>}</div>
                <div className="small muted">{d.doc_type}{d.insurer ? ` · ${d.insurer}` : ''} · v{d.version} · updated {fmtDate(d.updated_at)}</div>
                {d.description && <div className="small" style={{ marginTop: 4 }}>{d.description}</div>}
                <div className="chips" style={{ marginTop: 6 }}>{d.tags.map((t) => <span className="chip" key={t}>{t}</span>)}</div>
              </div>
              <div className="row" style={{ gap: 12 }}>
                {d.storage_path ? <button className="linkbtn" onClick={() => openKbDocument(d)}>Open</button> : <span className="small muted">No file (sample)</span>}
                {canEdit && <button className="linkbtn" onClick={() => archive(d)}>{d.archived ? 'Restore' : 'Archive'}</button>}
              </div>
            </li>
          ))}
        </ul>
        {rows.length === 0 && <div className="empty">No documents match.</div>}
      </div>
    </main>
  )
}
