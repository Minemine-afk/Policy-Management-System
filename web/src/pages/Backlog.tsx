import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { useRequests } from '../lib/requests'
import { nameOf, usePeople } from '../lib/people'
import { STATUS_LABEL, daysSince, fmtDate, summary } from '../lib/options'
import { StatusPill } from '../components/ui'

export default function Backlog() {
  const { has } = useAuth()
  const { rows, loading, reload } = useRequests()
  const people = usePeople()
  const [status, setStatus] = useState(has('introducer') ? 'all' : 'open')
  const [assignee, setAssignee] = useState('')
  const [q, setQ] = useState('')
  const [error, setError] = useState('')
  const staff = has('ops') || has('bsd')
  const ops = Object.values(people).filter((p) => p.role === 'ops' && p.active)

  const list = useMemo(() => rows
    .filter((r) => status === 'open' ? !['completed', 'removed'].includes(r.status) : status === 'all' || r.status === status)
    .filter((r) => !assignee || (assignee === 'none' ? !r.assignee_id : r.assignee_id === assignee))
    .filter((r) => !q || (r.ref + ' ' + summary(r) + ' ' + (people[r.introducer_id]?.full_name ?? '')).toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => (a.assignee_id ? 1 : 0) - (b.assignee_id ? 1 : 0) || a.submitted_at.localeCompare(b.submitted_at)),
  [rows, status, assignee, q, people])

  async function assign(id: string, user: string) {
    setError('')
    const { error } = await supabase.rpc('assign_request', { p_request: id, p_user: user })
    if (error) setError(error.message)
    reload()
  }

  if (loading) return <div className="empty">Loading…</div>
  return (
    <main className="page wide">
      <div className="row between">
        <h1>{has('introducer') ? 'My requests' : 'Backlog'}</h1>
        {has('introducer') && <Link className="btn primary" to="/requests/new">New request</Link>}
      </div>
      <div className="card">
        <div className="row">
          <label className="field" style={{ maxWidth: 220 }}>Status
            <select value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="open">Open (not completed)</option>
              <option value="all">All</option>
              {Object.entries(STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </label>
          {staff && (
            <label className="field" style={{ maxWidth: 220 }}>Handled by
              <select value={assignee} onChange={(e) => setAssignee(e.target.value)}>
                <option value="">Anyone</option>
                <option value="none">Unassigned</option>
                {ops.map((p) => <option key={p.id} value={p.id}>{p.full_name}</option>)}
              </select>
            </label>
          )}
          <label className="field" style={{ maxWidth: 260 }}>Search
            <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Reference, profile, introducer" />
          </label>
        </div>
        {error && <div className="error" role="alert">{error}</div>}
        <div className="tablewrap">
          <table>
            <thead><tr>
              <th>Ref</th><th>Status</th><th>Profile</th>{staff && <th>Introducer</th>}<th>Handled by</th><th className="num">Age</th><th>Submitted</th>
            </tr></thead>
            <tbody>
              {list.map((r) => (
                <tr key={r.id}>
                  <td><Link to={`/requests/${r.id}`}><strong>{r.ref}</strong></Link></td>
                  <td><StatusPill status={r.status} /></td>
                  <td>{summary(r)}</td>
                  {staff && <td>{nameOf(people, r.introducer_id)}<div className="small muted">{people[r.introducer_id]?.company}</div></td>}
                  <td>
                    {has('bsd') && !['completed', 'removed'].includes(r.status) ? (
                      <select aria-label={`Assign ${r.ref}`} value={r.assignee_id ?? ''} onChange={(e) => e.target.value && assign(r.id, e.target.value)}
                        style={{ height: 34, minWidth: 140 }}>
                        <option value="">Unassigned</option>
                        {ops.map((p) => <option key={p.id} value={p.id}>{p.full_name}</option>)}
                      </select>
                    ) : nameOf(people, r.assignee_id)}
                  </td>
                  <td className="num">{daysSince(r.submitted_at)}d</td>
                  <td>{fmtDate(r.submitted_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!list.length && <div className="empty">No requests match.</div>}
        </div>
      </div>
    </main>
  )
}
