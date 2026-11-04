import { useCallback, useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import {
  AGE_BANDS, COVERAGE_TERMS, GENDERS, PLAN_CATEGORIES, PREMIUM_TYPES, PRODUCTS, SUM_ASSURED_BANDS, tagsForRequest,
} from '../lib/options'
import type { Introducer, PolicyRequest, PriceRange, RequestDocument } from '../lib/types'
import { Fact, INDICATIVE_NOTE, PriceTable, Seg, Select } from '../components/ui'
import RelevantDocs from '../components/RelevantDocs'
import RequestDocs from '../components/RequestDocs'

type FormState = Pick<PolicyRequest,
  'plan_category' | 'product' | 'age_band' | 'gender' | 'smoker' | 'coverage_term' | 'sum_assured_band' |
  'premium_type' | 'ci_benefit' | 'introducer_id' | 'attested'>

const DEFAULTS: FormState = {
  plan_category: 'All', product: 'Term life', age_band: '25 to 29', gender: 'Male', smoker: false,
  coverage_term: '6 to 10 years', sum_assured_band: 'S$100,001 to 250,000', premium_type: 'Annual',
  ci_benefit: true, introducer_id: null, attested: false,
}

export default function RequestForm() {
  const { id: routeId } = useParams()
  const nav = useNavigate()
  const [id, setId] = useState<string | null>(routeId ?? null)
  const [ref, setRef] = useState<string>('')
  const [f, setF] = useState<FormState>(DEFAULTS)
  const [caseRef, setCaseRef] = useState('')
  const [introducers, setIntroducers] = useState<Introducer[]>([])
  const [prices, setPrices] = useState<PriceRange[]>([])
  const [docs, setDocs] = useState<RequestDocument[]>([])
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [referral, setReferral] = useState<string | null>(null)

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setF((s) => ({ ...s, [k]: v }))

  useEffect(() => {
    supabase.from('introducers').select('*').eq('status', 'active').order('name')
      .then(({ data }) => setIntroducers((data as Introducer[]) ?? []))
  }, [])

  const loadDocs = useCallback(async (rid: string | null = id) => {
    if (!rid) return
    const { data } = await supabase.from('request_documents').select('*').eq('request_id', rid).order('uploaded_at')
    setDocs((data as RequestDocument[]) ?? [])
  }, [id])

  useEffect(() => {
    if (!routeId) return
    ;(async () => {
      const { data } = await supabase.from('policy_requests').select('*').eq('id', routeId).single()
      if (!data) return
      const r = data as PolicyRequest
      if (!['draft', 'referred_back'].includes(r.status)) { nav(`/requests/${r.id}`, { replace: true }); return }
      setRef(r.ref)
      setReferral(r.status === 'referred_back' ? r.decision_reason : null)
      setF({
        plan_category: r.plan_category, product: r.product, age_band: r.age_band, gender: r.gender, smoker: r.smoker,
        coverage_term: r.coverage_term, sum_assured_band: r.sum_assured_band, premium_type: r.premium_type,
        ci_benefit: r.ci_benefit, introducer_id: r.introducer_id, attested: r.attested,
      })
      const p = await supabase.from('request_private_refs').select('case_ref').eq('request_id', routeId).maybeSingle()
      setCaseRef(p.data?.case_ref ?? '')
      loadDocs(routeId)
    })()
  }, [routeId, nav, loadDocs])

  useEffect(() => {
    supabase.rpc('indicative_prices', {
      p_age_band: f.age_band, p_gender: f.gender, p_smoker: f.smoker, p_coverage_term: f.coverage_term,
      p_sum_assured_band: f.sum_assured_band, p_ci: f.ci_benefit,
    }).then(({ data }) => setPrices((data as PriceRange[]) ?? []))
  }, [f.age_band, f.gender, f.smoker, f.coverage_term, f.sum_assured_band, f.ci_benefit])

  async function save(): Promise<string | null> {
    setSaving(true); setError('')
    let rid = id
    if (rid) {
      const { error } = await supabase.from('policy_requests').update({ ...f, updated_at: new Date().toISOString() }).eq('id', rid)
      if (error) { setError(error.message); setSaving(false); return null }
    } else {
      const { data, error } = await supabase.from('policy_requests').insert(f).select('id, ref').single()
      if (error || !data) { setError(error?.message ?? 'Could not save'); setSaving(false); return null }
      rid = data.id; setId(data.id); setRef(data.ref)
      window.history.replaceState(null, '', `/requests/${data.id}/edit`)
    }
    if (caseRef.trim()) {
      await supabase.from('request_private_refs').upsert({ request_id: rid, case_ref: caseRef.trim() })
    } else {
      await supabase.from('request_private_refs').delete().eq('request_id', rid!)
    }
    setSaving(false)
    return rid
  }

  async function preview() {
    const rid = await save()
    if (rid) nav(`/requests/${rid}`)
  }

  const introducer = introducers.find((i) => i.id === f.introducer_id)
  const yesNo = [{ value: false, label: 'No' }, { value: true, label: 'Yes' }]

  return (
    <main className="page">
      <div className="row between">
        <div>
          <p className="muted small" style={{ margin: 0 }}>{ref ? `Editing ${ref}` : 'New policy request'}</p>
          <h1>Term life request</h1>
        </div>
        <span className="pill warn">{referral !== null ? 'Referred back' : 'Draft'}</span>
      </div>

      {referral && (
        <div className="notice warn"><strong>Approver asked for changes</strong><span>{referral}</span></div>
      )}

      <div className="split">
        <div className="main" style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
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

          <section className="card" aria-labelledby="client-head">
            <div>
              <h2 id="client-head" className="eyebrow">Client profile (banded, no identity)</h2>
              <p className="small muted" style={{ margin: '4px 0 0' }}>Do not enter names, NRIC or contact details anywhere in this system.</p>
            </div>
            <div className="row" style={{ gap: 24, alignItems: 'flex-end' }}>
              <div style={{ minWidth: 200 }}>
                <Select label="Client age band" value={f.age_band} options={AGE_BANDS} onChange={(v) => set('age_band', v)} />
              </div>
              <Seg label="Gender" value={f.gender} onChange={(v) => set('gender', v)} options={GENDERS.map((g) => ({ value: g, label: g }))} />
              <Seg label="Smoker" value={f.smoker} onChange={(v) => set('smoker', v)} options={yesNo} />
            </div>
            <div className="grid">
              <Select label="Introducer" value={f.introducer_id ?? ''} onChange={(v) => set('introducer_id', v || null)}
                options={[{ value: '', label: 'No introducer (direct client)' }, ...introducers.map((i) => ({ value: i.id, label: i.name }))]} />
              <label className="field">Your private case reference (optional)
                <input type="text" value={caseRef} maxLength={40} onChange={(e) => setCaseRef(e.target.value)}
                  placeholder="Your own file number, not a name or NRIC" />
                <span className="small muted" style={{ fontWeight: 400 }}>Only you can see this.</span>
              </label>
            </div>
          </section>

          <RequestDocs requestId={id} ensureRequest={save} docs={docs} onChange={(rid) => loadDocs(rid)} />

          <section className="card">
            <label className="row" style={{ alignItems: 'flex-start', gap: 10, fontSize: 15 }}>
              <input type="checkbox" checked={f.attested} onChange={(e) => set('attested', e.target.checked)} style={{ width: 20, height: 20, marginTop: 2 }} />
              <span>I confirm the uploaded documents have name, NRIC, date of birth, address and contact details removed, and I have checked every page.</span>
            </label>
            {error && <div className="error" role="alert">{error}</div>}
            <div className="row">
              <button className="btn primary" onClick={preview} disabled={saving}>Preview request</button>
              <button className="btn" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save draft'}</button>
            </div>
          </section>
        </div>

        <aside className="side" style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          <section className="card" aria-labelledby="prev-head">
            <h2 id="prev-head" className="eyebrow">What the approver will see</h2>
            <dl className="facts" style={{ gridTemplateColumns: '1fr 1fr' }}>
              <Fact label="Product">{f.product}</Fact>
              <Fact label="Age band">{f.age_band}</Fact>
              <Fact label="Gender · Smoker">{f.gender} · {f.smoker ? 'Yes' : 'No'}</Fact>
              <Fact label="Coverage term">{f.coverage_term}</Fact>
              <Fact label="Sum assured">{f.sum_assured_band}</Fact>
              <Fact label="CI benefit">{f.ci_benefit ? 'Yes' : 'No'}</Fact>
              <Fact label="Introducer">{introducer?.name ?? 'None'}</Fact>
              <Fact label="Documents">{docs.length}</Fact>
            </dl>
            <PriceTable rows={prices} premiumType={f.premium_type} />
            <p className="small muted" style={{ margin: 0 }}>{INDICATIVE_NOTE}</p>
          </section>
          <RelevantDocs tags={tagsForRequest(f)} />
        </aside>
      </div>
    </main>
  )
}
