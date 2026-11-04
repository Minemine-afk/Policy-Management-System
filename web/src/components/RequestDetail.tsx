import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { fmtDate } from '../lib/options'
import type { Introducer, PolicyRequest, PriceRange, Profile, RequestDocument } from '../lib/types'
import { Fact, INDICATIVE_NOTE, PriceTable, StatusPill } from './ui'

export interface Loaded {
  req: PolicyRequest
  submitter: Profile | null
  decider: Profile | null
  introducer: Introducer | null
  docs: RequestDocument[]
  prices: PriceRange[]
}

export function useRequest(id: string | undefined) {
  const [data, setData] = useState<Loaded | null>(null)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    if (!id) return
    const { data: r, error } = await supabase.from('policy_requests').select('*').eq('id', id).maybeSingle()
    if (error || !r) { setError(error?.message ?? 'Request not found, or you do not have access.'); setData(null); return }
    const req = r as PolicyRequest
    const [sub, dec, intro, docs] = await Promise.all([
      supabase.from('profiles').select('*').eq('id', req.submitter_id).maybeSingle(),
      req.decided_by ? supabase.from('profiles').select('*').eq('id', req.decided_by).maybeSingle() : Promise.resolve({ data: null }),
      req.introducer_id ? supabase.from('introducers').select('*').eq('id', req.introducer_id).maybeSingle() : Promise.resolve({ data: null }),
      supabase.from('request_documents').select('*').eq('request_id', req.id).order('uploaded_at'),
    ])
    let prices = req.price_snapshot ?? []
    if (!req.price_snapshot) {
      const live = await supabase.rpc('indicative_prices', {
        p_age_band: req.age_band, p_gender: req.gender, p_smoker: req.smoker, p_coverage_term: req.coverage_term,
        p_sum_assured_band: req.sum_assured_band, p_ci: req.ci_benefit,
      })
      prices = (live.data as PriceRange[]) ?? []
    }
    setError('')
    setData({
      req, submitter: sub.data as Profile | null, decider: dec.data as Profile | null,
      introducer: intro.data as Introducer | null, docs: (docs.data as RequestDocument[]) ?? [], prices,
    })
  }, [id])

  useEffect(() => { load() }, [load])
  return { data, error, reload: load }
}

export async function openRequestDocument(d: RequestDocument) {
  await supabase.rpc('log_document_view', { p_document: d.id })
  const { data, error } = await supabase.storage.from('request-docs').createSignedUrl(d.storage_path, 60)
  if (error || !data) { alert(error?.message ?? 'Could not open the file'); return }
  window.open(data.signedUrl, '_blank', 'noopener')
}

export default function RequestDetail({ data, viewer, onReport }: {
  data: Loaded
  viewer: 'submitter' | 'approver' | 'admin'
  onReport?: (d: RequestDocument) => void
}) {
  const { req, submitter, decider, introducer, docs, prices } = data
  return (
    <article aria-label="Generated request" className="card" style={{ gap: 24, padding: 28 }}>
      <div className="row between" style={{ alignItems: 'flex-end' }}>
        <div>
          <div className="small muted">Policy request</div>
          <h1>{req.ref}</h1>
        </div>
        <StatusPill status={req.status} />
      </div>

      <div className="notice">
        <strong>Identity withheld</strong>
        <span>
          {viewer === 'approver'
            ? 'You see the banded profile and the redacted files only. Opening a file is recorded in the audit log.'
            : 'Documents were uploaded with name, NRIC and contact details removed. This system holds no client identity.'}
        </span>
      </div>

      {req.decision_reason && (
        <div className={`notice ${req.status === 'rejected' ? 'bad' : 'warn'}`}>
          <strong>{req.status === 'rejected' ? 'Rejected' : req.status === 'referred_back' ? 'Referred back' : 'Approver note'}</strong>
          <span>{req.decision_reason}</span>
        </div>
      )}

      <section style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <h2 className="eyebrow">Risk profile</h2>
        <dl className="facts">
          <Fact label="Plan category">{req.plan_category}</Fact>
          <Fact label="Product">{req.product}</Fact>
          <Fact label="Age band">{req.age_band}</Fact>
          <Fact label="Gender">{req.gender}</Fact>
          <Fact label="Smoker">{req.smoker ? 'Yes' : 'No'}</Fact>
          <Fact label="Coverage term">{req.coverage_term}</Fact>
          <Fact label="Sum assured">{req.sum_assured_band}</Fact>
          <Fact label="Premium type">{req.premium_type}</Fact>
          <Fact label="Critical illness benefit">{req.ci_benefit ? 'Yes' : 'No'}</Fact>
          <Fact label="Introducer">{introducer ? `${introducer.name} · ${introducer.status}` : 'None'}</Fact>
        </dl>
      </section>

      <section style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <h2 className="eyebrow">Attached documents (redacted)</h2>
        {docs.length === 0 && <p className="muted small" style={{ margin: 0 }}>No documents attached.</p>}
        <ul className="filelist">
          {docs.map((d) => (
            <li key={d.id}>
              <span style={{ fontWeight: 500 }}>{d.file_name}</span>
              <span className="row" style={{ gap: 12 }}>
                {d.scan === 'reported'
                  ? <span className="pill bad">Reported · hidden from approvers</span>
                  : d.scan_notes ? <span className="pill warn">Not auto-checked</span>
                  : <span className="pill ok">Checked · nothing identifying found</span>}
                <button className="linkbtn" onClick={() => openRequestDocument(d)}>Open</button>
                {viewer === 'approver' && onReport && !d.hidden && (
                  <button className="linkbtn danger" onClick={() => onReport(d)}>Report unredacted data</button>
                )}
              </span>
            </li>
          ))}
        </ul>
        {viewer === 'approver' && docs.length > 0 && (
          <div className="small muted">See a name, NRIC or contact detail? Use Report next to the file. It is hidden straight away and logged for an admin.</div>
        )}
      </section>

      <section style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <h2 className="eyebrow">Indicative premium range {req.price_snapshot ? '(as at submission)' : '(live)'}</h2>
        <PriceTable rows={prices} premiumType={req.premium_type} />
        <p className="small muted" style={{ margin: 0 }}>{INDICATIVE_NOTE}</p>
      </section>

      <section style={{ display: 'flex', flexDirection: 'column', gap: 12, borderTop: '1px solid var(--line)', paddingTop: 20 }}>
        <h2 className="eyebrow">Approval</h2>
        <dl className="facts">
          <Fact label="Submitted by">{submitter?.full_name ?? '—'}{viewer === 'submitter' ? ' (you)' : ''}</Fact>
          <Fact label="Submitted">{fmtDate(req.submitted_at)}</Fact>
          <Fact label="Decided by">{decider?.full_name ?? (req.status === 'submitted' ? 'Any approver except the submitter' : '—')}</Fact>
          <Fact label="Decided">{fmtDate(req.decided_at)}</Fact>
        </dl>
      </section>
    </article>
  )
}
