import { useCallback, useEffect, useState } from 'react'
import { NavLink, Navigate, Route, Routes } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { ROLE_LABEL, fmtDateTime, fmtHours } from '../lib/options'
import { forgetSettings } from '../lib/settings'
import type { AppSettings, AuditRow, Profile, Role } from '../lib/types'

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
    if (error) setError(error.message); else setSaved(`Saved ${p.email}`)
    load()
  }
  const edit = (id: string, patch: Partial<Profile>) => setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)))

  return (
    <>
    <AddUser onCreated={load} />
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

/** A readable temporary password, e.g. "Kite-7342-Moss". */
function tempPassword() {
  const words = ['Kite', 'Moss', 'Reef', 'Pine', 'Lark', 'Opal', 'Fern', 'Dune', 'Cove', 'Teal', 'Wren', 'Jade']
  const n = new Uint32Array(3); crypto.getRandomValues(n)
  return `${words[n[0] % words.length]}-${1000 + (n[1] % 9000)}-${words[n[2] % words.length]}`
}

const BLANK = { full_name: '', email: '', role: 'introducer' as Role, company: '', password: '' }

/** bsd creates a login with a role straight away (runs the admin-create-user server function). */
function AddUser({ onCreated }: { onCreated: () => void }) {
  const [f, setF] = useState({ ...BLANK, password: tempPassword() })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState<{ email: string; password: string; role: Role } | null>(null)
  const set = (patch: Partial<typeof f>) => setF((x) => ({ ...x, ...patch }))

  async function create(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true); setError(''); setDone(null)
    const { data, error } = await supabase.functions.invoke('admin-create-user', {
      body: { ...f, company: f.role === 'introducer' ? f.company : '' },
    })
    setBusy(false)
    if (error) {
      let msg = error.message
      const ctx = (error as { context?: Response }).context
      if (ctx && typeof ctx.json === 'function') {
        try { msg = (await ctx.json()).error ?? msg } catch { /* not JSON */ }
      } else if (/fetch|send a request|not found/i.test(msg)) {
        msg = 'Could not reach the user-creation function. It may not be deployed yet (see supabase/cloud/README.md, "Let bsd create users").'
      }
      setError(msg)
      return
    }
    setDone({ email: data.email, password: f.password, role: f.role })
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

function Audit() {
  const [rows, setRows] = useState<AuditRow[]>([])
  useEffect(() => {
    supabase.from('audit_log').select('*').order('at', { ascending: false }).limit(200)
      .then(({ data }) => setRows((data as AuditRow[]) ?? []))
  }, [])
  return (
    <div className="card">
      <div className="tablewrap">
        <table>
          <thead><tr><th>When</th><th>Action</th><th>Target</th><th>Details</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>{fmtDateTime(r.at)}</td><td>{r.action}</td><td>{r.entity_id}</td>
                <td className="small muted">{Object.keys(r.details).length ? JSON.stringify(r.details) : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.length && <div className="empty">Nothing logged yet.</div>}
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
    if (error) setError(error.message)
    else { setSaved('Saved. Open requests now follow the new deadline.'); forgetSettings(s) }
    load()
  }
  const num = (v: string) => Math.max(0, Math.round(Number(v) || 0))
  return (
    <div className="card" style={{ maxWidth: 620 }}>
      <p className="small muted" style={{ margin: 0 }}>
        Requests are due a set time after they are submitted. Ops and bsd see them in orange when the "due soon" window starts,
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
