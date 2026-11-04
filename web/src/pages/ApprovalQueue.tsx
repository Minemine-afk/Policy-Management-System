import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { daysSince } from '../lib/options'
import type { PolicyRequest, RequestDocument } from '../lib/types'
import RequestDetail, { useRequest } from '../components/RequestDetail'

function Age({ since }: { since: string | null }) {
  const d = daysSince(since)
  if (d === 0) return <span className="small muted">Today</span>
  if (d >= 2) return <span className="pill warn">{d} days</span>
  return <span className="small muted">{d} day</span>
}

export default function ApprovalQueue() {
  const { id } = useParams()
  const nav = useNavigate()
  const { profile } = useAuth()
  const [queue, setQueue] = useState<PolicyRequest[]>([])
  const [own, setOwn] = useState<PolicyRequest[]>([])
  const { data, reload } = useRequest(id)
  const [reason, setReason] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function loadQueue() {
    const { data } = await supabase.from('policy_requests').select('*').eq('status', 'submitted').order('submitted_at')
    const all = (data as PolicyRequest[]) ?? []
    setQueue(all.filter((r) => r.submitter_id !== profile?.id))
    setOwn(all.filter((r) => r.submitter_id === profile?.id))
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { loadQueue() }, [profile?.id])
  useEffect(() => { if (!id && queue.length) nav(`/queue/${queue[0].id}`, { replace: true }) }, [id, queue, nav])

  async function decide(decision: 'approve' | 'reject' | 'refer_back') {
    if (!data) return
    setBusy(true); setError('')
    const { error } = await supabase.rpc('decide_request', { p_request: data.req.id, p_decision: decision, p_reason: reason })
    setBusy(false)
    if (error) { setError(error.message); return }
    setReason('')
    await loadQueue()
    await reload()
  }

  async function report(d: RequestDocument) {
    const note = prompt('What did you see? (e.g. "NRIC visible on page 2"). Do not type the detail itself.')
    if (note === null) return
    const { error } = await supabase.rpc('report_unredacted', { p_document: d.id, p_note: note })
    if (error) alert(error.message)
    await reload()
  }

  const decidable = data && data.req.status === 'submitted' && data.req.submitter_id !== profile?.id

  return (
    <main className="page" style={{ maxWidth: 1280 }}>
      <div className="split">
        <section className="side" aria-labelledby="q-head" style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 380 }}>
          <div>
            <h1 id="q-head">Approval queue</h1>
            <p className="small muted" style={{ margin: '4px 0 0' }}>Oldest first. Target: decide within 2 working days.</p>
          </div>
          {queue.length === 0 && <div className="card muted">Nothing waiting. Well done.</div>}
          {queue.map((r) => (
            <Link key={r.id} to={`/queue/${r.id}`} className={`queue-item ${r.id === id ? 'current' : ''}`} aria-current={r.id === id ? 'true' : undefined}>
              <div className="row between"><strong>{r.ref}</strong><Age since={r.submitted_at} /></div>
              <div className="small muted" style={{ marginTop: 4 }}>{r.product} · age {r.age_band} · {r.sum_assured_band}</div>
            </Link>
          ))}
          {own.map((r) => (
            <div key={r.id} className="queue-item disabled">
              <div className="row between"><strong>{r.ref}</strong><span className="small">Submitted by you</span></div>
              <div className="small" style={{ marginTop: 4 }}>You can't approve your own request, so it goes to another approver.</div>
            </div>
          ))}
        </section>

        <div className="main" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {data && <RequestDetail data={data} viewer="approver" onReport={report} />}
          {data && decidable && (
            <section className="card" aria-label="Decision">
              <label className="field" htmlFor="reason">Reason (required for Reject or Refer back)</label>
              <textarea id="reason" rows={3} value={reason} onChange={(e) => { setReason(e.target.value); setError('') }}
                placeholder="Why is more information needed, or why declined?" />
              {error && <div className="error" role="alert">{error}</div>}
              <div className="row">
                <button className="btn primary" disabled={busy} onClick={() => decide('approve')}>Approve</button>
                <button className="btn" disabled={busy} onClick={() => decide('refer_back')}>Refer back</button>
                <button className="btn danger" disabled={busy} onClick={() => decide('reject')}>Reject</button>
              </div>
            </section>
          )}
          {!data && queue.length > 0 && <div className="empty">Pick a request from the queue.</div>}
        </div>
      </div>
    </main>
  )
}
