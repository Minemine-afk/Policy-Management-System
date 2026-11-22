import { useCallback, useEffect, useMemo, useState } from 'react'
import { FIELDS } from '../lib/piExtract'
import { fmtDateTime, says } from '../lib/options'
import { forgetRules, loadRules, type SavedRule } from '../lib/teach'

const fieldLabel = (k: string) => FIELDS.find((f) => f.key === k)?.label ?? k
function describe(r: SavedRule): string {
  if (r.how === 'na') return `NA for ${r.plan || 'this plan'}${r.corrects ? ' (ops corrected the reader here)' : ''}`
  const where = r.how === 'beside'
    ? r.offset === 0 ? `right after “${r.label}”` : `${r.offset === 1 ? 'next to' : `${r.offset} columns after`} “${r.label}”`
    : r.how === 'row' ? `in the column “${r.label}”, ${r.row === 'term' ? 'on the row of the last policy year' : 'on the last row'}`
    : `under the heading “${r.label}”`
  const factor = r.factor === 12 ? ', monthly figure × 12' : r.factor === 4 ? ', quarterly figure × 4' : r.factor === 2 ? ', half-yearly figure × 2' : ''
  return `${where}${factor}${r.corrects ? ' (ops corrected the reader here, so this place is used instead of its rules)' : ''}`
}

/** BSD and admin: what the PI reader has learned from saved comparisons, per insurer, with delete. Only label words
 *  and positions are stored, never client values. */
export default function LearnedPlaces() {
  const [rules, setRules] = useState<SavedRule[] | null>(null)
  const [error, setError] = useState('')
  const [note, setNote] = useState('')
  const [open, setOpen] = useState('')
  const [confirm, setConfirm] = useState<{ ids: string[]; what: string } | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const r = await loadRules()
    setRules(r.rules); setError(r.error ? says(r.error) : '')
  }, [])
  useEffect(() => { load() }, [load])

  const insurers = useMemo(() => {
    const by = new Map<string, SavedRule[]>()
    for (const r of rules ?? []) {
      const k = r.insurer.toLowerCase()
      by.set(k, [...(by.get(k) ?? []), r])
    }
    return [...by.values()].map((rs) => ({
      name: rs[0].insurer, rules: rs, fields: [...new Set(rs.map((r) => fieldLabel(r.field)))],
      plans: [...new Set(rs.map((r) => r.plan).filter(Boolean))], last: rs.map((r) => r.created_at).sort().at(-1) ?? '',
    })).sort((a, b) => a.name.localeCompare(b.name))
  }, [rules])

  async function forget() {
    if (!confirm) return
    setBusy(true); setError(''); setNote('')
    const { removed, error } = await forgetRules(confirm.ids)
    if (error) setError(says(error))
    else setNote(`Deleted ${removed} learned ${removed === 1 ? 'place' : 'places'} (${confirm.what}).`)
    setConfirm(null); setBusy(false)
    await load()
  }

  return (
    <div className="card">
      <h2 style={{ margin: 0 }}>What the PI reader has learned</h2>
      <p className="small muted" style={{ margin: 0 }}>
        When ops or BSD save a PI comparison, the reader remembers where each value they typed or corrected sits in a PI
        layout it doesn't know: the words next to it, or the column heading above it. The next PI from that insurer is read
        with these places, and those values are tagged “Learned” for ops to check. A place found only once is used only on
        the same plan; on another plan two places must agree, otherwise the cell stays blank. No client values are kept.
        Delete a place if it reads wrongly; it is learned again only if someone saves that value there again.
      </p>
      {error && <div className="error" role="alert">{error}</div>}
      {note && <div className="notice" role="status">{note}</div>}
      {rules && !error && insurers.length === 0 && <div className="small muted">Nothing learned yet.</div>}
      {insurers.map((ins) => (
        <div key={ins.name} className="card" style={{ padding: 12 }}>
          <div className="row between">
            <div>
              <strong>{ins.name}</strong>
              <div className="small muted">{ins.rules.length} {ins.rules.length === 1 ? 'place' : 'places'} for {ins.fields.join(', ')}
                {ins.plans.length ? ` · plans: ${ins.plans.join(', ')}` : ''} · last learned {fmtDateTime(ins.last)}</div>
            </div>
            <div className="row">
              <button className="btn small" onClick={() => setOpen(open === ins.name ? '' : ins.name)} aria-expanded={open === ins.name}>
                {open === ins.name ? 'Hide places' : 'Show places'}</button>
              <button className="btn small" onClick={() => setConfirm({ ids: ins.rules.map((r) => r.id), what: `everything learned for ${ins.name}` })}>Delete all</button>
            </div>
          </div>
          {open === ins.name && (
            <div className="tablewrap">
              <table aria-label={`Places learned for ${ins.name}`}>
                <thead><tr><th>Field</th><th>Where in the PI</th><th>Plan</th><th>Learned</th><th></th></tr></thead>
                <tbody>
                  {ins.rules.map((r) => (
                    <tr key={r.id}>
                      <td>{fieldLabel(r.field)}</td>
                      <td>{describe(r)}</td>
                      <td>{r.plan || <span className="muted">any</span>}</td>
                      <td className="small">{fmtDateTime(r.created_at)}</td>
                      <td><button className="btn small" onClick={() => setConfirm({ ids: [r.id], what: `${fieldLabel(r.field)} ${describe(r)}` })}>Delete</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ))}
      {confirm && (
        <div className="notice" role="alertdialog" aria-label="Confirm delete">
          <p style={{ margin: '0 0 8px' }}>Delete {confirm.what}? The reader stops using {confirm.ids.length === 1 ? 'this place' : `these ${confirm.ids.length} places`} straight away.</p>
          <div className="row">
            <button className="btn primary" disabled={busy} onClick={forget}>{busy ? 'Deleting…' : 'Delete'}</button>
            <button className="btn" disabled={busy} onClick={() => setConfirm(null)}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  )
}
