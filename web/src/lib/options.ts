export const BOARD_STATUSES = ['submitted', 'assigned', 'in_progress', 'sent_back', 'completed'] as const

/** Introducers see three simple stages: everything that is not sent back or completed counts as In progress. */
export type IntroGroup = 'in_progress' | 'sent_back' | 'completed'
export const INTRO_GROUPS: IntroGroup[] = ['in_progress', 'sent_back', 'completed']
export function introGroup(status: string): IntroGroup | null {
  if (status === 'sent_back') return 'sent_back'
  if (status === 'completed') return 'completed'
  if (status === 'removed') return null
  return 'in_progress'
}

/** Column colour chips, like a kanban board. */
export const COLUMN_COLOR: Record<string, string> = {
  submitted: '#6E7191', assigned: '#3B82C4', in_progress: '#E08A3C', sent_back: '#D64550', completed: '#3BA668',
}

export const STATUS_LABEL: Record<string, string> = {
  submitted: 'Unassigned',
  assigned: 'Assigned',
  in_progress: 'In progress',
  sent_back: 'Sent back',
  completed: 'Completed',
  removed: 'Removed',
}

/** What a status is called for the person looking at it. */
export function statusLabel(status: string, isIntroducer: boolean) {
  if (isIntroducer) { const g = introGroup(status); return g ? STATUS_LABEL[g] : STATUS_LABEL[status] }
  return STATUS_LABEL[status]
}

export const ROLE_LABEL: Record<string, string> = {
  introducer: 'Introducer',
  ops: 'Ops',
  bsd: 'BSD',
  admin: 'Admin',
}

export const EVENT_LABEL: Record<string, string> = {
  submitted: 'Submitted', edited: 'Details edited', assigned: 'Assigned', reassigned: 'Reassigned',
  started: 'Work started', sent_back: 'Sent back to introducer', resubmitted: 'Resubmitted by introducer',
  completed: 'Completed', removed: 'Removed', status_changed: 'Status changed',
  pi_uploaded: 'PI document uploaded', attachment_added: 'Attachment added',
  released: 'Returned to the unassigned pool', reopened: 'Reopened', priority_changed: 'Priority changed',
}

export function fmtDate(s: string | null | undefined) {
  if (!s) return '—'
  return new Date(s).toLocaleDateString('en-SG', { day: 'numeric', month: 'short', year: 'numeric' })
}

export function fmtDateTime(s: string) {
  return new Date(s).toLocaleString('en-SG', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}

export function daysSince(s: string | null) {
  if (!s) return 0
  return Math.floor((Date.now() - new Date(s).getTime()) / 86_400_000)
}

/** Age last birthday on a given day. */
export function ageOn(dob: string | null | undefined, on = new Date()) {
  if (!dob) return null
  const [y, m, d] = dob.split('-').map(Number)
  let age = on.getFullYear() - y
  if (on.getMonth() + 1 < m || (on.getMonth() + 1 === m && on.getDate() < d)) age--
  return age
}

/** "SGD 300,000" */
export function fmtMoney(currency: string, amount: number | null | undefined) {
  if (amount == null) return '—'
  return `${currency} ${Number(amount).toLocaleString('en-SG', { maximumFractionDigits: 2 })}`
}

/** "Sum assured SGD 300,000" or "Premium SGD 1,200 (Annual)" */
export function amountLabel(r: { amount_basis: string; currency: string; amount: number | null; premium_type?: string }) {
  return r.amount_basis === 'premium'
    ? `Premium ${fmtMoney(r.currency, r.amount)}${r.premium_type ? ` (${r.premium_type.toLowerCase()})` : ''}`
    : `Sum assured ${fmtMoney(r.currency, r.amount)}`
}

/** "Singlife Elite Term II", or "FWD Term Life" when the plan name already starts with the insurer. */
export function planName(r: { insurer: string | null; product: string }) {
  if (!r.insurer || r.product.toLowerCase().startsWith(r.insurer.toLowerCase())) return r.product
  return `${r.insurer} ${r.product}`
}

/** One line for board cards and the backlog. */
export function summary(r: { gender: string; date_of_birth: string | null; smoker: boolean; insurer: string | null; product: string
  amount_basis: string; currency: string; amount: number | null; policy_term: string | null; compare_term?: boolean }) {
  const age = ageOn(r.date_of_birth)
  const who = [r.gender, age != null ? `age ${age}` : null, r.smoker ? 'smoker' : 'non-smoker'].filter(Boolean).join(', ')
  const plan = planName(r)
  return [who, plan, r.amount != null ? amountLabel(r) : null, r.policy_term, r.compare_term ? 'term comparison' : null]
    .filter(Boolean).join(' · ')
}

/** "48 hours" -> "2 days". */
export function fmtHours(h: number) {
  if (h % 24 === 0) return h === 24 ? '1 day' : `${h / 24} days`
  return h === 1 ? '1 hour' : `${h} hours`
}

/** Each request has a due time (set from the deadline in Admin > Settings). Orange: the "due soon" window.
 *  Red: past the due time. Completed and removed requests are never flagged. While a request is sent back
 *  the clock can be paused. */
export type DueLevel = 'ok' | 'soon' | 'late' | 'paused'
export function dueInfo(r: { status: string; due_at: string | null; paused_at?: string | null }, soonHours = 24):
  { level: DueLevel; overdue: boolean; label: string } | null {
  if (!r.due_at || r.status === 'completed' || r.status === 'removed') return null
  if (r.paused_at) return { level: 'paused', overdue: false, label: 'Clock paused' }
  const left = (new Date(r.due_at).getTime() - Date.now()) / 3_600_000
  if (left < 0) {
    const over = Math.floor(-left)
    const label = over >= 24 ? `Overdue by ${Math.floor(over / 24)}d` : `Overdue by ${Math.max(over, 1)}h`
    return { level: 'late', overdue: true, label }
  }
  const label = left >= 24 ? `Due in ${Math.ceil(left / 24)}d` : `Due in ${Math.max(Math.ceil(left), 1)}h`
  return { level: left <= soonHours ? 'soon' : 'ok', overdue: false, label }
}

/** Urgent first, then the earliest due time. Introducers get neither field, so their requests sort oldest first. */
type Sortable = { priority: string | null; due_at: string | null; submitted_at: string }
export function byPriorityThenDue(a: Sortable, b: Sortable) {
  return (a.priority === 'urgent' ? 0 : 1) - (b.priority === 'urgent' ? 0 : 1)
    || (a.due_at ?? a.submitted_at).localeCompare(b.due_at ?? b.submitted_at)
}

/** Server messages use the database's lower-case role name "bsd". Show it as "BSD". */
export function says(msg: string) {
  return msg.replace(/\bbsd\b/gi, 'BSD')
}
