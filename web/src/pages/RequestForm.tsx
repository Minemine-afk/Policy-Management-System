import { useEffect, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { AGE_BANDS, COVERAGE_TERMS, GENDERS, PLAN_CATEGORIES, PREMIUM_TYPES, PRODUCTS, SUM_ASSURED_BANDS, says } from '../lib/options'
import type { PiRequest, RequestDocument } from '../lib/types'
import { Seg, Select } from '../components/ui'
import Files from '../components/Files'
import { useAuth } from '../lib/auth'

interface FormState {
  plan_category: string; product: string; age_band: string; gender: string; smoker: boolean
  coverage_term: string; sum_assured_band: string; premium_type: string; ci_benefit: boolean; remarks: string
}
const DEFAULTS: FormState = {
  plan_category: 'All', product: 'Term life', age_band: '25 to 29', gender: 'Male', smoker: false,
  coverage_term: '6 to 10 years', sum_assured_band: 'S$100,001 to 250,000', premium_type: 'Annual', ci_benefit: true, remarks: '',
}
const pick = (r: PiRequest): FormState => ({
  plan_category: r.plan_category, product: r.product, age_band: r.age_band, gender: r.gender, smoker: r.smoker,
  coverage_term: r.coverage_term, sum_assured_band: r.sum_assured_band, premium_type: r.premium_type, ci_benefit: r.ci_benefit,
  remarks: r.remarks ?? '',
})

interface PastClient { client_name: string; nric: string; contact: string; request: PiRequest }

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
  const [client, setClient] = useState({ client_name: '', nric: '', contact: '' })
  const [copiedFrom, setCopiedFrom] = useState('')
  const [past, setPast] = useState<PastClient[]>([])
  const [error, setError] = useState('')
  const [ready, setReady] = useState(!id && !from)
  const [saving, setSaving] = useState(false)
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setF((s) => ({ ...s, [k]: v }))

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
      if (c.data) setClient({ client_name: c.data.client_name, nric: c.data.nric ?? '', contact: c.data.contact ?? '' })
      setReady(true)
    })()
  }, [id, nav])

  // Duplicate: start a new request from an earlier one (profile and client details, no files).
  useEffect(() => {
    if (!from) return
    ;(async () => {
      const [{ data }, c] = await Promise.all([
        supabase.from('request_list').select('*').eq('id', from).maybeSingle(),
        supabase.from('request_clients').select('*').eq('request_id', from).maybeSingle(),
      ])
      if (data) { const r = data as PiRequest; setF(pick(r)); setCopiedFrom(r.ref) }
      if (c.data) setClient({ client_name: c.data.client_name, nric: c.data.nric ?? '', contact: c.data.contact ?? '' })
      setReady(true)
    })()
  }, [from])

  // Earlier clients of this introducer, newest request first, to fill the form again quickly.
  useEffect(() => {
    if (id) return
    ;(async () => {
      const [cl, rq] = await Promise.all([
        supabase.from('request_clients').select('request_id, client_name, nric, contact'),
        supabase.from('request_list').select('*').order('submitted_at', { ascending: false }),
      ])
      const byId = new Map(((rq.data as PiRequest[]) ?? []).map((r) => [r.id, r]))
      const seen = new Map<string, PastClient>()
      for (const c of (cl.data ?? []).map((c) => ({ ...c, request: byId.get(c.request_id)! })).filter((c) => c.request)
        .sort((a, b) => b.request.submitted_at.localeCompare(a.request.submitted_at))) {
        const key = c.client_name.trim().toLowerCase()
        if (!seen.has(key)) seen.set(key, { client_name: c.client_name, nric: c.nric ?? '', contact: c.contact ?? '', request: c.request })
      }
      setPast([...seen.values()].sort((a, b) => a.client_name.localeCompare(b.client_name)))
    })()
  }, [id])

  function fillFromPast(name: string) {
    const c = past.find((p) => p.client_name === name)
    if (!c) return
    setClient({ client_name: c.client_name, nric: c.nric, contact: c.contact })
    setF({ ...pick(c.request), remarks: '' })
    setCopiedFrom(c.request.ref)
  }

  async function submit() {
    setSaving(true); setError('')
    const res = id
      ? await supabase.rpc('update_request', { p_request: id, p: f, p_client: client })
      : await supabase.rpc('create_request', { p: f, p_client: client })
    setSaving(false)
    if (res.error) { setError(says(res.error.message)); return }
    nav(`/requests/${id ?? res.data}`)
  }

  const yesNo = [{ value: false, label: 'No' }, { value: true, label: 'Yes' }]
  if (!ready) return <div className="empty">Loading…</div>
  return (
    <main className="page">
      <div>
        <p className="muted small" style={{ margin: 0 }}>{ref ? `Editing ${ref}` : copiedFrom ? `New request, copied from ${copiedFrom}` : 'New policy illustration request'}</p>
        <h1>Request a policy illustration</h1>
      </div>

      <section className="card" aria-labelledby="client-head">
        <div>
          <h2 id="client-head" className="eyebrow">Client</h2>
          <p className="small muted" style={{ margin: '4px 0 0' }}>
            Only you can see these details. Ops and BSD see the request reference and profile below, never the client's name.
          </p>
        </div>
        {!id && past.length > 0 && (
          <label className="field" style={{ maxWidth: 360 }}>Previous client (optional)
            <select value="" onChange={(e) => fillFromPast(e.target.value)}>
              <option value="">Choose to fill in their details…</option>
              {past.map((p) => <option key={p.client_name} value={p.client_name}>{p.client_name} (last: {p.request.ref})</option>)}
            </select>
          </label>
        )}
        <div className="grid">
          <label className="field">Client name
            <input type="text" value={client.client_name} onChange={(e) => setClient({ ...client, client_name: e.target.value })} />
          </label>
          <label className="field">NRIC / FIN (optional)
            <input type="text" value={client.nric} onChange={(e) => setClient({ ...client, nric: e.target.value })} />
          </label>
          <label className="field">Contact (optional)
            <input type="text" value={client.contact} onChange={(e) => setClient({ ...client, contact: e.target.value })} />
          </label>
        </div>
      </section>

      <section className="card" aria-labelledby="cat-head">
        <h2 id="cat-head" className="eyebrow">Product</h2>
        <Seg label="Plan category" value={f.plan_category} onChange={(v) => set('plan_category', v)}
          options={PLAN_CATEGORIES.map((c) => ({ value: c, label: c }))} />
        <div className="grid">
          <Select label="Product" value={f.product} options={PRODUCTS} onChange={(v) => set('product', v)} />
          <Select label="Coverage term" value={f.coverage_term} options={COVERAGE_TERMS} onChange={(v) => set('coverage_term', v)} />
          <Select label="Sum assured" value={f.sum_assured_band} options={SUM_ASSURED_BANDS} onChange={(v) => set('sum_assured_band', v)} />
        </div>
        <div className="row" style={{ gap: 24, alignItems: 'flex-end' }}>
          <Seg label="Premium type" value={f.premium_type} onChange={(v) => set('premium_type', v)}
            options={PREMIUM_TYPES.map((c) => ({ value: c, label: c }))} />
          <Seg label="Critical illness benefit" value={f.ci_benefit} onChange={(v) => set('ci_benefit', v)} options={yesNo} />
        </div>
      </section>

      <section className="card" aria-labelledby="profile-head">
        <h2 id="profile-head" className="eyebrow">Client profile</h2>
        <div className="row" style={{ gap: 24, alignItems: 'flex-end' }}>
          <div style={{ minWidth: 200 }}>
            <Select label="Client age band" value={f.age_band} options={AGE_BANDS} onChange={(v) => set('age_band', v)} />
          </div>
          <Seg label="Gender" value={f.gender} onChange={(v) => set('gender', v)} options={GENDERS.map((g) => ({ value: g, label: g }))} />
          <Seg label="Smoker" value={f.smoker} onChange={(v) => set('smoker', v)} options={yesNo} />
        </div>
        <label className="field">Remarks for ops (optional)
          <textarea rows={3} value={f.remarks} onChange={(e) => set('remarks', e.target.value)}
            placeholder="Anything ops should know. Do not put the client's name here: ops can see this box." />
        </label>
      </section>

      {id && profile && (
        <Files title="Attachments" hint="Add or remove files before you save." requestId={id} kind="attachment" docs={docs}
          canUpload userId={profile.id} onChange={loadDocs} />
      )}

      {error && <div className="error" role="alert">{error}</div>}
      <div className="row">
        <button className="btn primary" onClick={submit} disabled={saving}>{id ? 'Save changes' : 'Submit request'}</button>
        <button className="btn" onClick={() => nav(-1)}>Cancel</button>
        {!id && <span className="small muted">You can attach files on the next page.</span>}
      </div>
    </main>
  )
}
