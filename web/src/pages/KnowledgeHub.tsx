// Knowledge Hub module: the Knowledge Bank's documents and product records.
// Ops and BSD keep it (upload, edit); a BSD person who did not make a change checks it. Introducers given the module
// see the checked, current documents only.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { nameOf, usePeople } from '../lib/people'
import { fmtDate, says } from '../lib/options'
import { STANDARD_INSURERS } from '../lib/formOptions'
import { readableName } from '../lib/kbExtract'
import {
  DOC_TYPES, DOC_TYPE_NAME_MAX, KB_ACCEPT, OTHERS, docTypeName, needsInsurer, KB_MAX_MB, daysLeft, docLabel, docState, loadDocs, loadProducts, loadUsable, openDoc, productState,
  type KbDoc, type KbProductRow,
} from '../lib/kbAdmin'
import { fmtNum, plain } from '../lib/num'

export function KbHeader({ tab, actions }: { tab: 'documents' | 'products'; actions?: React.ReactNode }) {
  const { has } = useAuth()
  const staff = has('ops') || has('bsd')
  return (
    <>
      <div className="row between" style={{ alignItems: 'flex-start' }}>
        <div>
          <p className="muted small" style={{ margin: 0 }}>Knowledge Hub</p>
          <h1>Knowledge Bank</h1>
          <p className="muted" style={{ margin: '6px 0 0', maxWidth: 760 }}>
            Insurer documents, training material, circulars and other files, and the product facts taken from them.
            Compare products on the PI request form reads checked products from here.
          </p>
        </div>
        {actions}
      </div>
      {staff && (
        <nav className="tabs" aria-label="Knowledge Bank">
          <Link to="/kb" className={tab === 'documents' ? 'on' : ''} aria-current={tab === 'documents' ? 'page' : undefined}>Documents</Link>
          <Link to="/kb/products" className={tab === 'products' ? 'on' : ''} aria-current={tab === 'products' ? 'page' : undefined}>Product records</Link>
        </nav>
      )}
    </>
  )
}

// ---------------------------------------------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------------------------------------------
export function KbDocuments() {
  const { profile, has } = useAuth()
  const people = usePeople()
  const member = has('ops') || has('bsd')
  const checker = has('bsd')
  const [docs, setDocs] = useState<KbDoc[]>([])
  const [products, setProducts] = useState<KbProductRow[]>([])
  const [loaded, setLoaded] = useState(false)
  const [q, setQ] = useState('')
  const [type, setType] = useState('')
  const [older, setOlder] = useState(false)
  const [dialog, setDialog] = useState<{ mode: 'new' | 'version' | 'edit'; doc?: KbDoc } | null>(null)
  const [made, setMade] = useState<{ id: string; doc_type: string } | null>(null)
  const [msg, setMsg] = useState('')
  const [error, setError] = useState('')
  const reload = useCallback(async () => {
    const [d, p] = await Promise.all([loadDocs(), member ? loadProducts() : Promise.resolve([])])
    setDocs(d); setProducts(p); setLoaded(true)
  }, [member])
  useEffect(() => { reload() }, [reload])

  const productName = (d: KbDoc) => (d.product_id ? products.find((p) => p.id === d.product_id)?.name ?? '—' : needsInsurer(d.doc_type) ? 'All products' : '—')
  const ownNames = customTypeNames(docs)
  const typeMatch = (d: KbDoc) => !type || (type === ANY_OTHERS ? d.doc_type === OTHERS : docTypeName(d) === type)
  const shown = docs.filter((d) => (older || !d.replaced_by) && typeMatch(d)
    && (!q || `${d.title} ${d.insurer} ${productName(d)} ${docTypeName(d)} ${d.file_name ?? ''}`.toLowerCase().includes(q.toLowerCase())))
  const toCheck = docs.filter((d) => d.status === 'new').length

  async function act(fn: () => PromiseLike<{ error: { message: string } | null }>, ok: string) {
    setError(''); setMsg(''); setMade(null)
    const { error } = await fn()
    if (error) setError(says(error.message)); else { setMsg(ok); reload() }
  }
  async function remove(d: KbDoc) {
    setError(''); setMsg(''); setMade(null)
    const { data, error } = await supabase.rpc('kb_remove_document', { p_id: d.id })
    if (error) { setError(says(error.message)); return }
    if (data) await supabase.storage.from('kb-docs').remove([data as string])   // files go through the Storage API only
    setMsg(`Removed ${d.title}.`); reload()
  }

  return (
    <main className="page">
      <KbHeader tab="documents" actions={member && <button className="btn primary" onClick={() => setDialog({ mode: 'new' })}>Upload document</button>} />
      <section className="card" aria-label="Documents">
        <div className="row" style={{ gap: 12 }}>
          <input type="search" aria-label="Search documents" placeholder="Search by insurer, product or document" value={q}
            onChange={(e) => setQ(e.target.value)} style={{ flex: '1 1 260px', width: 'auto' }} />
          <select aria-label="Document type" value={type} onChange={(e) => setType(e.target.value)} style={{ flex: '0 1 200px', width: 'auto' }}>
            <option value="">All types</option>
            {DOC_TYPES.filter((t) => t !== OTHERS).map((t) => <option key={t}>{t}</option>)}
            {ownNames.filter((n) => !DOC_TYPES.includes(n)).map((n) => <option key={`o:${n}`} value={n}>{n}</option>)}
            {ownNames.length > 0 && <option value={ANY_OTHERS}>Others (any name)</option>}
          </select>
          {member && <label className="row small" style={{ gap: 6 }}><input type="checkbox" checked={older} onChange={(e) => setOlder(e.target.checked)} /> Show older versions</label>}
        </div>
        {member && toCheck > 0 && <div className="notice" role="status">{fmtNum(toCheck)} document{toCheck === 1 ? ' is' : 's are'} waiting for a BSD person to check {toCheck === 1 ? 'it' : 'them'}{checker ? '' : ' (someone other than the uploader)'}.</div>}
        {msg && <div className="notice ok" role="status">{msg}
          {made && <> <Link to={`/kb/products/new?${made.doc_type === 'Rate sheet' ? 'rates' : 'summary'}=${made.id}`}>Make a product record from it</Link> (the details are read from the file for you to check).</>}</div>}
        {error && <div className="error" role="alert">{error}</div>}
        <div className="tablewrap">
          <table aria-label="Knowledge Bank documents">
            <thead><tr><th>Document</th><th>Insurer</th><th>Product</th><th>Type</th><th>Effective</th><th>Valid until</th><th>Status</th>{member && <th>Uploaded by</th>}{member && <th><span className="sr-only">Actions</span></th>}</tr></thead>
            <tbody>
              {shown.map((d) => {
                const st = docState(d)
                const mine = d.uploaded_by === profile?.id
                return (
                  <tr key={d.id}>
                    <td><button className="linkbtn" style={{ textAlign: 'left' }} onClick={async () => { const e = await openDoc(d); if (e) setError(e) }}>{docLabel(d)}</button>
                      {d.file_name && <div className="small muted">{d.file_name}</div>}</td>
                    <td>{d.insurer || <span className="muted">—</span>}</td>
                    <td className="small">{productName(d)}</td>
                    <td className="small">{docTypeName(d)}</td>
                    <td className="small">{fmtDate(d.effective_from)}</td>
                    <td className="small">{d.valid_until ? fmtDate(d.valid_until) : 'No end date'}</td>
                    <td><span className={`pill ${st.tone}`}>{st.text}</span>
                      {d.status === 'checked' && d.checked_by && <div className="small muted">by {nameOf(people, d.checked_by)}</div>}</td>
                    {member && <td className="small">{d.uploaded_by ? nameOf(people, d.uploaded_by) : 'Sample'}</td>}
                    {member && (
                      <td><div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                        {checker && d.status === 'new' && !mine && <button className="btn small primary" onClick={() => act(() => supabase.rpc('kb_check_document', { p_id: d.id }), `${d.title} is checked.`)}>Check</button>}
                        {checker && d.status === 'new' && mine && <span className="small muted">Someone else checks it</span>}
                        {!d.replaced_by && <button className="btn small" onClick={() => setDialog({ mode: 'version', doc: d })}>New version</button>}
                        {!d.replaced_by && <button className="btn small" onClick={() => setDialog({ mode: 'edit', doc: d })}>Edit</button>}
                        {!d.replaced_by && FILLS.includes(d.doc_type) && readableName(d.file_name) && (
                          <Link className="btn small" to={`/kb/products/new?${d.doc_type === 'Rate sheet' ? 'rates' : 'summary'}=${d.id}`}
                            title="Start a product record with the details read from this document">New record from it</Link>)}
                        {(d.status === 'new' || checker) && <button className="linkbtn danger" onClick={() => remove(d)}>Remove</button>}
                      </div></td>
                    )}
                  </tr>
                )
              })}
              {loaded && !shown.length && <tr><td colSpan={member ? 9 : 7} className="muted">{docs.length ? 'No documents match.' : 'No documents yet.'}</td></tr>}
            </tbody>
          </table>
        </div>
        <p className="small muted" style={{ margin: 0 }}>
          {member ? 'A new version replaces the earlier one once it is checked; product records that named the earlier one get a draft to re-check. When a document passes its valid-until date, products that rely on it drop out of Compare products.'
            : 'Checked, current insurer documents. Open one to read it.'}
        </p>
      </section>
      {dialog && <DocDialog mode={dialog.mode} doc={dialog.doc} docs={docs} products={products}
        onClose={() => setDialog(null)} onDone={(m, c) => { setDialog(null); setMsg(m); setMade(c && FILLS.includes(c.doc_type) && readableName(c.file.name) ? c : null); setError(''); reload() }} />}
    </main>
  )
}

/** The filter value for every "Others" document, whatever its name. */
const ANY_OTHERS = '*others'
/** The names people typed for "Others", A to Z, once each (ignoring case). */
export function customTypeNames(docs: KbDoc[]) {
  const seen = new Map<string, string>()
  for (const d of docs) {
    const n = d.doc_type === OTHERS ? d.doc_type_name?.trim() : ''
    if (n && !seen.has(n.toLowerCase())) seen.set(n.toLowerCase(), n)
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b))
}

/** Document types the reader can fill a product record from. */
export const FILLS = ['Product Summary', 'Rate sheet']
export interface Created { id: string; doc_type: string; file: File }

export function DocDialog({ mode, doc, docs, products, preset, onClose, onDone }: {
  mode: 'new' | 'version' | 'edit'; doc?: KbDoc; docs: KbDoc[]; products: KbProductRow[]
  /** For an upload started from a product record: the type and insurer to start with. */
  preset?: { doc_type?: string; insurer?: string; product_id?: string }
  onClose: () => void; onDone: (msg: string, created?: Created) => void
}) {
  const [file, setFile] = useState<File | null>(null)
  const [f, setF] = useState({
    insurer: doc?.insurer ?? preset?.insurer ?? '', product_id: doc?.product_id ?? preset?.product_id ?? '', title: doc?.title ?? '',
    doc_type: doc?.doc_type ?? preset?.doc_type ?? 'Product Summary', doc_type_name: doc?.doc_type_name ?? '',
    version: mode === 'edit' ? doc?.version ?? '' : '', effective_from: mode === 'edit' ? doc?.effective_from ?? '' : '',
    valid_until: mode === 'edit' ? doc?.valid_until ?? '' : '',
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const set = (k: keyof typeof f, v: string) => setF((s) => ({ ...s, [k]: v }))
  const insurers = useMemo(() => [...new Set([...products.map((p) => p.insurer), ...docs.map((d) => d.insurer), ...STANDARD_INSURERS])], [products, docs])
  const plans = products.filter((p) => p.insurer.toLowerCase() === f.insurer.trim().toLowerCase())
  const others = f.doc_type === OTHERS
  const ownNames = useMemo(() => customTypeNames(docs), [docs])
  const title = mode === 'new' ? 'Upload document' : mode === 'version' ? `New version of ${doc!.title}` : `Edit ${doc!.title}`

  function pick(list: FileList | null) {
    const x = list?.[0]
    setError('')
    if (!x) return
    const ext = x.name.toLowerCase().replace(/^.*(\.[^.]+)$/, '$1')
    if (!KB_ACCEPT.split(',').includes(ext)) { setError('Choose a PDF, image, Word or Excel file'); return }
    if (x.size > KB_MAX_MB * 1024 * 1024) { setError(`The file is over ${fmtNum(KB_MAX_MB)} MB`); return }
    setFile(x)
    if (!f.title) set('title', x.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' '))
  }

  async function save() {
    setError('')
    if (mode !== 'edit' && !file) { setError('Choose a file'); return }
    if (others && !f.doc_type_name.trim()) { setError('Type a name for the document type'); return }
    setBusy(true)
    const p = { ...f, product_id: f.product_id || null, valid_until: f.valid_until || null, doc_type_name: others ? f.doc_type_name.trim() : null }
    if (mode === 'edit') {
      const { error } = await supabase.rpc('kb_update_document', { p_id: doc!.id, p })
      setBusy(false)
      if (error) { setError(says(error.message)); return }
      onDone(`Saved. ${f.title} must be checked again.`)
      return
    }
    const path = `${crypto.randomUUID()}/${file!.name.replace(/[^\w.-]+/g, '_')}`
    const up = await supabase.storage.from('kb-docs').upload(path, file!, { contentType: file!.type || 'application/octet-stream' })
    if (up.error) { setBusy(false); setError(says(up.error.message)); return }
    const { data, error } = await supabase.rpc('kb_add_document', { p: { ...p, storage_path: path, file_name: file!.name, file_size: file!.size, replaces: mode === 'version' ? doc!.id : null } })
    setBusy(false)
    if (error) { await supabase.storage.from('kb-docs').remove([path]); setError(says(error.message)); return }
    onDone(mode === 'version' ? `Uploaded the new version. It replaces the earlier one once a BSD person checks it.` : `Uploaded ${f.title}. A BSD person (not you) checks it next.`,
      { id: data as string, doc_type: f.doc_type, file: file! })
  }

  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose() }}>
      <div className="card dialog" role="dialog" aria-modal="true" aria-label={title} style={{ maxWidth: 640 }}>
        <h2>{title}</h2>
        {mode !== 'edit' && (
          <label className="field">File
            <input type="file" accept={KB_ACCEPT} onChange={(e) => pick(e.target.files)} />
            <span className="small muted">PDF, image, Word or Excel, up to {fmtNum(KB_MAX_MB)} MB. Stored privately.</span>
          </label>
        )}
        <div className="form-grid">
          <label className="field">{needsInsurer(f.doc_type) ? 'Insurer' : 'Insurer (optional)'}
            <input type="text" list="kb-insurers" value={f.insurer} onChange={(e) => set('insurer', e.target.value)} disabled={mode === 'version'} />
            <datalist id="kb-insurers">{insurers.map((x) => <option key={x} value={x} />)}</datalist>
          </label>
          <label className="field">Product
            <select value={f.product_id} onChange={(e) => set('product_id', e.target.value)}>
              <option value="">All products / not one product</option>
              {plans.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
          <label className="field">Document name
            <input type="text" value={f.title} onChange={(e) => set('title', e.target.value)} />
          </label>
          <label className="field">Document type
            <select value={f.doc_type} onChange={(e) => set('doc_type', e.target.value)}>
              {DOC_TYPES.map((t) => <option key={t}>{t}</option>)}
            </select>
          </label>
          {others && (
            <label className="field" style={{ gridColumn: '1 / -1' }}>Name of this document type
              <input type="text" list="kb-type-names" required maxLength={DOC_TYPE_NAME_MAX} autoFocus placeholder="e.g. Underwriting guide"
                value={f.doc_type_name} onChange={(e) => set('doc_type_name', e.target.value)} />
              <datalist id="kb-type-names">{ownNames.map((x) => <option key={x} value={x} />)}</datalist>
              <span className="small muted">Shown as the document's type in the list and the type filter.</span>
            </label>
          )}
          <label className="field">Version (optional)
            <input type="text" placeholder="e.g. v4.2" value={f.version} onChange={(e) => set('version', e.target.value)} />
          </label>
          <span />
          <label className="field">Effective from
            <input type="date" value={f.effective_from} onChange={(e) => set('effective_from', e.target.value)} />
          </label>
          <label className="field">Valid until (optional)
            <input type="date" value={f.valid_until} onChange={(e) => set('valid_until', e.target.value)} />
          </label>
        </div>
        <p className="small muted" style={{ margin: 0 }}>
          {mode === 'version' ? 'The earlier version stays in use until this one is checked. Product records that name it then get a draft to re-check against the new version.'
            : mode === 'edit' ? 'Changing the details means the document must be checked again.'
            : 'A BSD person who did not upload it checks the details against the file.'}
        </p>
        {error && <div className="error" role="alert">{error}</div>}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn primary" onClick={save} disabled={busy}>{busy ? 'Saving…' : mode === 'edit' ? 'Save' : 'Upload'}</button>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------------------------------------------
// Product records
// ---------------------------------------------------------------------------------------------------------------
export function KbProducts() {
  const people = usePeople()
  const nav = useNavigate()
  const [products, setProducts] = useState<KbProductRow[]>([])
  const [docs, setDocs] = useState<KbDoc[]>([])
  const [usable, setUsable] = useState<Set<string>>(new Set())
  const [loaded, setLoaded] = useState(false)
  useEffect(() => {
    Promise.all([loadProducts(), loadDocs(), loadUsable()]).then(([p, d, u]) => { setProducts(p); setDocs(d); setUsable(u); setLoaded(true) })
  }, [])
  const waiting = products.filter((p) => p.pending_state === 'check').length
  const drafts = products.filter((p) => p.pending_state === 'draft' || (p.status === 'draft' && !p.pending_state)).length
  const offered = products.filter((p) => usable.has(p.id)).length
  const soon = products.filter((p) => usable.has(p.id) && Object.values(p.facts ?? {}).some((f) => {
    const d = docs.find((x) => x.id === f?.doc); const left = daysLeft(d?.valid_until ?? null); return left != null && left <= 40
  })).length
  const docName = (id?: string) => { const d = docs.find((x) => x.id === id); return d ? docLabel(d) : '—' }

  return (
    <main className="page">
      <KbHeader tab="products" actions={<button className="btn primary" onClick={() => nav('/kb/products/new')}>New product record</button>} />
      <div className="stats">
        <div className="card stat"><strong>{fmtNum(offered)}</strong><span className="pill ok">Checked, in Compare products</span></div>
        <div className="card stat"><strong>{fmtNum(waiting)}</strong><span className="pill purple">Waiting for check</span></div>
        <div className="card stat"><strong>{fmtNum(drafts)}</strong><span className="pill info">Drafts</span></div>
        <div className="card stat"><strong>{fmtNum(soon)}</strong><span className="pill warn">Source document expires within 40 days</span></div>
      </div>
      <section className="card" aria-label="Product records">
        <div className="tablewrap">
          <table aria-label="Product records">
            <thead><tr><th>Insurer</th><th>Product</th><th>Status</th><th className="num">Version</th><th>Facts taken from</th><th>Checked by</th><th>In Compare products</th><th><span className="sr-only">Open</span></th></tr></thead>
            <tbody>
              {products.map((p) => {
                const st = productState(p, usable.has(p.id))
                const name = p.status === 'draft' && p.pending ? p.pending.name : p.name
                return (
                  <tr key={p.id}>
                    <td>{p.status === 'draft' && p.pending ? p.pending.insurer : p.insurer}</td>
                    <td><strong>{name}</strong>{p.is_sample && <span className="small muted"> (sample)</span>}</td>
                    <td><span className={`pill ${st.tone}`}>{st.text}</span></td>
                    <td className="num">{p.verified_at ? `v${plain(p.version)}` : '—'}</td>
                    <td className="small">{docName(p.facts?._ps?.doc)}<br />{docName(p.facts?._rs?.doc)}</td>
                    <td className="small">{p.verified_by ? <>{nameOf(people, p.verified_by)}<br />{fmtDate(p.verified_at)}</> : p.verified_at ? fmtDate(p.verified_at) : <span className="muted">Not checked</span>}</td>
                    <td className="small">{usable.has(p.id) ? 'Yes' : <span className="muted">No</span>}</td>
                    <td><Link className="btn small" to={`/kb/products/${p.id}`} aria-label={`Open ${name}`}>Open</Link></td>
                  </tr>
                )
              })}
              {loaded && !products.length && <tr><td colSpan={8} className="muted">No product records yet. Upload the product's documents first, then add its record.</td></tr>}
            </tbody>
          </table>
        </div>
        <p className="small muted" style={{ margin: 0 }}>
          Changes to a checked product are kept as a draft; the checked version stays in Compare products until a BSD person
          who did not make the change checks it.
        </p>
      </section>
    </main>
  )
}
