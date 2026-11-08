// Form categories (same fields as the first design). Term life only for now.
export const PLAN_CATEGORIES = ['All', 'Direct Purchase Insurance (DPI)', 'Non-DPI']
export const PRODUCTS = ['Term life']
export const AGE_BANDS = ['18 to 24', '25 to 29', '30 to 34', '35 to 39', '40 to 44', '45 to 49', '50 to 54', '55 to 59', '60 to 64']
export const GENDERS = ['Male', 'Female']
export const COVERAGE_TERMS = ['5 years or less', '6 to 10 years', '11 to 20 years', '21 to 30 years']
export const SUM_ASSURED_BANDS = ['Up to S$100,000', 'S$100,001 to 250,000', 'S$250,001 to 500,000', 'Above S$500,000']
export const PREMIUM_TYPES = ['Annual', 'Monthly']

export const BOARD_STATUSES = ['submitted', 'assigned', 'in_progress', 'sent_back', 'completed'] as const

export const STATUS_LABEL: Record<string, string> = {
  submitted: 'Submitted',
  assigned: 'Assigned',
  in_progress: 'In progress',
  sent_back: 'Sent back',
  completed: 'Completed',
  removed: 'Removed',
}

export const ROLE_LABEL: Record<string, string> = {
  introducer: 'Introducer',
  ops: 'Ops',
  bsd: 'BSD (admin)',
}

export const EVENT_LABEL: Record<string, string> = {
  submitted: 'Submitted', edited: 'Details edited', assigned: 'Assigned', reassigned: 'Reassigned',
  started: 'Work started', sent_back: 'Sent back to introducer', resubmitted: 'Resubmitted by introducer',
  completed: 'Completed', removed: 'Removed', status_changed: 'Status changed',
  pi_uploaded: 'PI document uploaded', attachment_added: 'Attachment added',
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

export function summary(r: { age_band: string; gender: string; smoker: boolean; sum_assured_band: string; coverage_term: string }) {
  return `${r.gender}, ${r.age_band}, ${r.smoker ? 'smoker' : 'non-smoker'} · ${r.sum_assured_band} · ${r.coverage_term}`
}

/** Requests are due two days after submission. Orange: one day or less left. Red: past two days.
 *  Completed and removed requests are never flagged. */
export type DueLevel = 'ok' | 'soon' | 'late'
export function dueInfo(r: { status: string; submitted_at: string }): { level: DueLevel; overdue: boolean; label: string } | null {
  if (r.status === 'completed' || r.status === 'removed') return null
  const hours = (Date.now() - new Date(r.submitted_at).getTime()) / 3_600_000
  if (hours > 48) {
    const over = Math.floor(hours - 48)
    const label = over >= 24 ? `Overdue by ${Math.floor(over / 24)}d` : `Overdue by ${Math.max(over, 1)}h`
    return { level: 'late', overdue: true, label }
  }
  const left = 48 - hours
  return { level: left <= 24 ? 'soon' : 'ok', overdue: false, label: left <= 24 ? 'Due in 1d' : 'Due in 2d' }
}
