// The Knowledge Hub module's Knowledge Bank: documents (with versions and expiry) and product records.
// Ops and BSD keep it. No check step (Kumar, 25 Nov 2026): uploads are in use at once, and a product record is in
// search as soon as it is read from an upload or saved; what the reader filled in is tagged until someone reviews it.
import { supabase } from './supabase'
import { FACT_ROWS } from './kb'
import { fmtNum, plain } from './num.ts'
import { groupOf, isFinancing, planKey } from './families.ts'
import type { FinRate } from './kbFinancing.ts'

export const DOC_TYPES = ['Product Summary', 'Rate sheet', 'Brochure', 'Policy wording', 'Guide', 'Training material', 'Product Financing',
  'Circulars', 'Campaign', 'Regulatory', 'Others']
/** "Others" asks for a name, which is then shown as the document's type. */
export const OTHERS = 'Others'
export const DOC_TYPE_NAME_MAX = 60
/** Types that need not come from one insurer (the insurer is optional). */
export const NO_INSURER_TYPES = ['Training material', 'Product Financing', 'Circulars', OTHERS]
/** Only these document types belong to a product (Kumar, 25 Nov 2026): the upload form asks for the product and its
 *  plan type for them, and for no other type (training material, circulars, regulatory ... have no product). */
export const PRODUCT_DOC_TYPES = ['Product Summary', 'Rate sheet', 'Brochure', 'Product Financing']
export const hasProduct = (type: string) => PRODUCT_DOC_TYPES.includes(type)
export const needsInsurer = (type: string) => !NO_INSURER_TYPES.includes(type)
/** The type as people see it: the typed name for "Others". */
export const docTypeName = (d: { doc_type: string; doc_type_name?: string | null }) =>
  d.doc_type === OTHERS ? d.doc_type_name?.trim() || OTHERS : d.doc_type
export const KB_ACCEPT = '.pdf,.jpg,.jpeg,.png,.doc,.docx,.xls,.xlsx'
export const KB_MAX_MB = 20
/** Documents expiring within this many days are flagged (owners get time to upload the new version). */
export const EXPIRY_WARN_DAYS = 40

export interface KbDoc {
  id: string; product_id: string | null
  /** The product category for a document of a whole category (no product record); 1w-upgrade.sql. */
  plan_type?: string | null
  insurer: string; title: string; doc_type: string; doc_type_name: string | null; version: string
  effective_from: string | null; valid_until: string | null; storage_path: string | null; file_name: string | null
  file_size: number | null; status: 'new' | 'checked'; replaces: string | null; replaced_by: string | null
  uploaded_by: string | null; checked_by: string | null; checked_at: string | null; created_at: string; is_sample: boolean
}

export interface Fact { v?: string; doc?: string; page?: number }
export interface Rate { age: number; gender: 'Male' | 'Female'; smoker: boolean; rate: number; ci_rate?: number | null }
/** The editable record (what kb_save_product takes, and what a draft holds). */
export interface ProductRecord {
  insurer: string; name: string; product_type: string; category: string; dpi: boolean; jurisdiction: string; currencies: string[]
  entry_age_min: number | string; entry_age_max: number | string; residency: string[]
  sa_min: number | string | null; sa_max: number | string | null; has_tpd: boolean; has_ci: boolean
  facts: Record<string, Fact>; rates?: Rate[]
  /** Premium financing: cost-of-funds and drawdown rates (1x-upgrade.sql). */
  fin_rates?: FinRate[]
}
export interface KbProductRow extends ProductRecord {
  id: string; status: 'draft' | 'check' | 'verified' | 'withdrawn'; version: number; is_sample: boolean
  pending: ProductRecord | null; pending_state: 'draft' | 'check' | null; pending_by: string | null; pending_at: string | null
  pending_note: string | null; submitted_by: string | null; verified_by: string | null; verified_at: string | null
  created_by: string | null; updated_at: string
  auto_read: boolean; auto_fields: string[]; missing: string[]; read_note: string | null
}
export interface HistoryRow { id: number; product_id: string; version: number; record: ProductRecord & { rates_changed?: boolean }; changed_by: string | null; checked_by: string | null; checked_at: string; source: 'checked' | 'edit' | 'read' | 'migrated' }

/** What a record still needs before it can be found in search, in plain words. */
export const MISSING_LABEL: Record<string, string> = { currencies: 'policy currency', entry_age: 'entry ages' }
export const missingText = (m: string[]) => m.map((x) => MISSING_LABEL[x] ?? x).join(' and ')
/** What a record needs before it is searchable. Entry ages are not needed (Kumar, 25 Nov 2026): a product without
 *  them is searchable, marked "Entry ages not stated in the document". */
export const blocking = (m: string[] | null | undefined) => (m ?? []).filter((x) => x !== 'entry_age')
/** Why a product is not in Compare products (empty = it is). */
export function whyNotSearchable(p: KbProductRow, usable: boolean): string {
  if (usable || isFinancing(p.product_type)) return ''
  if (p.status === 'withdrawn') return 'Withdrawn'
  const m = blocking(p.missing)
  if (m.length) return `Not searchable: the ${missingText(m)} ${m.length > 1 ? 'were' : 'was'} not found in the documents. Open the record and fill ${m.length > 1 ? 'them' : 'it'} in`
  if (p.status === 'draft') return 'Not saved yet: open it and save it to put it in search'
  return 'Not searchable: a source document is out of date. Upload the new version'
}

/** The comparison rows a person fills in (the rest come from the record's own fields). */
export const FACT_FIELDS = FACT_ROWS.filter((r) => !r.key.startsWith('_'))

export const blankRecord = (): ProductRecord => ({
  insurer: '', name: '', product_type: '', category: 'Insurance', dpi: false, jurisdiction: 'Onshore', currencies: ['SGD'],
  entry_age_min: 18, entry_age_max: 65, residency: [], sa_min: null, sa_max: null, has_tpd: false, has_ci: false, facts: {},
})

/** The checked version as an editable record. */
export const liveRecord = (p: KbProductRow): ProductRecord => ({
  insurer: p.insurer, name: p.name, product_type: planKey(p.product_type), category: groupOf(p.product_type), dpi: p.dpi, jurisdiction: p.jurisdiction, currencies: p.currencies,
  entry_age_min: p.entry_age_min, entry_age_max: p.entry_age_max, residency: p.residency,
  sa_min: p.sa_min == null ? null : Number(p.sa_min), sa_max: p.sa_max == null ? null : Number(p.sa_max),
  has_tpd: p.has_tpd, has_ci: p.has_ci, facts: p.facts ?? {},
  ...(isFinancing(p.product_type) ? { fin_rates: p.fin_rates ?? [] } : {}),
})

export const today = () => new Date().toISOString().slice(0, 10)
export const daysLeft = (iso: string | null) => (iso ? Math.ceil((new Date(iso + 'T00:00:00').getTime() - new Date(today() + 'T00:00:00').getTime()) / 86_400_000) : null)

/** Where a document stands, in plain words, with a pill tone. */
export function docState(d: KbDoc): { text: string; tone: 'ok' | 'warn' | 'bad' | 'grey' | 'info' } {
  if (d.replaced_by) return { text: 'Older version', tone: 'grey' }
  const left = daysLeft(d.valid_until)
  if (left != null && left < 0) return { text: 'Out of date', tone: 'bad' }
  if (left != null && left <= EXPIRY_WARN_DAYS) return { text: `Expires in ${fmtNum(left)} day${left === 1 ? '' : 's'}`, tone: 'warn' }
  return { text: 'In use', tone: 'ok' }
}

/** Where a product record stands. */
export function productState(p: KbProductRow, usable: boolean, docs?: KbDoc[]): { text: string; tone: 'ok' | 'warn' | 'bad' | 'grey' | 'info' | 'purple' } {
  if (p.status === 'withdrawn') return { text: 'Withdrawn', tone: 'grey' }
  // Premium financing records are kept, not offered in Compare products (Kumar, 25 Nov 2026).
  if (isFinancing(p.product_type)) {
    if (p.status === 'draft') return { text: 'Not saved yet', tone: 'info' }
    if (docs && finOutOfDate(p, docs)) return { text: 'Saved · rates out of date', tone: 'bad' }
    return p.auto_read ? { text: 'Saved · auto-read, not yet reviewed', tone: 'warn' } : { text: 'Saved', tone: 'ok' }
  }
  if (p.status === 'draft' && !blocking(p.missing).length) return { text: 'Not saved yet', tone: 'info' }
  if (!usable) return { text: blocking(p.missing).length ? `Not searchable: no ${missingText(blocking(p.missing))}` : 'A source document is out of date', tone: 'bad' }
  if (p.auto_read) return { text: 'In search · auto-read, not yet reviewed', tone: 'warn' }
  return { text: 'In search', tone: 'ok' }
}

/** A financing record whose documents (its monthly cost-of-funds sheet) have passed their valid-until date. */
export const finOutOfDate = (p: { facts: Record<string, Fact | undefined> }, docs: KbDoc[]) =>
  Object.values(p.facts ?? {}).some((f) => { const left = daysLeft(docs.find((d) => d.id === f?.doc && !d.replaced_by)?.valid_until ?? null); return left != null && left < 0 })

export async function loadDocs(): Promise<KbDoc[]> {
  const { data } = await supabase.from('kb_documents').select('*').order('insurer').order('title').order('created_at', { ascending: false })
  return (data as KbDoc[]) ?? []
}
export async function loadProducts(): Promise<KbProductRow[]> {
  const { data } = await supabase.from('kb_products').select('*').order('insurer').order('name')
  return (data as KbProductRow[]) ?? []
}
/** Ids of the products Compare products offers now (in search). */
export async function loadUsable(): Promise<Set<string>> {
  const { data } = await supabase.from('kb_checked_products').select('id')
  return new Set(((data as { id: string }[]) ?? []).map((x) => x.id))
}

export async function openDoc(d: KbDoc): Promise<string | null> {
  if (!d.storage_path) return 'No file was uploaded for this sample document.'
  const { data, error } = await supabase.storage.from('kb-docs').createSignedUrl(d.storage_path, 60)
  if (error || !data) return error?.message ?? 'Could not open the file'
  window.open(data.signedUrl, '_blank', 'noopener')
  return null
}

export const docLabel = (d: KbDoc) => (d.version && !d.title.endsWith(d.version) ? `${d.title} ${d.version}` : d.title)

/** Rates as CSV lines: age,gender,smoker,rate,ci_rate (a header line is optional). */
export const RATES_HEADER = 'age,gender,smoker,rate,ci_rate'
export function ratesToCsv(rates: Rate[]) {
  return [RATES_HEADER, ...rates.map((r) => [r.age, r.gender, r.smoker ? 'yes' : 'no', r.rate, r.ci_rate ?? ''].join(','))].join('\n')
}
export function parseRates(text: string): { rates: Rate[]; error: string } {
  const rates: Rate[] = []
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  for (const [i, line] of lines.entries()) {
    const c = line.split(/[,\t;]/).map((x) => x.trim())
    if (i === 0 && /age/i.test(c[0])) continue
    const age = Number(c[0]), rate = Number(c[3]), ci = c[4] ? Number(c[4]) : null
    const g = /^f/i.test(c[1]) ? 'Female' : /^m/i.test(c[1]) ? 'Male' : ''
    const smoker = /^(y|yes|true|1|s|smoker)$/i.test(c[2]) ? true : /^(n|no|false|0|ns|non-smoker)$/i.test(c[2]) ? false : null
    if (!Number.isInteger(age) || age < 0 || age > 100 || !g || smoker == null || !(rate > 0) || (ci != null && !(ci > 0))) {
      return { rates: [], error: `Line ${plain(i + 1)} ("${line}") needs: age, gender (M/F), smoker (yes/no), rate, and optionally the CI rate` }
    }
    rates.push({ age, gender: g, smoker, rate, ci_rate: ci })
  }
  return { rates, error: '' }
}
