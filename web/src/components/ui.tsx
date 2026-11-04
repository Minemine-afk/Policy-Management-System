import type { ReactNode } from 'react'
import { STATUS_LABEL, money } from '../lib/options'
import type { PriceRange, RequestStatus } from '../lib/types'

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

const STATUS_TONE: Record<RequestStatus, string> = {
  draft: 'warn', submitted: 'info', referred_back: 'warn', approved: 'ok', rejected: 'bad', withdrawn: 'grey', expired: 'grey',
}

export function StatusPill({ status }: { status: RequestStatus }) {
  return <span className={`pill ${STATUS_TONE[status]}`}>{STATUS_LABEL[status]}</span>
}

export function Fact({ label, children }: { label: string; children: ReactNode }) {
  return <div><dt>{label}</dt><dd>{children}</dd></div>
}

export function PriceTable({ rows, premiumType }: { rows: PriceRange[]; premiumType: string }) {
  if (!rows.length) {
    return <p className="muted small" style={{ margin: 0 }}>No approved rate table covers this profile yet.</p>
  }
  const monthly = premiumType === 'Monthly'
  const f = (n: number) => money(monthly ? n / 12 : n)
  return (
    <div className="tablewrap">
      <table style={{ minWidth: 480 }}>
        <thead><tr><th>Insurer</th><th>Product</th><th className="num">Premium range (S$ {monthly ? 'a month' : 'a year'})</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.insurer}>
              <td>{r.insurer}</td>
              <td>{r.product_name}<div className="small muted">Rate table v{r.version} · rates as at {r.rates_as_at}</div></td>
              <td className="num" style={{ fontWeight: 600 }}>{f(r.premium_low)} to {f(r.premium_high)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export const INDICATIVE_NOTE =
  'Indicative only, not a quote. The insurer sets the final premium after underwriting. Sample figures in this prototype.'
