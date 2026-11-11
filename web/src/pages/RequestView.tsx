import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Link, useParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { isComparisonFile } from '../lib/piExcel'
import { nameOf, usePeople } from '../lib/people'
import { EVENT_LABEL, ageOn, dueInfo, fmtDate, fmtDateTime, planName, says } from '../lib/options'
import { useSettings } from '../lib/settings'
import type { PiRequest, RequestClient, RequestComment, RequestDocument, RequestEvent, RequestStatus } from '../lib/types'
import { ReasonDialog, StatusPill, UrgentPill } from '../components/ui'
import Files from '../components/Files'
import PiComparison from '../components/PiComparison'

export default function RequestView() {
  const { id } = useParams()
  const { profile, has } = useAuth()
  const people = usePeople()
  const settings = useSettings()
  const [r, setR] = useState<PiRequest | null | undefined>(undefined)
  const [client, setClient] = useState<RequestClient | null>(null)
  const [comments, setComments] = useState<RequestComment[]>([])
  const [events, setEvents] = useState<RequestEvent[]>([])
  const [docs, setDocs] = useState<RequestDocument[]>([])
  const [body, setBody] = useState('')
  const [internal, setInternal] = useState(false)
  const [assignTo, setAssignTo] = useState('')
  const [dialog, setDialog] = useState<'send_back' | 'remove' | 'reopen' | null>(null)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    if (!id) return
    const [req, cl, cm, ev, dc] = await Promise.all([
      supabase.from('request_list').select('*').eq('id', id).maybeSingle(),
      supabase.from('request_clients').select('*').eq('request_id', id).maybeSingle(),
      supabase.from('request_comments').select('*').eq('request_id', id).order('created_at'),
      supabase.from('request_events').select('*').eq('request_id', id).order('at', { ascending: false }),
      supabase.from('request_documents').select('*').eq('request_id', id).order('uploaded_at'),
    ])
    setR((req.data as PiRequest) ?? null)
    setClient((cl.data as RequestClient) ?? null)
    setComments((cm.data as RequestComment[]) ?? [])
    setEvents((ev.data as RequestEvent[]) ?? [])
    setDocs((dc.data as RequestDocument[]) ?? [])
  }, [id])
  useEffect(() => { load() }, [load])

  async function call(fn: string, args: Record<string, unknown>) {
    setError('')
    const { error } = await supabase.rpc(fn, args)
    if (error) setError(says(error.message))
    await load()
    return !error
  }

  if (r === undefined) return <div className="empty">Loading…</div>
  if (r === null || !profile) return <main className="page"><div className="card">Request not found, or you do not have access.</div></main>

  const intro = has('introducer')
  const who = (id: string | null) => (intro ? (id === profile.id ? 'You' : 'Ops team') : id ? nameOf(people, id) : 'Automatic')
  const mineAssigned = has('ops') && r.assignee_id === profile.id
  const staffActs = (mineAssigned || has('bsd')) && r.status !== 'removed'
  const ops = Object.values(people).filter((p) => p.role === 'ops' && p.active)
  const move = (to: RequestStatus) => call('change_status', { p_request: r.id, p_to: to })
  const piCount = docs.filter((d) => d.kind === 'pi_output').length
  const piPdfCount = docs.filter((d) => d.kind === 'pi_output' && d.file_name.toLowerCase().endsWith('.pdf')).length
  const hasComparison = docs.some((d) => d.kind === 'pi_output' && isComparisonFile(d.file_name))
  // With two or more PIs, the introducer gets the comparison Excel too, so it must be saved first.
  const completeBlock = !piCount ? 'Upload a PI first' : piPdfCount >= 2 && !hasComparison ? 'Save the PI comparison to this request first (PI comparison section)' : ''
  const canUploadAttachment = has('introducer') && r.introducer_id === profile.id && ['submitted', 'assigned', 'in_progress', 'sent_back'].includes(r.status)
  const canUploadPi = (mineAssigned || has('bsd')) && ['assigned', 'in_progress'].includes(r.status)
  const introducerSeesPi = !has('introducer') || r.status === 'completed'
  const owner = intro && r.introducer_id === profile.id
  const open = !['completed', 'removed'].includes(r.status)
  const canFlag = open && (has('bsd') || mineAssigned)
  const canReopen = r.status === 'completed' && (owner || has('bsd'))
  const due = !intro ? dueInfo(r, settings.due_soon_hours) : null
  const urgent = !intro && r.priority === 'urgent'
  const keepUrgent = urgent && !!due?.overdue

  const age = ageOn(r.date_of_birth)
  const details: [string, ReactNode][] = [
    ...(client ? [['Client name', client.client_name] as [string, ReactNode]] : []),
    ...(!intro ? [['Introducer', `${nameOf(people, r.introducer_id)}${people[r.introducer_id]?.company ? ` · ${people[r.introducer_id].company}` : ''}`] as [string, ReactNode]] : []),
    ['Date of birth', r.date_of_birth ? `${r.date_of_birth}${age != null ? ` (age ${age})` : ''}` : '—'],
    ['Gender', r.gender],
    ['Smoker status', r.smoker ? 'Smoker' : 'Non-smoker'],
    ['Nationality', r.nationality ?? '—'],
    ['Residency', r.residency ?? '—'],
    ['Client type', r.client_type ?? '—'],
    ['Product', planName(r)],
    ['Currency', r.currency],
    [r.amount_basis === 'premium' ? `Premium (${r.premium_type.toLowerCase()})` : 'Sum assured', r.amount != null ? Number(r.amount).toLocaleString('en-SG', { maximumFractionDigits: 2 }) : '—'],
    ['Policy term', r.policy_term ?? '—'],
    ['Premium term', r.premium_term ?? '—'],
    ['Payment frequency', r.premium_type],
    ['Riders', r.riders?.length ? r.riders.join(', ') : 'None'],
    ['Term product comparison', r.compare_term ? [r.compare_product_1, r.compare_product_2].filter(Boolean).join('; ') : 'No'],
    ...(client ? [['Client contact', client.contact ?? '—'] as [string, ReactNode]] : []),
    ...(!intro ? [['Handled by', nameOf(people, r.assignee_id)] as [string, ReactNode]] : []),
    ['Submitted', fmtDate(r.submitted_at)],
    ...(!intro ? [['Due', open && r.due_at ? fmtDateTime(r.due_at) : '—'], ['Priority', urgent ? (r.urgent_auto ? 'Urgent (overdue)' : 'Urgent') : 'Normal']] as [string, ReactNode][] : []),
  ]

  return (
    <main className="page">
      <div className="row between">
        <div>
          <p className="muted small" style={{ margin: 0 }}><Link to="/board">Board</Link> / {r.ref}</p>
          <h1>{r.ref} <StatusPill status={r.status} />{urgent && <> <UrgentPill auto={r.urgent_auto} /></>}{due && <span className={`due ${due.level}`} style={{ marginLeft: 8, fontSize: 14 }}>{due.label}</span>}</h1>
        </div>
        <div className="row">
          {has('introducer') && r.introducer_id === profile.id && r.status === 'submitted' &&
            <Link className="btn" to={`/requests/${r.id}/edit`}>Edit request</Link>}
          {owner && <Link className="btn" to={`/requests/new?from=${r.id}`}>Duplicate</Link>}
          {canReopen && <button className="btn" onClick={() => setDialog('reopen')}>Reopen</button>}
          {canFlag && <button className="btn" disabled={keepUrgent} title={keepUrgent ? 'Overdue requests stay urgent' : undefined}
            onClick={() => call('set_priority', { p_request: r.id, p_priority: urgent ? 'normal' : 'urgent' })}>
            {urgent ? 'Remove urgent flag' : 'Mark urgent'}</button>}
          {has('ops') && r.status === 'submitted' && !r.assignee_id &&
            <button className="btn primary" onClick={() => call('claim_request', { p_request: r.id })}>Assign to me</button>}
          {staffActs && r.status === 'assigned' && <button className="btn primary" onClick={() => move('in_progress')}>Start work</button>}
          {staffActs && ['assigned', 'in_progress'].includes(r.status) && <button className="btn" onClick={() => setDialog('send_back')}>Send back to introducer</button>}
          {staffActs && r.status === 'in_progress' && <button className="btn primary" disabled={!!completeBlock} title={completeBlock} onClick={() => move('completed')}>Mark completed</button>}
          {has('bsd') && r.status !== 'removed' && <button className="btn danger" onClick={() => setDialog('remove')}>Remove</button>}
        </div>
      </div>

      {error && <div className="notice bad" role="alert"><strong>{error}</strong></div>}
      {r.status === 'sent_back' && (
        <div className="notice warn"><strong>Sent back</strong><span>{r.status_reason}</span></div>
      )}
      {open && r.status !== 'sent_back' && r.status_reason && (
        <div className="notice warn"><strong>Reopened</strong><span>{r.status_reason}</span></div>
      )}
      {r.status === 'removed' && (
        <div className="notice bad"><strong>Removed</strong><span>{r.status_reason}</span></div>
      )}

      {has('introducer') && r.status === 'sent_back' && r.introducer_id === profile.id && (
        <section className="card">
          <h2 className="eyebrow">Fix and resubmit</h2>
          <p className="small muted" style={{ margin: 0 }}>Edit any detail of the request, including the client details and attachments, then resubmit it.</p>
          <div className="row">
            <Link className="btn" to={`/requests/${r.id}/edit`}>Edit request</Link>
            <button className="btn primary" onClick={() => call('resubmit_request', { p_request: r.id })}>Resubmit</button>
          </div>
        </section>
      )}

      <div className="split">
        <div className="main" style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          <section className="card" aria-label="Request details">
            <div>
              <h2 className="eyebrow">Request details</h2>
              {client && <p className="small muted" style={{ margin: '4px 0 0' }}>Client name and contact are seen only by you.</p>}
            </div>
            <table className="facts-table"><tbody>
              {details.map(([k, v]) => <tr key={k}><th scope="row">{k}</th><td>{v}</td></tr>)}
            </tbody></table>
            {r.remarks && <p style={{ margin: 0, whiteSpace: 'pre-line' }}><span className="muted small">Remarks</span><br />{r.remarks}</p>}
          </section>

          <Files title="Attachments" hint="Files the introducer adds to the request." requestId={r.id} kind="attachment" docs={docs}
            canUpload={canUploadAttachment} userId={profile.id} onChange={load} />
          {introducerSeesPi && (
            <Files title="Policy illustrations (PIs)" hint={has('introducer') ? undefined : 'Upload the PIs made outside the portal. They are compared below; save the comparison to this request. The introducer sees the PIs and the comparison once the request is completed.'}
              requestId={r.id} kind="pi_output" docs={docs} canUpload={canUploadPi} userId={profile.id} onChange={load} />
          )}
          {(has('ops') || has('bsd')) && piPdfCount > 0 && (
            <>
              {staffActs && r.status === 'in_progress' && completeBlock && piCount > 0 && <div className="small muted">Save the PI comparison to this request before marking it completed.</div>}
              <PiComparison req={r} docs={docs} userId={profile.id} isBsd={has('bsd')} onSaved={load} />
            </>
          )}

          {r.status !== 'sent_back' && (
          <section className="card" aria-label="Comments">
            <h2 className="eyebrow">Comments</h2>
            <ul className="comments">
              {comments.map((c) => (
                <li key={c.id} className={c.internal ? 'internal' : ''}>
                  <div className="small muted">{who(c.author_id)} · {fmtDateTime(c.created_at)}{c.internal && ' · internal note'}</div>
                  <div>{c.body}</div>
                </li>
              ))}
              {!comments.length && <li className="muted small">No comments yet</li>}
            </ul>
            {r.status !== 'removed' && (
              <form onSubmit={async (e) => { e.preventDefault(); const text = body; setBody(''); setInternal(false); if (!(await call('add_comment', { p_request: r.id, p_body: text, p_internal: internal }))) setBody(text) }}
                style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <textarea rows={2} value={body} onChange={(e) => setBody(e.target.value)} aria-label="Write a comment" placeholder="Write a comment" />
                <div className="row">
                  <button className="btn primary small" disabled={!body.trim()}>Post comment</button>
                  {!has('introducer') && <label className="row small" style={{ gap: 6 }}>
                    <input type="checkbox" checked={internal} onChange={(e) => setInternal(e.target.checked)} /> Internal note (hidden from the introducer)
                  </label>}
                </div>
              </form>
            )}
          </section>
          )}
        </div>

        <aside className="side" style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          {has('bsd') && !['completed', 'removed'].includes(r.status) && (
            <section className="card" aria-label="Assign">
              <h2 className="eyebrow">Assign</h2>
              <select aria-label="Assign to" value={assignTo || r.assignee_id || ''} onChange={(e) => setAssignTo(e.target.value)}>
                <option value="">Choose an ops user</option>
                {ops.map((p) => <option key={p.id} value={p.id}>{p.full_name}</option>)}
              </select>
              <div><button className="btn small" disabled={!assignTo || assignTo === r.assignee_id}
                onClick={async () => { if (await call('assign_request', { p_request: r.id, p_user: assignTo })) setAssignTo('') }}>
                {r.assignee_id ? 'Reassign' : 'Assign'}</button></div>
            </section>
          )}
          <section className="card" aria-label="Activity">
            <h2 className="eyebrow">Activity</h2>
            <ol className="timeline">
              {events.map((e) => (
                <li key={e.id}>
                  <strong>{EVENT_LABEL[e.kind] ?? e.kind}</strong>{e.detail && <span> · {e.detail}</span>}
                  <div className="small muted">{who(e.actor_id)} · {fmtDateTime(e.at)}</div>
                </li>
              ))}
            </ol>
          </section>
        </aside>
      </div>

      {dialog === 'send_back' && (
        <ReasonDialog title="Send back to the introducer" confirmLabel="Send back" onCancel={() => setDialog(null)}
          onConfirm={(reason) => { setDialog(null); call('change_status', { p_request: r.id, p_to: 'sent_back', p_reason: reason }) }} />
      )}
      {dialog === 'reopen' && (
        <ReasonDialog title={`Reopen ${r.ref}`} fieldLabel="What does the client want changed?" confirmLabel="Reopen request" onCancel={() => setDialog(null)}
          onConfirm={(reason) => { setDialog(null); call('reopen_request', { p_request: r.id, p_reason: reason }) }} />
      )}
      {dialog === 'remove' && (
        <ReasonDialog title={`Remove ${r.ref}`} confirmLabel="Remove request" onCancel={() => setDialog(null)}
          onConfirm={(reason) => { setDialog(null); call('remove_request', { p_request: r.id, p_reason: reason }) }} />
      )}
    </main>
  )
}
