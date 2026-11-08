import { useCallback, useEffect, useState } from 'react'
import { NavLink, Navigate, Route, Routes } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { ROLE_LABEL, fmtDateTime } from '../lib/options'
import type { AuditRow, Profile, Role } from '../lib/types'

export default function Admin() {
  const cls = ({ isActive }: { isActive: boolean }) => `btn small ${isActive ? 'primary' : ''}`
  return (
    <main className="page">
      <h1>Admin</h1>
      <nav className="row" aria-label="Admin sections">
        <NavLink to="/admin/users" className={cls}>Users and roles</NavLink>
        <NavLink to="/admin/audit" className={cls}>Audit log</NavLink>
      </nav>
      <Routes>
        <Route path="users" element={<Users />} />
        <Route path="audit" element={<Audit />} />
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
    <div className="card">
      <p className="small muted" style={{ margin: 0 }}>
        Create accounts in the Supabase dashboard (Authentication → Users). They appear here with no role until you assign one.
      </p>
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
