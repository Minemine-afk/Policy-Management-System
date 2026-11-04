import { useEffect, useState, type FormEvent } from 'react'
import { Link, NavLink, Navigate, Route, Routes } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { AGE_BANDS, COVERAGE_TERMS, GENDERS, ROLE_LABEL, STATUS_LABEL, SUM_ASSURED_BANDS, fmtDate } from '../lib/options'
import { parseRateCsv } from '../lib/csv'
import type { PolicyRequest, Profile, RateTable, Role } from '../lib/types'
import { StatusPill } from '../components/ui'

export default function Admin() {
  const cls = ({ isActive }: { isActive: boolean }) => `btn small ${isActive ? 'primary' : ''}`
  return (
    <main className="page">
      <h1>Admin</h1>
      <nav className="row" aria-label="Admin sections">
        <NavLink to="/admin/requests" className={cls}>All requests</NavLink>
        <NavLink to="/admin/users" className={cls}>Users and roles</NavLink>
        <NavLink to="/admin/rates" className={cls}>Rate tables</NavLink>
        <NavLink to="/admin/audit" className={cls}>Audit log</NavLink>
      </nav>
      <Routes>
        <Route path="requests" element={<AllRequests />} />
        <Route path="users" element={<Users />} />
        <Route path="rates" element={<Rates />} />
        <Route path="audit" element={<Audit />} />
        <Route path="*" element={<Navigate to="requests" replace />} />
      </Routes>
    </main>
  )
}

function useProfiles() {
  const [people, setPeople] = useState<Record<string, Profile>>({})
  const load = () => supabase.from('profiles').select('*').order('full_name')
    .then(({ data }) => setPeople(Object.fromEntries(((data as Profile[]) ?? []).map((p) => [p.id, p]))))
  useEffect(() => { load() }, [])
  return { people, reload: load }
}

function AllRequests() {
  const [rows, setRows] = useState<PolicyRequest[]>([])
  const [status, setStatus] = useState('')
  const { people } = useProfiles()
  useEffect(() => {
    let q = supabase.from('policy_requests').select('*').order('created_at', { ascending: false })
    if (status) q = q.eq('status', status)
    q.then(({ data }) => setRows((data as PolicyRequest[]) ?? []))
  }, [status])
  const counts = rows.reduce<Record<string, number>>((m, r) => ({ ...m, [r.status]: (m[r.status] ?? 0) + 1 }), {})
  return (
    <div className="card">
      <div className="row between">
        <label className="field" style={{ maxWidth: 260 }}>Status
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All (pending and completed)</option>
            {Object.entries(STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select></label>
        {!status && <div className="small muted">{Object.entries(counts).map(([k, n]) => `${STATUS_LABEL[k]}: ${n}`).join(' · ')}</div>}
      </div>
      <div className="tablewrap">
        <table>
          <thead><tr><th>Reference</th><th>Profile</th><th>Status</th><th>Submitted by</th><th>Decided by</th><th>Submitted</th></tr></thead>
          <tbody>{rows.map((r) => (
            <tr key={r.id}>
              <td><Link to={`/requests/${r.id}`}>{r.ref}</Link></td>
              <td>{r.product} · {r.age_band} · {r.sum_assured_band}</td>
              <td><StatusPill status={r.status} /></td>
              <td>{people[r.submitter_id]?.full_name ?? '—'}</td>
              <td>{r.decided_by ? people[r.decided_by]?.full_name : '—'}</td>
              <td>{fmtDate(r.submitted_at)}</td>
            </tr>))}</tbody>
        </table>
        {rows.length === 0 && <div className="empty">No requests.</div>}
      </div>
    </div>
  )
}

const ROLES: Role[] = ['submitter', 'approver', 'content_editor', 'admin']

function Users() {
  const { people, reload } = useProfiles()
  const { profile } = useAuth()
  const [error, setError] = useState('')
  async function update(p: Profile, roles: Role[], active: boolean) {
    setError('')
    const { error } = await supabase.rpc('admin_update_user', { p_user: p.id, p_roles: roles, p_active: active })
    if (error) setError(error.message)
    reload()
  }
  return (
    <div className="card">
      <p className="small muted" style={{ margin: 0 }}>
        People appear here after their first Microsoft sign-in, with no access until you tick a role.
        Deactivate leavers instead of deleting them, so the audit trail keeps their name.
      </p>
      {error && <div className="error" role="alert">{error}</div>}
      <div className="tablewrap">
        <table>
          <thead><tr><th>Name</th><th>Email</th>{ROLES.map((r) => <th key={r}>{ROLE_LABEL[r]}</th>)}<th>Active</th></tr></thead>
          <tbody>{Object.values(people).map((p) => (
            <tr key={p.id} style={!p.active ? { opacity: 0.55 } : undefined}>
              <td><strong>{p.full_name || '—'}</strong>{p.id === profile?.id && <span className="small muted"> (you)</span>}</td>
              <td>{p.email}</td>
              {ROLES.map((r) => (
                <td key={r}><input type="checkbox" aria-label={`${ROLE_LABEL[r]} for ${p.full_name}`} checked={p.roles.includes(r)}
                  onChange={(e) => update(p, e.target.checked ? [...p.roles, r] : p.roles.filter((x) => x !== r), p.active)} /></td>
              ))}
              <td><button className="linkbtn" onClick={() => update(p, p.roles, !p.active)}>{p.active ? 'Deactivate' : 'Reactivate'}</button></td>
            </tr>))}</tbody>
        </table>
      </div>
    </div>
  )
}

function Rates() {
  const { profile } = useAuth()
  const { people } = useProfiles()
  const [tables, setTables] = useState<RateTable[]>([])
  const [counts, setCounts] = useState<Record<string, number>>({})
  const [form, setForm] = useState({ insurer: '', product_name: 'Term plan + CI rider', rates_as_at: '' })
  const [file, setFile] = useState<File | null>(null)
  const [msg, setMsg] = useState<{ ok: boolean; text: string[] } | null>(null)

  async function load() {
    const { data } = await supabase.from('rate_tables').select('*').order('insurer').order('version', { ascending: false })
    setTables((data as RateTable[]) ?? [])
    const c: Record<string, number> = {}
    for (const t of (data as RateTable[]) ?? []) {
      const { count } = await supabase.from('rate_rows').select('id', { count: 'exact', head: true }).eq('rate_table_id', t.id)
      c[t.id] = count ?? 0
    }
    setCounts(c)
  }
  useEffect(() => { load() }, [])

  async function upload(e: FormEvent) {
    e.preventDefault()
    if (!file || !profile) return
    const { rows, errors } = parseRateCsv(await file.text(), {
      age_band: AGE_BANDS, gender: GENDERS, coverage_term: COVERAGE_TERMS, sum_assured_band: SUM_ASSURED_BANDS,
    })
    if (errors.length) { setMsg({ ok: false, text: errors }); return }
    const version = Math.max(0, ...tables.filter((t) => t.insurer === form.insurer).map((t) => t.version)) + 1
    const { data: t, error } = await supabase.from('rate_tables')
      .insert({ ...form, version, uploaded_by: profile.id }).select('id').single()
    if (error || !t) { setMsg({ ok: false, text: [error?.message ?? 'Upload failed'] }); return }
    for (let i = 0; i < rows.length; i += 500) {
      const res = await supabase.from('rate_rows').insert(rows.slice(i, i + 500).map((r) => ({ ...r, rate_table_id: t.id })))
      if (res.error) { setMsg({ ok: false, text: [res.error.message] }); return }
    }
    setMsg({ ok: true, text: [`Uploaded ${rows.length} rows as ${form.insurer} v${version}. A second admin must approve it before it is used.`] })
    setFile(null); load()
  }

  async function approve(t: RateTable) {
    const { error } = await supabase.rpc('approve_rate_table', { p_table: t.id })
    setMsg(error ? { ok: false, text: [error.message] } : { ok: true, text: [`${t.insurer} v${t.version} is now live.`] })
    load()
  }

  return (
    <>
      <form className="card" onSubmit={upload} aria-label="Upload rate table">
        <h2>Upload a rate table</h2>
        <p className="small muted" style={{ margin: 0 }}>
          Only when an insurer changes its rates. One CSV per insurer with the columns age_band, gender, smoker,
          coverage_term, sum_assured_band, ci_benefit, premium_low, premium_high (annual S$). See <code>docs/rate-table-template.csv</code>.
        </p>
        <div className="grid">
          <label className="field">Insurer<input type="text" required value={form.insurer} onChange={(e) => setForm({ ...form, insurer: e.target.value })} list="insurers" />
            <datalist id="insurers">{[...new Set(tables.map((t) => t.insurer))].map((i) => <option key={i} value={i} />)}</datalist></label>
          <label className="field">Product name<input type="text" required value={form.product_name} onChange={(e) => setForm({ ...form, product_name: e.target.value })} /></label>
          <label className="field">Rates as at<input type="date" required value={form.rates_as_at} onChange={(e) => setForm({ ...form, rates_as_at: e.target.value })} /></label>
          <label className="field">CSV file<input type="file" accept=".csv,text/csv" required onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></label>
        </div>
        <div className="row"><button className="btn primary">Upload for approval</button></div>
      </form>
      {msg && <div className={`notice ${msg.ok ? '' : 'bad'}`} role="status"><div>{msg.text.map((t) => <div key={t}>{t}</div>)}</div></div>}
      <div className="card">
        <div className="tablewrap">
          <table>
            <thead><tr><th>Insurer</th><th>Product</th><th>Version</th><th>Rates as at</th><th className="num">Rows</th><th>Status</th><th>Uploaded by</th><th>Approved by</th><th /></tr></thead>
            <tbody>{tables.map((t) => (
              <tr key={t.id}>
                <td>{t.insurer}</td><td>{t.product_name}</td><td>v{t.version}</td><td>{t.rates_as_at}</td>
                <td className="num">{counts[t.id] ?? '…'}</td>
                <td><span className={`pill ${t.status === 'approved' ? 'ok' : t.status === 'pending' ? 'warn' : 'grey'}`}>{t.status === 'approved' ? 'Live' : t.status}</span></td>
                <td>{t.uploaded_by ? people[t.uploaded_by]?.full_name : '—'}</td>
                <td>{t.approved_by ? people[t.approved_by]?.full_name : '—'}</td>
                <td>{t.status === 'pending' && (t.uploaded_by === profile?.id
                  ? <span className="small muted">Needs another admin</span>
                  : <button className="btn small primary" onClick={() => approve(t)}>Approve</button>)}</td>
              </tr>))}</tbody>
          </table>
        </div>
      </div>
    </>
  )
}

interface AuditRow { id: number; at: string; actor_id: string | null; action: string; entity: string; entity_id: string | null; details: Record<string, unknown> }

function Audit() {
  const { people } = useProfiles()
  const [rows, setRows] = useState<AuditRow[]>([])
  const [filter, setFilter] = useState('')
  useEffect(() => {
    let q = supabase.from('audit_log').select('*').order('at', { ascending: false }).limit(300)
    if (filter) q = q.like('action', `${filter}%`)
    q.then(({ data }) => setRows((data as AuditRow[]) ?? []))
  }, [filter])
  const reported = rows.filter((r) => r.action === 'document.reported_unredacted')
  return (
    <>
      {reported.length > 0 && !filter && (
        <div className="notice bad"><strong>{reported.length} file{reported.length > 1 ? 's' : ''} reported as unredacted</strong>
          <button className="linkbtn" onClick={() => setFilter('document.reported')}>Show</button></div>
      )}
      <div className="card">
        <label className="field" style={{ maxWidth: 280 }}>Show
          <select value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="">Everything</option>
            <option value="request.">Request decisions</option>
            <option value="document.reported">Reported unredacted files</option>
            <option value="document.viewed">Document views</option>
            <option value="user.">User and role changes</option>
            <option value="rate_table">Rate tables</option>
          </select></label>
        <div className="tablewrap">
          <table>
            <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Item</th><th>Details</th></tr></thead>
            <tbody>{rows.map((r) => (
              <tr key={r.id}>
                <td style={{ whiteSpace: 'nowrap' }}>{new Date(r.at).toLocaleString('en-SG')}</td>
                <td>{r.actor_id ? people[r.actor_id]?.full_name ?? r.actor_id.slice(0, 8) : 'System'}</td>
                <td>{r.action}</td>
                <td className="small">{r.entity} {r.entity_id?.slice(0, 18)}</td>
                <td className="small muted">{Object.keys(r.details ?? {}).length ? JSON.stringify(r.details) : ''}</td>
              </tr>))}</tbody>
          </table>
        </div>
      </div>
    </>
  )
}
