// Knowledge Hub module: the Knowledge Bank's documents and product records.
// Ops and BSD keep it (upload, edit). No check step: an upload is in use at once, and a Product Summary or rate sheet
// is read into a product record that is searchable straight away. Introducers given the module see current documents.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { nameOf, usePeople } from '../lib/people'
import { fmtDate, says } from '../lib/options'
import { STANDARD_INSURERS } from '../lib/formOptions'
import { FINANCING_DOC, afterRead, aiAskCount, fillWithAi, readUpload, readingLine, readName, readInsurer, readsInto, saveReading, READ_TYPES, type Reading } from '../lib/kbAuto'
import { FINANCING, GROUPS, PLAN_TYPES, groupLabel, groupOf, isFinancing, planKey, planLabel, plansIn } from '../lib/families'
import {
  DOC_TYPES, DOC_TYPE_NAME_MAX, KB_ACCEPT, OTHERS, docTypeName, hasProduct, needsInsurer, KB_MAX_MB, daysLeft, docLabel, docInSearch, docState, loadDocs, loadProducts, loadUsable, openDoc, productState, whyNotSearchable,
  type KbDoc, type KbProductRow,
} from '../lib/kbAdmin'
import { fmtNum, plain } from '../lib/num'
import { AI_MODELS } from '../lib/aiConfig'

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
            A Product Summary or rate sheet you upload is read into a product record that Compare products and the
            Product Comparison Matrix can find straight away.
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
  const [usable, setUsable] = useState<Set<string>>(new Set())
  const [loaded, setLoaded] = useState(false)
  const [q, setQ] = useState('')
  const [type, setType] = useState('')
  const [older, setOlder] = useState(false)
  const [grp, setGrp] = useState('All')     // Insurance / Investment
  const [ptype, setPtype] = useState('All') // plan type
  const [dialog, setDialog] = useState<{ mode: 'new' | 'version' | 'edit'; doc?: KbDoc } | null>(null)
  const [made, setMade] = useState<{ id: string; searchable: boolean } | null>(null)
  const [msg, setMsg] = useState('')
  const [error, setError] = useState('')
  const reload = useCallback(async () => {
    const [d, p, u] = await Promise.all([loadDocs(), member ? loadProducts() : Promise.resolve([]), member ? loadUsable() : Promise.resolve(new Set<string>())])
    setDocs(d); setProducts(p); setUsable(u); setLoaded(true)
  }, [member])
  useEffect(() => { reload() }, [reload])

  // A document's product record: the one it was filed with, else the one its facts were read into.
  const productOf = (d: KbDoc) => (d.product_id ? products.find((p) => p.id === d.product_id)
    : products.find((p) => Object.values(p.facts ?? {}).some((f) => f?.doc === d.id)))
  const planOfDoc = (d: KbDoc) => (productOf(d) ? planKey(productOf(d)!.product_type) : d.plan_type && hasProduct(d.doc_type) ? planKey(d.plan_type) : '')
  const productName = (d: KbDoc) => (productOf(d)?.name ?? (d.product_id ? '—' : !hasProduct(d.doc_type) ? '—' : d.plan_type ? `All ${planLabel(d.plan_type)} products` : 'All products'))
  const ownNames = customTypeNames(docs)
  const typeMatch = (d: KbDoc) => !type || (type === ANY_OTHERS ? d.doc_type === OTHERS : docTypeName(d) === type)
  // A document's category is its product's, or the category it was uploaded for ("All Universal life (inv) products").
  const planMatch = (d: KbDoc) => (grp === 'All' && ptype === 'All') || (!!planOfDoc(d) && (grp === 'All' || groupOf(planOfDoc(d)) === grp)
    && (ptype === 'All' || planOfDoc(d) === ptype))
  const shown = docs.filter((d) => (older || !d.replaced_by) && typeMatch(d) && planMatch(d)
    && (!q || `${d.title} ${d.insurer} ${productName(d)} ${docTypeName(d)} ${d.file_name ?? ''}`.toLowerCase().includes(q.toLowerCase())))

  const [busyRead, setBusyRead] = useState('')
  /** Reads a listed Product Summary or rate sheet again into its product record. */
  async function reread(d: KbDoc) {
    setError(''); setMsg(''); setMade(null); setBusyRead(d.id)
    const dl = d.storage_path ? await supabase.storage.from('kb-docs').download(d.storage_path) : null
    if (!dl?.data) { setBusyRead(''); setError(dl?.error?.message ?? 'This document has no file.'); return }
    const r = await readUpload(await dl.data.arrayBuffer(), d.file_name ?? '', d.doc_type)
    // A financing document linked to a policy's record (e.g. "financing for this UL plan") makes its own record.
    const own = productOf(d) && (d.doc_type !== FINANCING_DOC || isFinancing(productOf(d)!.product_type)) ? productOf(d) : undefined
    const name = own?.name || readName(r) || d.title
    const res = await saveReading(d.id, r, { product_id: own?.id ?? null, insurer: d.insurer || readInsurer(r), name, product_type: own ? planKey(own.product_type) : undefined })
    setBusyRead('')
    if ('error' in res && res.error) { setError(says(res.error)); return }
    if ('skipped' in res && res.skipped) { setMsg(res.skipped); return }
    const ok = res as { id: string; missing: string[]; searchable: boolean }
    setMsg(`${readingLine(r)} ${afterRead(ok, !!r.financing)}`); setMade({ id: ok.id, searchable: ok.searchable || !!r.financing }); reload()
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
          {member && <PlanFilters grp={grp} ptype={ptype} setGrp={setGrp} setPtype={setPtype} />}
          {member && <label className="row small" style={{ gap: 6 }}><input type="checkbox" checked={older} onChange={(e) => setOlder(e.target.checked)} /> Show older versions</label>}
        </div>
        {msg && <div className={`notice ${made && !made.searchable ? 'warn' : 'ok'}`} role="status">{msg}
          {made && <> <Link to={`/kb/products/${made.id}`}>Open the product record</Link>{made.searchable ? ' to review or change it (optional).' : ' to fill in what is missing.'}</>}</div>}
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
                    <td className="small">{productName(d)}{productOf(d) && <div className="muted">{planLabel(productOf(d)!.product_type)}</div>}</td>
                    <td className="small">{docTypeName(d)}</td>
                    <td className="small">{fmtDate(d.effective_from)}</td>
                    <td className="small">{d.valid_until ? fmtDate(d.valid_until) : 'No end date'}</td>
                    <td><span className={`pill ${st.tone}`}>{st.text}</span>
                      {member && (() => {
                        const m = docInSearch(d, productOf(d), !!productOf(d) && usable.has(productOf(d)!.id), readsInto(d.doc_type, d.file_name))
                        return m && <div style={{ marginTop: 4 }} aria-label="In the matrix?"><span className={`pill ${m.tone}`}>{m.text}</span>
                          {m.why && <div className="small muted" style={{ maxWidth: 260 }}>{m.why}</div>}</div>
                      })()}</td>
                    {member && <td className="small">{d.uploaded_by ? nameOf(people, d.uploaded_by) : 'Sample'}</td>}
                    {member && (
                      <td><div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                        {!d.replaced_by && <button className="btn small" onClick={() => setDialog({ mode: 'version', doc: d })}>New version</button>}
                        {!d.replaced_by && <button className="btn small" onClick={() => setDialog({ mode: 'edit', doc: d })}>Edit</button>}
                        {!d.replaced_by && readsInto(d.doc_type, d.file_name) && <button className="btn small" disabled={!!busyRead}
                          title="Read this document again into its product record" onClick={() => reread(d)}>{busyRead === d.id ? 'Reading…' : 'Read again'}</button>}
                        {(mine || checker) && <button className="linkbtn danger" onClick={() => remove(d)}>Remove</button>}
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
          {member ? 'Uploads are in use at once. A new version replaces the earlier one straight away and is read into the product records that named it. When a document passes its valid-until date, products that rely on it drop out of Compare products.'
            : 'Current insurer documents. Open one to read it.'}
        </p>
      </section>
      {dialog && <DocDialog mode={dialog.mode} doc={dialog.doc} docs={docs} products={products}
        onClose={() => setDialog(null)} onDone={(m, c) => { setDialog(null); setMsg(m); setMade(c?.product ? { id: c.product, searchable: !!c.searchable } : null); setError(''); reload() }} />}
    </main>
  )
}

/** Insurance (ins) / Investment (inv) and plan type filters, shared by the Documents and Product records tabs. */
export function PlanFilters({ grp, ptype, setGrp, setPtype }: { grp: string; ptype: string; setGrp: (g: string) => void; setPtype: (t: string) => void }) {
  return <>
    <select aria-label="Insurance or investment" value={grp} style={{ flex: '0 1 190px', width: 'auto' }}
      onChange={(e) => { setGrp(e.target.value); if (e.target.value !== 'All' && ptype !== 'All' && groupOf(ptype) !== e.target.value) setPtype('All') }}>
      <option value="All">Insurance and investment</option>
      {GROUPS.map((g) => <option key={g} value={g}>{groupLabel(g)}</option>)}
    </select>
    <select aria-label="Plan type" value={ptype} style={{ flex: '0 1 240px', width: 'auto' }} onChange={(e) => setPtype(e.target.value)}>
      <option value="All">All plan types</option>
      {plansIn(grp).map((t) => <option key={t.key} value={t.key}>{planLabel(t.key)}</option>)}
    </select>
  </>
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
export const FILLS = READ_TYPES
/** An upload: the document, and the product record it was read into (if it is a Product Summary or rate sheet). */
export interface Created { id: string; doc_type: string; file: File; product?: string; searchable?: boolean }


export function DocDialog({ mode, doc, docs, products, preset, read = true, onClose, onDone }: {
  mode: 'new' | 'version' | 'edit'; doc?: KbDoc; docs: KbDoc[]; products: KbProductRow[]
  /** For an upload started from a product record: the type and insurer to start with. */
  preset?: { doc_type?: string; insurer?: string; product_id?: string }
  /** Read a Product Summary or rate sheet into its product record on upload (the record page reads it into its form instead). */
  read?: boolean
  onClose: () => void; onDone: (msg: string, created?: Created) => void
}) {
  const [file, setFile] = useState<File | null>(null)
  const [f, setF] = useState({
    insurer: doc?.insurer ?? preset?.insurer ?? '', product_id: doc?.product_id ?? preset?.product_id ?? '', title: doc?.title ?? '',
    doc_type: doc?.doc_type ?? preset?.doc_type ?? 'Product Summary', doc_type_name: doc?.doc_type_name ?? '',
    version: mode === 'edit' ? doc?.version ?? '' : '', effective_from: mode === 'edit' ? doc?.effective_from ?? '' : '',
    valid_until: mode === 'edit' ? doc?.valid_until ?? '' : '',
  })
  const [newName, setNewName] = useState('')        // the product name for a new product record
  // The plan type (product category): the chosen product's, else what the reader found, else what the person picks.
  const startProduct = products.find((p) => p.id === (doc?.product_id ?? preset?.product_id))
  const [plan, setPlan] = useState(startProduct ? planKey(startProduct.product_type) : doc?.plan_type ? planKey(doc.plan_type)
    : (doc?.doc_type ?? preset?.doc_type) === FINANCING_DOC ? FINANCING : '')
  const [planTouched, setPlanTouched] = useState(false)
  // Whether the person (or the page that opened this) chose the product, not the reader.
  const [productTouched, setProductTouched] = useState(!!(doc?.product_id ?? preset?.product_id))
  const [reading, setReading] = useState<Reading | null>(null)
  const [progress, setProgress] = useState('')
  const [aiError, setAiError] = useState('')
  const [busy, setBusy] = useState(false)
  // The AI helper's model is large: free its memory when the dialog closes.
  useEffect(() => () => { import('../lib/aiModel').then((m) => m.releaseAi()).catch(() => {}) }, [])
  const [error, setError] = useState('')
  const set = (k: keyof typeof f, v: string) => setF((s) => ({ ...s, [k]: v }))
  const insurers = useMemo(() => [...new Set([...products.map((p) => p.insurer), ...docs.map((d) => d.insurer), ...STANDARD_INSURERS])], [products, docs])
  // The product field shows only for document types that belong to a product.
  const withProduct = hasProduct(f.doc_type)
  // The Product field: the 12 categories as headings, each with that category's product records (of this insurer) under it.
  const plans = products.filter((p) => !f.insurer.trim() || p.insurer.toLowerCase() === f.insurer.trim().toLowerCase() || p.id === f.product_id)
  const productValue = f.product_id || (plan ? `cat:${plan}` : '')
  function pickProduct(v: string) {
    setProductTouched(true); setPlanTouched(true)
    if (v.startsWith('cat:')) { set('product_id', ''); setPlan(v.slice(4)); return }
    set('product_id', v)
    const p = products.find((x) => x.id === v)
    setPlan(p ? planKey(p.product_type) : '')
  }
  const others = f.doc_type === OTHERS
  const ownNames = useMemo(() => customTypeNames(docs), [docs])
  const title = mode === 'new' ? 'Upload document' : mode === 'version' ? `New version of ${doc!.title}` : `Edit ${doc!.title}`
  // A Product Summary or rate sheet is read into a product record on upload: an existing one, or a new one by name.
  // A financing document is read only into a Premium financing record (or a new one), never into a policy's record.
  const pickedRecord = products.find((p) => p.id === (mode === 'version' ? doc?.product_id : f.product_id))
  const reads = read && mode !== 'edit' && !!file && readsInto(f.doc_type, file.name)
    && !(f.doc_type === FINANCING_DOC && pickedRecord && !isFinancing(pickedRecord.product_type))
    && !(f.doc_type === FINANCING_DOC && !pickedRecord && plan && !isFinancing(plan))
  const target = mode === 'version' ? (doc?.product_id ?? '') : f.product_id
  const needName = reads && mode === 'new' && !target

  async function askAi() {
    if (!reading) return
    setAiError('')
    setProgress('Starting the free AI helper…')
    try {
      const r = await fillWithAi(reading, setProgress)
      setReading(r)
      if (!r.ai?.length) setAiError('The AI helper found nothing more that passed the checks against the document, so those details stay blank.')
    } catch (e) {
      setAiError(`The AI helper could not run in this browser: ${e instanceof Error ? e.message : String(e)}. What the reader found is kept.`)
    } finally {
      setProgress('')
    }
  }

  async function readPicked(x: File, type: string) {
    setReading(null); setAiError('')
    if (!read || mode === 'edit' || !readsInto(type, x.name)) return
    setProgress(`Reading ${x.name}…`)
    const r = await readUpload(await x.arrayBuffer(), x.name, type, setProgress)
    setProgress(''); setReading(r)
    const ins = readInsurer(r), nm = readName(r)
    setF((s) => {
      const next = { ...s }
      if (!next.insurer.trim() && ins) next.insurer = ins
      // An existing record with the name read is picked for you.
      const match = nm && products.find((p) => p.insurer.toLowerCase() === next.insurer.trim().toLowerCase() && p.name.toLowerCase() === nm.toLowerCase())
      if (match && !next.product_id) next.product_id = match.id
      return next
    })
    if (r.summary?.planType) setPlan((p) => (planTouched && p ? p : r.summary!.planType))
    // A monthly rate sheet says which month it is for: its dates, so out-of-date rates show as out of date.
    const fin = r.financing
    if (fin) setF((s) => ({ ...s, effective_from: s.effective_from || fin.effectiveFrom || '', valid_until: s.valid_until || fin.validUntil || '', version: s.version || fin.version || '' }))
    setNewName((n) => n || nm || x.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').replace(/\s*(product summary|rates?|rate sheet)\s*$/i, '').trim())
  }

  function pick(list: FileList | null) {
    const x = list?.[0]
    setError('')
    if (!x) return
    const ext = x.name.toLowerCase().replace(/^.*(\.[^.]+)$/, '$1')
    if (!KB_ACCEPT.split(',').includes(ext)) { setError('Choose a PDF, image, Word or Excel file'); return }
    if (x.size > KB_MAX_MB * 1024 * 1024) { setError(`The file is over ${fmtNum(KB_MAX_MB)} MB`); return }
    setFile(x)
    if (!f.title) set('title', x.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' '))
    readPicked(x, f.doc_type)
  }
  function setType(t: string) {
    set('doc_type', t)
    // Product Financing documents go under Premium financing unless the person picked something else.
    if (t === FINANCING_DOC && !planTouched && !f.product_id) setPlan(FINANCING)
    else if (t !== FINANCING_DOC && !planTouched && plan === FINANCING) setPlan('')
    // A category or product the reader guessed from the file does not carry over to a type that is not read
    // (e.g. a bank's Product Financing rates): it starts at "All products" until the person picks.
    if (file && !readsInto(t, file.name) && mode === 'new') {
      if (!planTouched) setPlan('')
      if (!productTouched) set('product_id', '')
    }
    if (file) readPicked(file, t)
  }

  async function save() {
    setError('')
    if (mode !== 'edit' && !file) { setError('Choose a file'); return }
    if (others && !f.doc_type_name.trim()) { setError('Type a name for the document type'); return }
    if (needName && !newName.trim()) { setError('Fill in the product name (or choose the product record it belongs to)'); return }
    if (needName && !plan) { setError('In the Product field, choose the category of the new product record (or the product record it belongs to)'); return }
    if (progress) { setError('Wait until the file has been read'); return }
    setBusy(true)
    const p = { ...f, product_id: (withProduct && f.product_id) || null, plan_type: (withProduct && !f.product_id && plan) || null, valid_until: f.valid_until || null, doc_type_name: others ? f.doc_type_name.trim() : null }
    if (mode === 'edit') {
      const { error } = await supabase.rpc('kb_update_document', { p_id: doc!.id, p })
      setBusy(false)
      if (error) { setError(says(error.message)); return }
      onDone(`Saved ${f.title}.`)
      return
    }
    const path = `${crypto.randomUUID()}/${file!.name.replace(/[^\w.-]+/g, '_')}`
    const up = await supabase.storage.from('kb-docs').upload(path, file!, { contentType: file!.type || 'application/octet-stream' })
    if (up.error) { setBusy(false); setError(says(up.error.message)); return }
    const { data, error } = await supabase.rpc('kb_add_document', { p: { ...p, storage_path: path, file_name: file!.name, file_size: file!.size, replaces: mode === 'version' ? doc!.id : null } })
    if (error) { setBusy(false); await supabase.storage.from('kb-docs').remove([path]); setError(says(error.message)); return }
    const id = data as string
    const created: Created = { id, doc_type: f.doc_type, file: file! }
    let msg = mode === 'version' ? `Uploaded the new version of ${doc!.title}. It is in use now.` : `Uploaded ${f.title}.`
    if (reads) {
      const r = reading ?? await readUpload(await file!.arrayBuffer(), file!.name, f.doc_type)
      const name = products.find((x) => x.id === target)?.name || newName.trim() || readName(r) || f.title
      const res = await saveReading(id, r, { product_id: target || null, insurer: f.insurer || doc?.insurer || '', name, product_type: plan || undefined })
      if ('error' in res && res.error) msg += ` It could not be read into a product record: ${says(res.error)}`
      else if ('skipped' in res && res.skipped) msg += ` ${res.skipped}`
      else {
        const ok = res as { id: string; missing: string[]; searchable: boolean }
        created.product = ok.id; created.searchable = ok.searchable
        msg += ` ${readingLine(r)} ${afterRead(ok, !!r.financing)}`
        if (r.financing) created.searchable = true
      }
    }
    setBusy(false)
    onDone(msg, created)
  }

  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose() }}>
      <div className="card dialog" role="dialog" aria-modal="true" aria-label={title} style={{ maxWidth: 640 }}>
        <h2>{title}</h2>
        {mode !== 'edit' && (
          <label className="field">File
            <input type="file" accept={KB_ACCEPT} onChange={(e) => pick(e.target.files)} />
            {file && <span className="small filename">{file.name}</span>}
            <span className="small muted">PDF, image, Word or Excel, up to {fmtNum(KB_MAX_MB)} MB. Stored privately.</span>
          </label>
        )}
        <div className="form-grid">
          <label className="field">{needsInsurer(f.doc_type) ? 'Insurer' : 'Insurer (optional)'}
            <input type="text" list="kb-insurers" value={f.insurer} onChange={(e) => set('insurer', e.target.value)} disabled={mode === 'version'} />
            <datalist id="kb-insurers">{insurers.map((x) => <option key={x} value={x} />)}</datalist>
          </label>
          <label className="field">Document type
            <select value={f.doc_type} onChange={(e) => setType(e.target.value)}>
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
          {withProduct && <>
            <label className="field" style={{ gridColumn: '1 / -1' }}>Product
              <select aria-label="Product" value={productValue} onChange={(e) => pickProduct(e.target.value)} disabled={mode === 'version' && reads}>
                <option value="">{needName ? 'Choose the category of the new product record, or its product' : 'All products / not one product'}</option>
                {PLAN_TYPES.map((t) => (
                  <optgroup key={t.key} label={planLabel(t.key)}>
                    <option value={`cat:${t.key}`}>{reads && mode === 'new' ? `New product record: ${planLabel(t.key)}` : `All ${planLabel(t.key)} products`}</option>
                    {plans.filter((p) => planKey(p.product_type) === t.key).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </optgroup>
                ))}
              </select>
              <span className="small muted">{f.product_id ? `${planLabel(plan)} product record.`
                : plan && reads && mode === 'new' ? `A new ${planLabel(plan)} product record is made from the file${reading?.summary?.planType === plan && !planTouched ? ' (category as the document says; change it here if it is wrong)' : ''}.`
                : plan ? `For every ${planLabel(plan)} product, not one product record.`
                : 'Categories are the headings; pick a category for a document about all its products, or a product record under it.'}</span>
            </label>
            {needName && (
              <div className="field" style={{ gridColumn: '1 / -1' }}>
                <label htmlFor="kb-new-name">Product name (new product record)</label>
                <input id="kb-new-name" type="text" value={newName} onChange={(e) => setNewName(e.target.value)} />
                <span className="small muted">Read from the file where it says so. A record with the same insurer and name is updated instead of making a second one.</span>
              </div>
            )}
          </>}
          <label className="field">Document name
            <input type="text" value={f.title} onChange={(e) => set('title', e.target.value)} />
          </label>
          <label className="field">Version (optional)
            <input type="text" placeholder="e.g. v4.2" value={f.version} onChange={(e) => set('version', e.target.value)} />
          </label>
          <label className="field">Effective from
            <input type="date" value={f.effective_from} onChange={(e) => set('effective_from', e.target.value)} />
          </label>
          <label className="field">Valid until (optional)
            <input type="date" value={f.valid_until} onChange={(e) => set('valid_until', e.target.value)} />
          </label>
        </div>
        {progress && <div className="notice" role="status">{progress}</div>}
        {reads && reading && !progress && <div className="notice filename" role="status">{readingLine(reading)}</div>}
        {reads && reading && !progress && aiAskCount(reading) > 0 && (
          <div className="row small" style={{ gap: 8 }}>
            <button type="button" className="btn small" onClick={askAi} disabled={busy}
              title={`A free, open AI model runs in this browser: the document never leaves this computer. It is asked only about what the reader missed, must quote the document for every answer, and anything it gives that is not in the document is dropped. The first time, the browser downloads the model (about ${fmtNum(AI_MODELS.small.mb / 1000, 1)}–${fmtNum(AI_MODELS.gpu.mb / 1000, 1)} GB) and keeps it.`}>
              Ask the free AI helper about {plain(aiAskCount(reading))} detail{aiAskCount(reading) === 1 ? '' : 's'} the reader missed</button>
            <span className="muted">Optional. Runs in your browser, nothing is sent. Values it fills are marked "AI".</span>
          </div>
        )}
        {aiError && !progress && <div className="notice warn" role="status">{aiError}</div>}
        <p className="small muted" style={{ margin: 0 }}>
          {reads && f.doc_type === FINANCING_DOC ? 'On upload, what was read goes on a Premium financing product record (the bank as the lender), marked "Auto-read, not yet reviewed". Premium financing is kept in the Knowledge Bank and not offered in Compare products for now.'
            : f.doc_type === FINANCING_DOC && file && mode !== 'edit' && !reads ? 'This financing document is filed with the policy record or category chosen and is not read. To read it into a Premium financing record, choose Premium financing in the Product field.'
            : reads ? 'On upload, what was read goes on the product record and the product can be found in Compare products straight away, marked "Auto-read, not yet reviewed". Reviewing or changing the record afterwards is optional.'
            : mode === 'version' ? 'The new version replaces this one as soon as it is uploaded.'
            : mode === 'edit' ? 'The changes apply at once.'
            : 'The document is in use as soon as it is uploaded.'}
        </p>
        {error && <div className="error" role="alert">{error}</div>}
        <div className="row dialog-foot" style={{ justifyContent: 'flex-end' }}>
          <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn primary" onClick={save} disabled={busy || !!progress}>{busy ? 'Saving…' : mode === 'edit' ? 'Save' : 'Upload'}</button>
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
  const [grp, setGrp] = useState('All')
  const [ptype, setPtype] = useState('All')
  useEffect(() => {
    Promise.all([loadProducts(), loadDocs(), loadUsable()]).then(([p, d, u]) => { setProducts(p); setDocs(d); setUsable(u); setLoaded(true) })
  }, [])
  const offered = products.filter((p) => usable.has(p.id)).length
  const auto = products.filter((p) => usable.has(p.id) && p.auto_read).length
  const notIn = products.filter((p) => !usable.has(p.id) && p.status !== 'withdrawn' && !isFinancing(p.product_type)).length
  const loans = products.filter((p) => isFinancing(p.product_type) && p.status !== 'withdrawn').length
  const soon = products.filter((p) => usable.has(p.id) && Object.values(p.facts ?? {}).some((f) => {
    const d = docs.find((x) => x.id === f?.doc); const left = daysLeft(d?.valid_until ?? null); return left != null && left <= 40
  })).length
  const listed = products.filter((p) => (grp === 'All' || groupOf(p.product_type) === grp) && (ptype === 'All' || planKey(p.product_type) === ptype))
  const docName = (id?: string) => { const d = docs.find((x) => x.id === id); return d ? docLabel(d) : '—' }

  return (
    <main className="page">
      <KbHeader tab="products" actions={<button className="btn primary" onClick={() => nav('/kb/products/new')}>New product record</button>} />
      <div className="stats">
        <div className="card stat"><strong>{fmtNum(offered)}</strong><span className="pill ok">In search (Compare products)</span></div>
        <div className="card stat"><strong>{fmtNum(auto)}</strong><span className="pill warn">Auto-read, not yet reviewed</span></div>
        <div className="card stat"><strong>{fmtNum(notIn)}</strong><span className="pill bad">Not searchable</span></div>
        <div className="card stat"><strong>{fmtNum(soon)}</strong><span className="pill warn">Source document expires within 40 days</span></div>
        {loans > 0 && <div className="card stat"><strong>{fmtNum(loans)}</strong><span className="pill info">Premium financing (kept, not in search)</span></div>}
      </div>
      <section className="card" aria-label="Product records">
        <div className="row" style={{ gap: 12 }}>
          <PlanFilters grp={grp} ptype={ptype} setGrp={setGrp} setPtype={setPtype} />
          <span className="small muted" aria-live="polite">{fmtNum(listed.length)} of {fmtNum(products.length)} product record{products.length === 1 ? '' : 's'}</span>
        </div>
        <div className="tablewrap">
          <table aria-label="Product records">
            <thead><tr><th>Insurer</th><th>Product</th><th>Product category</th><th>Status</th><th className="num">Version</th><th>Facts taken from</th><th>Last saved by</th><th><span className="sr-only">Open</span></th></tr></thead>
            <tbody>
              {listed.map((p) => {
                const st = productState(p, usable.has(p.id), docs)
                const why = whyNotSearchable(p, usable.has(p.id))
                return (
                  <tr key={p.id}>
                    <td>{p.insurer}</td>
                    <td><strong>{p.name}</strong>{p.is_sample && <span className="small muted"> (sample)</span>}</td>
                    <td className="small">{planLabel(p.product_type)}</td>
                    <td><span className={`pill ${st.tone}`}>{st.text}</span>{why && p.status !== 'withdrawn' && <div className="small muted" style={{ maxWidth: 320 }}>{why}</div>}</td>
                    <td className="num">{p.verified_at ? `v${plain(p.version)}` : '—'}</td>
                    <td className="small">{docName(p.facts?._ps?.doc)}<br />{docName(p.facts?._rs?.doc ?? p.facts?._cof?.doc)}</td>
                    <td className="small">{p.verified_by ? <>{nameOf(people, p.verified_by)}<br />{fmtDate(p.verified_at)}</> : p.auto_read ? <>Read from the document<br />{fmtDate(p.verified_at)}</> : p.verified_at ? fmtDate(p.verified_at) : <span className="muted">—</span>}</td>
                    <td><Link className="btn small" to={`/kb/products/${p.id}`} aria-label={`Open ${p.name}`}>Open</Link></td>
                  </tr>
                )
              })}
              {loaded && !products.length && <tr><td colSpan={8} className="muted">No product records yet. Upload a Product Summary on the Documents tab: it is read into a product record for you.</td></tr>}
              {loaded && products.length > 0 && !listed.length && <tr><td colSpan={8} className="muted">No product records of this kind.</td></tr>}
            </tbody>
          </table>
        </div>
        <p className="small muted" style={{ margin: 0 }}>
          A product is in search as soon as its Product Summary (or rate sheet) is uploaded and its policy currency and entry ages are known.
          Reviewing or changing the record is optional; saving a change puts it in search at once and keeps the earlier version in the history.
          Premium financing records (read from a bank's Product Financing document) are kept here with their rates but are not offered in Compare products for now.
        </p>
      </section>
    </main>
  )
}
