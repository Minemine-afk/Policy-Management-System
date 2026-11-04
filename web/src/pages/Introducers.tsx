import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { fmtDate } from '../lib/options'
import type { Introducer } from '../lib/types'

type SortKey = 'name' | 'date_added' | 'last_active'
const EMPTY: Partial<Introducer> = { name: '', entity_type: 'Company', specialities: [], status: 'active', disclosure_on_file: false }

export default function Introducers() {
  const { has } = useAuth()
  const admin = has('admin')
  const [rows, setRows] = useState<Introducer[]>([])
  const [q, setQ] = useState('')
  const [spec, setSpec] = useState('')
  const [status, setStatus] = useState('active')
  const [sort, setSort] = useState<SortKey>('last_active')
  const [desc, setDesc] = useState(true)
  const [editing, setEditing] = useState<Partial<Introducer> | null>(null)
  const [error, setError] = useState('')

  const load = () => supabase.from('introducers').select('*').then(({ data }) => setRows((data as Introducer[]) ?? []))
  useEffect(() => { load() }, [])

  const specialities = useMemo(() => [...new Set(rows.flatMap((r) => r.specialities))].sort(), [rows])
  const shown = useMemo(() => {
    const list = rows.filter((r) =>
      (!status || r.status === status) &&
      (!spec || r.specialities.includes(spec)) &&
      (!q || r.name.toLowerCase().includes(q.toLowerCase())))
    return list.sort((a, b) => {
      const av = (a[sort] ?? '') as string, bv = (b[sort] ?? '') as string
      return (av < bv ? -1 : av > bv ? 1 : 0) * (desc ? -1 : 1)
    })
  }, [rows, q, spec, status, sort, desc])

  function sortBy(k: SortKey) { if (k === sort) setDesc(!desc); else { setSort(k); setDesc(k !== 'name') } }
  const arrow = (k: SortKey) => (k === sort ? (desc ? ' ↓' : ' ↑') : '')

  async function save(e: FormEvent) {
    e.preventDefault()
    if (!editing) return
    setError('')
    const { id, ...rest } = editing
    const payload = {
      name: rest.name, entity_type: rest.entity_type, uen_or_ref: rest.uen_or_ref || null,
      specialities: rest.specialities, status: rest.status, date_added: rest.date_added || undefined,
      last_active: rest.last_active || null, agreement_expiry: rest.agreement_expiry || null,
      disclosure_on_file: rest.disclosure_on_file, contact_person: rest.contact_person || null, notes: rest.notes || null,
    }
    const res = id ? await supabase.from('introducers').update(payload).eq('id', id) : await supabase.from('introducers').insert(payload)
    if (res.error) { setError(res.error.message); return }
    setEditing(null); load()
  }

  const expiringSoon = (d: string | null) => !!d && new Date(d).getTime() - Date.now() < 60 * 86_400_000

  return (
    <main className="page">
      <div className="row between">
        <div>
          <h1>Introducers</h1>
          <p className="small muted" style={{ margin: '4px 0 0' }}>Filter by speciality, sort by date added or last active.</p>
        </div>
        {admin && <button className="btn primary" onClick={() => setEditing({ ...EMPTY })}>Add introducer</button>}
      </div>

      {editing && (
        <form className="card" onSubmit={save} aria-label="Introducer details">
          <h2>{editing.id ? 'Edit introducer' : 'New introducer'}</h2>
          <div className="grid">
            <label className="field">Name<input type="text" required value={editing.name ?? ''} onChange={(e) => setEditing({ ...editing, name: e.target.value })} /></label>
            <label className="field">Type
              <select value={editing.entity_type} onChange={(e) => setEditing({ ...editing, entity_type: e.target.value })}>
                <option>Company</option><option>Individual</option></select></label>
            <label className="field">UEN or reference<input type="text" value={editing.uen_or_ref ?? ''} onChange={(e) => setEditing({ ...editing, uen_or_ref: e.target.value })} /></label>
            <label className="field">Specialities (comma separated)
              <input type="text" value={(editing.specialities ?? []).join(', ')}
                onChange={(e) => setEditing({ ...editing, specialities: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })} /></label>
            <label className="field">Status
              <select value={editing.status} onChange={(e) => setEditing({ ...editing, status: e.target.value as Introducer['status'] })}>
                <option value="active">Active</option><option value="suspended">Suspended</option><option value="terminated">Terminated</option></select></label>
            <label className="field">Date added<input type="date" value={editing.date_added ?? ''} onChange={(e) => setEditing({ ...editing, date_added: e.target.value })} /></label>
            <label className="field">Last active<input type="date" value={editing.last_active ?? ''} onChange={(e) => setEditing({ ...editing, last_active: e.target.value })} /></label>
            <label className="field">Agreement expiry<input type="date" value={editing.agreement_expiry ?? ''} onChange={(e) => setEditing({ ...editing, agreement_expiry: e.target.value })} /></label>
            <label className="field">Contact person<input type="text" value={editing.contact_person ?? ''} onChange={(e) => setEditing({ ...editing, contact_person: e.target.value })} /></label>
          </div>
          <label className="row" style={{ gap: 8 }}><input type="checkbox" checked={!!editing.disclosure_on_file} onChange={(e) => setEditing({ ...editing, disclosure_on_file: e.target.checked })} /> FAA-N02 disclosure document on file</label>
          <label className="field">Notes<textarea rows={2} value={editing.notes ?? ''} onChange={(e) => setEditing({ ...editing, notes: e.target.value })} /></label>
          {error && <div className="error">{error}</div>}
          <div className="row"><button className="btn primary">Save</button><button type="button" className="btn" onClick={() => setEditing(null)}>Cancel</button></div>
        </form>
      )}

      <div className="card">
        <div className="grid">
          <label className="field">Search<input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Introducer name" /></label>
          <label className="field">Speciality
            <select value={spec} onChange={(e) => setSpec(e.target.value)}>
              <option value="">All specialities</option>{specialities.map((s) => <option key={s}>{s}</option>)}</select></label>
          <label className="field">Status
            <select value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">All</option><option value="active">Active</option><option value="suspended">Suspended</option><option value="terminated">Terminated</option></select></label>
        </div>
        <div className="tablewrap">
          <table>
            <thead><tr>
              <th><button onClick={() => sortBy('name')}>Name{arrow('name')}</button></th>
              <th>Specialities</th><th>Status</th>
              <th><button onClick={() => sortBy('date_added')}>Date added{arrow('date_added')}</button></th>
              <th><button onClick={() => sortBy('last_active')}>Last active{arrow('last_active')}</button></th>
              <th>Agreement expiry</th>{admin && <th />}
            </tr></thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.id}>
                  <td><strong>{r.name}</strong><div className="small muted">{r.entity_type}{r.uen_or_ref ? ` · ${r.uen_or_ref}` : ''}{!r.disclosure_on_file && ' · disclosure missing'}</div></td>
                  <td><div className="chips">{r.specialities.map((s) => <span className="chip" key={s}>{s}</span>)}</div></td>
                  <td><span className={`pill ${r.status === 'active' ? 'ok' : r.status === 'suspended' ? 'warn' : 'grey'}`}>{r.status}</span></td>
                  <td>{fmtDate(r.date_added)}</td>
                  <td>{fmtDate(r.last_active)}</td>
                  <td>{fmtDate(r.agreement_expiry)}{r.status === 'active' && expiringSoon(r.agreement_expiry) && <div><span className="pill warn">Renew soon</span></div>}</td>
                  {admin && <td><button className="linkbtn" onClick={() => setEditing(r)}>Edit</button></td>}
                </tr>
              ))}
            </tbody>
          </table>
          {shown.length === 0 && <div className="empty">No introducers match.</div>}
        </div>
      </div>
    </main>
  )
}
