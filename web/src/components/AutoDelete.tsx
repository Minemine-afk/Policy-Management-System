import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { STATUS_LABEL, fmtDateTime, says } from '../lib/options'
import { fmtNum } from '../lib/num'

interface Candidate { id: string; ref: string; status: string; due_at: string; days_overdue: number; files: number }
interface Setting { auto_delete_on: boolean; auto_delete_days: number }

/** Admin > Deadline settings: automatic deletion of open requests that are long overdue (default: more than 30 days),
 *  with a preview of what the rule matches now. The daily run is scheduled by supabase/cloud/5b-schedule-auto-delete.sql. */
export default function AutoDelete() {
  const [s, setS] = useState<Setting | null>(null)
  const [saved, setSaved] = useState<Setting | null>(null)
  const [missing, setMissing] = useState(false)
  const [list, setList] = useState<Candidate[] | null>(null)
  const [waiting, setWaiting] = useState(0)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [note, setNote] = useState('')

  const load = useCallback(async () => {
    const { data, error } = await supabase.from('app_settings').select('auto_delete_on, auto_delete_days').maybeSingle()
    if (error || !data) { setMissing(true); return }
    setS(data as Setting); setSaved(data as Setting)
    const [p, w] = await Promise.all([supabase.rpc('preview_overdue_deletion'), supabase.rpc('files_waiting_for_cleanup')])
    setList(((p.data as Candidate[]) ?? []))
    setWaiting(Number(w.data ?? 0))
  }, [])
  useEffect(() => { load() }, [load])

  if (missing) {
    return (
      <div className="card" style={{ maxWidth: 620 }}>
        <h2 style={{ margin: 0 }}>Automatic deletion of long-overdue requests</h2>
        <p className="small muted" style={{ margin: 0 }}>Not set up yet: run <code>supabase/cloud/1k-upgrade.sql</code> in Supabase first.</p>
      </div>
    )
  }
  if (!s || !saved) return null

  async function save() {
    if (!s) return
    setError(''); setNote('')
    const { error } = await supabase.rpc('update_auto_delete', { p_on: s.auto_delete_on, p_days: s.auto_delete_days })
    if (error) setError(says(error.message))
    else setNote(s.auto_delete_on ? 'Saved. The list below follows the new setting.' : 'Saved. Automatic deletion is off; nothing will be deleted.')
    setConfirming(false)
    load()
  }

  // Removes the queued files of deleted requests with the Storage API (Edge Function cleanup-deleted-files).
  async function cleanFiles() {
    const { data, error } = await supabase.functions.invoke('cleanup-deleted-files', { body: {} })
    if (error) return 'The files will be removed by the hourly clean-up (the clean-up function did not answer: is it deployed?).'
    const left = Number((data as { remaining?: number })?.remaining ?? 0)
    return left ? `${fmtNum(left)} files are still waiting and will be removed by the hourly clean-up.` : 'Their files were removed.'
  }

  async function deleteNow() {
    setBusy(true); setError(''); setNote('')
    const { data, error } = await supabase.rpc('run_overdue_deletion')
    if (error) { setError(says(error.message)); setBusy(false); return }
    const done = (data as { ref: string; files: number }[]) ?? []
    const files = done.some((d) => d.files > 0) ? ' ' + await cleanFiles() : ''
    setNote(done.length ? `Deleted ${fmtNum(done.length)} ${done.length === 1 ? 'request' : 'requests'}: ${done.map((d) => d.ref).join(', ')}.${files}` : 'Nothing to delete.')
    setConfirming(false); setBusy(false)
    load()
  }

  async function removeWaiting() {
    setBusy(true); setError('')
    setNote(await cleanFiles())
    setBusy(false)
    load()
  }

  const days = saved.auto_delete_days
  return (
    <div className="card" style={{ maxWidth: 900 }}>
      <h2 style={{ margin: 0 }}>Automatic deletion of long-overdue requests</h2>
      <p className="small muted" style={{ margin: 0 }}>
        Once a day (3 AM Singapore time), open requests (submitted, assigned, in progress, or sent back with the clock running)
        whose due time passed more than the number of days below are <strong>deleted for good</strong>: the request, its client
        details, comments, history, files, PI comparison and PI pack. This cannot be undone. Completed and removed requests are
        never deleted, nor are sent-back requests while their clock is paused. The audit log keeps one line per deleted request
        (its reference, not the client).
      </p>
      <div className="row" style={{ alignItems: 'flex-end' }}>
        <label className="row small" style={{ gap: 6 }}>
          <input type="checkbox" checked={s.auto_delete_on} onChange={(e) => setS({ ...s, auto_delete_on: e.target.checked })} />
          Delete long-overdue requests automatically
        </label>
        <label className="field" style={{ maxWidth: 220 }}>Overdue for more than (days)
          <input type="number" min={1} max={365} value={days}
            onChange={(e) => setS({ ...s, auto_delete_days: Math.max(0, Math.round(Number(e.target.value) || 0)) })} />
        </label>
        <button className="btn" onClick={save}>Save</button>
      </div>
      {error && <div className="error" role="alert">{error}</div>}
      {note && <div className="small" role="status" style={{ color: 'var(--ok)' }}>{note}</div>}

      <h3 style={{ margin: '8px 0 0' }}>Preview: what would be deleted now</h3>
      {list === null ? <div className="empty">Loading…</div> : !list.length ? (
        <div className="empty">No request is overdue for more than {fmtNum(days)} days.</div>
      ) : (
        <>
          <div className="small muted">
            {fmtNum(list.length)} {list.length === 1 ? 'request' : 'requests'}
            {saved.auto_delete_on ? ' will be deleted at the next daily run.' : ' would be deleted if automatic deletion were on.'}
          </div>
          <div className="tablewrap">
            <table>
              <thead><tr><th>Request</th><th>Status</th><th>Was due</th><th>Days overdue</th><th>Files</th></tr></thead>
              <tbody>
                {list.map((c) => (
                  <tr key={c.id}>
                    <td>{c.ref}</td><td>{STATUS_LABEL[c.status] ?? c.status}</td><td>{fmtDateTime(c.due_at)}</td>
                    <td>{fmtNum(c.days_overdue)}</td><td>{fmtNum(c.files)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {saved.auto_delete_on && (confirming ? (
            <div className="row">
              <span className="small"><strong>Delete {fmtNum(list.length)} {list.length === 1 ? 'request' : 'requests'} for good?</strong> This cannot be undone.</span>
              <button className="btn primary" disabled={busy} onClick={deleteNow}>{busy ? 'Deleting…' : 'Yes, delete them'}</button>
              <button className="btn" disabled={busy} onClick={() => setConfirming(false)}>Cancel</button>
            </div>
          ) : (
            <div><button className="btn danger" onClick={() => { setConfirming(true); setNote('') }}>Delete these now</button></div>
          ))}
        </>
      )}
      {waiting > 0 && (
        <div className="row small">
          <span>{fmtNum(waiting)} {waiting === 1 ? 'file' : 'files'} of deleted requests still waiting to be removed (nobody can open them).</span>
          <button className="btn small" disabled={busy} onClick={removeWaiting}>Remove now</button>
        </div>
      )}
    </div>
  )
}
