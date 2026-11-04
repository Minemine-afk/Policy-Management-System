import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { fmtDate } from '../lib/options'
import type { PolicyRequest } from '../lib/types'
import { StatusPill } from '../components/ui'

export default function MyRequests() {
  const { profile } = useAuth()
  const [rows, setRows] = useState<PolicyRequest[]>([])
  const [refs, setRefs] = useState<Record<string, string>>({})

  useEffect(() => {
    if (!profile) return
    supabase.from('policy_requests').select('*').eq('submitter_id', profile.id).order('created_at', { ascending: false })
      .then(({ data }) => setRows((data as PolicyRequest[]) ?? []))
    supabase.from('request_private_refs').select('request_id, case_ref')
      .then(({ data }) => setRefs(Object.fromEntries((data ?? []).map((r) => [r.request_id, r.case_ref]))))
  }, [profile])

  return (
    <main className="page">
      <div className="row between">
        <h1>My requests</h1>
        <Link className="btn primary" to="/requests/new">New request</Link>
      </div>
      <div className="card" style={{ padding: 0 }}>
        <div className="tablewrap">
          <table>
            <thead><tr><th>Reference</th><th>Your case ref</th><th>Profile</th><th>Status</th><th>Created</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td><Link to={['draft', 'referred_back'].includes(r.status) ? `/requests/${r.id}/edit` : `/requests/${r.id}`}>{r.ref}</Link></td>
                  <td>{refs[r.id] ?? <span className="muted">—</span>}</td>
                  <td>{r.product} · age {r.age_band} · {r.sum_assured_band}</td>
                  <td><StatusPill status={r.status} /></td>
                  <td>{fmtDate(r.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length === 0 && <div className="empty">No requests yet.</div>}
        </div>
      </div>
    </main>
  )
}
