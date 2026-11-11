import { useCallback, useEffect, useState } from 'react'
import { NavLink, Navigate, Route, Routes } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { ROLE_LABEL, fmtDateTime, fmtHours, says } from '../lib/options'
import { forgetSettings } from '../lib/settings'
import { nameOf, usePeople } from '../lib/people'
import { auditActionLabel, describeAudit } from '../lib/audit'
import type { AppSettings, AuditRow, Profile, Role } from '../lib/types'
import { createUser, tempPassword } from '../lib/users'
import UserCsv from '../components/UserCsv'

export default function Admin() {
  const cls = ({ isActive }: { isActive: boolean }) => `btn small ${isActive ? 'primary' : ''}`
  return (
    <main className="page">
      <h1>Admin</h1>
      <nav className="row" aria-label="Admin sections">
        <NavLink to="/admin/users" className={cls}>Users and roles</NavLink>
        <NavLink to="/admin/settings" className={cls}>Deadline settings</NavLink>
        <NavLink to="/admin/audit" className={cls}>Audit log</NavLink>
      </nav>
      <Routes>
        <Route path="users" element={<Users />} />
        <Route path="audit" element={<Audit />} />
        <Route path="settings" element={<Settings />} />
        <Route path="*" element={<Navigate to="users" replace />} />
      </Routes>
    </main>
  )
}

function Users() {
  const { profile } = useAuth()
  const [rows, setRows] = useState<Profile[]>([])
  const [error, setError] = useState('')
  const [saved, setSaved] = useState('')
  const load = useCallback(() => supabase.from('profiles').select('*').order('created_at')
    .then(({ data }) => setRows((data as Profile[]) ?? [])), [])
  useEffect(() => { load() }, [load])

  async function save(p: Profile) {
    setError(''); setSaved('')
    const { error } = await supabase.rpc('admin_update_user', {
      p_user: p.id, p_role: p.role, p_active: p.active, p_full_name: p.full_name, p_company: p.company,
    })
    if (error) setError(says(error.message)); else setSaved(`Saved ${p.email}`)
    load()
  }
  const edit = (id: string, patch: Partial<Profile>) => setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)))

  return (
    <>
    <AddUser onCreated={load} />
    <UserCsv myId={profile?.id ?? ''} onChanged={load} />
    <div className="card">
      <h2 style={{ margin: 0 }}>Everyone</h2>
      {error && <div className="error" role="alert">{error}</div>}
      {saved && <div className="small" role="status" style={{ color: 'var(--ok)' }}>{saved}</div>}
      <div className="tablewrap">
        <table>
          <thead><tr><th>Name</th><th>Email</th><th>Firm (introducers)</th><th>Role</th><th>Active</th><th /></tr></thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.id}>
                <td><input type="text" aria-label={`Name for ${p.email}`} value={p.full_name} onChange={(e) => edit(p.id, { full_name: e.target.value })} /></td>
                <td>{p.email}{p.id === profile?.id && <span className="chip" style={{ marginLeft: 6 }}>you</span>}</td>
                <td><input type="text" aria-label={`Firm for ${p.email}`} value={p.company} onChange={(e) => edit(p.id, { company: e.target.value })} /></td>
                <td>
                  <select aria-label={`Role for ${p.email}`} value={p.role ?? ''} onChange={(e) => edit(p.id, { role: (e.target.value || null) as Role | null })}>
                    <option value="">No role</option>
                    {Object.entries(ROLE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                  </select>
                </td>
                <td><input type="checkbox" aria-label={`Active ${p.email}`} checked={p.active} onChange={(e) => edit(p.id, { active: e.target.checked })} /></td>
                <td><button className="btn small" onClick={() => save(p)}>Save</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
    </>
  )
}

const BLANK = { full_name: '', email: '', role: 'introducer' as Role, company: '', password: '' }

/** An admin creates a login with a role straight away (runs the admin-create-user server function). */
function AddUser({ onCreated }: { onCreated: () => void }) {
  const [f, setF] = useState({ ...BLANK, password: tempPassword() })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState<{ email: string; password: string; role: Role } | null>(null)
  const set = (patch: Partial<typeof f>) => setF((x) => ({ ...x, ...patch }))

  async function create(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true); setError(''); setDone(null)
    const msg = await createUser(f)
    setBusy(false)
    if (msg) { setError(msg); return }
    setDone({ email: f.email.trim().toLowerCase(), password: f.password, role: f.role })
    setF({ ...BLANK, role: f.role, company: f.role === 'introducer' ? f.company : '', password: tempPassword() })
    onCreated()
  }

  return (
    <form className="card" onSubmit={create} aria-label="Add a user">
      <h2 style={{ margin: 0 }}>Add a user</h2>
      <p className="small muted" style={{ margin: 0 }}>
        The account works straight away with the role you pick. Give the person their email and temporary password
        privately; they can change it under Account after signing in.
      </p>
      <div className="grid">
        <label className="field">Name
          <input type="text" required value={f.full_name} onChange={(e) => set({ full_name: e.target.value })} />
        </label>
        <label className="field">Email
          <input type="email" required value={f.email} onChange={(e) => set({ email: e.target.value })} />
        </label>
        <label className="field">Role
          <select value={f.role} onChange={(e) => set({ role: e.target.value as Role })}>
            {Object.entries(ROLE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
        {f.role === 'introducer' && (
          <label className="field">Firm
            <input type="text" value={f.company} onChange={(e) => set({ company: e.target.value })} />
          </label>
        )}
        <label className="field">Temporary password
          <span className="row" style={{ gap: 8, flexWrap: 'nowrap' }}>
            <input type="text" required minLength={8} value={f.password} onChange={(e) => set({ password: e.target.value })}
              aria-label="Temporary password" style={{ flex: 1, minWidth: 0 }} />
            <button type="button" className="btn small" onClick={() => set({ password: tempPassword() })}>New</button>
          </span>
        </label>
      </div>
      {error && <div className="error" role="alert">{error}</div>}
      {done && (
        <div className="small" role="status" style={{ color: 'var(--ok)' }}>
          Created {done.email} as {ROLE_LABEL[done.role]}. Temporary password: <code>{done.password}</code>
        </div>
      )}
      <div className="row"><button className="btn primary" disabled={busy}>{busy ? 'Creating…' : 'Create user'}</button></div>
    </form>
  )
}

const AUDIT_LIMIT = 500
const NO_AUDIT_FILTER = { from: '', to: '', who: '', role: '', action: '' }

/** Start of a local calendar day ('2026-11-09') as an ISO timestamp, optionally a number of days later. */
function dayStart(d: string, plusDays = 0) {
  const t = new Date(`${d}T00:00:00`); t.setDate(t.getDate() + plusDays); return t.toISOString()
}

function Audit() {
  const people = usePeople()
  const [rows, setRows] = useState<AuditRow[]>([])
  const [actions, setActions] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [f, setF] = useState(NO_AUDIT_FILTER)
  const set = (patch: Partial<typeof NO_AUDIT_FILTER>) => setF((x) => ({ ...x, ...patch }))
  const everyone = Object.values(people).sort((a, b) => (a.full_name || a.email).localeCompare(b.full_name || b.email))

  // The list of action types for the Action filter (from the latest entries).
  useEffect(() => {
    supabase.from('audit_log').select('action').order('at', { ascending: false }).limit(2000)
      .then(({ data }) => setActions([...new Set(((data as { action: string }[]) ?? []).map((r) => r.action))].sort()))
  }, [])

  useEffect(() => {
    // Role filter means "done by someone who has this role now"; wait for the people list before applying it.
    if (f.role && f.role !== 'system' && !everyone.length) return
    let q = supabase.from('audit_log').select('*').order('at', { ascending: false }).limit(AUDIT_LIMIT)
    if (f.from) q = q.gte('at', dayStart(f.from))
    if (f.to) q = q.lt('at', dayStart(f.to, 1))
    if (f.action) q = q.eq('action', f.action)
    if (f.who === 'system') q = q.is('actor_id', null)
    else if (f.who) q = q.eq('actor_id', f.who)
    if (f.role === 'system') q = q.is('actor_id', null)
    else if (f.role) {
      const ids = everyone.filter((p) => p.role === f.role).map((p) => p.id)
      q = q.in('actor_id', ids.length ? ids : ['00000000-0000-0000-0000-000000000000'])
    }
    let stale = false
    setLoading(true)
    q.then(({ data }) => { if (!stale) { setRows((data as AuditRow[]) ?? []); setLoading(false) } })
    return () => { stale = true }
  }, [f, everyone.length])

  const filtered = Object.values(f).some(Boolean)
  const whoOf = (id: string | null) => (id ? nameOf(people, id) : 'System')
  const roleOf = (id: string | null) => (id ? (people[id]?.role ? ROLE_LABEL[people[id].role!] : 'No role') : '—')

  return (
    <div className="card">
      <div className="row" style={{ alignItems: 'flex-end' }}>
        <label className="field" style={{ maxWidth: 160 }}>From
          <input type="date" value={f.from} onChange={(e) => set({ from: e.target.value })} />
        </label>
        <label className="field" style={{ maxWidth: 160 }}>To
          <input type="date" value={f.to} onChange={(e) => set({ to: e.target.value })} />
        </label>
        <label className="field" style={{ maxWidth: 220 }}>User
          <select value={f.who} onChange={(e) => set({ who: e.target.value })}>
            <option value="">Anyone</option>
            <option value="system">System (automatic)</option>
            {everyone.map((p) => <option key={p.id} value={p.id}>{p.full_name || p.email}</option>)}
          </select>
        </label>
        <label className="field" style={{ maxWidth: 170 }}>Role
          <select value={f.role} onChange={(e) => set({ role: e.target.value })}>
            <option value="">Any</option>
            {Object.entries(ROLE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            <option value="system">System (automatic)</option>
          </select>
        </label>
        <label className="field" style={{ maxWidth: 220 }}>Action
          <select value={f.action} onChange={(e) => set({ action: e.target.value })}>
            <option value="">Any</option>
            {actions.map((a) => <option key={a} value={a}>{auditActionLabel(a)}</option>)}
          </select>
        </label>
        {filtered && <button type="button" className="btn small" onClick={() => setF(NO_AUDIT_FILTER)}>Clear filters</button>}
      </div>
      <div className="small muted" role="status">
        {loading ? 'Loading…' : `${rows.length}${rows.length === AUDIT_LIMIT ? '+' : ''} ${rows.length === 1 ? 'entry' : 'entries'}`}
        {!loading && rows.length === AUDIT_LIMIT && ` (showing the latest ${AUDIT_LIMIT}; narrow the filters to see older ones)`}
        {f.role && f.role !== 'system' && ' · Role is the person\'s current role.'}
      </div>
      <div className="tablewrap">
        <table>
          <thead><tr><th>When</th><th>User</th><th>Role</th><th>What happened</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td style={{ whiteSpace: 'nowrap' }}>{fmtDateTime(r.at)}</td><td>{whoOf(r.actor_id)}</td><td>{roleOf(r.actor_id)}</td>
                <td>{describeAudit(r, people)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!loading && !rows.length && <div className="empty">{filtered ? 'Nothing matches these filters.' : 'Nothing logged yet.'}</div>}
      </div>
    </div>
  )
}

function Settings() {
  const [s, setS] = useState<AppSettings | null>(null)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState('')
  const load = useCallback(() => supabase.from('app_settings').select('deadline_hours, due_soon_hours, pause_when_sent_back').maybeSingle()
    .then(({ data }) => setS(data as AppSettings)), [])
  useEffect(() => { load() }, [load])
  if (!s) return <div className="empty">Loading…</div>

  async function save() {
    if (!s) return
    setError(''); setSaved('')
    const { error } = await supabase.rpc('update_settings', {
      p_deadline_hours: s.deadline_hours, p_due_soon_hours: s.due_soon_hours, p_pause: s.pause_when_sent_back,
    })
    if (error) setError(says(error.message))
    else { setSaved('Saved. Open requests now follow the new deadline.'); forgetSettings(s) }
    load()
  }
  const num = (v: string) => Math.max(0, Math.round(Number(v) || 0))
  return (
    <div className="card" style={{ maxWidth: 620 }}>
      <p className="small muted" style={{ margin: 0 }}>
        Requests are due a set time after they are submitted. Ops and BSD see them in orange when the "due soon" window starts,
        and in red once overdue. Changing the deadline moves the due time of every open request by the same amount.
      </p>
      <div className="grid">
        <label className="field">Deadline (hours after submission)
          <input type="number" min={1} max={720} value={s.deadline_hours} onChange={(e) => setS({ ...s, deadline_hours: num(e.target.value) })} />
          <span className="small muted">{s.deadline_hours > 0 ? fmtHours(s.deadline_hours) : ''}</span>
        </label>
        <label className="field">Warn when this many hours are left
          <input type="number" min={0} max={719} value={s.due_soon_hours} onChange={(e) => setS({ ...s, due_soon_hours: num(e.target.value) })} />
          <span className="small muted">{fmtHours(s.due_soon_hours)}</span>
        </label>
      </div>
      <label className="row small" style={{ gap: 6 }}>
        <input type="checkbox" checked={s.pause_when_sent_back} onChange={(e) => setS({ ...s, pause_when_sent_back: e.target.checked })} />
        Pause the clock while a request is sent back to the introducer
      </label>
      {error && <div className="error" role="alert">{error}</div>}
      {saved && <div className="small" role="status" style={{ color: 'var(--ok)' }}>{saved}</div>}
      <div><button className="btn primary" onClick={save}>Save settings</button></div>
    </div>
  )
}
