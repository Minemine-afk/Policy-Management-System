import { useLayoutEffect, useRef, useState, type InputHTMLAttributes, type ReactNode } from 'react'
import { groupDigits, ungroup } from '../lib/num'
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

/** Ops and bsd only. Overdue requests are urgent automatically. */
export function UrgentPill({ auto }: { auto?: boolean | null }) {
  return <span className="pill bad urgent" title={auto ? 'Urgent because it is overdue' : 'Marked urgent'}>Urgent</span>
}

/**
 * A box for an amount that shows a comma at every thousand while you type (1,000,000) and hands back
 * the plain number text ("1000000") to save. Accepts pasted amounts with or without commas.
 */
export function AmountInput({ value, onValue, decimals = true, allowText = false, ...rest }: {
  value: string | number | null | undefined; onValue: (plain: string) => void; decimals?: boolean
  /** Also takes words, such as "NA" or "Included" in a PI comparison cell; only the digits get commas. */
  allowText?: boolean
} & Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type'>) {
  const ref = useRef<HTMLInputElement>(null)
  const caret = useRef<number | null>(null)
  const shown = groupDigits(value == null ? '' : String(value))
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || caret.current == null || document.activeElement !== el) return
    // Put the cursor back after the same characters it was after, skipping the commas that moved.
    let seen = 0, pos = 0
    while (pos < shown.length && seen < caret.current) { if (!isGroupComma(shown, pos)) seen++; pos++ }
    el.setSelectionRange(pos, pos)
    caret.current = null
  })
  const keep = (t: string) => {
    const u = ungroup(t)
    if (allowText) return u
    const d = u.replace(decimals ? /[^\d.]/g : /\D/g, '')
    return decimals ? d.replace(/^([^.]*\.)(.*)$/, (_, a: string, b: string) => a + b.replace(/\./g, '')) : d
  }
  return <input {...rest} ref={ref} type="text" inputMode={allowText ? undefined : decimals ? 'decimal' : 'numeric'} value={shown}
    onChange={(e) => {
      const raw = e.target.value
      const at = e.target.selectionStart ?? raw.length
      caret.current = keep(raw.slice(0, at)).length
      onValue(keep(raw))
    }} />
}

const isGroupComma = (s: string, i: number) => s[i] === ',' && /\d/.test(s[i - 1] ?? '') && /\d/.test(s[i + 1] ?? '')
