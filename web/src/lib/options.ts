// Form categories. These drive both the request form and the generated template.
export const PLAN_CATEGORIES = ['All', 'Direct Purchase Insurance (DPI)', 'Non-DPI']
export const PRODUCTS = ['Term life'] // v1: term only
export const AGE_BANDS = ['18 to 24', '25 to 29', '30 to 34', '35 to 39', '40 to 44', '45 to 49', '50 to 54', '55 to 59', '60 to 64']
export const GENDERS = ['Male', 'Female']
export const COVERAGE_TERMS = ['5 years or less', '6 to 10 years', '11 to 20 years', '21 to 30 years']
export const SUM_ASSURED_BANDS = ['Up to S$100,000', 'S$100,001 to 250,000', 'S$250,001 to 500,000', 'Above S$500,000']
export const PREMIUM_TYPES = ['Annual', 'Monthly']
export const KB_TYPES = ['Product', 'Onboarding', 'Compliance', 'Process']

export const STATUS_LABEL: Record<string, string> = {
  draft: 'Draft',
  submitted: 'Submitted · awaiting review',
  referred_back: 'Referred back',
  approved: 'Approved',
  rejected: 'Rejected',
  withdrawn: 'Withdrawn',
  expired: 'Expired',
}

export const ROLE_LABEL: Record<string, string> = {
  submitter: 'Submitter',
  approver: 'Approver',
  content_editor: 'Content editor',
  admin: 'Admin',
}

/** Tags a knowledge-bank document needs to show up as "relevant" for a request. */
export function tagsForRequest(r: { product: string; ci_benefit: boolean }): string[] {
  const tags: string[] = []
  if (r.product === 'Term life') tags.push('term')
  if (r.ci_benefit) tags.push('ci')
  return tags
}

export function money(n: number) {
  return 'S$' + Math.round(n).toLocaleString('en-SG')
}

export function fmtDate(s: string | null | undefined) {
  if (!s) return '—'
  return new Date(s).toLocaleDateString('en-SG', { day: 'numeric', month: 'short', year: 'numeric' })
}

export function daysSince(s: string | null) {
  if (!s) return 0
  return Math.floor((Date.now() - new Date(s).getTime()) / 86_400_000)
}
