import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { ageOn, fmtMoney, says } from '../lib/options'
import {
  ACKNOWLEDGEMENT, ALL_TERM_PRODUCTS, AMOUNT_BASES, CLIENT_TYPES, CURRENCIES, DOC_ACCEPT, DOC_MAX_FILES, DOC_MAX_MB, GENDERS,
  INSURERS, MAX_AGE, MIN_AGE, NATIONALITIES, PAYMENT_FREQUENCIES, POLICY_TERMS, PREMIUM_TERMS, RESIDENCIES, RIDERS,
  SAME_AS_POLICY, SMOKER, productsFor,
} from '../lib/formOptions'
import type { PiRequest, RequestDocument } from '../lib/types'
import { Seg } from '../components/ui'
import Files from '../components/Files'
import { uploadDocuments } from '../lib/documents'
import { useAuth } from '../lib/auth'

interface FormState {
  gender: string; client_type: string; residency: string; nationality: string; date_of_birth: string
  insurer: string; product: string; currency: string; amount_basis: 'sum_assured' | 'premium'; amount: string
  smoker: boolean | null; policy_term: string; premium_term: string; premium_type: string; riders: string[]
  compare_term: boolean; compare_product_1: string; compare_product_2: string; remarks: string
}
const DEFAULTS: FormState = {
  gender: '', client_type: '', residency: '', nationality: '', date_of_birth: '',
  insurer: '', product: '', currency: 'SGD', amount_basis: 'sum_assured', amount: '',
  smoker: null, policy_term: '', premium_term: SAME_AS_POLICY, premium_type: 'Annual', riders: [],
  compare_term: false, compare_product_1: '', compare_product_2: '', remarks: '',
}
const pick = (r: PiRequest): FormState => ({
  gender: r.gender ?? '', client_type: r.client_type ?? '', residency: r.residency ?? '', nationality: r.nationality ?? '',
  date_of_birth: r.date_of_birth ?? '', insurer: r.insurer ?? '', product: r.insurer ? r.product : '', currency: r.currency || 'SGD',
  amount_basis: r.amount_basis ?? 'sum_assured', amount: r.amount != null ? String(r.amount) : '', smoker: r.smoker,
  policy_term: r.policy_term ?? '', premium_term: r.premium_term ?? SAME_AS_POLICY, premium_type: r.premium_type || 'Annual',
  riders: r.riders ?? [], compare_term: r.compare_term, compare_product_1: r.compare_product_1 ?? '',
  compare_product_2: r.compare_product_2 ?? '', remarks: r.remarks ?? '',
})
/** A saved value that is no longer in a list still shows (and stays chosen). */
const withValue = (list: string[], v: string) => (v && !list.includes(v) ? [v, ...list] : list)
const FIX_FIELDS = 'Please fix the highlighted fields.'
const fmtSize = (b: number) => (b < 1024 * 1024 ? `${Math.max(1, Math.round(b / 1024))} KB` : `${(b / 1024 / 1024).toFixed(1)} MB`)
const today = () => new Date().toISOString().slice(0, 10)

interface PastClient { client_name: string; contact: string; request: PiRequest }

/** Checks the form the way the database does, plus the lists and limits here. Returns one message per field. */
function validate(f: FormState, client: { client_name: string }): Record<string, string> {
  const e: Record<string, string> = {}
  const need = (k: string, v: unknown, msg: string) => { if (v === '' || v == null) e[k] = msg }
  need('gender', f.gender, 'Choose the gender')
  need('client_name', client.client_name.trim(), 'Enter the client name')
  need('client_type', f.client_type, 'Choose the client type')
  need('residency', f.residency, 'Choose the residency')
  need('nationality', f.nationality, 'Choose the nationality')
  if (f.nationality && !NATIONALITIES.includes(f.nationality) && !e.nationality) e.nationality = 'Pick a nationality from the list'
  need('date_of_birth', f.date_of_birth, 'Enter the date of birth')
  if (f.date_of_birth) {
    const age = ageOn(f.date_of_birth)
    if (f.date_of_birth > today()) e.date_of_birth = 'The date of birth cannot be in the future'
    else if (age == null || age < MIN_AGE || age > MAX_AGE) e.date_of_birth = `Check the date of birth (age ${MIN_AGE} to ${MAX_AGE})`
  }
  need('insurer', f.insurer, 'Choose the insurer')
  need('product', f.product, 'Choose the product')
  need('currency', f.currency, 'Choose the currency')
  const amt = Number(f.amount.replace(/,/g, ''))
  if (!f.amount.trim()) e.amount = 'Enter the sum assured or premium'
  else if (!Number.isFinite(amt) || amt <= 0) e.amount = 'Enter a number above 0'
  if (f.smoker == null) e.smoker = 'Choose smoker or non-smoker'
  need('policy_term', f.policy_term, 'Choose the policy term')
  if (f.compare_term) {
    need('compare_product_1', f.compare_product_1, 'Choose the 1st product to compare')
    if (f.compare_product_2 && f.compare_product_2 === f.compare_product_1) e.compare_product_2 = 'Choose a different product'
  }
  return e
}

export default function RequestForm() {
  const { id } = useParams()
  const [params] = useSearchParams()
  const from = id ? null : params.get('from')
  const nav = useNavigate()
  const { profile } = useAuth()
  const [docs, setDocs] = useState<RequestDocument[]>([])
  const loadDocs = async () => {
    if (!id) return
    const { data } = await supabase.from('request_documents').select('*').eq('request_id', id).order('uploaded_at')
    setDocs((data as RequestDocument[]) ?? [])
  }
  const [ref, setRef] = useState('')
  const [f, setF] = useState<FormState>(DEFAULTS)
  const [client, setClient] = useState({ client_name: '', contact: '' })
  const [copiedFrom, setCopiedFrom] = useState('')
  const [past, setPast] = useState<PastClient[]>([])
  const [files, setFiles] = useState<File[]>([])
  const [fileError, setFileError] = useState('')
  const [dragOver, setDragOver] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [step, setStep] = useState<'edit' | 'review'>('edit')
  const [ack, setAck] = useState(false)
  const [done, setDone] = useState<{ id: string; ref: string; uploadErrors: string[] } | null>(null)
  const [error, setError] = useState('')
  const [ready, setReady] = useState(!id && !from)
  const [saving, setSaving] = useState(false)
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => {
    setF((s) => ({ ...s, [k]: v }))
    setErrors((e) => { if (!e[k]) return e; const n = { ...e }; delete n[k]; return n })
  }

  useEffect(() => {
    if (!id) return
    ;(async () => {
      const { data } = await supabase.from('request_list').select('*').eq('id', id).single()
      if (!data) return
      const r = data as PiRequest
      if (!['submitted', 'sent_back'].includes(r.status)) { nav(`/requests/${r.id}`, { replace: true }); return }
      setRef(r.ref)
      setF(pick(r))
      loadDocs()
      const c = await supabase.from('request_clients').select('*').eq('request_id', id).maybeSingle()
      if (c.data) setClient({ client_name: c.data.client_name, contact: c.data.contact ?? '' })
      setReady(true)
    })()
  }, [id, nav])

  // Duplicate: start a new request from an earlier one (client and policy details, no files).
  useEffect(() => {
    if (!from) return
    ;(async () => {
      const [{ data }, c] = await Promise.all([
        supabase.from('request_list').select('*').eq('id', from).maybeSingle(),
        supabase.from('request_clients').select('*').eq('request_id', from).maybeSingle(),
      ])
      if (data) { const r = data as PiRequest; setF(pick(r)); setCopiedFrom(r.ref) }
      if (c.data) setClient({ client_name: c.data.client_name, contact: c.data.contact ?? '' })
      setReady(true)
    })()
  }, [from])

  // Earlier clients of this introducer, newest request first, to fill the form again quickly.
  useEffect(() => {
    if (id) return
    ;(async () => {
      const [cl, rq] = await Promise.all([
        supabase.from('request_clients').select('request_id, client_name, contact'),
        supabase.from('request_list').select('*').order('submitted_at', { ascending: false }),
      ])
      const byId = new Map(((rq.data as PiRequest[]) ?? []).map((r) => [r.id, r]))
      const seen = new Map<string, PastClient>()
      for (const c of (cl.data ?? []).map((c) => ({ ...c, request: byId.get(c.request_id)! })).filter((c) => c.request)
        .sort((a, b) => b.request.submitted_at.localeCompare(a.request.submitted_at))) {
        const key = c.client_name.trim().toLowerCase()
        if (!seen.has(key)) seen.set(key, { client_name: c.client_name, contact: c.contact ?? '', request: c.request })
      }
      setPast([...seen.values()].sort((a, b) => a.client_name.localeCompare(b.client_name)))
    })()
  }, [id])

  function fillFromPast(name: string) {
    const c = past.find((p) => p.client_name === name)
    if (!c) return
    setClient({ client_name: c.client_name, contact: c.contact })
    setF({ ...pick(c.request), remarks: '' })
    setErrors({})
    setCopiedFrom(c.request.ref)
  }

  function addFiles(list: FileList | null) {
    if (!list?.length) return
    setFileError('')
    const ok: File[] = []
    const allowed = DOC_ACCEPT.split(',')
    for (const file of Array.from(list)) {
      const ext = file.name.toLowerCase().replace(/^.*(\.[^.]+)$/, '$1')
      if (!allowed.includes(ext)) { setFileError(`${file.name}: only PDF, image, Word or Excel files`); continue }
      if (file.size > DOC_MAX_MB * 1024 * 1024) { setFileError(`${file.name} is over ${DOC_MAX_MB} MB`); continue }
      ok.push(file)
    }
    setFiles((cur) => {
      const next = [...cur, ...ok.filter((n) => !cur.some((c) => c.name === n.name && c.size === n.size))]
      if (next.length > DOC_MAX_FILES) setFileError(`At most ${DOC_MAX_FILES} files`)
      return next.slice(0, DOC_MAX_FILES)
    })
    if (fileInput.current) fileInput.current.value = ''
  }

  function review() {
    const e = validate(f, client)
    setErrors(e)
    setError('')
    if (Object.keys(e).length) {
      setError(FIX_FIELDS)
      document.querySelector<HTMLElement>(`[data-field="${Object.keys(e)[0]}"] :is(input,select,button)`)?.focus()
      return
    }
    setAck(false)
    setStep('review')
    window.scrollTo(0, 0)
  }

  async function submit() {
    setSaving(true); setError('')
    const p = {
      ...f, amount: Number(f.amount.replace(/,/g, '')),
      premium_term: f.premium_term || SAME_AS_POLICY,
      compare_product_1: f.compare_term ? f.compare_product_1 : '', compare_product_2: f.compare_term ? f.compare_product_2 : '',
    }
    const res = id
      ? await supabase.rpc('update_request', { p_request: id, p, p_client: client })
      : await supabase.rpc('create_request', { p, p_client: client })
    if (res.error) { setSaving(false); setError(says(res.error.message)); return }
    if (id) { setSaving(false); nav(`/requests/${id}`); return }
    const rid = res.data as string
    const uploadErrors = files.length ? await uploadDocuments(rid, 'attachment', files) : []
    const { data } = await supabase.from('request_list').select('ref').eq('id', rid).maybeSingle()
    setSaving(false)
    setDone({ id: rid, ref: data?.ref ?? '', uploadErrors })
    window.scrollTo(0, 0)
  }

  const products = useMemo(() => withValue(productsFor(f.insurer), f.product), [f.insurer, f.product])
  const mainProduct = f.insurer && f.product ? `${f.insurer} · ${f.product}` : ''
  const compareList = (other: string, v: string) => withValue(ALL_TERM_PRODUCTS.filter((p) => p !== mainProduct && p !== other), v)

  if (!ready) return <div className="empty">Loading…</div>

  if (done) return (
    <main className="page">
      <section className="card" role="status" aria-label="Request submitted">
        <h1 style={{ margin: 0 }}>Request submitted</h1>
        <p style={{ margin: 0 }}>Your reference is <strong className="ref-big">{done.ref}</strong>. Quote it when you contact the ops team.
          You can follow its progress on your board.</p>
        {done.uploadErrors.length > 0 && <div className="error" role="alert">Some files did not upload: {done.uploadErrors.join(' · ')}. Add them again on the request page.</div>}
        <div className="row">
          <Link className="btn primary" to={`/requests/${done.id}`}>Open {done.ref}</Link>
          <Link className="btn" to="/board">Back to board</Link>
        </div>
      </section>
    </main>
  )

  const F = ({ k, label, children }: { k: string; label: string; children: ReactNode }) => (
    <div className={`field${errors[k] ? ' has-error' : ''}`} data-field={k}>
      <label htmlFor={`f-${k}`}>{label}</label>
      {children}
      {errors[k] && <span className="error" id={`e-${k}`}>{errors[k]}</span>}
    </div>
  )
  const sel = (k: keyof FormState, list: string[], placeholder = 'Select') => (
    <select id={`f-${k}`} value={f[k] as string} aria-invalid={!!errors[k]} aria-describedby={errors[k] ? `e-${k}` : undefined}
      onChange={(e) => set(k, e.target.value as never)}>
      <option value="">{placeholder}</option>
      {withValue(list, f[k] as string).map((o) => <option key={o} value={o}>{o}</option>)}
    </select>
  )

  if (step === 'review') {
    const rows: [string, string][] = [
      ['Client name', client.client_name], ['Contact', client.contact || '—'], ['Gender', f.gender], ['Client type', f.client_type],
      ['Residency', f.residency], ['Nationality', f.nationality],
      ['Date of birth', `${f.date_of_birth} (age ${ageOn(f.date_of_birth)})`], ['Insurer', f.insurer], ['Product', f.product],
      ['Currency', f.currency],
      [f.amount_basis === 'premium' ? `Premium (${f.premium_type.toLowerCase()})` : 'Sum assured', fmtMoney(f.currency, Number(f.amount.replace(/,/g, '')))],
      ['Smoker status', f.smoker ? 'Smoker' : 'Non-smoker'], ['Policy term', f.policy_term], ['Premium term', f.premium_term || SAME_AS_POLICY],
      ['Payment frequency', f.premium_type], ['Riders', f.riders.join(', ') || 'None'],
      ['Term product comparison', f.compare_term ? [f.compare_product_1, f.compare_product_2].filter(Boolean).join('; ') : 'No'],
      ['Remarks for ops', f.remarks || '—'],
    ]
    if (!id) rows.push(['Supporting documents', files.map((x) => x.name).join(', ') || 'None'])
    return (
      <main className="page">
        <div>
          <p className="muted small" style={{ margin: 0 }}>{ref ? `Editing ${ref}` : 'New PI request'} · Step 2 of 2</p>
          <h1>Review and submit</h1>
        </div>
        <section className="card" aria-label="Review">
          <table className="facts-table"><tbody>
            {rows.map(([k, v]) => <tr key={k}><th scope="row">{k}</th><td>{v}</td></tr>)}
          </tbody></table>
          <label className="row small" style={{ gap: 8, alignItems: 'flex-start' }}>
            <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} style={{ marginTop: 3 }} />
            <span>{ACKNOWLEDGEMENT}</span>
          </label>
          {error && <div className="error" role="alert">{error}</div>}
          <div className="row">
            <button className="btn primary" onClick={submit} disabled={!ack || saving}>
              {saving ? (files.length && !id ? 'Submitting and uploading…' : 'Saving…') : id ? 'Save changes' : 'Submit request'}</button>
            <button className="btn" onClick={() => { setStep('edit'); setError('') }} disabled={saving}>Back to edit</button>
          </div>
        </section>
      </main>
    )
  }

  return (
    <main className="page">
      <div>
        <p className="muted small" style={{ margin: 0 }}>{ref ? `Editing ${ref}` : copiedFrom ? `New request, copied from ${copiedFrom}` : 'New PI request'}</p>
        <h1>Request a policy illustration</h1>
      </div>

      <section className="card" aria-label="Request form">
        {!id && past.length > 0 && (
          <label className="field" style={{ maxWidth: 420 }}>Previous client (optional)
            <select value="" onChange={(e) => fillFromPast(e.target.value)}>
              <option value="">Choose to fill in their details…</option>
              {past.map((p) => <option key={p.client_name} value={p.client_name}>{p.client_name} (last: {p.request.ref})</option>)}
            </select>
          </label>
        )}
        <p className="small muted" style={{ margin: 0 }}>
          The client's name and contact are seen only by you. Ops and BSD see the other details, which they need to prepare the PIs.
        </p>

        <div className="form-grid">
          {F({ k: 'gender', label: 'Gender', children: sel('gender', GENDERS) })}
          {F({ k: 'client_name', label: 'Client name', children:
            <input id="f-client_name" type="text" value={client.client_name} aria-invalid={!!errors.client_name}
              onChange={(e) => { setClient({ ...client, client_name: e.target.value }); setErrors((x) => ({ ...x, client_name: '' })) }} /> })}
          {F({ k: 'client_type', label: 'Client type', children: sel('client_type', CLIENT_TYPES) })}
          {F({ k: 'residency', label: 'Residency', children: sel('residency', RESIDENCIES) })}
          {F({ k: 'nationality', label: 'Nationality', children: <>
            <input id="f-nationality" type="search" list="nationalities" placeholder="Search" value={f.nationality}
              aria-invalid={!!errors.nationality} autoComplete="off" onChange={(e) => set('nationality', e.target.value)} />
            <datalist id="nationalities">{NATIONALITIES.map((x) => <option key={x} value={x} />)}</datalist>
          </> })}
          {F({ k: 'date_of_birth', label: 'Date of birth', children:
            <input id="f-date_of_birth" type="date" max={today()} value={f.date_of_birth} aria-invalid={!!errors.date_of_birth}
              onChange={(e) => set('date_of_birth', e.target.value)} /> })}
          {F({ k: 'insurer', label: 'Insurer (required)', children:
            <select id="f-insurer" value={f.insurer} aria-invalid={!!errors.insurer}
              onChange={(e) => { set('insurer', e.target.value); set('product', '') }}>
              <option value="">Select</option>
              {withValue(INSURERS, f.insurer).map((o) => <option key={o} value={o}>{o}</option>)}
            </select> })}
          {F({ k: 'product', label: 'Product', children:
            <select id="f-product" value={f.product} disabled={!f.insurer} aria-invalid={!!errors.product} onChange={(e) => set('product', e.target.value)}>
              <option value="">{f.insurer ? 'Select' : 'Choose the insurer first'}</option>
              {products.map((o) => <option key={o} value={o}>{o}</option>)}
            </select> })}
          {F({ k: 'currency', label: 'Currency', children: sel('currency', CURRENCIES) })}
          {F({ k: 'amount', label: 'Sum assured / premium', children: <div className="row" style={{ gap: 8, flexWrap: 'nowrap' }}>
            <select aria-label="Amount is the" value={f.amount_basis} style={{ width: 'auto', flex: '0 0 auto' }}
              onChange={(e) => set('amount_basis', e.target.value as FormState['amount_basis'])}>
              {AMOUNT_BASES.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            <input id="f-amount" type="text" inputMode="decimal" placeholder="Numeric" value={f.amount} aria-invalid={!!errors.amount}
              onChange={(e) => set('amount', e.target.value.replace(/[^\d.,]/g, ''))} />
          </div> })}
        </div>

        <div className="form-grid">
          <div className={`field${errors.smoker ? ' has-error' : ''}`} data-field="smoker">
            <Seg label="Smoker status" value={f.smoker as boolean} onChange={(v) => set('smoker', v)} options={SMOKER} />
            {errors.smoker && <span className="error">{errors.smoker}</span>}
          </div>
          {F({ k: 'policy_term', label: 'Policy term', children: sel('policy_term', POLICY_TERMS) })}
          {F({ k: 'premium_term', label: 'Premium term', children:
            <select id="f-premium_term" value={f.premium_term} onChange={(e) => set('premium_term', e.target.value)}>
              {withValue(PREMIUM_TERMS, f.premium_term).map((o) => <option key={o} value={o}>{o}</option>)}
            </select> })}
          {F({ k: 'premium_type', label: 'Payment frequency', children:
            <select id="f-premium_type" value={f.premium_type} onChange={(e) => set('premium_type', e.target.value)}>
              {withValue(PAYMENT_FREQUENCIES, f.premium_type).map((o) => <option key={o} value={o}>{o}</option>)}
            </select> })}
        </div>
        <fieldset className="field riders" data-field="riders">
          <legend>Riders (optional)</legend>
          <div className="row" style={{ gap: '8px 20px' }}>
            {RIDERS.concat(f.riders.filter((x) => !RIDERS.includes(x))).map((x) => (
              <label key={x} className="row small" style={{ gap: 6 }}>
                <input type="checkbox" checked={f.riders.includes(x)}
                  onChange={(e) => set('riders', e.target.checked ? [...f.riders, x] : f.riders.filter((y) => y !== x))} /> {x}
              </label>
            ))}
          </div>
        </fieldset>

        <div className="compare-box">
          <label className="row" style={{ gap: 8, fontWeight: 500 }}>
            <input type="checkbox" checked={f.compare_term} onChange={(e) => set('compare_term', e.target.checked)} />
            Term Product Comparison Request
          </label>
          <span className="small muted">Compare this product with up to 2 other term products (3 in all). Ops send back a PI for each, plus the comparison table.</span>
          {f.compare_term && (
            <div className="form-grid">
              {F({ k: 'compare_product_1', label: 'Term Product Name – 1st Product', children:
                <select id="f-compare_product_1" value={f.compare_product_1} aria-invalid={!!errors.compare_product_1}
                  onChange={(e) => set('compare_product_1', e.target.value)}>
                  <option value="">Select</option>
                  {compareList(f.compare_product_2, f.compare_product_1).map((o) => <option key={o} value={o}>{o}</option>)}
                </select> })}
              {F({ k: 'compare_product_2', label: 'Term Product Name – 2nd Product (optional)', children:
                <select id="f-compare_product_2" value={f.compare_product_2} aria-invalid={!!errors.compare_product_2}
                  onChange={(e) => set('compare_product_2', e.target.value)}>
                  <option value="">Select</option>
                  {compareList(f.compare_product_1, f.compare_product_2).map((o) => <option key={o} value={o}>{o}</option>)}
                </select> })}
            </div>
          )}
        </div>

        <div className="form-grid">
          {F({ k: 'contact', label: 'Client contact (optional, only you see it)', children:
            <input id="f-contact" type="text" value={client.contact} onChange={(e) => setClient({ ...client, contact: e.target.value })} /> })}
        </div>
        {F({ k: 'remarks', label: 'Remarks for ops (optional)', children:
          <textarea id="f-remarks" rows={3} value={f.remarks} onChange={(e) => set('remarks', e.target.value)}
            placeholder="Anything ops should know. Do not put the client's name here: ops can see this box." /> })}

        {id && profile ? (
          <Files title="Supporting documents" hint="Add or remove files before you save." requestId={id} kind="attachment" docs={docs}
            canUpload userId={profile.id} onChange={loadDocs} />
        ) : (
          <div className="field" data-field="files">
            <span className="label">Supporting documents (optional)</span>
            <div className={`dropzone${dragOver ? ' over' : ''}`}
              onDragOver={(e) => { e.preventDefault(); setDragOver(true) }} onDragLeave={() => setDragOver(false)}
              onDrop={(e) => { e.preventDefault(); setDragOver(false); addFiles(e.dataTransfer.files) }}>
              <span>Drag files here or</span>
              <button type="button" className="linkbtn" onClick={() => fileInput.current?.click()}>browse</button>
              <input ref={fileInput} type="file" multiple accept={DOC_ACCEPT} hidden aria-label="Upload supporting documents"
                onChange={(e) => addFiles(e.target.files)} />
              <span className="small muted" style={{ width: '100%' }}>PDF, image, Word or Excel, up to {DOC_MAX_MB} MB each, {DOC_MAX_FILES} files at most. Stored privately; only you, ops and BSD can open them.</span>
            </div>
            {fileError && <span className="error" role="alert">{fileError}</span>}
            {files.length > 0 && (
              <ul className="filelist">
                {files.map((x) => (
                  <li key={x.name + x.size}><span>{x.name} <span className="small muted">· {fmtSize(x.size)}</span></span>
                    <button type="button" className="linkbtn danger" onClick={() => setFiles((c) => c.filter((y) => y !== x))}>Remove</button></li>
                ))}
              </ul>
            )}
          </div>
        )}

        {error && !(error === FIX_FIELDS && !Object.values(errors).some(Boolean)) && <div className="error" role="alert">{error}</div>}
        <div className="row">
          <button className="btn primary" onClick={review}>Review and submit</button>
          <button className="btn" onClick={() => nav(-1)}>Cancel</button>
        </div>
      </section>
    </main>
  )
}
