import { useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import { ROLE_LABEL, says } from '../lib/options'
import { downloadCsv, parseCsv } from '../lib/csv'
import { MAX_IMPORT_ROWS, actionLabel, planImport, templateCsvRows, usersToCsvRows, type ImportRow } from '../lib/userCsv'
import { createUser, tempPassword } from '../lib/users'
import type { Profile } from '../lib/types'

type Outcome = { row: ImportRow; ok: boolean; message: string; password?: string }

const today = () => new Date().toISOString().slice(0, 10)
const fetchPeople = async () => ((await supabase.from('profiles').select('*').order('created_at')).data as Profile[]) ?? []

/** Admin only: export everyone as CSV, or add and update users from a CSV (checked and previewed first). */
export default function UserCsv({ myId, onChanged }: { myId: string; onChanged: () => void }) {
  const fileRef = useRef<HTMLInputElement>(null)
  const [fileName, setFileName] = useState('')
  const [plan, setPlan] = useState<ImportRow[] | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState(0)
  const [outcomes, setOutcomes] = useState<Outcome[] | null>(null)

  async function exportUsers() {
    downloadCsv(`users-${today()}.csv`, usersToCsvRows(await fetchPeople()))
  }

  async function pick(file: File | undefined) {
    setError(''); setPlan(null); setOutcomes(null)
    if (!file) return
    setFileName(file.name)
    if (file.size > 2_000_000) { setError('That file is too big for a users list (over 2 MB).'); return }
    const text = await file.text()
    const { rows, error } = planImport(parseCsv(text), await fetchPeople(), myId)
    if (error) setError(error); else setPlan(rows)
    if (fileRef.current) fileRef.current.value = ''
  }

  async function run() {
    if (!plan) return
    const todo = plan.filter((r) => r.action === 'create' || r.action === 'update')
    setBusy(true); setProgress(0)
    const out: Outcome[] = []
    for (const r of todo) {
      if (r.action === 'create') {
        const password = r.password || tempPassword()
        const msg = await createUser({ full_name: r.full_name, email: r.email, role: r.role!, company: r.company ?? '', password })
        out.push(msg ? { row: r, ok: false, message: msg } : { row: r, ok: true, message: 'Added', password })
      } else {
        const p = r.existing!
        const { error } = await supabase.rpc('admin_update_user', {
          p_user: p.id, p_role: r.role ?? p.role, p_active: r.active ?? p.active,
          p_full_name: r.full_name || p.full_name, p_company: r.company ?? p.company,
        })
        out.push(error ? { row: r, ok: false, message: says(error.message) } : { row: r, ok: true, message: `Updated: ${r.changes.join(', ')}` })
      }
      setProgress(out.length)
    }
    // Rows that were not valid stay in the report so they can be fixed and imported again.
    for (const r of plan.filter((x) => x.action === 'error')) out.push({ row: r, ok: false, message: r.problems.join('; ') })
    out.sort((a, b) => a.row.line - b.row.line)
    setBusy(false); setPlan(null); setOutcomes(out)
    onChanged()
  }

  const count = (a: ImportRow['action']) => plan?.filter((r) => r.action === a).length ?? 0
  const todo = count('create') + count('update')
  const added = outcomes?.filter((o) => o.password) ?? []
  const failed = outcomes?.filter((o) => !o.ok) ?? []

  return (
    <section className="card" aria-label="Import and export users">
      <h2 style={{ margin: 0 }}>Import and export (CSV)</h2>
      <p className="small muted" style={{ margin: 0 }}>
        Export lists everyone (no passwords). To import, use the same columns: Name, Email, Role ({Object.values(ROLE_LABEL).join(', ')}),
        Firm, Active (Yes or No) and an optional Temporary password. A new email adds a user; an existing email updates that
        person, and blank cells keep what is there. You see what will happen before anything changes. Up to {MAX_IMPORT_ROWS} rows per file.
      </p>
      <div className="row">
        <button type="button" className="btn small" onClick={exportUsers}>Export users</button>
        <button type="button" className="btn small" onClick={() => downloadCsv('users-template.csv', templateCsvRows())}>Download template</button>
        <label className="btn small primary" style={{ cursor: 'pointer' }}>
          Import users…
          <input ref={fileRef} type="file" accept=".csv,text/csv" aria-label="Import users CSV" style={{ display: 'none' }}
            onChange={(e) => pick(e.target.files?.[0])} disabled={busy} />
        </label>
      </div>
      {error && <div className="error" role="alert">{fileName ? `${fileName}: ` : ''}{error}</div>}

      {plan && (
        <>
          <div className="small" role="status">
            <strong>{fileName}</strong>: {count('create')} to add, {count('update')} to update, {count('same')} unchanged,{' '}
            <span style={{ color: count('error') ? 'var(--bad)' : undefined }}>{count('error')} with problems (skipped)</span>.
          </div>
          <div className="tablewrap">
            <table aria-label="Import preview">
              <thead><tr><th>Line</th><th>Email</th><th>Name</th><th>Role</th><th>Firm</th><th>Active</th><th>What will happen</th></tr></thead>
              <tbody>
                {plan.map((r) => (
                  <tr key={r.line}>
                    <td>{r.line}</td><td>{r.email}</td><td>{r.full_name || <span className="muted">{r.existing?.full_name}</span>}</td>
                    <td>{r.role ? ROLE_LABEL[r.role] : <span className="muted">{r.existing?.role ? ROLE_LABEL[r.existing.role] : ''}</span>}</td>
                    <td>{r.company ?? <span className="muted">{r.existing?.company}</span>}</td>
                    <td>{r.active === null ? <span className="muted">{r.existing ? (r.existing.active ? 'Yes' : 'No') : 'Yes'}</span> : r.active ? 'Yes' : 'No'}</td>
                    <td style={{ color: r.action === 'error' ? 'var(--bad)' : r.action === 'same' ? 'var(--muted)' : undefined }}>{actionLabel(r)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="row">
            <button type="button" className="btn primary" disabled={busy || !todo} onClick={run}>
              {busy ? `Working… ${progress} of ${todo}` : todo ? `Import ${todo} ${todo === 1 ? 'user' : 'users'}` : 'Nothing to import'}
            </button>
            <button type="button" className="btn" disabled={busy} onClick={() => setPlan(null)}>Cancel</button>
          </div>
        </>
      )}

      {outcomes && (
        <>
          <div className="small" role="status" style={{ color: failed.length ? 'var(--bad)' : 'var(--ok)' }}>
            Import finished: {outcomes.filter((o) => o.ok).length} done, {failed.length} not imported.
          </div>
          {added.length > 0 && (
            <div className="small">
              {added.length} new {added.length === 1 ? 'login' : 'logins'} with temporary passwords. Pass each one to the person privately;
              they can change it under Account. Delete the downloaded file once you have.{' '}
              <button type="button" className="btn small" onClick={() => downloadCsv(`new-logins-${today()}.csv`,
                [['Name', 'Email', 'Role', 'Temporary password'], ...added.map((o) => [o.row.full_name, o.row.email, ROLE_LABEL[o.row.role!], o.password])])}>
                Download new logins
              </button>
            </div>
          )}
          {failed.length > 0 && (
            <div className="small">
              <button type="button" className="btn small" onClick={() => downloadCsv(`import-problems-${today()}.csv`,
                [['Line', 'Email', 'Problem'], ...failed.map((o) => [o.row.line, o.row.email, o.message])])}>
                Download problem report
              </button>
            </div>
          )}
          <div className="tablewrap">
            <table aria-label="Import results">
              <thead><tr><th>Line</th><th>Email</th><th>Result</th><th>Temporary password</th></tr></thead>
              <tbody>
                {outcomes.map((o) => (
                  <tr key={o.row.line}>
                    <td>{o.row.line}</td><td>{o.row.email}</td>
                    <td style={{ color: o.ok ? 'var(--ok)' : 'var(--bad)' }}>{o.message}</td>
                    <td>{o.password && <code>{o.password}</code>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  )
}
