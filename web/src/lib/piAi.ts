// The optional AI helper for the PI reader (Kumar, 25 Nov 2026: "add the free AI option for now").
//
// It runs a small free, open model (Apache 2.0) IN THE BROWSER: the PI text never leaves the user's computer, only the
// model's files are downloaded (once, then cached by the browser). It only fills cells the reader's rules left
// BLANK, and every value it gives must pass checks against the PI's own text before it is used:
//  - an amount, sum assured, term or age must be a number written in the PI (an annual premium may also be a
//    monthly, quarterly or half-yearly amount written in the PI, times 12, 4 or 2);
//  - an insurer or plan name must be words written in the PI;
//  - a premium's frequency (monthly, yearly...) must agree with the PI's own wording next to it;
//  - a rider's value must sit next to the rider's name, and a rider premium can't be the plan's own premium.
// Anything that fails a check is dropped (the cell stays blank). Values it fills are tagged "AI" for ops to check.
// This file holds the prompt and the checks, shared by the browser (aiModel.ts) and the Node tests.
import { KNOWN_INSURERS, detectInsurer, type Found, type Page } from './piExtract.ts'
import { fmtNum, plain } from './num.ts'

export type AiKind = 'name' | 'money' | 'annual' | 'years' | 'age' | 'total' | 'person' | 'date' | 'gender' | 'smoker' | 'country' | 'currency' | 'cover' | 'cash' | 'campaign'

/** The fields the AI is asked about: every row of the comparison but the insured's name (the request form gives
 *  "Mr VIP" / "Ms VIP", and a small model takes the adviser's or the plan's name for it). It is asked only about cells still blank after the
 *  reader's rules, the places ops taught and the request form (which fills the client particulars it holds), so in
 *  practice client particulars are asked only on requests whose form lacks them. `group`: asked together in one
 *  question (a small model answers a short list better than a long one). */
export const AI_FIELDS: { key: string; ask: string; kind: AiKind; group: 'plan' | 'more' }[] = [
  { key: 'insurer', ask: 'the insurance company name', kind: 'name', group: 'plan' },
  { key: 'policy_name', ask: 'the plan (product) name, without the company name', kind: 'name', group: 'plan' },
  { key: 'policy_term', ask: 'the policy term or coverage period, in years (a number)', kind: 'years', group: 'plan' },
  { key: 'premium_term', ask: 'the premium payment term, in years (a number)', kind: 'years', group: 'plan' },
  { key: 'cover_age', ask: 'the age the cover ends at (a number), only if the document says it', kind: 'age', group: 'plan' },
  { key: 'death_sa', ask: 'the death benefit / sum assured / coverage amount', kind: 'money', group: 'plan' },
  { key: 'annual_premium', ask: 'the total premium to pay, with how often it is paid', kind: 'annual', group: 'plan' },
  { key: 'base_premium', ask: 'the premium of the basic plan alone (without riders), with how often it is paid', kind: 'annual', group: 'plan' },
  { key: 'tpd_sa', ask: 'the total & permanent disability (TPD) rider sum assured, only if there is such a rider', kind: 'money', group: 'plan' },
  { key: 'tpd_premium', ask: 'the TPD rider premium, with how often it is paid', kind: 'annual', group: 'plan' },
  { key: 'ci_sa', ask: 'the critical illness (CI) rider sum assured, only if there is such a rider', kind: 'money', group: 'plan' },
  { key: 'ci_premium', ask: 'the CI rider premium, with how often it is paid', kind: 'annual', group: 'plan' },
  { key: 'currency', ask: 'the policy currency (for example SGD, USD)', kind: 'currency', group: 'more' },
  { key: 'total_premium', ask: 'the total of all premiums paid over the whole policy term (total premiums paid to date at the end)', kind: 'total', group: 'more' },
  { key: 'terminal_illness', ask: 'is terminal illness covered by the plan? "yes" or null', kind: 'cover', group: 'more' },
  { key: 'accidental_death', ask: 'is accidental death covered by the plan? "yes" or null', kind: 'cover', group: 'more' },
  { key: 'cash_value', ask: 'the cash (surrender) value; "none" if the document says there is no cash value', kind: 'cash', group: 'more' },
  { key: 'campaigns', ask: 'a discount or promotion given on the premium, copied as written, or null', kind: 'campaign', group: 'more' },
  { key: 'date_of_birth', ask: "the person insured's date of birth (not the date the document was prepared)", kind: 'date', group: 'more' },
  { key: 'gender', ask: "the person insured's gender (Male or Female)", kind: 'gender', group: 'more' },
  { key: 'underwriting_class', ask: "the person insured's smoker status (Smoker or Non-Smoker)", kind: 'smoker', group: 'more' },
  { key: 'residency', ask: "the person insured's country of residence, only if the document says it", kind: 'country', group: 'more' },
]

/** The questions for these blank keys: the plan fields first, then the rest. */
export const aiGroups = (keys: string[]): string[][] =>
  (['plan', 'more'] as const).map((g) => AI_FIELDS.filter((f) => f.group === g && keys.includes(f.key)).map((f) => f.key)).filter((g) => g.length)

/** About 2,000 tokens: enough for the pages that hold a PI's summary, small enough to read quickly on a laptop. */
export const MAX_CHARS = 7000

const KEYWORDS = /premium|sum\s+(?:assured|insured)|coverage|benefit|death|term|plan|policy|product|insur|age\b|annual|month|year|disab|critical|illness|rider|amount|cost|face/i

/** The PI text the model reads: the first pages whole (they hold the summary), then lines with words that matter,
 *  up to MAX_CHARS. Year-by-year table rows after the first few are left out. */
export function promptText(pages: Page[], max = MAX_CHARS): string {
  const out: string[] = []
  let size = 0
  const add = (s: string) => { if (size + s.length + 1 > max) return false; out.push(s); size += s.length + 1; return true }
  const used = new Set<string>()
  for (const p of pages.slice(0, 2)) {
    for (const l of p.lines) {
      const t = l.text.trim()
      if (!t || used.has(t)) continue
      used.add(t)
      if (!add(t)) return out.join('\n')
    }
  }
  let rows = 0
  for (const p of pages.slice(2)) {
    for (const l of p.lines) {
      const t = l.text.trim()
      if (!t || used.has(t)) continue
      const tableRow = /^\d{1,3}\s+\d{1,3}\b/.test(t) && (t.match(/\d[\d,.]*/g) ?? []).length >= 4
      if (tableRow ? ++rows > 6 : !KEYWORDS.test(t)) continue
      used.add(t)
      if (!add(t)) return out.join('\n')
    }
  }
  return out.join('\n')
}

/** The chat messages for the model: the PI text and the fields still blank. */
export function buildMessages(pages: Page[], keys: string[]): { role: 'system' | 'user'; content: string }[] {
  const ask = AI_FIELDS.filter((f) => keys.includes(f.key))
  const shape = ask.map((f) => f.kind === 'annual' ? `"${f.key}": {"amount": "...", "per": "year|month|quarter|half-year"}` : `"${f.key}": "..."`).join(', ')
  return [
    { role: 'system', content: 'You read life insurance policy illustrations and quotes. You copy values exactly as the document writes them. When the document does not clearly state a value, you answer null. You never guess or calculate.' },
    {
      role: 'user',
      content: `Document:\n"""\n${promptText(pages)}\n"""\n\nFrom the document, give:\n${ask.map((f) => `- ${f.key}: ${f.ask}`).join('\n')}\n\n`
        + `Answer with one JSON object only, like {${shape}}. Copy numbers as written. Use null for anything the document does not state.`,
    },
  ]
}

/** The first {...} object in the model's answer, or null. */
export function parseAnswer(text: string): Record<string, unknown> | null {
  const s = text.replace(/<think>[\s\S]*?<\/think>/g, '')
  const start = s.indexOf('{')
  if (start < 0) return null
  let depth = 0
  for (let i = start; i < s.length; i++) {
    if (s[i] === '{') depth++
    else if (s[i] === '}' && --depth === 0) {
      try { return JSON.parse(s.slice(start, i + 1)) } catch { return null }
    }
  }
  return null
}

const amountOf = (raw: unknown): number | null => {
  if (typeof raw === 'number') return Number.isFinite(raw) && raw > 0 ? raw : null
  if (typeof raw !== 'string') return null
  const m = raw.replace(/\s/g, '').match(/^(?:[A-Z]{0,3}\$|[A-Z]{3}|RM)?(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)(?:[A-Z]{3})?$/i)
  if (!m) return null
  const n = Number(m[1].replace(/,/g, ''))
  return n > 0 ? n : null
}
/** Every number written in the PI (commas dropped), e.g. "$1,000,000.00" -> 1000000. */
export function numbersIn(pages: Page[]): Set<number> {
  const set = new Set<number>()
  for (const p of pages) for (const l of p.lines) {
    for (const m of l.text.matchAll(/(?<![\d.])(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)(?![\d]|\s*%)/g)) set.add(Number(m[1].replace(/,/g, '')))
  }
  return set
}
/** A line and up to 8 lines above it on the same page, as one text. */
const contextOf = (lines: { page: number; text: string }[], line: { page: number; text: string }) => {
  const i = lines.indexOf(line)
  return lines.slice(Math.max(0, i - 8), i + 1).filter((l) => l.page === line.page).map((l) => l.text).join(' \n ')
}
/** Names that say only what kind of plan it is ("Term Life Insurance"), not which. */
const GENERIC = /^(?:(?:level|renewable|decreasing|term|life|whole|insurance|assurance|plan|policy|product|basic|coverage|protection|the|a|of|and|premium)\s*)+$/
/** Words that make an answer a description, not a plan's name ("Non-Participating Term Plan", "Life Client Quote"). */
const NOT_A_NAME = /\b(?:non participating|participating|client|quote|illustration|summary|disclosure|sheet|proposal|benefit illustration)\b/
/** A company's name: "... Ltd", "... Insurance", "... Assurance", "... Financial", "... Bank", "... Berhad". */
const COMPANY = /\b(?:ltd|limited|inc|insurance|assurance|financial|bank|berhad|bhd|company|co\.|group|corporation)\b/i
/** Words in plan names, not company names. */
const PLAN_WORDS = /\b(?:term|protect\w*|plan|secure|shield|cover|guard|care|essential|plus|saver|elite|first)\b/i
const LIMIT = /\bup\s+to\b|maximum|\bmax\b|minimum|\bmin\b|\blimit|exceed|\bcap\b/i
const WORKED = /\d\s*[x×]\s*[\d.]+\s*=/i
/** An age in such a line is a renewal, conversion or benefit limit, not the age this policy's cover ends. */
const NOT_COVER_END = /renew|convert|conversion|prior\s+to|before|attain|entry|issue\s+age|disab|\btpd\b|critical|minimum|maximum|illustrat|years?[\s-]+old/i
/** An age where the cover ends is written as such: "expires at age 85", "cover up to age 80", "maturity age", or under a
 *  column heading such as "Coverage Provided To Age" (the line or the 3 above it). */
const COVER_END = /expir|matur|\bends?\b|until\s+(?:the\s+)?age|till\s+age|to\s+age|cover(?:ed|age|s)?\s+(?:to|until|till)|terminat/i
/** A list number ("5. What are...") or a row of year numbers ("1 2 3 4 5"), not a term. */
const LIST_LINE = /^\s*\d{1,2}\.\s|\b1\s+2\s+3\b/
const TERM_WORDS = /term|year|yrs?\b|pay|period|age|duration|T-?\d|\d\s*-?\s*(?:yr|year)/i
const DATE_LIKE = /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2}\b|\b\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\b|\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}/i
/** Another amount on the same line within 10% of this one ("RM 102,000.00  RM 100,000.00" for two options): which
 *  one is this policy's can't be told from the line. */
const rivals = (line: string, n: number) => [...line.matchAll(/\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g)].map((m) => Number(m[0].replace(/,/g, ''))).some((x) => x !== n && Math.abs(x - n) <= 0.1 * n)
const flat = (s: string) => s.toLowerCase().replace(/[’']/g, "'").replace(/[^a-z0-9'&]+/g, ' ').trim()
const show = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2))

type Ln = { page: number; text: string }
interface Ctx {
  lines: Ln[]; text: string; nums: Set<number>; lineWith: (needle: string) => Ln | null; lineWithNum: (n: number) => Ln | null
  known: Record<string, string>; found: Record<string, Found>
}
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
/** "12/03/1985", "12-03-1985", "12 Mar 1985", "March 12, 1985", "1985-03-12" -> [day, month, year], or null. */
export function dateParts(raw: string): [number, number, number] | null {
  const s = raw.trim()
  let m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/)
  if (m) return [+m[1], +m[2], +m[3]]
  m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/)
  if (m) return [+m[3], +m[2], +m[1]]
  m = s.match(/^(\d{1,2})[\s-]+([a-z]{3})[a-z]*\.?[\s-]+(\d{4})$/i)
  if (m && MONTHS.includes(m[2].toLowerCase())) return [+m[1], MONTHS.indexOf(m[2].toLowerCase()) + 1, +m[3]]
  m = s.match(/^([a-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})$/i)
  if (m && MONTHS.includes(m[1].toLowerCase())) return [+m[2], MONTHS.indexOf(m[1].toLowerCase()) + 1, +m[3]]
  return null
}
const pad = (n: number) => String(n).padStart(2, '0')
/** Every date written in a line, as [day, month, year]. */
const datesIn = (t: string) => [...t.matchAll(/\d{1,2}[/.-]\d{1,2}[/.-]\d{4}|\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[\s-]+[a-z]{3,9}\.?[\s-]+\d{4}|[a-z]{3,9}\.?\s+\d{1,2},?\s+\d{4}/gi)].map((m) => dateParts(m[0])).filter(Boolean) as [number, number, number][]
/** The line and the 3 lines above it on its page (a table's column heading sits above its rows). */
const near = (lines: Ln[], l: Ln) => contextOf(lines, l).split(' \n ').slice(-4).join(' ')
/** An ISO code for a currency the model named ("S$", "Singapore Dollars", "sgd"). */
const CURRENCY_WORDS: [RegExp, string, RegExp][] = [
  [/^s\$|singapore|^sgd$/i, 'SGD', /\bSGD\b|\bS\$|singapore\s+dollars?/i],
  [/^us\$|united states|u\.?s\.? dollar|^usd$/i, 'USD', /\bUSD\b|\bUS\$|u\.?s\.?\s+dollars?|united\s+states\s+dollars?/i],
  [/^c\$|canad|^cad$/i, 'CAD', /\bCAD\b|\bC\$|canadian\s+dollars?/i],
  [/^rm$|ringgit|^myr$/i, 'MYR', /\bMYR\b|\bRM\s?\d|ringgit/i],
  [/^hk\$|hong kong|^hkd$/i, 'HKD', /\bHKD\b|\bHK\$|hong\s+kong\s+dollars?/i],
  [/^a\$|australia|^aud$/i, 'AUD', /\bAUD\b|\bA\$|australian\s+dollars?/i],
  [/^b\$|brunei|^bnd$/i, 'BND', /\bBND\b|\bB\$|brunei\s+dollars?/i],
  [/pound|sterling|^gbp$|^£$/i, 'GBP', /\bGBP\b|£|pounds?\s+sterling/i],
  [/euro|^eur$|^€$/i, 'EUR', /\bEUR\b|€|\beuros?\b/i],
]
export const currencyOfAnswer = (raw: string) => CURRENCY_WORDS.find(([re]) => re.test(raw.replace(/\s*\(.*\)\s*$/, '').trim()))?.[1] ?? ''
const YES = /^(?:yes|y|true|included|covered)$/i
const NO_CASH = /^(?:none|no|nil|na|n\/a|0|0\.00|-|no cash value|not applicable)$/i
const GENDER: Record<string, string> = { male: 'Male', m: 'Male', female: 'Female', f: 'Female' }
const smokerOfAnswer = (v: string) => /^(?:non[\s-]?smoker|ns|non[\s-]?smoking|non[\s-]?tobacco)$/i.test(v.trim()) ? 'Non-Smoker' : /^(?:smoker|s|smoking|tobacco)$/i.test(v.trim()) ? 'Smoker' : ''
/** A date that is not the client's date of birth: when the PI was prepared, issued, valid till, printed... */
const NOT_BIRTH = /prepar|issu|valid|quot|print|illustrat|effective|commenc|expir|generat|date\s+of\s+(?:proposal|application)|today/i

/** Checks an answer for one of the fields beyond the plan's numbers (client particulars, currency, total premium,
 *  covers, cash value, campaigns) against the PI's text. Returns the value and the line it was found on, or null. */
function checkMore(kind: AiKind, key: string, raw: unknown, c: Ctx): { value: string; line: Ln | null } | null {
  const str = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : typeof raw === 'number' || typeof raw === 'boolean' ? String(raw) : ''
  if (!str) return null
  const { lines, text } = c
  const word = (re: RegExp) => lines.find((l) => re.test(l.text)) ?? null
  if (kind === 'gender') {
    const v = GENDER[str.toLowerCase()]
    if (!v) return null
    // The word itself next to a "Gender" / "Sex" label (its line or the column heading above it).
    // Not a rates table for both ("Age  Male  Female") nor a worked example ("Mary; Female, Age 30").
    const l = lines.find((x) => new RegExp(`\\b${v}\\b`, 'i').test(x.text) && !(/\bmale\b/i.test(x.text) && /\bfemale\b/i.test(x.text))
      && /gender|\bsex\b/i.test(contextOf(lines, x).split(' \n ').slice(-7).join(' ')) && !/example|e\.g\.|for instance|illustration\s+only/i.test(near(lines, x)))
    return l ? { value: v, line: l } : null
  }
  if (kind === 'smoker') {
    const v = smokerOfAnswer(str)
    if (!v) return null
    const re = v === 'Smoker' ? /(?<!non[\s-]?)\bsmoker\b/i : /non[\s-]?smoker|non[\s-]?smoking/i
    const l = lines.find((x) => re.test(x.text) && /smok/i.test(near(lines, x)))
    // A smoker status that the PI also writes the other way (a table of rates for both) can't be told.
    const other = v === 'Smoker' ? /non[\s-]?smoker/i : /(?<!non[\s-]?)\bsmoker\b/i
    return l && !(other.test(l.text)) ? { value: v, line: l } : null
  }
  if (kind === 'date') {
    const d = dateParts(str)
    if (!d) return null
    const [dd, mm, yy] = d
    const now = new Date().getFullYear()
    if (mm < 1 || mm > 12 || dd < 1 || dd > 31 || yy < now - 100 || yy > now - 1) return null
    const l = lines.find((x) => datesIn(x.text).some(([a, b, y]) => a === dd && b === mm && y === yy))
    // Its own line, or the label above it, speaks of birth, and not of when the PI was prepared or issued.
    if (!l || !/birth|\bd\.?o\.?b\b/i.test(near(lines, l)) || NOT_BIRTH.test(l.text.replace(/birth/ig, ''))) return null
    return { value: `${pad(dd)}/${pad(mm)}/${plain(yy)}`, line: l }
  }
  if (kind === 'person' || kind === 'country') {
    const words = flat(str)
    if (!words || words.length < 2 || words.length > 40 || /\d/.test(words) || !text.includes(` ${words} `)) return null
    const label = kind === 'person' ? /\bname\b|insured|assured|life\s+to\s+be|policy\s*holder|proposer|on\s+the\s+life\s+of/i : /residen|nationality|country/i
    // The label on the value's own line, before it ("Country of Residence : Indonesia"), or a short heading right
    // above it (a table's column heading). Not just anywhere near: "Policy Currency  Singapore Dollars" sits under
    // "Country of Residence" in some PIs.
    const at = (x: Ln) => {
      const i = flat(x.text).indexOf(words)
      if (label.test(flat(x.text).slice(0, Math.max(0, i)))) return true
      const k = lines.indexOf(x), up = lines[k - 1]
      // Under a heading, the line holds the value alone.
      return !!up && up.page === x.page && up.text.length <= 60 && label.test(up.text) && !/\d/.test(up.text) && flat(x.text) === words
    }
    const l = lines.find((x) => flat(x.text).includes(words) && at(x))
    if (!l || NOT_A_NAME.test(words)) return null
    if (kind === 'person') {
      // A person's name, not the plan's or the insurer's.
      const others = [c.found.policy_name?.value, c.known.policy_name, c.found.insurer?.value, c.known.insurer].filter(Boolean).map((x) => flat(x!))
      if (GENERIC.test(words) || NOT_A_NAME.test(words) || COMPANY.test(str) || PLAN_WORDS.test(str) || others.some((o) => o.includes(words) || words.includes(o))) return null
    }
    return { value: str.replace(/[.,;:]+$/, ''), line: l }
  }
  if (kind === 'currency') {
    const code = currencyOfAnswer(str)
    const ev = CURRENCY_WORDS.find(([, k]) => k === code)?.[2]
    if (!code || !ev) return null
    const l = word(ev)
    if (!l) return null
    // Another currency written as often or more: which one is this policy's can't be told from the text.
    const count = (re: RegExp) => lines.filter((x) => re.test(x.text)).length
    const mine = count(ev)
    if (CURRENCY_WORDS.some(([, k, re]) => k !== code && count(re) >= mine)) return null
    return { value: code, line: l }
  }
  if (kind === 'cover') {
    if (!YES.test(str)) return null
    const re = key === 'terminal_illness' ? /terminal\s+illness|\(TI\)|\bTI\b/i : /accident(?:al)?\s+death/i
    // Named as something the plan pays, not as an exclusion, an optional rider, or a rider you can add.
    // Not an item of a numbered list of illnesses ("39. Terminal Illness": a critical illness definition).
    const l = lines.find((x) => re.test(x.text) && !/\b\d{1,2}\.\s/.test(x.text) && !/exclu|not\s+(?:be\s+)?(?:covered|payable|included)|\bno\b|rider|optional|additional|supplementary|add[\s-]?on/i.test(near(lines, x)))
    return l ? { value: 'Included', line: l } : null
  }
  if (kind === 'cash') {
    if (NO_CASH.test(str)) {
      const l = word(/no\s+(?:guaranteed\s+)?(?:cash|surrender)\s+value|(?:cash|surrender)\s+value\s*(?:is|:)?\s*(?:nil|none|not\s+applicable)|no\s+savings\s+or\s+investment/i)
      return l ? { value: 'NA', line: l } : null
    }
    const n = amountOfAny(str)
    const l = n === null ? null : c.lineWithNum(n)
    if (n === null || n < 1 || !c.nums.has(n) || !l || !/cash|surrender/i.test(near(c.lines, l)) || LIMIT.test(l.text)) return null
    return { value: show(n), line: l }
  }
  if (kind === 'campaign') {
    const words = flat(str)
    if (words.length < 8 || words.length > 200 || !text.includes(` ${words} `) || !/discount|promo|rebate|waive|waiver|free|\d\s*%|offer|campaign|cash\s*back/i.test(str)) return null
    // A discount for paying yearly ("save 5% if you pay annually") is a payment-mode saving, not a campaign.
    if (/pay(?:ing)?\s+(?:your\s+premiums?\s+)?(?:annual|yearly)|annual\s+(?:mode|payment)/i.test(str)) return null
    const l = c.lineWith(words.split(' ').slice(0, 4).join(' '))
    return { value: str, line: l }
  }
  if (kind === 'total') {
    const n = amountOfAny(str)
    const l = n === null ? null : c.lineWithNum(n)
    if (n === null || !c.nums.has(n) || !l || !/total|to[\s-]*date|accumulat|cumulative/i.test(near(c.lines, l)) || WORKED.test(l.text) || /distribution|commission/i.test(near(c.lines, l))) return null
    // Over the whole term, so more than one year's premium (and not wildly more): the yearly premium must be known.
    const annual = Number(c.found.annual_premium?.value ?? c.known.annual_premium ?? NaN)
    if (!Number.isFinite(annual) || annual <= 0 || n < annual * 1.5 || n > annual * 120) return null
    const sa = Number(c.found.death_sa?.value ?? c.known.death_sa ?? NaN)
    if (Number.isFinite(sa) && sa > 0 && n === sa) return null
    return { value: show(n), line: l }
  }
  return null
}
/** An amount in any currency's writing ("S$10,884.00", "SGD 1,000", "1000"). */
const amountOfAny = (raw: string): number | null => {
  const m = raw.replace(/\s/g, '').match(/^(?:[A-Z]{0,3}\$|[A-Z]{3}|RM)?(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)(?:[A-Z]{3})?$/i)
  if (!m) return null
  const n = Number(m[1].replace(/,/g, ''))
  return Number.isFinite(n) ? n : null
}

export interface AiFill { found: Record<string, Found>; dropped: string[] }

/** Checks the model's answer against the PI and turns what passes into reader values tagged `ai`. Only `keys`
 *  (the blank cells) are taken. `known`: the cells already filled (by the rules or by hand), to cross-check
 *  against. `dropped` names the answers that failed a check. */
export function checkAnswer(answer: Record<string, unknown> | null, pages: Page[], keys: string[], known: Record<string, string> = {}): AiFill {
  const found: Record<string, Found> = {}
  const dropped: string[] = []
  if (!answer) return { found, dropped }
  const nums = numbersIn(pages)
  const lines = pages.flatMap((p) => p.lines)
  const text = ' ' + flat(lines.map((l) => l.text).join(' ')) + ' '
  const lineWith = (needle: string) => lines.find((l) => flat(l.text).includes(needle)) ?? null
  const lineWithNum = (n: number) => lines.find((l) => [...l.text.matchAll(/\d[\d,]*(?:\.\d+)?(?![\d.]|\s*%)/g)].some((m) => Number(m[0].replace(/,/g, '')) === n)) ?? null
  const put = (key: string, value: string, line: { page: number; text: string } | null) => {
    found[key] = { value, page: line?.page ?? null, line: line?.text ?? null, ai: true }
  }

  for (const f of AI_FIELDS) {
    if (!keys.includes(f.key)) continue
    const raw = answer[f.key]
    if (raw === null || raw === undefined || raw === '' || (typeof raw === 'string' && /^(?:null|n\/?a|none|unknown|not stated)$/i.test(raw.trim()) && !(f.kind === 'cash' && /^none$/i.test(raw.trim())))) continue
    if (f.kind === 'name') {
      if (typeof raw !== 'string') { dropped.push(f.key); continue }
      const v = raw.replace(/\s+/g, ' ').replace(/[®™]/g, '').trim()
      const words = flat(v)
      if (!words || words.length < 2 || words.length > 60 || !text.includes(` ${words} `) || /^\d+$/.test(words) || GENERIC.test(words) || NOT_A_NAME.test(words)) { dropped.push(f.key); continue }
      if (f.key === 'insurer') {
        // An insurer is one the reader knows (given by its short name), or a name that reads like a company's.
        const known = detectInsurer(v)
        // "Acme Life" is a company's name, "Life Term Protect Secure" a plan's.
        const lifeCo = /\blife\b/i.test(v) && v.split(/\s+/).length <= 3 && !PLAN_WORDS.test(v)
        // A bare "PTE LTD" is what is left of a blacked-out name, not an insurer.
        if ((!known && !COMPANY.test(v) && !lifeCo) || /^(?:pte\.?\s*)?(?:ltd|limited|berhad|bhd|inc)\.?$/i.test(v)) { dropped.push(f.key); continue }
        put(f.key, known || v, lineWith(words))
        continue
      }
      // The plan name without the insurer in front ("iA Financial Group Term 20" -> "Term 20"), as the reader gives it.
      const ins = (found.insurer?.value ?? known.insurer ?? '').trim()
      const heads = [ins.split(/\s+/)[0], ...KNOWN_INSURERS.flatMap((x) => [x.name, ...x.aliases])].filter(Boolean).sort((a, b) => b.length - a.length)
      const head = heads.find((h) => flat(v).startsWith(flat(h) + ' '))
      const name = head ? v.replace(new RegExp(`^\\s*${head.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')}\\s+`, 'i'), '').replace(/^\s*(?:financial\s+group|life(?:\s+assurance|\s+insurance)?|insurance|assurance)?\s+/i, '').trim() : v
      // A label ("Basic Sum Insured", "Premium Frequency") is not a plan's name.
      if (!flat(name) || GENERIC.test(flat(name)) || /\b(?:sum|insured|assured|premium|amount|frequency|currency|date|summary|benefit)\b/i.test(name)) { dropped.push(f.key); continue }
      put(f.key, name, lineWith(words))
    } else if (f.kind === 'money') {
      const n = amountOf(raw)
      const line = n === null ? null : lineWithNum(n)
      // "up to RM1,000,000", "maximum", "minimum": a product limit, not this policy's cover.
      if (n === null || !nums.has(n) || n < 1000 || !line || LIMIT.test(line.text) || WORKED.test(line.text) || rivals(line.text, n)) { dropped.push(f.key); continue }
      put(f.key, show(n), line)
    } else if (f.kind === 'years' || f.kind === 'age') {
      const n = amountOf(raw)
      // A term under 5 years is too rare in term plans to tell from a footnote number ("® 1"): left for ops.
      const ok = n !== null && Number.isInteger(n) && nums.has(n) && (f.kind === 'years' ? n >= 5 && n <= 100 : n >= 30 && n <= 120)
      // A term in years is never the N of "To Age N" (that is an age).
      // Nor the N of "every N policy years" (how often a benefit is paid).
      const isAge = (t: string) => new RegExp(`\\b(?:age\\s*(?:of\\s*)?|every\\s+)${plain(n!)}\\b`, 'i').test(t)
      // Its line must be about a term or an age, not a date ("September 12, 2024") or a phone number.
      // A premium term's line must speak of paying ("premium", "pay"), so the cover's length is not taken for it.
      const words = f.key === 'premium_term' ? /premium|pay/i : TERM_WORDS
      const l = ok ? lines.find((x) => [...x.text.matchAll(/\d[\d,]*(?:\.\d+)?(?![\d.]|\s*%)/g)].some((m) => Number(m[0].replace(/,/g, '')) === n) && words.test(x.text) && !DATE_LIKE.test(x.text) && !LIST_LINE.test(x.text) && !(f.kind === 'years' && isAge(x.text)) && !(f.kind === 'age' && (NOT_COVER_END.test(x.text) || !COVER_END.test(contextOf(lines, x).split(' \n ').slice(-4).join(' '))))) : undefined
      if (!ok || !l) { dropped.push(f.key); continue }
      put(f.key, String(n), l)
    } else if (f.kind !== 'annual') {
      const r = checkMore(f.kind, f.key, raw, { lines, text, nums, lineWith, lineWithNum, known, found })
      if (r) put(f.key, r.value, r.line)
      else dropped.push(f.key)
    } else {
      const o = (raw && typeof raw === 'object' ? raw : { amount: raw, per: 'year' }) as { amount?: unknown; per?: unknown }
      const n = amountOf(o.amount)
      const per = String(o.per ?? 'year').toLowerCase()
      const times = /month/.test(per) ? 12 : /quarter/.test(per) ? 4 : /half|semi/.test(per) ? 2 : /year|annual|^$/.test(per) ? 1 : 0
      if (n === null || !times || !nums.has(n)) { dropped.push(f.key); continue }
      const line = lineWithNum(n)
      // How often the PI says this amount is paid: its own line and the lines above it on that page (a column
      // heading such as "Initial Monthly Premium"). The model's "per" must agree, so a monthly figure is never taken
      // as yearly, and a yearly one is never multiplied by 12.
      const ctx = line ? contextOf(lines, line) : ''
      const says = { 12: /month|\/\s*mo\b/i, 4: /quarter/i, 2: /half[\s-]*year|semi[\s-]*annual/i, 1: /annual|yearly|per\s+year|\/\s*y(?:ea)?r\b|per\s+annum|p\.\s?a\./i } as Record<number, RegExp>
      // The amount's own line decides when it names a frequency; else the lines above it.
      const freq = (t: string) => Object.keys(says).map(Number).filter((k) => says[k].test(t))
      const named = line && freq(line.text).length ? freq(line.text) : freq(ctx)
      // The distribution cost (commission) is not a premium, though it sits beside one in SG PIs.
      if (/distribution|commission/i.test(contextOf(lines, line ?? { page: -1, text: '' }).split(' \n ').slice(-3).join(' '))) { dropped.push(f.key); continue }
      // A single premium is not a yearly one; a worked example ("RM200,000 x 4.92 = RM984.00") is not this policy's.
      if (!line || (times > 1 ? !named.includes(times) : named.length > 0 && !named.includes(1)) || /single\s+premium/i.test(ctx) || WORKED.test(line.text) || rivals(line.text, n)) { dropped.push(f.key); continue }
      // A monthly premium times 12 only when the PI shows no yearly premium at all (paying yearly is often cheaper).
      if (times > 1 && /annual|yearly|per\s+annum/i.test(text)) { dropped.push(f.key); continue }
      // When the PI has a "Total" premium line, the total premium must be read from it, not from the plan's own line.
      if (f.key === 'annual_premium' && !/total/i.test(line.text) && lines.some((x) => /^\s*total\b[^\d]*\d/i.test(x.text) || /total\s+(?:annual\s+)?premium/i.test(x.text))) { dropped.push(f.key); continue }
      const value = (Math.round(n * times * 100) / 100).toFixed(2)
      put(f.key, value, line)
      if (times > 1) found[f.key].line = `${line!.text} (${fmtNum(n)} × ${plain(times)} a year)`
    }
  }
  // A rider value must sit next to the rider's name (TPD / critical illness) in the PI, and a rider premium can't be
  // the plan's own premium: a small model easily copies the base premium into every premium cell.
  const rider: Record<string, RegExp> = { tpd: /disab|\btpd\b/i, ci: /critical|\bci\b|dread/i }
  const premiums = ['annual_premium', 'base_premium'].map((k) => found[k]?.value ?? known[k] ?? '').filter(Boolean).map(Number)
  for (const k of ['tpd_sa', 'tpd_premium', 'ci_sa', 'ci_premium']) {
    const fd = found[k]
    if (!fd) continue
    const l = lines.find((x) => x.page === fd.page && fd.line?.startsWith(x.text))
    const near = l ? (rider[k.slice(0, k.indexOf('_'))].test(l.text) || rider[k.slice(0, k.indexOf('_'))].test(contextOf(lines, l).split(' \n ').slice(-3).join(' '))) : false
    if (!near || (k.endsWith('premium') && premiums.includes(Number(fd.value)))) { delete found[k]; dropped.push(k) }
  }
  if (found.tpd_premium && found.ci_premium && found.tpd_premium.value === found.ci_premium.value) { delete found.tpd_premium; delete found.ci_premium; dropped.push('tpd_premium', 'ci_premium') }
  // A premium term longer than the policy term, or a rider larger than the death cover, means the model mixed things up.
  const nv = (k: string) => (found[k] ? Number(found[k].value) : null)
  if (nv('premium_term') !== null && nv('policy_term') !== null && nv('premium_term')! > nv('policy_term')!) { delete found.premium_term; delete found.policy_term; dropped.push('premium_term', 'policy_term') }
  for (const k of ['tpd_sa', 'ci_sa']) if (nv(k) !== null && nv('death_sa') !== null && nv(k)! > nv('death_sa')!) { delete found[k]; dropped.push(k) }
  const kv = (k: string) => nv(k) ?? (known[k] && !isNaN(Number(known[k])) ? Number(known[k]) : null)
  if (nv('death_sa') === null && kv('death_sa') !== null) for (const k of ['tpd_sa', 'ci_sa']) if (nv(k) !== null && nv(k)! > kv('death_sa')!) { delete found[k]; dropped.push(k) }
  // A premium is a small part of the cover: one at 20% or more of the death sum assured is a sum assured misread.
  if (kv('death_sa') !== null) for (const k of ['annual_premium', 'base_premium', 'tpd_premium', 'ci_premium']) if (nv(k) !== null && nv(k)! >= 0.2 * kv('death_sa')!) { delete found[k]; dropped.push(k) }
  // The base plan's premium equal to the total, where the PI says its amounts include riders: the total was copied.
  // A premium the PI says includes riders' premiums is not the basic plan's alone.
  if (found.base_premium) {
    const l = lines.find((x) => x.page === found.base_premium.page && found.base_premium.line?.startsWith(x.text))
    if (l && /includ\w*\s+(?:any\s+|the\s+)?(?:premiums?\s+(?:of|for)\s+)?(?:the\s+)?riders?/i.test(contextOf(lines, l))) { delete found.base_premium; dropped.push('base_premium') }
  }
  // So is one equal to the total where the PI has riders or a policy fee anywhere (the total holds them too).
  if (found.base_premium && nv('base_premium') === kv('annual_premium')) {
    const l = lines.find((x) => x.page === found.base_premium.page && found.base_premium.line?.startsWith(x.text))
    if (!l || /rider|supplementary/i.test(contextOf(lines, l)) || /policy\s+fee|admin\w*\s+fee/i.test(text)) { delete found.base_premium; dropped.push('base_premium') }
  }
  if (nv('base_premium') !== null && kv('annual_premium') !== null && nv('base_premium')! > kv('annual_premium')!) { delete found.base_premium; dropped.push('base_premium') }
  return { found, dropped }
}

/** The cells the AI may fill: blank after the reader's rules and the taught places. */
export const blankKeys = (found: Record<string, Found | undefined>) => AI_FIELDS.map((f) => f.key).filter((k) => !found[k]?.value)

// ----- Page pictures: when pdf.js and OCR got no text from a PI (or reading stopped part-way) -----
// The model also sees images. Asked straight for values, a small model makes some up for pages that don't show them
// (tested 26 Nov 2026 on two scanned SG PIs: 14 of 25 values wrong). So it is asked only to READ OUT each page's
// words (as OCR would). That text then goes through the same steps as any PI text: the AI is asked about it, and its
// answers must be found in it, next to the right words (checkAnswer). Values found this way are tagged as read from a
// page picture, since the read-out itself can be wrong: ops check them against the PDF.

/** Enough for a PI page's words; a read-out that runs on is cut here (on a processor, ~0.3 s a word piece). */
export const READ_OUT_TOKENS = 450

/** Not asked from read-out page pictures: too easy to take from the wrong line of a rough read-out. */
const NOT_FROM_PICTURE = new Set(['date_of_birth', 'insured_name', 'residency', 'campaigns'])

/** The keys to ask about pages read from pictures. */
export const pictureKeys = (keys: string[]) => keys.filter((k) => !NOT_FROM_PICTURE.has(k))

/** The request to read out one page picture (the image goes with it, as the first part). */
export function readOutMessages(): { role: string; content: string | ({ type: 'image' } | { type: 'text'; text: string })[] }[] {
  return [{ role: 'user', content: [{ type: 'image' }, { type: 'text', text: 'Read out all the text on this page, line by line, exactly as written. For a table, write each row on one line. Do not add anything.' }] }]
}

/** The model's read-out of a page as PI text lines. A small model sometimes ends in a loop of empty table rows or the
 *  same line again and again: that tail is dropped. */
export function readOutPage(raw: string, page: number): Page {
  const out: string[] = []
  let junk = 0, same = 0
  for (const l of raw.replace(/<think>[\s\S]*?<\/think>/g, '').split(/\r?\n/)) {
    const t = l.replace(/^\s*\|\s*|\s*\|\s*$/g, '').replace(/\s*\|\s*/g, '  ').replace(/[*#`]+/g, '').trim()
    if (!t || /^[-:|\s]+$/.test(t)) { if (++junk >= 3) break; continue }
    junk = 0
    if (out.length && out[out.length - 1] === t) { if (++same >= 2) break; continue }
    same = 0
    out.push(t)
  }
  return { page, items: [], lines: out.map((text) => ({ page, text })) }
}

/** The cross-checks of checkAnswer that need no text: values that can't all be right together are dropped. */
export function pictureCrossChecks(found: Record<string, Found>, dropped: string[], known: Record<string, string>) {
  const nv = (k: string) => (found[k] ? Number(found[k].value) : null)
  const kv = (k: string) => nv(k) ?? (known[k] && !isNaN(Number(known[k])) ? Number(known[k]) : null)
  const drop = (...ks: string[]) => { for (const k of ks) if (found[k]) { delete found[k]; dropped.push(k) } }
  if (kv('premium_term') !== null && kv('policy_term') !== null && kv('premium_term')! > kv('policy_term')!) drop('premium_term', 'policy_term')
  const premiums = ['annual_premium', 'base_premium'].map(kv).filter((x) => x !== null)
  for (const k of ['tpd_premium', 'ci_premium']) if (nv(k) !== null && premiums.includes(nv(k)!)) drop(k)
  if (nv('tpd_premium') !== null && nv('tpd_premium') === nv('ci_premium')) drop('tpd_premium', 'ci_premium')
  if (nv('tpd_sa') !== null && nv('tpd_sa') === nv('ci_sa') && nv('tpd_premium') === null && nv('ci_premium') === null) drop('tpd_sa', 'ci_sa')
  for (const k of ['tpd_sa', 'ci_sa']) if (nv(k) !== null && kv('death_sa') !== null && nv(k)! > kv('death_sa')!) drop(k)
  if (kv('death_sa') !== null) for (const k of ['annual_premium', 'base_premium', 'tpd_premium', 'ci_premium']) if (nv(k) !== null && nv(k)! >= 0.2 * kv('death_sa')!) drop(k)
  if (kv('base_premium') !== null && kv('annual_premium') !== null && kv('base_premium')! > kv('annual_premium')!) drop('base_premium')
  // Riders' premiums must add up with the plan's to the total, when all of them were read.
  const parts = ['base_premium', 'tpd_premium', 'ci_premium'].map(kv)
  if (kv('annual_premium') !== null && parts[0] !== null && (parts[1] !== null || parts[2] !== null)) {
    const sum = parts.reduce((a: number, b) => a + (b ?? 0), 0)
    if (Math.abs(sum - kv('annual_premium')!) > 0.02 * kv('annual_premium')!) drop('annual_premium', 'base_premium', 'tpd_premium', 'ci_premium')
  }
  // The total premium over the term: about the yearly premium times the premium term (within a fifth, as premiums
  // can step up or riders stop earlier), when both are known.
  if (nv('total_premium') !== null) {
    const a = kv('annual_premium'), t = kv('premium_term')
    if (a !== null && t !== null ? Math.abs(nv('total_premium')! - a * t) > 0.2 * a * t : a !== null ? nv('total_premium')! < a * 1.5 : false) drop('total_premium')
    else if (a === null) drop('total_premium')
  }
  // A cover age must fit the policy term (an age at the end of the term between 30 and 120 years).
  if (nv('cover_age') !== null && kv('policy_term') !== null && nv('cover_age')! - kv('policy_term')! < 16) drop('cover_age')
}
