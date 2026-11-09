import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { useRequests } from '../lib/requests'
import { nameOf, usePeople } from '../lib/people'
import { useSettings } from '../lib/settings'
import { STATUS_LABEL, byPriorityThenDue, daysSince, dueInfo, fmtDate, introGroup, summary } from '../lib/options'
import { downloadCsv } from '../lib/csv'
import { StatusPill, UrgentPill } from '../components/ui'
import type { PiRequest, SavedFilter } from '../lib/types'

interface Filters { status: string; assignee: string; priority: string; due: string; from: string; to: string; q: string }
const OPEN = (r: PiRequest) => !['completed', 'removed'].includes(r.status)

export default function Backlog() {
  const { has } = useAuth()
  const { rows, loading, reload } = useRequests()
  const people = usePeople()
  const settings = useSettings()
  const intro = has('introducer')
  const staff = has('ops') || has('bsd')
  const bsd = has('bsd')
  const blank: Filters = { status: intro ? 'all' : 'open', assignee: '', priority: '', due: '', from: '', to: '', q: '' }
  const [f, setF] = useState<Filters>(blank)
  const set = (patch: Partial<Filters>) => setF((s) => ({ ...s, ...patch }))
  const [error, setError] = useState('')
  const [info, setInfo] = useState('')
  const [clients, setClients] = useState<Record<string, string>>({})
  const [saved, setSaved] = useState<SavedFilter[]>([])
  const [savedId, setSavedId] = useState('')
  const [saveName, setSaveName] = useState<string | null>(null)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [bulkTo, setBulkTo] = useState('')
  const ops = Object.values(people).filter((p) => p.role === 'ops' && p.active)
  const due = useCallback((r: PiRequest) => dueInfo(r, settings.due_soon_hours), [settings.due_soon_hours])

  // Introducers can search by their own clients' names (ops and bsd never receive them).
  useEffect(() => {
    if (!intro) return
    supabase.from('request_clients').select('request_id, client_name').then(({ data }) =>
      setClients(Object.fromEntries((data ?? []).map((c) => [c.request_id, c.client_name]))))
  }, [intro])

  const loadSaved = useCallback(async () => {
    const { data } = await supabase.from('saved_filters').select('id, name, filters').order('name')
    setSaved((data as SavedFilter[]) ?? [])
  }, [])
  useEffect(() => { loadSaved() }, [loadSaved])

  const list = useMemo(() => rows
    .filter((r) => f.status === 'open' ? OPEN(r)
      : f.status === 'all' ? true : intro ? introGroup(r.status) === f.status : r.status === f.status)
    .filter((r) => !f.assignee || (f.assignee === 'none' ? !r.assignee_id : r.assignee_id === f.assignee))
    .filter((r) => !f.priority || r.priority === f.priority)
    .filter((r) => {
      if (!f.due) return true
      const d = due(r)
      return f.due === 'overdue' ? !!d?.overdue : f.due === 'soon' ? d?.level === 'soon' : d?.level === 'paused'
    })
    .filter((r) => !f.from || r.submitted_at.slice(0, 10) >= f.from)
    .filter((r) => !f.to || r.submitted_at.slice(0, 10) <= f.to)
    .filter((r) => !f.q || [r.ref, summary(r), people[r.introducer_id]?.full_name ?? '', people[r.introducer_id]?.company ?? '', clients[r.id] ?? '']
      .join(' ').toLowerCase().includes(f.q.toLowerCase()))
    .sort((a, b) => (a.priority === 'urgent' ? 0 : 1) - (b.priority === 'urgent' ? 0 : 1)
      || (a.assignee_id ? 1 : 0) - (b.assignee_id ? 1 : 0) || byPriorityThenDue(a, b)),
  [rows, f, people, clients, intro, due])

  // Workload for bsd: open requests per ops user
  const workload = useMemo(() => {
    const open = rows.filter(OPEN)
    const count = (rs: PiRequest[]) => ({
      assigned: rs.filter((r) => r.status === 'assigned').length,
      in_progress: rs.filter((r) => r.status === 'in_progress').length,
      sent_back: rs.filter((r) => r.status === 'sent_back').length,
      urgent: rs.filter((r) => r.priority === 'urgent').length,
      overdue: rs.filter((r) => due(r)?.overdue).length,
      total: rs.length,
    })
    return {
      people: ops.map((p) => ({ p, ...count(open.filter((r) => r.assignee_id === p.id)) })).sort((a, b) => b.total - a.total),
      pool: count(open.filter((r) => !r.assignee_id)),
    }
  }, [rows, ops, due])

  async function assign(id: string, user: string) {
    setError(''); setInfo('')
    const { error } = await supabase.rpc('assign_request', { p_request: id, p_user: user })
    if (error) setError(error.message)
    reload()
  }

  async function bulkAssign() {
    setError(''); setInfo('')
    const { data, error } = await supabase.rpc('assign_requests', { p_requests: [...picked], p_user: bulkTo })
    if (error) setError(error.message)
    else { setInfo(`Assigned ${data} request${data === 1 ? '' : 's'} to ${nameOf(people, bulkTo)}`); setPicked(new Set()); setBulkTo('') }
    reload()
  }

  async function claim(id: string) {
    setError(''); setInfo('')
    const { error } = await supabase.rpc('claim_request', { p_request: id })
    if (error) setError(error.message)
    reload()
  }

  async function saveFilter() {
    if (!saveName?.trim()) return
    const { data, error } = await supabase.rpc('save_filter', { p_name: saveName.trim(), p_filters: f })
    if (error) { setError(error.message); return }
    setSaveName(null); await loadSaved(); setSavedId(data as string)
  }

  async function deleteFilter() {
    await supabase.rpc('delete_saved_filter', { p_id: savedId })
    setSavedId(''); loadSaved()
  }

  function applySaved(id: string) {
    setSavedId(id)
    const s = saved.find((x) => x.id === id)
    if (s) setF({ ...blank, ...s.filters })
  }

  function exportCsv() {
    const head = ['Ref', 'Status', 'Priority', 'Product', 'Plan category', 'Age band', 'Gender', 'Smoker', 'Coverage term',
      'Sum assured', 'Premium type', 'CI benefit', 'Introducer', 'Firm', 'Handled by', 'Submitted', 'Due', 'Completed', 'Deadline status']
    const body = list.map((r) => [r.ref, STATUS_LABEL[r.status], r.priority === 'urgent' ? 'Urgent' : 'Normal', r.product, r.plan_category,
      r.age_band, r.gender, r.smoker ? 'Yes' : 'No', r.coverage_term, r.sum_assured_band, r.premium_type, r.ci_benefit ? 'Yes' : 'No',
      nameOf(people, r.introducer_id), people[r.introducer_id]?.company ?? '', r.assignee_id ? nameOf(people, r.assignee_id) : '',
      r.submitted_at, r.due_at, r.completed_at ?? '', due(r)?.label ?? ''])
    downloadCsv(`pi-requests-${new Date().toISOString().slice(0, 10)}.csv`, [head, ...body])
  }

  const pickable = list.filter(OPEN)
  const allPicked = pickable.length > 0 && pickable.every((r) => picked.has(r.id))
  const toggle = (id: string) => setPicked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n })

  if (loading) return <div className="empty">Loading…</div>
  return (
    <main className="page wide">
      <div className="row between">
        <h1>{intro ? 'My requests' : 'Backlog'}</h1>
        <div className="row">
          {staff && <button className="btn" onClick={exportCsv} disabled={!list.length}>Export CSV ({list.length})</button>}
          {intro && <Link className="btn primary" to="/requests/new">New request</Link>}
        </div>
      </div>

      {bsd && (
        <section className="card workload" aria-label="Workload">
          <h2 className="eyebrow">Workload (open requests)</h2>
          <div className="tablewrap">
            <table>
              <thead><tr><th>Ops user</th><th className="num">Assigned</th><th className="num">In progress</th><th className="num">Sent back</th>
                <th className="num">Urgent</th><th className="num">Overdue</th><th className="num">Total open</th></tr></thead>
              <tbody>
                {workload.people.map(({ p, ...c }) => (
                  <tr key={p.id}>
                    <td><button className="linkish" onClick={() => set({ assignee: p.id, status: 'open' })}>{p.full_name || p.email}</button></td>
                    <td className="num">{c.assigned}</td><td className="num">{c.in_progress}</td><td className="num">{c.sent_back}</td>
                    <td className="num">{c.urgent}</td><td className="num">{c.overdue}</td><td className="num"><strong>{c.total}</strong></td>
                  </tr>
                ))}
                <tr>
                  <td><button className="linkish" onClick={() => set({ assignee: 'none', status: 'open' })}>Unassigned pool</button></td>
                  <td className="num">—</td><td className="num">—</td><td className="num">{workload.pool.sent_back}</td>
                  <td className="num">{workload.pool.urgent}</td><td className="num">{workload.pool.overdue}</td><td className="num"><strong>{workload.pool.total}</strong></td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>
      )}

      <div className="card">
        <div className="row" style={{ alignItems: 'flex-end' }}>
          <label className="field" style={{ maxWidth: 200 }}>Status
            <select value={f.status} onChange={(e) => set({ status: e.target.value })}>
              <option value="open">Open (not completed)</option>
              <option value="all">All</option>
              {(intro ? ['in_progress', 'sent_back', 'completed'] : Object.keys(STATUS_LABEL)).map((k) => <option key={k} value={k}>{STATUS_LABEL[k]}</option>)}
            </select>
          </label>
          {staff && (
            <label className="field" style={{ maxWidth: 200 }}>Handled by
              <select value={f.assignee} onChange={(e) => set({ assignee: e.target.value })}>
                <option value="">Anyone</option>
                <option value="none">Unassigned</option>
                {ops.map((p) => <option key={p.id} value={p.id}>{p.full_name}</option>)}
              </select>
            </label>
          )}
          <label className="field" style={{ maxWidth: 150 }}>Priority
            <select value={f.priority} onChange={(e) => set({ priority: e.target.value })}>
              <option value="">Any</option>
              <option value="urgent">Urgent</option>
              <option value="normal">Normal</option>
            </select>
          </label>
          {staff && (
            <label className="field" style={{ maxWidth: 170 }}>Deadline
              <select value={f.due} onChange={(e) => set({ due: e.target.value })}>
                <option value="">Any</option>
                <option value="overdue">Overdue</option>
                <option value="soon">Due soon</option>
                <option value="paused">Clock paused</option>
              </select>
            </label>
          )}
          <label className="field" style={{ maxWidth: 160 }}>Submitted from
            <input type="date" value={f.from} onChange={(e) => set({ from: e.target.value })} />
          </label>
          <label className="field" style={{ maxWidth: 160 }}>Submitted to
            <input type="date" value={f.to} onChange={(e) => set({ to: e.target.value })} />
          </label>
          <label className="field" style={{ maxWidth: 260 }}>Search
            <input type="search" value={f.q} onChange={(e) => set({ q: e.target.value })}
              placeholder={intro ? 'Client name, reference, profile' : 'Reference, profile, introducer, firm'} />
          </label>
        </div>
        <div className="row small">
          <label className="row" style={{ gap: 6 }}>Saved filters
            <select aria-label="Saved filters" value={savedId} onChange={(e) => applySaved(e.target.value)} style={{ height: 34 }}>
              <option value="">Choose…</option>
              {saved.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </label>
          {saveName === null
            ? <button className="btn small" onClick={() => setSaveName(saved.find((s) => s.id === savedId)?.name ?? '')}>Save these filters</button>
            : <>
                <input type="text" aria-label="Filter name" placeholder="Name, e.g. Urgent this week" value={saveName} autoFocus
                  onChange={(e) => setSaveName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && saveFilter()} style={{ height: 34, maxWidth: 220 }} />
                <button className="btn small primary" disabled={!saveName.trim()} onClick={saveFilter}>Save</button>
                <button className="btn small" onClick={() => setSaveName(null)}>Cancel</button>
              </>}
          {savedId && <button className="btn small" onClick={deleteFilter}>Delete saved filter</button>}
          <button className="btn small" onClick={() => { setF(blank); setSavedId('') }}>Clear filters</button>
        </div>

        {bsd && picked.size > 0 && (
          <div className="toolbar" role="region" aria-label="Bulk assign">
            <strong>{picked.size} selected</strong>
            <select aria-label="Assign selected to" value={bulkTo} onChange={(e) => setBulkTo(e.target.value)}>
              <option value="">Assign to…</option>
              {ops.map((p) => <option key={p.id} value={p.id}>{p.full_name}</option>)}
            </select>
            <button className="btn small primary" disabled={!bulkTo} onClick={bulkAssign}>Assign selected</button>
            <button className="btn small" onClick={() => setPicked(new Set())}>Clear selection</button>
          </div>
        )}
        {error && <div className="error" role="alert">{error}</div>}
        {info && <div className="small" role="status" style={{ color: 'var(--ok)' }}>{info}</div>}
        <div className="tablewrap">
          <table aria-label="Requests">
            <thead><tr>
              {bsd && <th><input type="checkbox" aria-label="Select all open requests" checked={allPicked}
                onChange={() => setPicked(allPicked ? new Set() : new Set(pickable.map((r) => r.id)))} /></th>}
              <th>Ref</th><th>Status</th>{intro && <th>Client</th>}<th>Profile</th>{staff && <th>Introducer</th>}{staff && <th>Handled by</th>}
              <th className="num">Age</th>{staff && <th>Due</th>}<th>Submitted</th>
            </tr></thead>
            <tbody>
              {list.map((r) => {
                const d = staff ? due(r) : null
                return (
                <tr key={r.id} className={d && (d.level === 'soon' || d.level === 'late') ? 'row-' + d.level : ''}>
                  {bsd && <td>{OPEN(r) && <input type="checkbox" aria-label={`Select ${r.ref}`} checked={picked.has(r.id)} onChange={() => toggle(r.id)} />}</td>}
                  <td><Link to={`/requests/${r.id}`}><strong>{r.ref}</strong></Link> {r.priority === 'urgent' && <UrgentPill />}</td>
                  <td><StatusPill status={r.status} /></td>
                  {intro && <td>{clients[r.id] ?? ''}</td>}
                  <td>{summary(r)}</td>
                  {staff && <td>{nameOf(people, r.introducer_id)}<div className="small muted">{people[r.introducer_id]?.company}</div></td>}
                  {staff && <td>
                    {bsd && OPEN(r) ? (
                      <select aria-label={`Assign ${r.ref}`} value={r.assignee_id ?? ''} onChange={(e) => e.target.value && assign(r.id, e.target.value)}
                        style={{ height: 34, minWidth: 140 }}>
                        <option value="">Unassigned</option>
                        {ops.map((p) => <option key={p.id} value={p.id}>{p.full_name}</option>)}
                      </select>
                    ) : has('ops') && r.status === 'submitted' && !r.assignee_id ? (
                      <button className="btn small primary" onClick={() => claim(r.id)}>Assign to me</button>
                    ) : nameOf(people, r.assignee_id)}
                  </td>}
                  <td className="num">{daysSince(r.submitted_at)}d</td>
                  {staff && <td>{d && <span className={`due ${d.level}`}>{d.label}</span>}</td>}
                  <td>{fmtDate(r.submitted_at)}</td>
                </tr>
              )})}
            </tbody>
          </table>
          {!list.length && <div className="empty">No requests match.</div>}
        </div>
      </div>
    </main>
  )
}
