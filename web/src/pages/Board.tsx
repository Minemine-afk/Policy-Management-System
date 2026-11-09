import { useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { useRequests } from '../lib/requests'
import { nameOf, usePeople } from '../lib/people'
import { BOARD_STATUSES, COLUMN_COLOR, INTRO_GROUPS, STATUS_LABEL, byPriorityThenDue, daysSince, dueInfo, fmtHours, introGroup, summary } from '../lib/options'
import { useSettings } from '../lib/settings'
import type { PiRequest, RequestStatus } from '../lib/types'
import { ReasonDialog, UrgentPill } from '../components/ui'

export default function Board() {
  const { has, profile } = useAuth()
  const { rows, loading, reload } = useRequests()
  const people = usePeople()
  const settings = useSettings()
  const [mine, setMine] = useState(false)
  const [urgentOnly, setUrgentOnly] = useState(false)
  const [msg, setMsg] = useState('')
  const [over, setOver] = useState<string | null>(null)
  const [pending, setPending] = useState<{ req: PiRequest; to: RequestStatus } | null>(null)
  const intro = has('introducer')
  const staff = has('ops') || has('bsd')
  const columns: string[] = intro ? INTRO_GROUPS : [...BOARD_STATUSES]

  async function move(req: PiRequest, to: RequestStatus, reason?: string) {
    setMsg('')
    if (req.status === to) return
    let res
    const pool = req.status === 'submitted' && !req.assignee_id
    if (pool && to !== 'submitted') {
      if (has('ops') && (to === 'assigned' || to === 'in_progress')) res = await supabase.rpc('claim_request', { p_request: req.id, p_start: to === 'in_progress' })
      else if (has('bsd')) { setMsg('To assign a request, open it and choose an ops user.'); return }
      else res = await supabase.rpc('change_status', { p_request: req.id, p_to: to, p_reason: reason ?? null })
    } else {
      res = await supabase.rpc('change_status', { p_request: req.id, p_to: to, p_reason: reason ?? null })
    }
    if (res.error) setMsg(res.error.message)
    reload()
  }

  function drop(req: PiRequest, to: RequestStatus) {
    if (to === 'sent_back') setPending({ req, to })
    else move(req, to)
  }

  const visible = rows.filter((r) => (!mine || r.assignee_id === profile?.id) && (!urgentOnly || r.priority === 'urgent'))
  const cardsIn = (col: string) => visible.filter((r) => (intro ? introGroup(r.status) === col : r.status === col)).sort(byPriorityThenDue)
  const due = (r: PiRequest) => dueInfo(r, settings.due_soon_hours)
  if (loading) return <div className="empty">Loading…</div>
  return (
    <main className="page wide">
      <div className="row between">
        <h1>Board</h1>
        <div className="row">
          {staff && (
            <label className="row small" style={{ gap: 6 }}>
              <input type="checkbox" checked={urgentOnly} onChange={(e) => setUrgentOnly(e.target.checked)} /> Only urgent
            </label>
          )}
          {staff && (
            <label className="row small" style={{ gap: 6 }}>
              <input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} /> Only assigned to me
            </label>
          )}
          {intro && <Link className="btn primary" to="/requests/new">New request</Link>}
        </div>
      </div>
      {staff && visible.some((r) => due(r)?.overdue) && (
        <div className="notice bad"><strong>{visible.filter((r) => due(r)?.overdue).length} overdue</strong>
          <span>Requests are due {fmtHours(settings.deadline_hours)} after submission and turn red once overdue.
            Orange means {fmtHours(settings.due_soon_hours)} or less is left. Overdue requests are marked urgent automatically and urgent requests are listed first.</span></div>
      )}
      {msg && <div className="notice warn" role="alert"><strong>{msg}</strong></div>}
      {staff && <p className="small muted" style={{ margin: 0 }}>Drag a card by its grip (⋮⋮) to another column to change its status.</p>}
      <div className={`board cols-${columns.length}`}>
        {columns.map((s) => {
          const cards = cardsIn(s)
          return (
            <section key={s} className={`column${over === s ? ' over' : ''}`} aria-label={STATUS_LABEL[s]}
              onDragOver={(e) => { if (staff) { e.preventDefault(); setOver(s) } }}
              onDragLeave={() => setOver((o) => (o === s ? null : o))}
              onDrop={(e) => {
                setOver(null)
                const id = e.dataTransfer.getData('text/plain')
                const req = rows.find((r) => r.id === id)
                if (req && staff) drop(req, s as RequestStatus)
              }}>
              <header className="colhead">
                <span className="swatch" style={{ background: COLUMN_COLOR[s] }} />
                <h2>{STATUS_LABEL[s]}</h2>
                <span className="count">{cards.length}</span>
              </header>
              <div className="colbody">
                {cards.map((r) => {
                  const d = staff ? due(r) : null
                  const urgent = staff && r.priority === 'urgent'
                  return (
                    <Link key={r.id} to={`/requests/${r.id}`} className={`cardlet${d && (d.level === 'soon' || d.level === 'late') ? ' ' + d.level : ''}${staff ? ' draggable' : ''}${urgent ? ' urgent' : ''}`} data-ref={r.ref}
                      draggable={staff} onDragStart={(e) => e.dataTransfer.setData('text/plain', r.id)}>
                      {staff && <span className="grip" aria-hidden="true" title="Drag to move">⋮⋮</span>}
                      <div className="row between"><strong>{r.ref} {urgent && <UrgentPill auto={r.urgent_auto} />}</strong><span className="small muted" style={{ marginRight: staff ? 22 : 0 }}>{daysSince(r.submitted_at)}d</span></div>
                      <div className="small">{summary(r)}</div>
                      {staff && <div className="small muted">{nameOf(people, r.introducer_id)} · {people[r.introducer_id]?.company}</div>}
                      {staff && <div className="small handler" style={{ fontWeight: 700 }}>{r.assignee_id ? `Handled by ${nameOf(people, r.assignee_id)}` : 'Unassigned'}</div>}
                      {d && <div className={`due ${d.level}`}>{d.label}</div>}
                      {has('ops') && r.status === 'submitted' && !r.assignee_id && (
                        <button className="btn small primary" onClick={(e) => { e.preventDefault(); e.stopPropagation(); move(r, 'assigned') }}>Assign to me</button>
                      )}
                    </Link>
                  )
                })}
                {!cards.length && <div className="small muted empty-col">{staff ? 'Drop a card here' : 'Nothing here'}</div>}
              </div>
            </section>
          )
        })}
      </div>
      {pending && (
        <ReasonDialog title={`Send ${pending.req.ref} back to the introducer`} confirmLabel="Send back"
          onCancel={() => setPending(null)}
          onConfirm={(reason) => { const p = pending; setPending(null); move(p.req, p.to, reason) }} />
      )}
    </main>
  )
}
