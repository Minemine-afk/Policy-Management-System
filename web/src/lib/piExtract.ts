// Reads the term quotation comparison fields out of Singapore policy illustration (PI) PDFs, in the browser.
// The field list follows Kumar's spec "PI Illustration - Data Extraction" (Term Quotation Comparison Excel).
// Nothing leaves the user's computer, and no AI is used: only fixed reading rules. Results are
// suggestions, so ops must check every value. When a rule is not sure, the field is left blank
// for ops to fill in, rather than guessed.
//
// Singapore PIs follow the LIA format (LIA guidelines MU 22/18), which helps a lot:
//  - The Cover Page has the plan name above "Product Type", then "Premium Term", "Policy Term",
//    "Name of Insurer" and "Policy Currency" rows.
//  - The Policy Illustration starts with the life assured's details ("Life Assured : ...",
//    "Gender / Smoker Status : Male/Non-Smoker", "Residency / Nationality : ..."), then a summary
//    table (plan, terms, sum assured, premium, discount), then the riders ("Supplementary Benefits")
//    and a "Total:" line, then year-by-year tables with "Total Premiums Paid To-date".
// When a real insurer's PI reads wrongly, add an entry for that insurer in INSURER_RULES
// instead of changing the generic rules.

/** text: words. money: an amount in the policy currency. sum: a sum assured (or "NA"). years: a term.
 *  age: an age. cover: "Included" or "NA". currency: a 3-letter code such as SGD. */
export type FieldKind = 'text' | 'money' | 'sum' | 'years' | 'age' | 'cover' | 'currency'
/** 'meta': read and used (currency labels), but not a row of the comparison. */
export type Section = 'client' | 'banner' | 'plan' | 'death' | 'riders' | 'other' | 'meta'

export interface FieldDef {
  key: string
  /** The row label. Money rows get the policy currency added, e.g. "Annual Premium (SGD)". */
  label: string
  kind: FieldKind
  section: Section
}

export const SECTIONS: { key: Section; label: string }[] = [
  { key: 'client', label: 'Insured person' },
  { key: 'banner', label: 'Plan type: Term plan' },
  { key: 'plan', label: 'Plan' },
  { key: 'death', label: 'Base plan cover' },
  { key: 'riders', label: 'Riders' },
  { key: 'other', label: 'Other' },
]

export const FIELDS: FieldDef[] = [
  { key: 'insured_name', label: 'Insured Name', kind: 'text', section: 'client' },
  { key: 'date_of_birth', label: 'Date of Birth', kind: 'text', section: 'client' },
  { key: 'gender', label: 'Gender', kind: 'text', section: 'client' },
  { key: 'residency', label: 'Residency', kind: 'text', section: 'client' },
  { key: 'underwriting_class', label: 'Underwriting Class', kind: 'text', section: 'client' },
  { key: 'currency', label: 'Policy Currency', kind: 'currency', section: 'meta' },
  { key: 'cover_age', label: 'Policy Term: Up till age', kind: 'age', section: 'banner' },
  { key: 'insurer', label: 'Insurer', kind: 'text', section: 'plan' },
  { key: 'policy_name', label: 'Policy Name', kind: 'text', section: 'plan' },
  { key: 'policy_term', label: 'Policy Term (Years)', kind: 'years', section: 'plan' },
  { key: 'premium_term', label: 'Premium Term (Years)', kind: 'years', section: 'plan' },
  { key: 'annual_premium', label: 'Annual Premium', kind: 'money', section: 'plan' },
  { key: 'total_premium', label: 'Total Premium', kind: 'money', section: 'plan' },
  { key: 'death_sa', label: 'Death', kind: 'sum', section: 'death' },
  { key: 'terminal_illness', label: 'Terminal Illness', kind: 'cover', section: 'death' },
  { key: 'accidental_death', label: 'Accidental Death', kind: 'cover', section: 'death' },
  { key: 'base_premium', label: 'Premium', kind: 'money', section: 'death' },
  { key: 'tpd_sa', label: 'Total & Permanent Disability', kind: 'sum', section: 'riders' },
  { key: 'tpd_premium', label: 'TPD Premium', kind: 'money', section: 'riders' },
  { key: 'ci_sa', label: 'Critical Illness', kind: 'sum', section: 'riders' },
  { key: 'ci_premium', label: 'CI Premium', kind: 'money', section: 'riders' },
  { key: 'cash_value', label: 'Cash Value', kind: 'sum', section: 'other' },
  { key: 'campaigns', label: 'Campaigns', kind: 'text', section: 'other' },
]

/** The row label with the policy currency, e.g. "Annual Premium (SGD)". */
export const labelWith = (f: FieldDef, currency: string) => (f.kind === 'money' && currency ? `${f.label} (${currency})` : f.label)

/** Short insurer names, and the other names they appear under in PIs. First match wins. */
export const KNOWN_INSURERS: { name: string; aliases: string[] }[] = [
  { name: 'Singlife', aliases: ['Singlife', 'Singapore Life'] },
  { name: 'Tokio Marine', aliases: ['Tokio Marine'] },
  { name: 'Great Eastern', aliases: ['Great Eastern'] },
  { name: 'Income', aliases: ['Income Insurance', 'NTUC Income'] },
  { name: 'AIA', aliases: ['AIA'] },
  { name: 'Prudential', aliases: ['Prudential'] },
  { name: 'Manulife', aliases: ['Manulife'] },
  { name: 'HSBC Life', aliases: ['HSBC Life'] },
  { name: 'FWD', aliases: ['FWD'] },
  { name: 'China Life', aliases: ['China Life'] },
  { name: 'China Taiping', aliases: ['China Taiping'] },
  { name: 'Etiqa', aliases: ['Etiqa'] },
  { name: 'Raffles Health', aliases: ['Raffles Health'] },
]

/** Per-insurer extra labels for the "label then value" fallback, tried first. Fill in from real PIs. */
export const INSURER_RULES: Record<string, Partial<Record<string, RegExp[]>>> = {
  // Example: 'Great Eastern': { base_premium: [/\bmonthly\s+instalment\b/i] },
}

/** Currency names as PIs write them, to ISO codes. */
const CURRENCIES: [RegExp, string][] = [
  [/singapore\s+dollars?|\bS\$/i, 'SGD'], [/u\.?s\.?\s+dollars?|united\s+states\s+dollars?|\bUS\$/i, 'USD'],
  [/australian\s+dollars?|\bA\$/i, 'AUD'], [/canadian\s+dollars?|\bC\$/i, 'CAD'], [/hong\s+kong\s+dollars?|\bHK\$/i, 'HKD'],
  [/brunei\s+dollars?|\bB\$/i, 'BND'], [/new\s+zealand\s+dollars?/i, 'NZD'], [/ringgit|\bRM\s?\d/i, 'MYR'],
  [/pounds?\s+sterling|british\s+pounds?|£/i, 'GBP'], [/\beuros?\b|€/i, 'EUR'], [/renminbi|chinese\s+yuan/i, 'CNY'],
  [/japanese\s+yen/i, 'JPY'], [/indonesian\s+rupiah/i, 'IDR'],
]
const CODES = /^(SGD|USD|AUD|CAD|HKD|BND|NZD|MYR|GBP|EUR|CNY|RMB|JPY|IDR|CHF)$/

export interface TextItem { str: string; x: number; y: number; w: number }
export interface Line { page: number; text: string }
export interface Page {
  page: number; items: TextItem[]; lines: Line[]
  /** A scanned page that was not read with OCR, because the main values had already been found. */
  skipped?: boolean
}

/** Groups positioned text into reading-order lines. Wide gaps become double spaces. */
export function toLines(page: number, items: TextItem[]): Line[] {
  const rows: { y: number; items: TextItem[] }[] = []
  for (const it of items) {
    if (!it.str.trim()) continue
    const row = rows.find((r) => Math.abs(r.y - it.y) <= 3)
    if (row) row.items.push(it); else rows.push({ y: it.y, items: [it] })
  }
  rows.sort((a, b) => b.y - a.y)
  return rows.map((r) => {
    r.items.sort((a, b) => a.x - b.x)
    let text = '', end = -Infinity
    for (const it of r.items) {
      if (text) text += it.x - end > 12 ? '  ' : (text.endsWith(' ') || it.str.startsWith(' ') ? '' : ' ')
      text += it.str
      end = it.x + it.w
    }
    return { page, text: text.replace(/\s{3,}/g, '  ').trim() }
  })
}

export interface Found { value: string; page: number | null; line: string | null }
export interface Extracted {
  found: Record<string, Found>
  /** Things ops should know, such as a discounted premium. Shown on screen and written under the table. */
  notes: string[]
  /** True when the premium shown is after a discount. */
  discounted: boolean
  /** True when every year-by-year illustration was read to its last year (needed before skipping scanned pages). */
  totalComplete?: boolean
}

const NUM = /^\(?-?(?:S\$|SGD|\$)?\s*(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)\)?$/i
const MONEY_IN_TEXT = /(?:S\$|SGD|\$)\s*(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)/i

const num = (s: string) => Number(s.replace(/,/g, ''))
const money = (s: string) => {
  const n = num(s)
  return Number.isInteger(n) ? String(n) : n.toFixed(2)
}

/** "25 Years", "1 Year", "25" -> "25". "To age 65" stays as text. Anything else -> null. */
export function parseYears(raw: string): string | null {
  const s = raw.replace(/^[\s:\-–|]+/, '').trim()
  const toAge = s.match(/^(?:to|until|up\s+to)\s+age\s+(\d{2,3})\b/i)
  if (toAge) return `To age ${toAge[1]}`
  const yrs = s.match(/^(\d{1,2})(?:\s*(?:years?|yrs?))?\b(?!\s*[,.%\d])/i)
  return yrs ? yrs[1] : null
}

export function detectInsurer(text: string): string {
  for (const ins of KNOWN_INSURERS) {
    for (const a of ins.aliases) {
      if (new RegExp(`\\b${a.replace(/\s+/g, '\\s+')}\\b`, 'i').test(text)) return ins.name
    }
  }
  return ''
}

// ---------- Cover page (LIA format) ----------

function coverRow(lines: Line[], label: RegExp): { value: string; line: Line } | null {
  for (const l of lines) {
    const m = l.text.match(label)
    if (m && m.index === 0) {
      const value = l.text.slice(m[0].length).replace(/^[\s:]+/, '').trim()
      if (value) return { value, line: l }
    }
  }
  return null
}

// ---------- Summary table, read by position ----------

interface Cell { str: string; x: number; y: number; w: number }

const overlaps = (a: Cell, b: Cell) => a.x <= b.x + b.w + 4 && b.x <= a.x + a.w + 4

interface TableRead {
  page: number
  values: Partial<Record<'plan' | 'policy_term' | 'premium_term' | 'sum_assured' | 'premium' | 'before' | 'discount' | 'promo', string>>
  premiumHeader: string
  line: string
}

/**
 * Finds a table with a "Sum Assured" heading and reads the first row under it.
 * Each value is matched to the heading it sits under.
 */
// Known column headings. pdf.js sometimes joins neighbouring headings into one piece of text
// ("Premium Term Sum Assured /"), so we split them back out, with their share of the width.
const HEADING = /plan\s+name|your\s+plan|policy\s+term|premium\s+term|sum\s+assured(?:\s*\/\s*benefit)?(?:\s*\(S\$\))?|monthly\s+premium(?:\s*\(S\$\))?|premium\s+payable|premium\s+before\s+discount|before\s+discount|discount\s*\(%\)|premium|before|discount|benefit|promo\s+code:?/gi

function splitByPattern(it: Cell, re: RegExp): Cell[] {
  const out: Cell[] = []
  const len = it.str.length || 1
  for (const m of it.str.matchAll(re)) {
    const idx = m.index ?? 0
    out.push({ str: m[0].trim(), x: it.x + (it.w * idx) / len, y: it.y, w: (it.w * m[0].length) / len })
  }
  return out.length > 1 ? out : [it]
}

/**
 * Finds a table with a "Sum Assured" heading and reads the first row under it.
 * Each value is matched to the heading it sits under.
 */
function readSummaryTable(p: Page): TableRead | null {
  const raw = p.items.filter((i) => i.str.trim()).map((i) => ({ ...i, str: i.str.trim() }))
  // Short pieces of text only: a "sum assured" inside a sentence is small print, not a heading.
  for (const saRaw of raw.filter((i) => /(?:^|\s)sum\s+assured\b/i.test(i.str) && i.str.length <= 60)) {
    const t = readTableAt(raw, saRaw, p.page)
    if (t) return t
  }
  return null
}

function readTableAt(raw: Cell[], saRaw: Cell, page: number): TableRead | null {
  // Headings can wrap over a few lines, above and below the "Sum Assured" line.
  const head = raw.filter((i) => i.y <= saRaw.y + 12 && i.y >= saRaw.y - 22 && !NUM.test(i.str)).flatMap((i) => splitByPattern(i, HEADING))
  const saHead = head.find((i) => /^sum\s+assured\b/i.test(i.str))
  if (!saHead) return null
  const headBottom = Math.min(...head.map((h) => h.y))
  // Cells under the headings. Runs of numbers joined into one piece ("25 25 1,000,000.00") are split up.
  const items = raw.filter((i) => i.y < headBottom - 2).flatMap((i) => (/^[\d,.%$\s]+$/.test(i.str) && /\s/.test(i.str) ? splitByPattern(i, /\S+/g) : [i]))
  // The first row under the headings that has a number under "Sum Assured".
  const below = items.filter((i) => i.y > headBottom - 60)
  const saValue = below.filter((i) => NUM.test(i.str) && overlaps(i, saHead)).sort((a, b) => b.y - a.y)[0]
  if (!saValue) return null
  const row = below.filter((i) => Math.abs(i.y - saValue.y) <= 7)
  const under = (h: Cell | undefined, test: (s: string) => boolean) =>
    h ? row.filter((i) => overlaps(i, h) && test(i.str)).sort((a, b) => Math.abs(a.x - h.x) - Math.abs(b.x - h.x))[0]?.str : undefined
  const isNum = (s: string) => NUM.test(s)
  const find = (re: RegExp) => head.find((h) => re.test(h.str))

  const values: TableRead['values'] = {}
  values.sum_assured = saValue.str
  const pt = under(find(/^policy\s+term\b/i), (s) => !!parseYears(s))
  if (pt) values.policy_term = pt
  const prt = under(find(/^premium\s+term\b/i), (s) => !!parseYears(s))
  if (prt) values.premium_term = prt
  const isPct = (s: string) => /^\d{1,2}(?:\.\d+)?\s*%$/.test(s)
  const disc = head.filter((h) => /\bdiscount\b/i.test(h.str)).map((h) => under(h, isPct)).find(Boolean)
  if (disc) values.discount = disc
  // Promo code: "Promo Code: TP07" in one piece, or the code printed under the "Promo Code:" heading.
  const promoHead = head.find((h) => /^promo\s+code/i.test(h.str))
  const inline = raw.find((i) => Math.abs(i.y - saRaw.y) <= 30 && /promo\s+code\s*:?\s*([A-Z0-9]{3,12})\b/i.test(i.str))
  const promo = inline?.str.match(/promo\s+code\s*:?\s*([A-Z0-9]{3,12})\b/i)?.[1]
    ?? (promoHead ? raw.find((i) => i !== promoHead && i.y < promoHead.y && i.y > promoHead.y - 25 && overlaps(i, promoHead) && /^[A-Z]{0,6}\d[A-Z0-9]{0,8}$/.test(i.str) && !NUM.test(i.str))?.str : undefined)
  if (promo) values.promo = promo
  const before = under(find(/^before\b|before\s+discount/i), isNum)
  if (before) values.before = before

  // Premium column, most specific heading first.
  let premiumHeader = ''
  for (const re of [/^premium\s+payable\b/i, /^monthly\s+premium\b/i, /^premium\s*\(\s*monthly\s*\)/i, /^premium$/i]) {
    const h = head.find((x) => re.test(x.str))
    // A bare "Premium" heading that sits over "Before Discount" is not the payable premium.
    if (h && re.source === '^premium$' && head.some((x) => /^before\b/i.test(x.str) && overlaps(x, h))) continue
    const v = under(h, isNum)
    if (h && v) { values.premium = v; premiumHeader = h.str; break }
  }
  // Plan name: the text at the left of the row, if it is not a number or term.
  const leftmost = row.filter((i) => !NUM.test(i.str) && !parseYears(i.str)).sort((a, b) => a.x - b.x)[0]
  const planRow = items.filter((i) => i.y < headBottom - 2 && i.y >= saValue.y - 2 && i.x < (leftmost?.x ?? 0) + 5 && !NUM.test(i.str))
  const plan = planRow.sort((a, b) => b.y - a.y)[0] ?? leftmost
  if (plan && !/^life\s+assured$/i.test(plan.str)) values.plan = plan.str
  const line = [...row].sort((a, b) => a.x - b.x).map((i) => i.str).join(' ')
  return { page, values, premiumHeader, line }
}

// ---------- Main ----------

/** Reads "Label : value" from the lines. The label must start a piece of the line (pieces are split at wide
 *  gaps); the value is the rest of that piece or, when the label stands alone, the next piece. */
function labelled(lines: Line[], label: RegExp, needColon = true): { value: string; line: Line } | null {
  for (const l of lines) {
    const parts = l.text.split(/\s{2,}/)
    for (let i = 0; i < parts.length; i++) {
      const m = parts[i].match(label)
      if (!m || m.index !== 0) continue
      let rest = parts[i].slice(m[0].length)
      if (!rest.trim() && parts[i + 1]) rest = parts[i + 1]
      if (needColon && !/^\s*:/.test(rest)) continue
      const value = rest.replace(/^[\s:]+/, '').trim()
      if (value && !/^_+$/.test(value)) return { value, line: l }
    }
  }
  return null
}

export function currencyCode(raw: string): string {
  const s = raw.trim()
  if (CODES.test(s.toUpperCase())) return s.toUpperCase() === 'RMB' ? 'CNY' : s.toUpperCase()
  for (const [re, code] of CURRENCIES) if (re.test(s)) return code
  return ''
}

const round2 = (n: number) => Math.round(n * 100) / 100
const fmt2 = (n: number) => round2(n).toFixed(2)
/** "1,000,000.00" -> "1000000"; "46.35" -> "46.35". */
const amount = (s: string) => money(s.replace(/[^\d.,]/g, ''))

/** Payments a year for each payment mode. */
function modeFactor(mode: string): number | null {
  if (/monthly/i.test(mode)) return 12
  if (/quarterly/i.test(mode)) return 4
  if (/half|semi/i.test(mode)) return 2
  if (/annual|yearly/i.test(mode)) return 1
  return null
}

interface Rider { name: string; sa: string; premium: string; discount: string; page: number; line: string }

/** The rows of the "Supplementary Benefits" table on the summary page, read line by line:
 *  name, then numbers (terms, sum assured, premium before discount, discount %, premium payable). */
function readRiders(lines: Line[]): { riders: Rider[]; total: { value: string; page: number; line: string } | null; seen: boolean } {
  const idx = lines.findIndex((l) => /^supplementary\s+benefits?\b/i.test(l.text.trim()) && l.text.trim().length < 40)
  if (idx < 0) return { riders: [], total: null, seen: false }
  const page = lines[idx].page
  const riders: Rider[] = []
  let total: { value: string; page: number; line: string } | null = null
  for (const l of lines.slice(idx + 1).filter((x) => x.page === page).slice(0, 30)) {
    const t = l.text.trim()
    if (/^total\s*:/i.test(t)) {
      const nums = t.match(/\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?/g)
      if (nums) total = { value: amount(nums[nums.length - 1]), page, line: t }
      break
    }
    const m = t.match(/^([A-Za-z][^\d]*?(?:\b[IVX]+\b)?)\s+((?:\d|to\s+age).*)$/i)
    if (!m) continue
    const tokens = m[2].split(/\s+/)
    const nums = tokens.filter((x) => NUM.test(x))
    const pct = tokens.find((x) => /^\d{1,2}(?:\.\d+)?%$/.test(x)) ?? ''
    const big = nums.find((x) => num(x.replace(/[^\d.]/g, '')) >= 1000)
    if (!big || nums.length < 2) continue
    riders.push({ name: m[1].trim(), sa: amount(big), premium: amount(nums[nums.length - 1]), discount: pct, page, line: t })
  }
  return { riders, total, seen: true }
}

/** Another summary layout (e.g. FWD): one line per plan, base plan first, then riders, then "Total":
 *  "Future First  S$8,866.00  Annually  S$1,000,000  35  35" = name, premium, frequency, sum insured, two terms.
 *  Which term is which comes from the heading (premium "payment period" vs "coverage period"). */
const FREQ = /^(annual(?:ly)?|yearly|monthly|quarterly|half[\s-]?yearly|semi[\s-]?annual(?:ly)?|single)$/i
const CUR_AMT = /^(?:S\$|SGD|US\$|USD|HK\$|A\$|RM|\$)?\s?(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?)$/
interface PlanRow { name: string; premium: string; freq: string; sa: string; premiumTerm: string; policyTerm: string; page: number; line: string }
function readPlanRows(lines: Line[]): { rows: PlanRow[]; total: { value: string; page: number; line: string } | null } | null {
  for (let i = 0; i < lines.length; i++) {
    const parts = lines[i].text.split(/\s{2,}/)
    const fi = parts.findIndex((x) => FREQ.test(x.trim()))
    if (fi < 2 || parts.length < fi + 4) continue
    const prem = parts[fi - 1].match(CUR_AMT), sa = parts[fi + 1].match(CUR_AMT)
    const t1 = parseYears(parts[fi + 2]), t2 = parseYears(parts[fi + 3])
    if (!prem || !sa || !t1 || !t2) continue
    // Heading lines above: is the premium payment period before the coverage period?
    const head = lines.slice(Math.max(0, i - 8), i).filter((l) => l.page === lines[i].page).map((l) => l.text).join(' ')
    const afterSa = head.split(/sum\s+(?:insured|assured)/i).slice(1).join(' ')
    const payAt = afterSa.search(/payment|premium\s+term/i), covAt = afterSa.search(/coverage|policy\s+term|cover/i)
    const premiumFirst = payAt >= 0 && (covAt < 0 || payAt < covAt)
    const rows: PlanRow[] = []
    let total: { value: string; page: number; line: string } | null = null
    for (const l of lines.slice(i, i + 15).filter((x) => x.page === lines[i].page)) {
      const ps = l.text.split(/\s{2,}/)
      const t = ps[0].match(/^total\b/i) && ps[1]?.match(CUR_AMT)
      if (t) { total = { value: amount(t[1]), page: l.page, line: l.text }; break }
      const f = ps.findIndex((x) => FREQ.test(x.trim()))
      if (f < 1 || ps.length < f + 4) { if (rows.length) break; continue }
      const pm = ps[f - 1].match(CUR_AMT), sm = ps[f + 1].match(CUR_AMT)
      const a = parseYears(ps[f + 2]), b = parseYears(ps[f + 3])
      if (!pm || !sm || !a || !b) break
      rows.push({ name: ps.slice(0, f - 1).join(' ').trim(), premium: amount(pm[1]), freq: ps[f].trim(), sa: amount(sm[1]),
        premiumTerm: premiumFirst ? a : b, policyTerm: premiumFirst ? b : a, page: l.page, line: l.text })
    }
    if (rows.length) return { rows, total }
  }
  return null
}

const isTpd = (n: string) => /\bTPD\b|total\s*(?:and|&)\s*permanent\s+disab/i.test(n)
const isCi = (n: string) => /critical\s+illness|\bCI\b|dread\s+disease/i.test(n) && !/waiver|payer/i.test(n)

interface IllRow { year: number; age: number; total: string; rest: string[]; page: number; line: string }

/** The year-by-year tables headed "Total Premiums Paid To-date". Tables about distribution cost are left out.
 *  A new illustration starts when the policy year goes back down (main plan first, then each rider). */
function readIllustrations(lines: Line[]): { segments: IllRow[][]; surrender: boolean } {
  const segments: IllRow[][] = []
  let inTable = false, surrender = false, misses = 0
  lines.forEach((l, i) => {
    if (/total\s*premiums?\s*paid|paid\s+to[\s-]*date/i.test(l.text)) {
      const near = lines.slice(Math.max(0, i - 1), i + 3).filter((x) => x.page === l.page).map((x) => x.text).join(' ')
      inTable = !/distribution\s+cost/i.test(near)
      surrender = inTable && /surr?ender\s+(?:value|benefit)/i.test(near)
      misses = 0
      return
    }
    if (!inTable) return
    // "25/61  13,905 ..." or, with year and age in their own columns, "25  61  13,905 ..."
    const m = l.text.match(/^(\d{1,3})\s*(?:\/\s*|\s+)(\d{1,3})\s+(?:S\$|\$)?(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?)\b\s*(.*)$/)
    if (!m) { if (++misses > 15) inTable = false; return }
    misses = 0
    const row: IllRow = { year: +m[1], age: +m[2], total: amount(m[3]), rest: m[4].split(/\s+/).filter(Boolean), page: l.page, line: l.text }
    const seg = segments[segments.length - 1]
    const last = seg?.[seg.length - 1]
    if (!last || row.year < last.year) segments.push([row])
    else if (!(row.year === last.year && row.total === last.total)) seg.push(row)
    ;(row as IllRow & { surrender?: boolean }).surrender = surrender
  })
  return { segments, surrender }
}

export function extract(pages: Page[], fileName: string): Extracted {
  const lines = pages.flatMap((p) => p.lines)
  const found: Record<string, Found> = Object.fromEntries(FIELDS.map((f) => [f.key, { value: '', page: null, line: null }]))
  const notes: string[] = []
  const set = (key: string, value: string | null | undefined, page: number | null, line: string | null) => {
    if (value && !found[key].value) found[key] = { value, page, line }
  }

  // ----- Insured person (the "Policyholder and Plan Details" block) -----
  const name = labelled(lines, /^life\s+assured(?:'s)?(?:\s+name)?\b/i) ?? labelled(lines, /^(?:name\s+of\s+(?:the\s+)?life\s+assured|insured\s+name)\b/i)
  if (name) set('insured_name', name.value, name.line.page, name.line.text)
  // Another layout (e.g. FWD): a table "Name | Gender | Age | Smoker Status" with a "Person insured" row.
  for (const l of lines) {
    const m = l.text.match(/^(?:person|life)\s+(?:insured|assured)\s{2,}(.+?)\s{2,}(male|female)\s{2,}(?:(\d{1,3})\s{2,})?(non[\s-]?smoker|smoker)\b/i)
    if (!m) continue
    set('insured_name', m[1].trim(), l.page, l.text)
    set('gender', cap(m[2]), l.page, l.text)
    set('underwriting_class', smoker(m[4]), l.page, l.text)
    break
  }
  const dob = labelled(lines, /^(?:date\s+of\s+birth|DOB)\b/i)
  if (dob) set('date_of_birth', dob.value, dob.line.page, dob.line.text)
  const gs = labelled(lines, /^gender\s*\/\s*smok(?:er|ing)\s+status\b/i) ?? labelled(lines, /^sex\s*\/\s*smok(?:er|ing)\s+status\b/i)
  if (gs) {
    const g = gs.value.match(/\b(male|female)\b/i)
    if (g) set('gender', cap(g[1]), gs.line.page, gs.line.text)
    const sm = gs.value.match(/\b(non[\s-]?smoker|smoker)\b/i)
    if (sm) set('underwriting_class', smoker(sm[1]), gs.line.page, gs.line.text)
  }
  const g2 = labelled(lines, /^(?:gender|sex)\b/i)
  if (g2) { const g = g2.value.match(/^(male|female|m|f)\b/i); if (g) set('gender', /^f/i.test(g[1]) ? 'Female' : 'Male', g2.line.page, g2.line.text) }
  const sm2 = labelled(lines, /^(?:smok(?:ing|er)\s+status|smoker|underwriting\s+class)\b/i)
  if (sm2) { const sm = sm2.value.match(/^(non[\s-]?smoker|smoker|yes|no)\b/i); if (sm) set('underwriting_class', /^yes$/i.test(sm[1]) ? 'Smoker' : /^no$/i.test(sm[1]) ? 'Non-Smoker' : smoker(sm[1]), sm2.line.page, sm2.line.text) }
  const res = labelled(lines, /^(?:residency(?:\s*\/\s*nationality)?|country\s+of\s+residence|residence)\b/i)
  if (res) {
    // "Indonesia - Major Cities (D1) / Indonesia (ID)" -> "Indonesia"
    const v = res.value.split('/')[0].replace(/\s+-\s+.*$/, '').replace(/\([^)]*\)/g, '').trim()
    set('residency', v, res.line.page, res.line.text)
  }

  // ----- Cover page rows (only the first pages, where the cover page sits) -----
  const cover = lines.filter((l) => l.page <= 2)
  const prt = coverRow(cover, /^premium\s+term\b/i)
  if (prt) set('premium_term', parseYears(prt.value), prt.line.page, prt.line.text)
  const pt = coverRow(cover, /^policy\s+(?:coverage\s+)?term\b/i) ?? coverRow(cover, /^(?:coverage|policy)\s+period\b/i)
  if (pt) set('policy_term', parseYears(pt.value), pt.line.page, pt.line.text)
  const insurerRow = coverRow(cover, /^name\s+of\s+insurer\b/i)

  // Plan name: the line just above "Product Type" on the cover page.
  let plan = ''
  let planAt: Line | null = null
  const ptIdx = cover.findIndex((l) => /^product\s+type\b/i.test(l.text))
  if (ptIdx > 0 && cover[ptIdx - 1].page === cover[ptIdx].page) {
    const cand = cover[ptIdx - 1].text.trim()
    if (cand.length <= 80 && !/[.:]$/.test(cand)) { plan = cand; planAt = cover[ptIdx - 1] }
  }

  // ----- Currency: "Currency : SGD", the cover page's "Policy Currency  Singapore Dollars", or "(S$)" headings -----
  const cur = labelled(lines, /^(?:policy\s+)?currency\b/i, false)
  const curCode = cur ? currencyCode(cur.value.split(/\s{2,}/)[0]) : ''
  if (cur && curCode) set('currency', curCode, cur.line.page, cur.line.text)
  if (!found.currency.value) {
    const l = lines.find((x) => /\((?:S\$|SGD|US\$|USD|HK\$|A\$|RM)\)/.test(x.text))
    const c = l?.text.match(/\((S\$|SGD|US\$|USD|HK\$|A\$|RM)\)/)?.[1]
    if (l && c) set('currency', currencyCode(c === 'RM' ? 'RM 1' : c), l.page, l.text)
  }
  const currency = found.currency.value
  /** An amount for a note: "SGD 1,089.00" (no currency when it is not known). */
  const cm = (v: string | number) => `${currency ? currency + ' ' : ''}${num(String(v)).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

  // Total distribution cost: not a comparison field any more, but useful to know.
  for (const l of lines) {
    const m = l.text.match(/total\s+distribution\s+cost\s+for\s+this\s+plan\s+is\s*(.*)$/i)
    if (!m) continue
    const v = m[1].replace(/\$\s+(?=\d)/, '$').replace(/([\d.,])\s+(?=[\d.,])/g, '$1').match(MONEY_IN_TEXT)
    const next = lines[lines.indexOf(l) + 1]?.text ?? ''
    const pct = (l.text + ' ' + next).match(/makes\s+up\s+(\d{1,3}(?:\.\d+)?)\s*%/i)
    if (v) notes.push(`Total distribution cost is ${cm(v[1])}${pct ? ` (${pct[1]}% of total premiums)` : ''}.`)
    break
  }

  // ----- Payment mode: premiums in the comparison are per year -----
  const modeRow = labelled(lines, /^payment\s+mode\b/i, false)
  const mode = modeRow?.value.match(/^(monthly|quarterly|half[\s-]?yearly|semi[\s-]?annual(?:ly)?|annual(?:ly)?|yearly|single)/i)?.[1] ?? ''

  // ----- Summary table -----
  let table: TableRead | null = null
  for (const p of pages) { table = readSummaryTable(p); if (table) break }
  const planRows = table ? null : readPlanRows(lines)
  const baseRow = planRows?.rows[0]
  const factor = modeFactor(mode) ?? (baseRow ? modeFactor(baseRow.freq) : null) ?? (table && /monthly/i.test(table.premiumHeader) ? 12 : table && /annual/i.test(table.premiumHeader) ? 1 : null)
  const modeName = mode ? cap(mode) : baseRow && modeFactor(baseRow.freq) ? cap(baseRow.freq) : factor === 12 ? 'Monthly' : factor === 1 ? 'Annual' : ''
  const yearly = (v: string) => (factor ? fmt2(num(v) * factor) : '')
  let baseModal = ''
  if (table) {
    const t = table.values
    set('death_sa', t.sum_assured ? amount(t.sum_assured) : '', table.page, table.line)
    set('policy_term', t.policy_term ? parseYears(t.policy_term) : '', table.page, table.line)
    set('premium_term', t.premium_term ? parseYears(t.premium_term) : '', table.page, table.line)
    if (t.premium) { baseModal = amount(t.premium); set('base_premium', yearly(baseModal), table.page, table.line) }
    if (!plan && t.plan) plan = t.plan
  }
  if (baseRow) {
    set('death_sa', baseRow.sa, baseRow.page, baseRow.line)
    set('policy_term', baseRow.policyTerm, baseRow.page, baseRow.line)
    set('premium_term', baseRow.premiumTerm, baseRow.page, baseRow.line)
    baseModal = baseRow.premium
    set('base_premium', yearly(baseModal), baseRow.page, baseRow.line)
    if (!plan && baseRow.name) plan = baseRow.name
  }

  // Fallbacks: "label: value" on one line (never the next line, to avoid picking up the wrong number).
  const insurer = detectInsurer(insurerRow?.value ?? '') || detectInsurer(lines.slice(0, 80).map((l) => l.text).join('\n') + '\n' + fileName.replace(/[_.-]+/g, ' '))
  const labelRules: Record<string, RegExp[]> = {
    death_sa: [/\b(?:basic\s+)?sum\s+assured\s*(?:\((?:S\$|SGD|US\$|USD)\))?\s*:/i],
  }
  for (const [key, generic] of Object.entries(labelRules)) {
    for (const re of [...(INSURER_RULES[insurer]?.[key] ?? []), ...generic]) {
      for (const l of lines) {
        const m = l.text.match(re)
        if (!m) continue
        const after = l.text.slice((m.index ?? 0) + m[0].length).trim()
        const v = after.match(/^(?:S\$|SGD|US\$|USD|\$)?\s*(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)\b/i)
        if (v) { set(key, money(v[1]), l.page, l.text); break }
      }
      if (found[key].value) break
    }
  }

  // ----- Riders, and the total premium line -----
  const fromTable = readRiders(lines)
  const riders: Rider[] = planRows ? planRows.rows.slice(1).map((r) => ({ name: r.name, sa: r.sa, premium: r.premium, discount: '', page: r.page, line: r.line })) : fromTable.riders
  const total = planRows ? planRows.total : fromTable.total
  const ridersSeen = planRows ? true : fromTable.seen
  const tpd = riders.find((r) => isTpd(r.name))
  const ci = riders.find((r) => isCi(r.name))
  if (tpd) { set('tpd_sa', tpd.sa, tpd.page, tpd.line); set('tpd_premium', yearly(tpd.premium), tpd.page, tpd.line) }
  if (ci) { set('ci_sa', ci.sa, ci.page, ci.line); set('ci_premium', yearly(ci.premium), ci.page, ci.line) }
  // Spec: no CI rider -> "NA" and "NA". Same for TPD. Only once the summary page has been read.
  if (table || ridersSeen) {
    if (!ci) { set('ci_sa', 'NA', null, null); set('ci_premium', 'NA', null, null) }
    if (!tpd) { set('tpd_sa', 'NA', null, null); set('tpd_premium', 'NA', null, null) }
  }
  const others = riders.filter((r) => r !== tpd && r !== ci)
  if (others.length) notes.push(`Other riders not in the table: ${others.map((r) => `${r.name} (${cm(r.premium)} ${modeName.toLowerCase() || 'per payment'})`).join('; ')}.`)
  if (total) set('annual_premium', yearly(total.value), total.page, total.line)
  else if (table && baseModal && ridersSeen === false) set('annual_premium', yearly(baseModal), table.page, table.line)
  else if (baseRow && planRows!.rows.length === 1) set('annual_premium', yearly(baseModal), baseRow.page, baseRow.line)
  if (factor && factor !== 1 && (found.annual_premium.value || found.base_premium.value)) {
    notes.push(`Payment mode is ${modeName}: premiums are shown per year (${factor} × the ${modeName.toLowerCase()} premium${total ? `, ${cm(total.value)} in total` : baseModal ? `, ${cm(baseModal)}` : ''}).`)
  }
  if (!factor && (table?.values.premium || total || baseRow)) {
    notes.push('Payment mode not found, so premiums were left blank. Fill them in as yearly amounts.')
  }
  if (mode && /single/i.test(mode)) notes.push('This is a single premium policy: the premium is paid once.')

  // ----- Total premium: the last "Total Premiums Paid To-date" of the main illustration, plus each rider's -----
  const { segments } = readIllustrations(lines)
  if (segments.length) {
    const lasts = segments.map((s) => s[s.length - 1])
    const sum = lasts.reduce((n, r) => n + num(r.total), 0)
    set('total_premium', fmt2(sum), lasts[0].page, lasts.map((r) => r.line).join(' + '))
    if (lasts.length > 1) notes.push(`Total premium adds the main plan (${cm(lasts[0].total)}) and ${lasts.length - 1 === 1 ? 'the rider' : `${lasts.length - 1} riders`} (${lasts.slice(1).map((r) => `${cm(r.total)}`).join(', ')}).`)
    // Covered up till age: the age on the main illustration's last row.
    set('cover_age', String(lasts[0].age), lasts[0].page, lasts[0].line)
    // Cash value: none when every guaranteed surrender value in the main illustration is "-" or 0.
    const main = segments[0] as (IllRow & { surrender?: boolean })[]
    if (main.some((r) => r.surrender)) {
      // The surrender value is the last of at least two columns after the premiums (death benefit, surrender value).
      // OCR often drops a lone "-", leaving only the death benefit: that row then has no surrender value.
      const sv = main.map((r) => (r.rest.length >= 2 ? r.rest[r.rest.length - 1] : '-')).map((x) => (NUM.test(x) ? num(x.replace(/[^\d.]/g, '')) : 0))
      const best = Math.max(...sv)
      set('cash_value', best > 0 ? money(String(best)) : 'NA', lasts[0].page, best > 0 ? `highest guaranteed surrender value ${best}` : 'guaranteed surrender values are all "-" or 0')
      if (best > 0) notes.push(`Cash value shown is the highest guaranteed surrender value in the illustration (${cm(money(String(best)))}).`)
    }
  }
  if (!found.cover_age.value) {
    const pTerm = found.policy_term.value
    const anb = labelled(lines, /^age\s+next\s+birthday\b/i) ?? labelled(lines, /^(?:ANB|age)\b/i)
    const anbN = anb?.value.match(/^\d{1,3}/)?.[0]
    if (/^to\s+age\s+(\d+)/i.test(pTerm)) set('cover_age', pTerm.match(/(\d+)/)![1], found.policy_term.page, found.policy_term.line)
    else if (anbN && /^\d+$/.test(pTerm)) set('cover_age', String(+anbN + +pTerm), anb!.line.page, `${anb!.line.text} + policy term ${pTerm}`)
  }

  // ----- Benefits of the base plan, from the cover page and product summary wording -----
  const mention = (re: RegExp) => lines.find((l) => re.test(l.text) && !/\b(?:not|no|exclud\w*)\b[^.]*$/i.test(l.text.split(re)[0]))
  const ti = mention(/terminal\s+illness/i)
  if (ti) set('terminal_illness', 'Included', ti.page, ti.text)
  const ad = mention(/accidental\s+death/i)
  if (ad) set('accidental_death', 'Included', ad.page, ad.text)
  // A PI lists what the plan pays for; a benefit it never mentions is not covered (spec: "NA").
  if (table || baseRow) {
    if (!ti) set('terminal_illness', 'NA', null, 'not mentioned anywhere in the PI')
    if (!ad) set('accidental_death', 'NA', null, 'not mentioned anywhere in the PI')
  }
  const noCash = lines.find((l) => /(?:does\s+not\s+have|has\s+no|there\s+is\s+no|without)\s+(?:any\s+)?cash\s+values?/i.test(l.text))
  if (noCash) set('cash_value', 'NA', noCash.page, noCash.text)
  const coverText = lines.filter((l) => l.page <= 2).map((l) => l.text).join(' ')
  const baseCovers = /protection\s+against\s+death[^.]*(?:critical\s+illness|permanent\s+disability)/i.test(coverText)
  if (baseCovers && !tpd && !ci) notes.push('The plan itself covers more than death (see the cover page, e.g. TPD or critical illness), without a separate rider. The rider rows show NA by the spec\'s rule.')

  // ----- Campaigns: the discount on the summary table, promo code, and whether it lasts the whole term -----
  if (table?.values.discount) {
    const pct = table.values.discount.replace(/\s+/g, '')
    const perpetual = lines.some((l) => /discount\s+is\s+applied[^.]*(?:entire|whole|full)\s+(?:duration|premium\s+term|policy\s+term)|perpetual\s+discount|discount\s+for\s+(?:the\s+)?(?:entire|whole|full)\s+(?:premium|policy)\s+term|lifetime\s+discount/i.test(l.text))
    const onRiders = riders.filter((r) => r.discount).map((r) => (isTpd(r.name) ? 'TPD rider' : isCi(r.name) ? 'CI rider' : r.name))
    const value = `${pct}${perpetual ? ' perpetual' : ''} discount${onRiders.length ? ` with ${onRiders.join(', ')}` : ''}${table.values.promo ? ` (promo code ${table.values.promo})` : ''}`
    set('campaigns', value, table.page, table.line)
    if (table.values.before) notes.unshift(`Premium is after the ${pct} discount (${cm(amount(table.values.before))}${modeName ? ' ' + modeName.toLowerCase() : ''} before it).`)
  } else if (lines.some((l) => /\b(?:promo(?:tion(?:al)?)?\s+(?:code|discount)|premium\s+discount|discount\s*\(%\))/i.test(l.text))) {
    notes.unshift('This PI mentions a premium discount or promotion. Fill in Campaigns by hand.')
  } else if (table || baseRow) {
    set('campaigns', 'NA', null, null)
  }

  // ----- Insurer and policy name -----
  const insurerName = insurer || (insurerRow?.value ?? '').replace(/\s+(?:Pte\.?\s+)?Ltd\.?$/i, '')
  if (insurerName) set('insurer', insurerName, insurerRow?.line.page ?? planAt?.page ?? null, insurerRow?.line.text ?? null)
  if (plan) {
    // "Singlife Elite Term II" -> "Elite Term II": the insurer has its own row.
    const aliases = KNOWN_INSURERS.find((k) => k.name === insurer)?.aliases ?? []
    // OCR sometimes reads one capital as small inside an all-capitals word ("CiMB"): put it back.
    let p = plan.replace(/\b([A-Z]+)([a-z])([A-Z]+)\b/g, (_m, a: string, b: string, c: string) => a + b.toUpperCase() + c)
    for (const a of aliases) p = p.replace(new RegExp(`^${a.replace(/\s+/g, '\\s+')}\\s+`, 'i'), '')
    set('policy_name', p, planAt?.page ?? table?.page ?? null, planAt?.text ?? table?.line ?? null)
  }

  if (currency && currency !== 'SGD') notes.push(`Policy currency is ${currency}, not SGD: amounts are in ${currency}.`)
  if (!currency) notes.push('Policy currency not found. Fill it in, so amounts are labelled correctly.')

  // Every illustration read to its end (last row at the policy term or the cover age), so the total premium is whole.
  const termN = /^\d+$/.test(found.policy_term.value) ? +found.policy_term.value : null
  const endAge = found.cover_age.value ? +found.cover_age.value : null
  const totalComplete = segments.length > 0 && segments.every((s) => {
    const last = s[s.length - 1]
    return (termN !== null && last.year >= termN) || (endAge !== null && last.age >= endAge)
  })

  return { found, notes, discounted: !!table?.values.discount, totalComplete }
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase()
const smoker = (s: string) => (/^non/i.test(s) ? 'Non-Smoker' : 'Smoker')

/** Called as pages are read: pages done so far (with a fraction while OCR reads a page), the PDF's page count,
 *  and whether OCR is being used. */
export type PageProgress = (done: number, total: number, ocr: boolean) => void
/** Reads a page that has no text inside it (a scanned picture). Calls `alive` while it works on the page,
 *  with how much of the page is done (0 to 1). */
export type OcrPage = (page: unknown, alive: (done: number) => void) => Promise<TextItem[]>

/** Fields that many PIs never show (date of birth, residency, accidental death, cash value), or that are only
 *  complete once every illustration has been read (total premium), are not needed to stop reading scans early. */
const NEEDED_FOR_EARLY_STOP = ['total_premium', 'insured_name', 'gender', 'underwriting_class', 'currency', 'insurer', 'policy_name', 'policy_term',
  'premium_term', 'annual_premium', 'death_sa', 'terminal_illness', 'base_premium', 'tpd_sa', 'ci_sa', 'campaigns', 'cover_age']

/** True when the pages read so far hold the main values, so the scanned pages left can be skipped. */
export function allFound(pages: Page[]): boolean {
  const { found, totalComplete } = extract(pages, '')
  return !!totalComplete && NEEDED_FOR_EARLY_STOP.every((k) => !!found[k].value)
}

/** A page with fewer text pieces than this is treated as a scan and read with OCR. */
const MIN_TEXT_ITEMS = 5

/** Reads a PDF into positioned text and lines with pdf.js (loaded only when needed). Scanned pages are read
 *  with OCR (see ocr.ts). Gives up when nothing moves for `stallMs`, so a PDF the reader can't finish never
 *  leaves the screen waiting; a long scanned PI keeps going as long as pages keep being read. */
export async function readPdf(data: ArrayBuffer, onPage?: PageProgress, stallMs = 60_000, useOcr = true): Promise<Page[]> {
  let task: { destroy?: () => unknown } | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let fail: (e: Error) => void = () => {}
  const stalled = new Promise<never>((_, reject) => { fail = reject })
  const arm = () => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      task?.destroy?.()
      fail(new Error(`nothing happened for ${Math.round(stallMs / 1000)} seconds. Reload the page and try again, or type the values in by hand`))
    }, stallMs)
  }
  arm()
  const read = (async () => {
    // The legacy build carries polyfills: the default build needs very recent browser features
    // (Map.getOrInsertComputed, Math.sumPrecise, Promise.try, ...) and silently fails in older Chrome, Edge or Safari.
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
    const workerUrl = (await import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url')).default
    pdfjs.GlobalWorkerOptions.workerSrc = workerUrl
    const ocr = useOcr ? (await import('./ocr')).ocrPage : undefined
    return readWith(pdfjs, data, (d, t, o) => { arm(); onPage?.(d, t, o) }, (t) => { task = t }, ocr, allFound)
  })()
  try {
    return await Promise.race([read, stalled])
  } finally {
    clearTimeout(timer)
  }
}

/** Shared by the browser and the Node test scripts. OCR is slow (seconds a page), so once `enough` says the
 *  pages read so far hold everything, later scanned pages are skipped (marked `skipped`). */
export async function readWith(pdfjs: { getDocument: (src: { data: Uint8Array }) => { promise: Promise<unknown> } }, data: ArrayBuffer,
  onPage?: PageProgress, onTask?: (task: { destroy?: () => unknown }) => void, ocr?: OcrPage, enough?: (pages: Page[]) => boolean): Promise<Page[]> {
  const task = pdfjs.getDocument({ data: new Uint8Array(data) })
  onTask?.(task as { destroy?: () => unknown })
  const doc = (await task.promise) as any
  onPage?.(0, doc.numPages, false)
  const pages: Page[] = []
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p)
    const content = await page.getTextContent()
    let items: TextItem[] = []
    for (const it of content.items) {
      if (!('str' in it)) continue
      items.push({ str: it.str, x: it.transform[4], y: it.transform[5], w: it.width })
    }
    if (ocr && items.filter((i) => i.str.trim()).length < MIN_TEXT_ITEMS) {
      if (enough?.(pages)) {
        pages.push({ page: p, items: [], lines: [], skipped: true })
        onPage?.(p, doc.numPages, false)
        continue
      }
      onPage?.(p - 1, doc.numPages, true)
      items = await ocr(page, (done) => onPage?.(p - 1 + Math.min(0.99, done), doc.numPages, true))
    }
    pages.push({ page: p, items, lines: toLines(p, items) })
    onPage?.(p, doc.numPages, false)
  }
  return pages
}
