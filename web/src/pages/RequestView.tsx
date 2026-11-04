import { useEffect, useState } from 'react'
import { Link, Navigate, useParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import RequestDetail, { useRequest } from '../components/RequestDetail'

export default function RequestView() {
  const { id } = useParams()
  const { profile, has } = useAuth()
  const { data, error, reload } = useRequest(id)
  const [caseRef, setCaseRef] = useState('')
  const [actionError, setActionError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!id) return
    supabase.from('request_private_refs').select('case_ref').eq('request_id', id).maybeSingle()
      .then(({ data }) => setCaseRef(data?.case_ref ?? ''))
  }, [id])

  if (error) return <main className="page"><div className="card">{error}</div></main>
  if (!data) return <main className="page"><div className="empty">Loading…</div></main>

  const mine = data.req.submitter_id === profile?.id
  // Approvers who are not the submitter decide from the queue screen.
  if (!mine && has('approver') && data.req.status === 'submitted' && !has('admin')) {
    return <Navigate to={`/queue/${data.req.id}`} replace />
  }
  const editable = mine && ['draft', 'referred_back'].includes(data.req.status)
  const withdrawable = mine && ['draft', 'submitted', 'referred_back'].includes(data.req.status)

  async function run(fn: string) {
    setBusy(true); setActionError('')
    const { error } = await supabase.rpc(fn, { p_request: data!.req.id })
    if (error) setActionError(error.message)
    else await reload()
    setBusy(false)
  }

  return (
    <main className="page" style={{ maxWidth: 940 }}>
      {mine && caseRef && <div className="small muted">Your case reference: <strong>{caseRef}</strong> (only you see this)</div>}
      <RequestDetail data={data} viewer={mine ? 'submitter' : has('admin') ? 'admin' : 'approver'} />
      {actionError && <div className="error" role="alert">{actionError}</div>}
      <div className="row">
        {editable && (
          <button className="btn primary" disabled={busy} onClick={() => run('submit_request')}>
            {data.req.status === 'referred_back' ? 'Resubmit for approval' : 'Submit for approval'}
          </button>
        )}
        {editable && <Link className="btn" to={`/requests/${data.req.id}/edit`}>Back to edit</Link>}
        {withdrawable && (
          <button className="btn danger" disabled={busy}
            onClick={() => confirm('Withdraw this request? This cannot be undone.') && run('withdraw_request')}>Withdraw</button>
        )}
        <button className="btn" onClick={() => window.print()}>Print or save as PDF</button>
        {mine && <Link to="/requests" style={{ marginLeft: 8 }}>My requests</Link>}
      </div>
    </main>
  )
}
