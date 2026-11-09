import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { fmtDateTime } from '../lib/options'
import { useAuth } from '../lib/auth'
import type { Notice } from '../lib/notifications'

const ICON: Record<string, string> = {
  sent_back: '↩', completed: '✓', due_soon: '⏰', overdue: '⚠', assigned: '→', resubmitted: '↻', comment: '💬',
  urgent: '❗', reopened: '↺',
}

export default function Notifications() {
  const { profile } = useAuth()
  const [rows, setRows] = useState<Notice[] | null>(null)
  const [email, setEmail] = useState<boolean | null>(null)
  const load = useCallback(async () => {
    const { data } = await supabase.from('notifications').select('*').order('created_at', { ascending: false }).limit(100)
    setRows((data as Notice[]) ?? [])
  }, [])
  useEffect(() => { load() }, [load])
  useEffect(() => {
    if (!profile) return
    supabase.from('profiles').select('email_alerts').eq('id', profile.id).maybeSingle()
      .then(({ data }) => setEmail(data?.email_alerts ?? true))
  }, [profile])

  async function toggleEmail(on: boolean) {
    setEmail(on)
    const { error } = await supabase.rpc('set_email_alerts', { p_on: on })
    if (error) setEmail(!on)
  }

  async function markRead(ids: string[] | null) {
    await supabase.rpc('mark_notifications_read', { p_ids: ids })
    window.dispatchEvent(new Event('notifications-changed'))
    load()
  }

  if (!rows) return <div className="empty">Loading…</div>
  const unread = rows.filter((n) => !n.read_at).length
  return (
    <main className="page">
      <div className="row between">
        <h1>Notifications</h1>
        {unread > 0 && <button className="btn" onClick={() => markRead(null)}>Mark all as read</button>}
      </div>
      {email !== null && (
        <label className="row small" style={{ gap: 6 }}>
          <input type="checkbox" checked={email} onChange={(e) => toggleEmail(e.target.checked)} />
          Also email me these notifications{profile?.email ? ` at ${profile.email}` : ''} (once the admin has switched on email alerts)
        </label>
      )}
      <div className="card" style={{ padding: 0 }}>
        <ul className="notices">
          {rows.map((n) => (
            <li key={n.id} className={`${n.read_at ? '' : 'unread'} ${n.kind}`}>
              <span className="nicon" aria-hidden="true">{ICON[n.kind] ?? '•'}</span>
              <Link to={`/requests/${n.request_id}`} onClick={() => !n.read_at && markRead([n.id])}>{n.message}</Link>
              <span className="small muted">{fmtDateTime(n.created_at)}</span>
            </li>
          ))}
        </ul>
        {!rows.length && <div className="empty">No notifications yet.</div>}
      </div>
    </main>
  )
}
