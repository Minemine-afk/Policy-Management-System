// Product categories (plan types) in the Knowledge Bank (Kumar, 25 Nov 2026): every product record has one, and
// each belongs to Insurance (ins) or Investment (inv). The label ends with "(ins)" or "(inv)". The key is what
// kb_products.product_type stores (1v-upgrade.sql); kb_products.category holds the group (Insurance / Investment).
//
// Grouping notes (judgement calls, easy to swap here and in 1v-upgrade.sql's kb_plan_group):
// * Whole life is grouped as insurance and universal life as investment. Under MAS Notice FAA-N16 every life policy
//   that is not investment-linked is an Excluded Investment Product; only investment-linked policies are Specified
//   Investment Products, with the stricter advice and disclosure rules.
export interface PlanType { key: string; label: string; group: 'Insurance' | 'Investment' }

export const PLAN_TYPES: PlanType[] = [
  { key: 'Term life', label: 'Term life', group: 'Insurance' },
  { key: 'Critical illness', label: 'Critical illness', group: 'Insurance' },
  { key: 'Whole life', label: 'Whole life', group: 'Insurance' },
  { key: 'Health', label: 'Health: hospital / Integrated Shield', group: 'Insurance' },
  { key: 'Personal accident', label: 'Personal accident', group: 'Insurance' },
  { key: 'Disability income', label: 'Disability income', group: 'Insurance' },
  { key: 'Long-term care', label: 'Long-term care', group: 'Insurance' },
  { key: 'Mortgage cover', label: 'Mortgage cover', group: 'Insurance' },
  { key: 'Investment-linked', label: 'Investment-linked / ILP', group: 'Investment' },
  { key: 'Universal life', label: 'Universal life incl. indexed', group: 'Investment' },
  { key: 'Endowment', label: 'Endowment', group: 'Investment' },
  { key: 'Retirement and annuity', label: 'Retirement and annuity', group: 'Investment' },
]
export const PLAN_KEYS = PLAN_TYPES.map((t) => t.key)
export const TERM = 'Term life'
export const GROUPS = ['Insurance', 'Investment'] as const
export const groupTag = (g: string) => (g === 'Investment' ? 'inv' : 'ins')
/** "Insurance (ins)", "Investment (inv)". */
export const groupLabel = (g: string) => `${g} (${groupTag(g)})`

/** The type before 1v-upgrade.sql was "Term": read it as Term life. */
export const planKey = (k: string | null | undefined) => (!k || k === 'Term' ? TERM : k)
export const planOf = (k: string | null | undefined) => PLAN_TYPES.find((t) => t.key === planKey(k))
export const groupOf = (k: string | null | undefined): 'Insurance' | 'Investment' => planOf(k)?.group ?? 'Insurance'
/** "Term life (ins)", "Universal life incl. indexed (inv)". */
export const planLabel = (k: string | null | undefined) => {
  const t = planOf(k)
  return t ? `${t.label} (${groupTag(t.group)})` : String(k ?? '')
}
/** Plan types in one group ('All' = every type). */
export const plansIn = (group: string) => PLAN_TYPES.filter((t) => group === 'All' || !group || t.group === group)

/** Investment-linked policies are Specified Investment Products (MAS): shown whenever one is compared. */
export const ILP_NOTE = 'Investment-linked policies are Specified Investment Products under MAS rules: stricter advice and disclosure rules apply ' +
  '(for example the Customer Knowledge Assessment), and policy values depend on the funds chosen and are not guaranteed. Read the fund\'s ' +
  'Product Highlights Sheet and the Product Summary.'
/** Shown when the products compared are of different kinds. */
export const mixedNote = (types: string[]) => `These products are of different kinds (${[...new Set(types.map(planLabel))].join(', ')}). ` +
  'They work differently, so a side-by-side comparison can mislead: rows that do not apply to a kind of plan say "Not applicable". ' +
  'Compare like with like before relying on it.'
