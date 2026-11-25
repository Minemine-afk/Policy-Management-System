// The Knowledge Bank as the PI request form uses it: the term products in search, their documents and premium rates,
// the client-needs filters (wireframe 4) and the side-by-side comparison rows (wireframe 5).
// Facts only: nothing here ranks products or says which suits the client (no advice, MAS).
import { supabase } from './supabase'
import { fmtNum, groupMoneyInText, plain } from './num.ts'

export interface KbFact { v: string; doc?: string; page?: number }
export interface KbProduct {
  id: string; insurer: string; name: string; product_type: string; category: string; dpi: boolean; jurisdiction: string
  currencies: string[]; entry_age_min: number; entry_age_max: number; residency: string[]
  sa_min: number | null; sa_max: number | null; has_tpd: boolean; has_ci: boolean
  facts: Record<string, KbFact | undefined>; version: number; is_sample: boolean
  /** Read from an uploaded document by the reader; nobody has reviewed the values yet. */
  auto_read?: boolean
}
export interface KbDocument { id: string; product_id: string; title: string; doc_type: string; version: string; effective_from: string | null; valid_until: string | null }
export interface KbRate { product_id: string; age: number; gender: string; smoker: boolean; rate: number; ci_rate: number | null }
export interface Kb { products: KbProduct[]; docs: Record<string, KbDocument>; rates: KbRate[] }

export async function loadKb(): Promise<Kb> {
  const [p, d, r] = await Promise.all([
    supabase.from('kb_checked_products').select('*').order('insurer').order('name'),
    supabase.from('kb_checked_documents').select('*'),
    supabase.from('kb_checked_rates').select('*'),
  ])
  const docs: Record<string, KbDocument> = {}
  for (const x of (d.data as KbDocument[]) ?? []) docs[x.id] = x
  return {
    products: ((p.data as KbProduct[]) ?? []).map((x) => ({ ...x, sa_min: x.sa_min == null ? null : Number(x.sa_min), sa_max: x.sa_max == null ? null : Number(x.sa_max) })),
    docs,
    rates: ((r.data as KbRate[]) ?? []).map((x) => ({ ...x, rate: Number(x.rate), ci_rate: x.ci_rate == null ? null : Number(x.ci_rate) })),
  }
}

export const productLabel = (p: { insurer: string; name: string }) => `${p.insurer} · ${p.name}`

/** Wireframe 4, fields 1 to 8, filled in from the request form. */
export interface Needs {
  profile: string
  age: number | null          // age next birthday
  residency: string
  currency: string
  mode: 'coverage' | 'budget'
  amount: number              // sum assured, or premium a year
  insurer: string             // 'All' or a name
  category: string            // 'All', 'Insurance', 'Investment'
  jurisdiction: string        // 'All', 'Onshore', 'Offshore'
  gender: string
  smoker: boolean
  ci: boolean                 // the form asks for critical illness cover
}

/** Indicative annual premium for the sum assured, from the rate sheet (null when there is no rate). */
export function premiumFor(kb: Kb, p: KbProduct, n: Needs, sumAssured: number): number | null {
  if (n.age == null) return null
  const r = kb.rates.find((x) => x.product_id === p.id && x.age === n.age && x.gender === n.gender && x.smoker === n.smoker)
  if (!r) return null
  const extra = n.ci ? r.ci_rate : 0
  if (n.ci && extra == null) return null
  return (sumAssured / 1000) * (r.rate + (extra ?? 0))
}
/** Budget mode: the cover the budget buys, capped at the product's maximum. */
export function coverFor(kb: Kb, p: KbProduct, n: Needs): number | null {
  const per1000 = premiumFor(kb, p, n, 1000)
  if (!per1000) return null
  const cover = Math.floor((n.amount / per1000) * 1000 / 1000) * 1000
  return p.sa_max ? Math.min(cover, p.sa_max) : cover
}

/** Why a product does not fit the needs (empty = it fits). */
export function whyNot(kb: Kb, p: KbProduct, n: Needs): string[] {
  const why: string[] = []
  const money = (x: number) => `${p.currencies[0] ?? ''} ${fmtNum(x)}`
  if (n.age != null && (n.age < p.entry_age_min || n.age > p.entry_age_max)) why.push(`entry age ${plain(p.entry_age_min)} to ${plain(p.entry_age_max)}`)
  if (n.residency && p.residency.length && !p.residency.includes(n.residency)) why.push(`not open to: ${n.residency.toLowerCase()}`)
  if (n.currency && !p.currencies.includes(n.currency)) why.push(`no ${n.currency} policies`)
  if (n.ci && !p.has_ci) why.push('no critical illness cover')
  if (n.insurer !== 'All' && p.insurer !== n.insurer) why.push('other insurer')
  if (n.category !== 'All' && p.category !== n.category) why.push(`category ${p.category.toLowerCase()}`)
  if (n.jurisdiction !== 'All' && p.jurisdiction !== n.jurisdiction) why.push(p.jurisdiction.toLowerCase())
  if (n.mode === 'coverage' && n.amount > 0) {
    if (p.sa_min != null && n.amount < p.sa_min) why.push(`minimum sum assured ${money(p.sa_min)}`)
    if (p.sa_max != null && n.amount > p.sa_max) why.push(`maximum sum assured ${money(p.sa_max)}`)
  }
  if (n.mode === 'budget' && n.amount > 0) {
    const c = coverFor(kb, p, n)
    if (c != null && p.sa_min != null && c < p.sa_min) why.push(`the budget buys less than the minimum sum assured (${money(p.sa_min)})`)
  }
  return why
}

/** Wireframe 5: the ten categories and their rows. Keys starting with "_" are worked out from the product record. */
export const FACT_ROWS: { cat: string; label: string; key: string }[] = [
  { cat: 'Product information', label: 'Insurer', key: '_insurer' },
  { cat: 'Product information', label: 'Product type', key: '_type' },
  { cat: 'Product information', label: 'Onshore / offshore', key: '_juris' },
  { cat: 'Product information', label: 'Policy currency', key: '_cur' },
  { cat: 'Eligibility', label: 'Entry age', key: '_age' },
  { cat: 'Eligibility', label: 'Who can apply', key: '_res' },
  { cat: 'Eligibility', label: 'Sum assured', key: '_sa' },
  { cat: 'Eligibility', label: 'Underwriting', key: 'uw' },
  { cat: 'Premium', label: 'Indicative annual premium', key: '_prem' },
  { cat: 'Premium', label: 'Premium term', key: 'premTerm' },
  { cat: 'Premium', label: 'Premium rates', key: 'guaranteed' },
  { cat: 'Premium', label: 'Payment modes', key: 'modes' },
  { cat: 'Coverage', label: 'Cover until', key: 'coverTo' },
  { cat: 'Coverage', label: 'Death', key: 'death' },
  { cat: 'Coverage', label: 'Terminal illness', key: 'ti' },
  { cat: 'Coverage', label: 'Total and permanent disability', key: 'tpd' },
  { cat: 'Coverage', label: 'Critical illness', key: 'ci' },
  { cat: 'Coverage', label: 'Early critical illness', key: 'eci' },
  { cat: 'Coverage', label: 'Accidental death', key: 'ad' },
  { cat: 'Product features', label: 'Conversion option', key: 'conversion' },
  { cat: 'Product features', label: 'Renewal', key: 'renew' },
  { cat: 'Product features', label: 'Increase cover without medical', key: 'inc' },
  { cat: 'Investment features', label: 'Investment component', key: 'invest' },
  { cat: 'Investment features', label: 'Cash / surrender value', key: 'cash' },
  { cat: 'Charges', label: 'Total distribution cost', key: 'dist' },
  { cat: 'Charges', label: 'Other fees', key: 'fees' },
  { cat: 'Policy conditions', label: 'Free-look period', key: 'freelook' },
  { cat: 'Policy conditions', label: 'Grace period', key: 'grace' },
  { cat: 'Policy conditions', label: 'Reinstatement', key: 'reinstate' },
  { cat: 'Policy conditions', label: 'Main exclusions', key: 'excl' },
  { cat: 'Special provisions', label: 'Special provisions', key: 'special' },
  { cat: 'Important considerations', label: 'Important considerations', key: 'consider' },
]
export const NOT_AVAILABLE = 'Not available'
/** A fact an auto-read product's document reader did not find: it may still be in the document. */
export const NOT_READ = 'Not found by the reader. See the Product Summary'
export const AUTO_TAG = 'Auto-read, not yet reviewed'
/** Products the "Exclude sample products" switch leaves out (the made-up "(sample)" products from 3c-sample-products.sql). */
export const withoutSamples = (kb: Kb, exclude: boolean): Kb => (exclude ? { ...kb, products: kb.products.filter((p) => !p.is_sample) } : kb)
/** What a blank cell says for this product. */
export const blankText = (p: KbProduct) => (p.auto_read ? NOT_READ : NOT_AVAILABLE)

export interface Cell { text: string; source: string }

const fmtDate = (iso: string | null | undefined) => iso ? new Date(iso).toLocaleDateString('en-SG', { day: 'numeric', month: 'short', year: 'numeric' }) : ''
function sourceOf(kb: Kb, docId: string | undefined, page?: number) {
  const d = docId ? kb.docs[docId] : undefined
  if (!d) return ''
  return `${d.title}${page ? `, p.${plain(page)}` : ''}${d.effective_from ? ` · effective ${fmtDate(d.effective_from)}` : ''}`
}

/** One cell of the comparison: the value and where it came from. */
export function cellOf(kb: Kb, p: KbProduct, key: string, n: Needs): Cell {
  const ps = p.facts._ps?.doc ?? undefined
  const rs = p.facts._rs?.doc ?? undefined
  const fromPs = (text: string) => ({ text, source: sourceOf(kb, ps) })
  const money = (x: number | null) => x == null ? '' : `${p.currencies[0] ?? ''} ${fmtNum(x)}`
  switch (key) {
    case '_insurer': return fromPs(p.insurer)
    case '_type': return fromPs(`${p.product_type} life${p.dpi ? ' (Direct Purchase Insurance)' : ''}`)
    case '_juris': return fromPs(p.jurisdiction)
    case '_cur': return fromPs(p.currencies.join(', '))
    case '_age': return fromPs(`${plain(p.entry_age_min)} to ${plain(p.entry_age_max)} (age next birthday)`)
    case '_res': return fromPs(p.residency.join('; '))
    case '_sa': return fromPs(p.sa_min != null || p.sa_max != null ? `${money(p.sa_min) || 'Any'} to ${money(p.sa_max) || 'no stated maximum'}` : '')
    case '_prem': {
      const sa = n.mode === 'coverage' ? n.amount : coverFor(kb, p, n)
      const prem = sa ? premiumFor(kb, p, n, sa) : null
      if (prem == null) return { text: '', source: sourceOf(kb, rs) }
      const who = `age ${plain(n.age)}, ${n.gender.toLowerCase()}, ${n.smoker ? 'smoker' : 'non-smoker'}`
      return { text: `${n.currency} ${fmtNum(Math.round(prem))} a year for ${n.currency} ${fmtNum(sa)} cover (${who}, paying to age 65${n.ci ? ', with critical illness rider' : ''}). Indicative only; the PI gives the actual premium.`, source: sourceOf(kb, rs) }
    }
    default: {
      const f = p.facts[key]
      if (key === 'invest' && !f) return { text: `${NOT_AVAILABLE} (term plan)`, source: sourceOf(kb, ps) }
      return { text: groupMoneyInText(f?.v ?? ''), source: f ? sourceOf(kb, f.doc, f.page) : '' }
    }
  }
}

/** Every row for the chosen products, with a flag for rows whose values differ. */
export function comparisonRows(kb: Kb, products: KbProduct[], n: Needs) {
  return FACT_ROWS.map((row) => {
    const cells = products.map((p) => cellOf(kb, p, row.key, n))
    const differ = cells.some((c) => c.text !== cells[0].text)
    return { ...row, cells, differ }
  })
}

export const DISCLAIMER = 'Factual comparison only. Product features are taken from each insurer\'s documents in the Knowledge Bank. ' +
  'It is not a recommendation and does not consider the client\'s financial situation or needs. Read the Product Summary and ' +
  'Policy Illustration before deciding. Premiums are indicative; the PI gives the actual premium.'
/** Added under the disclaimer when an auto-read product is compared. */
export const AUTO_NOTE = 'Products marked "Auto-read, not yet reviewed" were read from the insurer\'s documents by the system and no one has ' +
  'checked the values yet. They may be incomplete or wrong: confirm them in the Product Summary before relying on them.'
