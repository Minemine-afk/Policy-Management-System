import { useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { useRequests } from '../lib/requests'
import { nameOf, usePeople } from '../lib/people'
import { BOARD_STATUSES, STATUS_LABEL, daysSince, dueInfo, summary } from '../lib/options'
import type { PiRequest, RequestStatus } from '../lib/types'
import { ReasonDialog } from '../components/ui'

export default function Board() {
  const { has, profile } = useAuth()
  const { rows, loading, reload } = useRequests()
  const people = usePeople()
  const [mine, setMine] = useState(false)
  const [msg, setMsg] = useState('')
  const [pending, setPending] = useState<{ req: PiRequest; to: RequestStatus } | null>(null)
  const canMove = has('ops') || has('bsd')
  const staff = canMove

  async function move(req: PiRequest, to: RequestStatus, reason?: string) {
    setMsg('')
    if (req.status === to) return
    let res
    if (to === 'assigned') {
      if (has('ops') && req.status === 'submitted' && !req.assignee_id) res = await supabase.rpc('claim_request', { p_request: req.id })
      else { setMsg('To assign a request, open it and choose an ops user.'); return }
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

  const visible = rows.filter((r) => !mine || r.assignee_id === profile?.id)
  if (loading) return <div className="empty">Loading…</div>
  return (
    <main className="page wide">
      <div className="row between">
        <h1>Board</h1>
        <div className="row">
          {(has('ops') || has('bsd')) && (
            <label className="row small" style={{ gap: 6 }}>
              <input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} /> Only assigned to me
            </label>
          )}
          {has('introducer') && <Link className="btn primary" to="/requests/new">New request</Link>}
        </div>
      </div>
      {staff && visible.some((r) => dueInfo(r)?.overdue) && (
        <div className="notice bad"><strong>{visible.filter((r) => dueInfo(r)?.overdue).length} overdue</strong>
          <span>Requests open for more than two days are red. Orange means one day or less is left.</span></div>
      )}
      {msg && <div className="notice warn" role="alert"><strong>{msg}</strong></div>}
      {canMove && <p className="small muted" style={{ margin: 0 }}>Drag a card to another column to change its status.</p>}
      <div className="board">
        {BOARD_STATUSES.map((s) => {
          const cards = visible.filter((r) => r.status === s)
          return (
            <section key={s} className="column" aria-label={STATUS_LABEL[s]}
              onDragOver={(e) => canMove && e.preventDefault()}
              onDrop={(e) => {
                const id = e.dataTransfer.getData('text/plain')
                const req = rows.find((r) => r.id === id)
                if (req && canMove) drop(req, s)
              }}>
              <h2 className="eyebrow">{STATUS_LABEL[s]} <span className="count">{cards.length}</span></h2>
              {cards.map((r) => {
                const due = staff ? dueInfo(r) : null
                return (
                <Link key={r.id} to={`/requests/${r.id}`} className={`cardlet${due && due.level !== 'ok' ? ' ' + due.level : ''}`} data-ref={r.ref}
                  draggable={canMove} onDragStart={(e) => e.dataTransfer.setData('text/plain', r.id)}>
                  <div className="row between"><strong>{r.ref}</strong><span className="small muted">{daysSince(r.submitted_at)}d</span></div>
                  <div className="small">{summary(r)}</div>
                  {!has('introducer') && <div className="small muted">{nameOf(people, r.introducer_id)} · {people[r.introducer_id]?.company}</div>}
                  <div className="small muted">{r.assignee_id ? `Handled by ${nameOf(people, r.assignee_id)}` : 'Unassigned'}</div>
                  {due && <div className={`due ${due.level}`}>{due.label}</div>}
                  {has('ops') && r.status === 'submitted' && !r.assignee_id && (
                    <button className="btn small primary" onClick={(e) => { e.preventDefault(); e.stopPropagation(); move(r, 'assigned') }}>Assign to me</button>
                  )}
                </Link>
              )})}
              {!cards.length && <div className="small muted">Nothing here</div>}
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
