// The introducer's PI request form: the deck's wireframe 2 (field numbers match it), plus smoker status, coverage
// term and critical illness (Kumar, 22 Nov 2026). The optional Term Product Comparison Request opens the
// Product Matrix pop-up (wireframes 4 and 5) to pick 2 or 3 Knowledge Bank products.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { ageOn, dobDmy, isoToday, COVERAGE_TERMS, GENDERS, says } from '../lib/options'
import {
  ACKNOWLEDGEMENT, AMOUNT_BASES, CLIENT_TYPES, CURRENCIES, DOC_ACCEPT, DOC_MAX_MB, NATIONALITIES, OTHER_PLAN, RESIDENCIES,
  STANDARD_INSURERS, fmtMoney, vipName,
} from '../lib/formOptions'
import { loadKb, productLabel, type Kb, type Needs } from '../lib/kb'
import type { PiRequest, RequestDocument } from '../lib/types'
import { Seg } from '../components/ui'
import Files from '../components/Files'
import ProductMatrix from '../components/ProductMatrix'
import { uploadDocuments } from '../lib/documents'
import { useAuth } from '../lib/auth'

const DOC_MAX_FILES = 10
const OTHER = '__other__'

interface FormState {
  gender: string; client_type: string; residency: string; nationality: string; date_of_birth: string
  insurer: string; plan_kb_id: string; plan_name: string; other_plan: boolean
  currency: string; amount_basis: 'sum_assured' | 'premium'; amount: string
  smoker: boolean | null; coverage_term: string; ci_benefit: boolean
  compare_term: boolean; compare_kb_1: string; compare_kb_2: string; remarks: string
}
const DEFAULTS: FormState = {
  gender: '', client_type: '', residency: '', nationality: '', date_of_birth: '',
  insurer: '', plan_kb_id: '', plan_name: '', other_plan: false,
  currency: 'SGD', amount_basis: 'sum_assured', amount: '',
  smoker: null, coverage_term: '', ci_benefit: false,
  compare_term: false, compare_kb_1: '', compare_kb_2: '', remarks: '',
}
const pick = (r: PiRequest): FormState => ({
  gender: r.gender ?? '', client_type: r.client_type ?? '', residency: r.residency ?? '', nationality: r.nationality ?? '',
  date_of_birth: r.date_of_birth ?? '', insurer: r.insurer ?? '', plan_kb_id: r.plan_kb_id ?? '',
  plan_name: r.plan_kb_id ? '' : r.plan_name ?? '', other_plan: !r.plan_kb_id && !!r.plan_name,
  currency: r.currency || 'SGD', amount_basis: r.amount_basis ?? 'sum_assured', amount: r.amount != null ? String(Number(r.amount)) : '',
  smoker: r.smoker, coverage_term: r.coverage_term ?? '', ci_benefit: r.ci_benefit,
  compare_term: !!r.compare_term, compare_kb_1: r.compare_kb_1 ?? '', compare_kb_2: r.compare_kb_2 ?? '', remarks: r.remarks ?? '',
})
const withValue = (list: string[], v: string) => (v && !list.includes(v) ? [v, ...list] : list)
const FIX_FIELDS = 'Please fix the highlighted fields.'
const fmtSize = (b: number) => (b < 1024 * 1024 ? `${Math.max(1, Math.round(b / 1024))} KB` : `${(b / 1024 / 1024).toFixed(1)} MB`)
const num = (s: string) => Number(s.replace(/,/g, ''))

interface PastClient { client_name: string; contact: string; request: PiRequest }

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
    if (f.date_of_birth > isoToday()) e.date_of_birth = 'The date of birth cannot be in the future'
    else if (age == null || age < 0 || age > 100) e.date_of_birth = 'Check the date of birth'
  }
  need('insurer', f.insurer, 'Choose the insurer')
  if (!f.plan_kb_id && !f.other_plan) e.product = 'Choose the product'
  if (f.other_plan && !f.plan_name.trim()) e.product = 'Enter the plan name'
  need('currency', f.currency, 'Choose the currency')
  if (!f.amount.trim()) e.amount = 'Enter the sum assured or premium'
  else if (!Number.isFinite(num(f.amount)) || num(f.amount) <= 0) e.amount = 'Enter a number above 0'
  if (f.smoker == null) e.smoker = 'Choose smoker or non-smoker'
  need('coverage_term', f.coverage_term, 'Choose the coverage term')
  if (f.compare_term) {
    if (!f.compare_kb_1) e.compare_kb_1 = 'Choose the 1st product to compare'
    else if (f.compare_kb_1 === f.plan_kb_id) e.compare_kb_1 = 'Choose a product other than field 9'
    if (f.compare_kb_2 && (f.compare_kb_2 === f.compare_kb_1 || f.compare_kb_2 === f.plan_kb_id)) e.compare_kb_2 = 'Choose a different product'
    const kbCount = [f.plan_kb_id, f.compare_kb_1, f.compare_kb_2].filter(Boolean).length
    if (!e.compare_kb_1 && !e.compare_kb_2 && kbCount < 2) e.compare_kb_2 = 'A comparison needs 2 Knowledge Bank products. Choose a 2nd product'
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
  const loadDocs = useCallback(async () => {
    if (!id) return
    const { data } = await supabase.from('request_documents').select('*').eq('request_id', id).order('uploaded_at')
    setDocs((data as RequestDocument[]) ?? [])
  }, [id])
  const [kb, setKb] = useState<Kb>({ products: [], docs: {}, rates: [] })
  const [ref, setRef] = useState('')
  const [f, setF] = useState<FormState>(DEFAULTS)
  const [savedNames, setSavedNames] = useState<Record<string, string>>({})   // names of saved KB picks, if no longer checked
  const [client, setClient] = useState({ client_name: '', contact: '' })
  const [copiedFrom, setCopiedFrom] = useState('')
  const [past, setPast] = useState<PastClient[]>([])
  const [files, setFiles] = useState<File[]>([])
  const [fileError, setFileError] = useState('')
  const [dragOver, setDragOver] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [step, setStep] = useState<'edit' | 'review'>('edit')
  const [matrix, setMatrix] = useState(false)
  const [notice, setNotice] = useState('')
  const [ack, setAck] = useState(false)
  const [done, setDone] = useState<{ id: string; ref: string; uploadErrors: string[] } | null>(null)
  const [error, setError] = useState('')
  const [ready, setReady] = useState(!id && !from)
  const [saving, setSaving] = useState(false)
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => {
    setF((s) => ({ ...s, [k]: v }))
    const field = k === 'plan_kb_id' || k === 'plan_name' ? 'product' : k
    setErrors((e) => { if (!e[field]) return e; const n = { ...e }; delete n[field]; return n })
  }

  useEffect(() => { loadKb().then(setKb).catch(() => undefined) }, [])

  const remember = (r: PiRequest) => setSavedNames({
    ...(r.plan_kb_id ? { [r.plan_kb_id]: `${r.insurer} · ${r.plan_name}` } : {}),
    ...(r.compare_kb_1 && r.compare_product_1 ? { [r.compare_kb_1]: r.compare_product_1 } : {}),
    ...(r.compare_kb_2 && r.compare_product_2 ? { [r.compare_kb_2]: r.compare_product_2 } : {}),
  })

  useEffect(() => {
    if (!id) return
    ;(async () => {
      const { data } = await supabase.from('request_list').select('*').eq('id', id).single()
      if (!data) return
      const r = data as PiRequest
      if (!['submitted', 'sent_back'].includes(r.status)) { nav(`/requests/${r.id}`, { replace: true }); return }
      setRef(r.ref)
      setF(pick(r)); remember(r)
      loadDocs()
      const c = await supabase.from('request_clients').select('*').eq('request_id', id).maybeSingle()
      if (c.data) setClient({ client_name: c.data.client_name, contact: c.data.contact ?? '' })
      setReady(true)
    })()
  }, [id, nav, loadDocs])

  // Duplicate: start a new request from an earlier one (client and policy details, no files).
  useEffect(() => {
    if (!from) return
    ;(async () => {
      const [{ data }, c] = await Promise.all([
        supabase.from('request_list').select('*').eq('id', from).maybeSingle(),
        supabase.from('request_clients').select('*').eq('request_id', from).maybeSingle(),
      ])
      if (data) { const r = data as PiRequest; setF(pick(r)); remember(r); setCopiedFrom(r.ref) }
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
    remember(c.request)
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

  // Lists for fields 8, 9, 12 and 13.
  const kbInsurers = useMemo(() => [...new Set(kb.products.map((p) => p.insurer))], [kb])
  const insurers = useMemo(() => withValue([...kbInsurers, ...STANDARD_INSURERS.filter((x) => !kbInsurers.includes(x))], f.insurer), [kbInsurers, f.insurer])
  const plans = kb.products.filter((p) => p.insurer === f.insurer)
  const nameOf = (pid: string) => { const p = kb.products.find((x) => x.id === pid); return p ? productLabel(p) : savedNames[pid] ? `${savedNames[pid]} (no longer in the Knowledge Bank)` : '' }
  const kbOk = (pid: string) => !pid || kb.products.some((x) => x.id === pid)
  const age = f.date_of_birth ? ageOn(f.date_of_birth) : null

  const needs = (): Needs => ({
    profile: f.client_type || 'Family',
    age: age != null && age >= 0 ? age + 1 : null,
    residency: f.residency || 'Singapore citizen',
    currency: f.currency || 'SGD',
    mode: f.amount_basis === 'premium' ? 'budget' : 'coverage',
    amount: num(f.amount) || 0,
    insurer: 'All', category: 'All', jurisdiction: 'All',
    gender: f.gender || 'Male', smoker: !!f.smoker, ci: f.ci_benefit,
  })

  function applyProducts(ids: string[]) {
    const main = f.plan_kb_id && ids.includes(f.plan_kb_id) ? f.plan_kb_id : ids[0]
    const rest = ids.filter((x) => x !== main)
    const p = kb.products.find((x) => x.id === main)!
    setF((s) => ({ ...s, insurer: p.insurer, plan_kb_id: main, plan_name: '', other_plan: false, compare_term: true,
      compare_kb_1: rest[0] ?? '', compare_kb_2: rest[1] ?? '' }))
    setErrors((e) => { const n = { ...e }; for (const k of ['insurer', 'product', 'compare_kb_1', 'compare_kb_2']) delete n[k]; return n })
    setMatrix(false)
    setNotice(ids.length >= 3
      ? 'Fields 8, 9, 12 and 13 are filled in with the 3 products. Check the form, then review and submit.'
      : 'Fields 8, 9 and 12 are filled in with the 2 products. Field 13 stays empty because you compared 2 products (pick 3 to fill it, or choose one there). Check the form, then review and submit.')
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
      gender: f.gender, client_type: f.client_type, residency: f.residency, nationality: f.nationality, date_of_birth: f.date_of_birth,
      insurer: f.insurer, plan_kb_id: f.other_plan ? '' : f.plan_kb_id, plan_name: f.other_plan ? f.plan_name.trim() : '',
      currency: f.currency, amount_basis: f.amount_basis, amount: String(num(f.amount)),
      smoker: f.smoker, coverage_term: f.coverage_term, ci_benefit: f.ci_benefit, remarks: f.remarks,
      compare_term: f.compare_term, compare_kb_1: f.compare_term ? f.compare_kb_1 : '', compare_kb_2: f.compare_term ? f.compare_kb_2 : '',
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

  if (!ready) return <div className="empty">Loading…</div>

  const productText = f.other_plan ? `${f.plan_name} (not in the Knowledge Bank)` : (nameOf(f.plan_kb_id).replace(/^.*? · /, '') || '—')
  const compared = [f.plan_kb_id, f.compare_kb_1, f.compare_kb_2].filter(Boolean)

  if (done) return (
    <main className="page">
      <section className="card" role="status" aria-label="Request submitted">
        <h1 style={{ margin: 0 }}>Request submitted</h1>
        <p style={{ margin: 0 }}>Your reference is <strong className="ref-big">{done.ref}</strong>. Quote it when you contact the ops team.
          You can follow its progress on your board.</p>
        {f.compare_term && <p className="muted" style={{ margin: 0 }}>Ops will illustrate the products you compared. You get the PI pack with the comparison when it's ready.</p>}
        {done.uploadErrors.length > 0 && <div className="error" role="alert">Some files did not upload: {done.uploadErrors.join(' · ')}. Add them again on the request page.</div>}
        <div className="row">
          <Link className="btn primary" to={`/requests/${done.id}`}>Open {done.ref}</Link>
          <Link className="btn" to="/board">Back to board</Link>
        </div>
      </section>
    </main>
  )

  const F = ({ k, n, label, hint, children }: { k: string; n?: number | string; label: string; hint?: ReactNode; children: ReactNode }) => (
    <div className={`field${errors[k] ? ' has-error' : ''}`} data-field={k}>
      <span className="wf-head">{n != null && <span className="wf-badge" aria-hidden="true">{n}</span>}<label htmlFor={`f-${k}`}>{label}</label></span>
      {children}
      {hint && !errors[k] && <span className="small muted">{hint}</span>}
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
  const compareSelect = (k: 'compare_kb_1' | 'compare_kb_2', others: string[]) => (
    <select id={`f-${k}`} value={f[k]} aria-invalid={!!errors[k]} onChange={(e) => set(k, e.target.value)}>
      <option value="">{k === 'compare_kb_2' ? 'None' : 'Select'}</option>
      {!kbOk(f[k]) && <option value={f[k]}>{nameOf(f[k])}</option>}
      {kb.products.filter((p) => !others.includes(p.id)).map((p) => <option key={p.id} value={p.id}>{productLabel(p)}</option>)}
    </select>
  )
  const yesNo = [{ value: false, label: 'No' }, { value: true, label: 'Yes' }]

  if (step === 'review') {
    const rows: [string, string][] = [
      ['Gender', f.gender],
      ['Client name', `${client.client_name} (ops and BSD see "${vipName(f.gender)}")`], ['Client contact', client.contact || '—'],
      ['Client type', f.client_type], ['Residency', f.residency], ['Nationality', f.nationality],
      ['Date of birth', `${dobDmy(f.date_of_birth)} (age ${age})`], ['Insurer', f.insurer], ['Product', productText],
      ['Currency', f.currency],
      [f.amount_basis === 'premium' ? 'Premium (a year)' : 'Sum assured', fmtMoney(num(f.amount), f.currency)],
      ['Smoker status', f.smoker ? 'Smoker' : 'Non-smoker'], ['Coverage term', f.coverage_term],
      ['Critical illness benefit', f.ci_benefit ? 'Yes' : 'No'],
      ['Term product comparison', f.compare_term ? compared.map(nameOf).join('; ') : 'No'],
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

        <div className="form-grid">
          {F({ k: 'gender', n: 2, label: 'Gender', children: sel('gender', GENDERS) })}
          {F({ k: 'client_name', n: 3, label: 'Client name',
            hint: `Only you see this name. Ops, BSD and the PI pack show ${f.gender ? `"${vipName(f.gender)}"` : '"Mr VIP" or "Ms VIP" (from the gender)'}.`, children:
            <input id="f-client_name" type="text" value={client.client_name} aria-invalid={!!errors.client_name}
              onChange={(e) => { setClient({ ...client, client_name: e.target.value }); setErrors((x) => { const n = { ...x }; delete n.client_name; return n }) }} /> })}
          {F({ k: 'client_type', n: 4, label: 'Client type', children: sel('client_type', CLIENT_TYPES) })}
          {F({ k: 'residency', n: 5, label: 'Residency', children: sel('residency', RESIDENCIES) })}
          {F({ k: 'nationality', n: 6, label: 'Nationality', children: <>
            <input id="f-nationality" type="search" list="nationalities" placeholder="Search" value={f.nationality}
              aria-invalid={!!errors.nationality} autoComplete="off" onChange={(e) => set('nationality', e.target.value)} />
            <datalist id="nationalities">{NATIONALITIES.map((x) => <option key={x} value={x} />)}</datalist>
          </> })}
          {F({ k: 'date_of_birth', n: 7, label: 'Date of birth',
            hint: age != null && age >= 0 && f.date_of_birth <= isoToday() ? `Age ${age} today` : undefined, children:
            <input id="f-date_of_birth" type="date" max={isoToday()} min="1900-01-01" value={f.date_of_birth} aria-invalid={!!errors.date_of_birth}
              onChange={(e) => set('date_of_birth', e.target.value)} /> })}
          {F({ k: 'insurer', n: 8, label: 'Insurer', hint: 'Required', children:
            <select id="f-insurer" value={f.insurer} aria-invalid={!!errors.insurer}
              onChange={(e) => setF((s) => ({ ...s, insurer: e.target.value, plan_kb_id: '', plan_name: '', other_plan: false }))}>
              <option value="">Select</option>
              {insurers.map((o) => <option key={o} value={o}>{o}</option>)}
            </select> })}
          {F({ k: 'product', n: 9, label: 'Product', hint: f.insurer && !plans.length && !f.plan_kb_id ? 'No checked plans for this insurer in the Knowledge Bank yet. Choose "Other" and type the plan name.' : 'Only this insurer\'s term plans', children: <>
            <select id="f-product" value={f.other_plan ? OTHER : f.plan_kb_id} disabled={!f.insurer} aria-invalid={!!errors.product}
              onChange={(e) => {
                const v = e.target.value
                setF((s) => ({ ...s, other_plan: v === OTHER, plan_kb_id: v === OTHER ? '' : v,
                  compare_kb_1: s.compare_kb_1 === v ? '' : s.compare_kb_1, compare_kb_2: s.compare_kb_2 === v ? '' : s.compare_kb_2 }))
                setErrors((x) => { const n = { ...x }; delete n.product; return n })
              }}>
              <option value="">{f.insurer ? 'Select' : 'Choose the insurer first'}</option>
              {!kbOk(f.plan_kb_id) && <option value={f.plan_kb_id}>{nameOf(f.plan_kb_id)}</option>}
              {plans.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              <option value={OTHER}>{OTHER_PLAN}</option>
            </select>
            {f.other_plan && <input type="text" aria-label="Plan name" placeholder="Plan name" maxLength={160} value={f.plan_name}
              onChange={(e) => set('plan_name', e.target.value)} />}
          </> })}
          {F({ k: 'currency', n: 10, label: 'Currency', children: sel('currency', CURRENCIES) })}
          {F({ k: 'amount', n: 11, label: 'Sum assured / premium', children: <div className="row" style={{ gap: 8, flexWrap: 'nowrap' }}>
            <select aria-label="Amount is the" value={f.amount_basis} style={{ width: 'auto', flex: '0 0 auto' }}
              onChange={(e) => set('amount_basis', e.target.value as FormState['amount_basis'])}>
              {AMOUNT_BASES.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            <input id="f-amount" style={{ minWidth: 0, flex: 1 }} type="text" inputMode="decimal" placeholder="Numeric" value={f.amount} aria-invalid={!!errors.amount}
              onChange={(e) => set('amount', e.target.value.replace(/[^\d.,]/g, ''))} />
          </div> })}
          <div className={`field${errors.smoker ? ' has-error' : ''}`} data-field="smoker">
            <Seg label="Smoker status" value={f.smoker as boolean} onChange={(v) => set('smoker', v)}
              options={[{ value: false, label: 'Non-smoker' }, { value: true, label: 'Smoker' }]} />
            {errors.smoker && <span className="error">{errors.smoker}</span>}
          </div>
          {F({ k: 'coverage_term', label: 'Coverage term', children: sel('coverage_term', COVERAGE_TERMS) })}
          <div className="field" data-field="ci_benefit">
            <Seg label="Critical illness benefit" value={f.ci_benefit} onChange={(v) => set('ci_benefit', v)} options={yesNo} />
          </div>
        </div>

        <div className="compare-box">
          <label className="row" style={{ gap: 8, fontWeight: 600 }}>
            <input type="checkbox" checked={f.compare_term} onChange={(e) => { set('compare_term', e.target.checked); setNotice('') }} />
            Term Product Comparison Request
          </label>
          <span className="small muted">Optional. Compare 2 or 3 term plans from the Knowledge Bank. Ops send back a PI for each.</span>
          {f.compare_term && <>
            <div className="row">
              <button type="button" className="btn primary" onClick={() => { setMatrix(true); setNotice('') }} disabled={!kb.products.length}>
                Find and compare products</button>
              <span className="small muted">{kb.products.length
                ? 'Opens the Product Matrix, filled in from this form. Pick 2 or 3 matching products to compare.'
                : 'No checked products in the Knowledge Bank yet.'}</span>
            </div>
            {notice && <div className="notice" role="status">{notice}</div>}
            <div className="form-grid">
              {F({ k: 'compare_kb_1', n: 12, label: 'Term Product Name – 1st Product', children: compareSelect('compare_kb_1', [f.plan_kb_id, f.compare_kb_2]) })}
              {F({ k: 'compare_kb_2', n: 13, label: 'Term Product Name – 2nd Product (optional)', children: compareSelect('compare_kb_2', [f.plan_kb_id, f.compare_kb_1]) })}
            </div>
            <span className="small muted">Filled in when you use products from the comparison. You can also choose them here.</span>
          </>}
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
            <span className="label wf-head"><span className="wf-badge" aria-hidden="true">14</span><span>Supporting documents (optional)</span></span>
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

        {error && <div className="error" role="alert">{error}</div>}
        <div className="row">
          <span className="wf-badge" aria-hidden="true">15</span>
          <button className="btn primary" onClick={review}>Review and submit</button>
          <button className="btn" onClick={() => nav(-1)}>Cancel</button>
        </div>
      </section>

      {matrix && (
        <ProductMatrix kb={kb} initial={needs()} mainId={f.other_plan ? null : f.plan_kb_id || null}
          selected={f.compare_term ? compared : [f.plan_kb_id].filter(Boolean)}
          onUse={applyProducts} onClose={() => setMatrix(false)} />
      )}
    </main>
  )
}
