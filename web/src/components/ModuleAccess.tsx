import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import { ROLE_LABEL, says } from '../lib/options'
import { loadModules, type AppModule } from '../lib/modules'
import type { Profile, Role } from '../lib/types'

const ROLES: Role[] = ['introducer', 'ops', 'bsd']
type Defaults = Record<string, boolean>            // `${module}:${role}` -> on
type Overrides = Record<string, boolean>           // `${user}:${module}` -> on

/**
 * Admin: which modules each person can open. A role gives everyone in it a default; a per-user switch overrides
 * it. Inside a module the role still decides what the person sees and does. The database enforces all of this.
 */
export default function ModuleAccess() {
  const [mods, setMods] = useState<AppModule[]>([])
  const [defs, setDefs] = useState<Defaults>({})
  const [over, setOver] = useState<Overrides>({})
  const [users, setUsers] = useState<Profile[]>([])
  const [q, setQ] = useState('')
  const [roleFilter, setRoleFilter] = useState<'' | Role>('')
  const [error, setError] = useState('')
  const [saved, setSaved] = useState('')

  const load = useCallback(async () => {
    const [m, d, o, u] = await Promise.all([
      loadModules(),
      supabase.from('module_role_defaults').select('module_key, role, enabled'),
      supabase.from('user_module_access').select('user_id, module_key, enabled'),
      supabase.from('profiles').select('*').order('full_name'),
    ])
    setMods(m)
    setDefs(Object.fromEntries((d.data ?? []).map((r) => [`${r.module_key}:${r.role}`, r.enabled])))
    setOver(Object.fromEntries((o.data ?? []).map((r) => [`${r.user_id}:${r.module_key}`, r.enabled])))
    setUsers(((u.data as Profile[]) ?? []).filter((p) => p.role && p.role !== 'admin'))
  }, [])
  useEffect(() => { load() }, [load])

  async function run(fn: string, args: Record<string, unknown>, msg: string) {
    setError(''); setSaved('')
    const { error } = await supabase.rpc(fn, args)
    if (error) setError(says(error.message)); else setSaved(msg)
    load()
  }

  const shown = useMemo(() => {
    const s = q.trim().toLowerCase()
    return users.filter((u) => (!roleFilter || u.role === roleFilter) &&
      (!s || `${u.full_name} ${u.email} ${u.company}`.toLowerCase().includes(s)))
  }, [users, q, roleFilter])

  const name = (u: Profile) => u.full_name || u.email
  const onOff = (b: boolean) => (b ? 'On' : 'Off')

  return (
    <>
      <div className="card">
        <h2 style={{ margin: 0 }}>Role defaults</h2>
        <p className="small muted" style={{ margin: 0 }}>
          What everyone in a role gets unless you change it for that person below. A dash means the module can't be
          given to that role. Admin pages stay with the Admin role and aren't switched here.
        </p>
        {error && <div className="error" role="alert">{error}</div>}
        {saved && <div className="small" role="status" style={{ color: 'var(--ok)' }}>{saved}</div>}
        <div className="tablewrap">
          <table className="access">
            <thead><tr><th>Module</th>{ROLES.map((r) => <th key={r}>{ROLE_LABEL[r]}</th>)}</tr></thead>
            <tbody>
              {mods.map((m) => (
                <tr key={m.key}>
                  <td><strong>{m.name}</strong>{!m.live && <span className="chip" style={{ marginLeft: 6 }}>Coming soon</span>}
                    <div className="small muted">{m.description}</div></td>
                  {ROLES.map((r) => (
                    <td key={r}>{m.roles.includes(r) ? (
                      <input type="checkbox" aria-label={`${m.name} for ${ROLE_LABEL[r]} by default`}
                        checked={!!defs[`${m.key}:${r}`]}
                        onChange={(e) => run('admin_set_role_module', { p_role: r, p_module: m.key, p_enabled: e.target.checked },
                          `${m.name} is now ${e.target.checked ? 'on' : 'off'} by default for ${ROLE_LABEL[r]}`)} />
                    ) : <span className="muted" aria-label="Not available for this role">—</span>}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <h2 style={{ margin: 0 }}>Per person</h2>
        <p className="small muted" style={{ margin: 0 }}>
          Change one person without changing their role. "Default" follows the table above. Changes apply the next
          time the person opens or refreshes the app.
        </p>
        <div className="row">
          <input type="search" style={{ maxWidth: 320 }} placeholder="Search name, email or firm" aria-label="Search people" value={q} onChange={(e) => setQ(e.target.value)} />
          <select style={{ maxWidth: 200 }} aria-label="Filter by role" value={roleFilter} onChange={(e) => setRoleFilter(e.target.value as '' | Role)}>
            <option value="">All roles</option>
            {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
          </select>
        </div>
        <div className="tablewrap">
          <table className="access">
            <thead><tr><th>Person</th>{mods.map((m) => <th key={m.key}>{m.name}</th>)}</tr></thead>
            <tbody>
              {shown.map((u) => (
                <tr key={u.id}>
                  <td>{name(u)}<div className="small muted">{ROLE_LABEL[u.role!]}{u.company ? ` · ${u.company}` : ''}{!u.active ? ' · inactive' : ''}</div></td>
                  {mods.map((m) => {
                    if (!m.roles.includes(u.role!)) return <td key={m.key}><span className="muted" aria-label="Not available for this role">—</span></td>
                    const o = over[`${u.id}:${m.key}`]
                    const value = o === undefined ? 'default' : o ? 'on' : 'off'
                    return (
                      <td key={m.key}>
                        <select aria-label={`${m.name} for ${name(u)}`} value={value}
                          className={o === undefined ? '' : 'changed'}
                          onChange={(e) => {
                            const v = e.target.value
                            run('admin_set_user_module', { p_user: u.id, p_module: m.key, p_enabled: v === 'default' ? null : v === 'on' },
                              `${m.name} for ${name(u)}: ${v === 'default' ? 'back to the role default' : v}`)
                          }}>
                          <option value="default">Default ({onOff(!!defs[`${m.key}:${u.role}`])})</option>
                          <option value="on">On</option>
                          <option value="off">Off</option>
                        </select>
                      </td>
                    )
                  })}
                </tr>
              ))}
              {shown.length === 0 && <tr><td colSpan={mods.length + 1} className="muted">No one matches.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </>
  )
}
