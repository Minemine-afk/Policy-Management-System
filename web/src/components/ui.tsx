import { useState, type ReactNode } from 'react'
import { introGroup, statusLabel } from '../lib/options'
import { useAuth } from '../lib/auth'
import type { RequestStatus } from '../lib/types'

export function Seg<T extends string | boolean>({ label, value, options, onChange }: {
  label: string; value: T; options: { value: T; label: string }[]; onChange: (v: T) => void
}) {
  return (
    <div className="field" role="group" aria-label={label} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span style={{ fontSize: 14, fontWeight: 500 }}>{label}</span>
      <div className="seg">
        {options.map((o) => (
          <button key={String(o.value)} type="button" aria-pressed={o.value === value} onClick={() => onChange(o.value)}>
            {o.label}
          </button>
        ))}
      </div>
    </div>
  )
}

export function Select({ label, value, options, onChange }: {
  label: string; value: string; options: (string | { value: string; label: string })[]; onChange: (v: string) => void
}) {
  return (
    <label className="field">{label}
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => typeof o === 'string'
          ? <option key={o} value={o}>{o}</option>
          : <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </label>
  )
}

const TONE: Record<RequestStatus, string> = {
  submitted: 'info', assigned: 'info', in_progress: 'purple', sent_back: 'warn', completed: 'ok', removed: 'grey',
}

export function StatusPill({ status }: { status: RequestStatus }) {
  const { has } = useAuth()
  const intro = has('introducer')
  const shown = (intro ? introGroup(status) ?? status : status) as RequestStatus
  return <span className={`pill ${TONE[shown]}`}>{statusLabel(status, intro)}</span>
}

export function Fact({ label, children }: { label: string; children: ReactNode }) {
  return <div><dt>{label}</dt><dd>{children}</dd></div>
}

/** Small dialog asking for a reason, used for send back and remove. */
export function ReasonDialog({ title, confirmLabel, onConfirm, onCancel, fieldLabel = 'Reason' }: {
  title: string; confirmLabel: string; onConfirm: (reason: string) => void; onCancel: () => void; fieldLabel?: string
}) {
  const [reason, setReason] = useState('')
  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label={title}>
      <div className="card dialog">
        <h2>{title}</h2>
        <label className="field">{fieldLabel}
          <textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
        </label>
        <div className="row">
          <button className="btn primary" disabled={!reason.trim()} onClick={() => onConfirm(reason.trim())}>{confirmLabel}</button>
          <button className="btn" onClick={onCancel}>Cancel</button>
        </div>
      </div>
    </div>
  )
}

export function UrgentPill() {
  return <span className="pill bad urgent" title="Marked urgent">Urgent</span>
}
