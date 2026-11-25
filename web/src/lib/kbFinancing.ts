// Reads a bank's premium financing document (a factsheet, or a monthly cost-of-funds sheet) into a draft Knowledge
// Bank product record of the "Premium financing" category (Kumar, 25 Nov 2026: "i still need financing documents as
// a product type since they are also an add on policy"; "make sure it can be scanned and saved").
//
// Like the Product Summary reader (kbExtract.ts): fixed rules, in the browser, nothing leaves the computer. Every
// value is the document's own words (or its own numbers, for rates); anything the rules can't place stays blank.
// The free AI helper (kbAi.ts) may then be asked about the blanks, under the same checks as for Product Summaries.
//
// What it reads:
// * the lender (the bank) and the product name;
// * the loan currencies (the "Choice of Currency" row, or the currencies of the rate table);
// * facts: the policies it can finance, pricing basis, spread tiers, cost of funds, tenors, quantum of finance,
//   cancellation fee, repricing, margin call and close out, key risks and conditions on the rates;
// * cost-of-funds (COF) rates by currency and tenor, with their date, and indicative policy cash drawdown rates.
//   A sheet "for the month of November 2026" is valid until the end of that month (suggested as the document's
//   valid-until date), so out-of-date rates show as out of date on the record.
// Shared with the Node tests (tests/kb-extract), so it imports only files that run in Node too.
import type { Line } from './piExtract.ts'
import type { ProductRecord } from './kbAdmin'
import type { ReadDoc } from './kbExtract.ts'
import { FINANCING } from './families.ts'
import { fmtNum, plain } from './num.ts'

/** One rate read from the document: a cost of funds (COF) for a tenor, or an all-in drawdown rate (tenor 0). */
export interface FinRate { currency: string; tenor_months: number; rate: number; as_of: string | null; kind: 'cof' | 'drawdown' }

export interface FinancingResult {
  record: Partial<ProductRecord>
  facts: Record<string, { v: string; page: number }>
  filled: string[]
  notes: string[]
  kind: string
  planType: string
  /** Rates read from the document's tables. */
  finRates: FinRate[]
  /** Dates the document gives itself: the month its rates are for. */
  effectiveFrom?: string
  validUntil?: string
  version?: string
  /** Where the document goes on the record: the factsheet ('_ps') or the monthly rate sheet ('_cof'). */
  source: '_ps' | '_cof'
}

/** Loan currencies the reader knows (banks lend in more currencies than policies are sold in). */
export const FIN_CURRENCIES = ['SGD', 'USD', 'HKD', 'AUD', 'GBP', 'EUR', 'CHF', 'JPY', 'CNY']
const CODE = new RegExp(String.raw`\b(${FIN_CURRENCIES.join('|')})\b`, 'g')
const codesIn = (s: string) => FIN_CURRENCIES.filter((c) => [...s.matchAll(CODE)].some((m) => m[1] === c))

/** Is this a premium financing document (and not an insurer's Product Summary that mentions a policy loan)? */
export function isFinancingDoc(doc: ReadDoc): boolean {
  const text = doc.pages.flatMap((p) => p.lines.map((l) => l.text)).join('\n')
  return /premium financ/i.test(text) && /cost of funds|\bCOF\b|quantum of financ|loan amount|drawdown/i.test(text)
}

// Banks that offer premium financing in Singapore, as people name them. The longest name that the document uses wins.
const LENDERS: [RegExp, string][] = [
  [/\biFAST Global Bank\b/i, 'iFAST Global Bank'],
  [/\bCIMB Bank\b|\bCIMB\b/, 'CIMB Bank'],
  [/\bDBS\b/, 'DBS Bank'],
  [/\bOCBC\b/, 'OCBC Bank'],
  [/\bUOB\b|United Overseas Bank/i, 'UOB'],
  [/\bMaybank\b/i, 'Maybank'],
  [/\bStandard Chartered\b/i, 'Standard Chartered'],
  [/\bHSBC\b/, 'HSBC'],
  [/\bCitibank\b|\bCiti\b/, 'Citibank'],
  [/\bBank of Singapore\b/i, 'Bank of Singapore'],
  [/\bJulius Baer\b/i, 'Julius Baer'],
  [/\bUBS\b/, 'UBS'],
  [/\bLGT\b/, 'LGT Bank'],
  [/\bEFG\b/, 'EFG Bank'],
  [/\bBNP Paribas\b/i, 'BNP Paribas'],
  [/\bDeutsche Bank\b/i, 'Deutsche Bank'],
  [/\bPictet\b/i, 'Pictet'],
  [/\bCoutts\b/i, 'Coutts'],
]

const pieces = (l: Line) => l.text.split(/\s{2,}/).map((x) => x.trim()).filter(Boolean)
/** Footnote marks after a value ("COF + Spread 1", "revolving options 3"). */
const noFootnote = (s: string) => s.replace(/\s+\d$/, '').trim()
/** Spacing the PDF puts inside quotes and brackets ("( “CIMB Bank”" , "“COF” )"). */
const tidy = (s: string) => s.replace(/\(\s+/g, '(').replace(/\s+\)/g, ')').replace(/\s+([,.;:])/g, '$1').replace(/\s{2,}/g, ' ').trim()

/** Row labels of a factsheet's "Key Features" table. A label starts a line, and its value follows a wide gap. */
const LABELS: { key: string; re: RegExp }[] = [
  { key: 'currency', re: /^(?:choice of currenc(?:y|ies)|loan currenc(?:y|ies)|currenc(?:y|ies) of (?:the )?loan|financing currenc(?:y|ies))$/i },
  { key: 'finPricing', re: /^(?:pricing|interest rate|financing rate|loan interest rate)$/i },
  { key: 'finCof', re: /^cost of funds(?: \(cof\))?$/i },
  { key: 'finTenor', re: /^(?:financing|loan) tenors?$|^tenors?$/i },
  { key: 'finQuantum', re: /^quantum of financ(?:e|ing)(?: \(qof\))?$|^(?:maximum )?loan[- ]to[- ]value(?: \(ltv\))?$|^(?:maximum )?financing (?:quantum|amount)$/i },
  { key: 'finCancel', re: /^cancell?ation fees?$/i },
]
/** Headings whose paragraph is the value. */
const HEADINGS: { key: string; re: RegExp; label: string }[] = [
  { key: 'margin', re: /^margin (?:maintenance|call)$/i, label: 'Margin maintenance' },
  { key: 'close', re: /^close[- ]?out$/i, label: 'Close out' },
]
/** A line that starts something else: a label, a heading, a table or a footnote. */
const STOP = /^(?:key (?:features|benefits|risks)|historical|date\b|\d\s+[A-Z]|[ivx]+\.\s|[•·▪]|important note|review$|reference rate$|client acknowledg|a premium financing example)/i
const isLabelLine = (l: Line) => {
  const p = pieces(l)
  return (p.length >= 2 && LABELS.some((x) => x.re.test(p[0]))) || HEADINGS.some((h) => h.re.test(l.text.trim()))
}

/** Lines of the document, in page order, each with its page. */
const linesOf = (doc: ReadDoc) => doc.pages.flatMap((p) => p.lines.map((l) => ({ ...l, page: p.page })))

/** A labelled row: the value after the label, and the lines that carry it on (until the next label or a table). */
function labelled(lines: Line[], re: RegExp): { v: string; page: number; at: number } | null {
  for (let i = 0; i < lines.length; i++) {
    const p = pieces(lines[i])
    if (p.length < 2 || !re.test(p[0])) continue
    let v = noFootnote(p.slice(1).join(' '))
    for (let j = i + 1; j < lines.length && lines[j].page === lines[i].page; j++) {
      const t = lines[j].text.trim()
      if (!t || isLabelLine(lines[j]) || STOP.test(t) || pieces(lines[j]).length > 1) break
      v = `${v} ${noFootnote(t)}`
    }
    return { v: tidy(v), page: lines[i].page, at: i }
  }
  return null
}
/** A heading and the paragraph under it. */
function underHeading(lines: Line[], re: RegExp): { v: string; page: number } | null {
  for (let i = 0; i < lines.length; i++) {
    if (!re.test(lines[i].text.trim())) continue
    const out: string[] = []
    for (let j = i + 1; j < lines.length; j++) {
      const t = lines[j].text.trim()
      if (!t || isLabelLine(lines[j]) || STOP.test(t) || (out.length && /[.!?]$/.test(out[out.length - 1]) && /^[A-Z][a-z]+(?: [A-Za-z]+){0,3}$/.test(t))) break
      out.push(t)
    }
    if (out.length) return { v: tidy(out.join(' ')), page: lines[i].page }
  }
  return null
}

/** Sentences of the running text (bullets and table rows apart), each with its page. */
function sentences(lines: Line[]): { s: string; page: number }[] {
  const out: { s: string; page: number }[] = []
  let cur = '', page = 0
  const flush = () => { if (cur) for (const s of cur.split(/(?<=[.!?])\s+(?=[A-Z*(])/)) out.push({ s: tidy(s), page }); cur = '' }
  // A title or heading line ("CIMB Premium Financing Factsheet", "Key Risks") stands alone.
  const titleLike = (t: string) => t.length <= 60 && !/[.,;:!?]$/.test(t) && t.split(/\s+/).every((w) => /^[A-Z0-9(“"&]|^(?:and|or|of|for|the|to|with|on)$/.test(w))
  for (const l of lines) {
    const t = l.text.trim()
    if (!t) continue
    const head = titleLike(t)
    const body = t.replace(/^[•·▪]\s*/, '')
    const table = pieces({ ...l, text: body }).length > 1
    if (body !== t || /^[ivx]+\.\s/.test(t) || (l.page !== page && /[.!?]$/.test(cur)) || table || head) flush()
    if (head) continue
    if (!cur) page = l.page
    cur = !cur ? body : /[A-Za-z]-$/.test(cur) ? cur + body : `${cur} ${body}`
    if (table) flush()
  }
  flush()
  return out
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const iso = (y: number, m: number, d: number) => `${String(y)}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate()
/** "29-May-26", "30-June-26", "31 Oct 2026" as an ISO date; null when it is not a date. */
export function dateOf(s: string): string | null {
  const m = s.trim().match(/^(\d{1,2})[-\s/]([A-Za-z]{3,9})[-\s/](\d{2}|\d{4})$/)
  if (!m) return null
  const mon = MONTHS.indexOf(m[2].slice(0, 3).toLowerCase()) + 1
  const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])
  const d = Number(m[1])
  if (!mon || d < 1 || d > lastDay(y, mon)) return null
  return iso(y, mon, d)
}
/** "for the month of November 2026" (the month the rates are for). */
function monthOf(text: string): { from: string; to: string; label: string } | null {
  const m = text.match(/\bfor the month of\s+([A-Za-z]{3,9})\s+(\d{4})\b/i)
  if (!m) return null
  const mon = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()) + 1
  if (!mon) return null
  const y = Number(m[2])
  return { from: iso(y, mon, 1), to: iso(y, mon, lastDay(y, mon)), label: `${m[1]} ${m[2]}` }
}
const pct = (s: string) => { const m = s.trim().match(/^(-?\d{1,2}(?:\.\d{1,4})?)\s*%?$/); return m ? Number(m[1]) : null }

/** The rate tables. Two layouts are known:
 *  - dates down the side, a column per tenor and currency ("Date | 1-month SGD COF (%) | 3-month SGD COF (%)");
 *  - currencies down the side, a column per tenor ("Currency | 1M COF | Changes | 3M COF | Changes"), for one month.
 *  And a list of currencies with one rate under a "Policy Cash Drawdown" heading (no tenor). */
function readRates(lines: Line[], month: { from: string } | null): { rates: FinRate[]; notes: string[] } {
  const rates: FinRate[] = []
  const notes: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].text
    // Dates down the side: the header names each column's tenor and currency.
    const cols = [...t.matchAll(/(\d{1,2})[- ]?(?:month|mth|m)\b\s*([A-Z]{3})\b/gi)].map((m) => ({ tenor: Number(m[1]), cur: m[2].toUpperCase() }))
    if (/^\s*date\b/i.test(t) && cols.length && cols.every((c) => FIN_CURRENCIES.includes(c.cur))) {
      for (let j = i + 1; j < lines.length; j++) {
        const p = pieces(lines[j])
        if (/^cof\b/i.test(p[0] ?? '') && !dateOf(p[0])) continue
        const d = dateOf(p[0] ?? '')
        if (!d) break
        const vals = p.slice(1).map(pct)
        if (vals.length !== cols.length || vals.some((v) => v == null)) break
        cols.forEach((c, k) => rates.push({ currency: c.cur, tenor_months: c.tenor, rate: vals[k]!, as_of: d, kind: 'cof' }))
      }
      continue
    }
    // Currencies down the side, for the month the sheet is for.
    const tenors = [...t.matchAll(/\b(\d{1,2})\s*M\s+COF\b/g)].map((m) => Number(m[1]))
    if (/^\s*currency\b/i.test(t) && tenors.length) {
      for (let j = i + 1; j < lines.length; j++) {
        const p = pieces(lines[j])
        if (/^from previous/i.test(lines[j].text.trim())) continue
        if (!FIN_CURRENCIES.includes(p[0] ?? '')) break
        // The rates are the % values; the changes in basis points ("-1 bps", "N.A.") are not rates.
        const vals = p.slice(1).filter((x) => /%\s*$/.test(x)).map(pct)
        if (vals.length !== tenors.length || vals.some((v) => v == null)) break
        tenors.forEach((n, k) => rates.push({ currency: p[0], tenor_months: n, rate: vals[k]!, as_of: month?.from ?? null, kind: 'cof' }))
      }
      if (!month) notes.push('The cost-of-funds table does not say which month it is for: fill in the effective and valid-until dates.')
      continue
    }
    // Indicative drawdown pricing: one rate per currency, no tenor.
    if (/drawdown/i.test(t) && /pricing|rate/i.test(t) && !/premium financing/i.test(t)) {
      let seen = 0
      for (let j = i + 1; j < lines.length && seen < 20; j++) {
        const p = pieces(lines[j])
        if (!p.length) continue
        if (!FIN_CURRENCIES.includes(p[0])) { if (rates.some((r) => r.kind === 'drawdown')) break; if (/^(?:indicative|currency|pricing)$/i.test(lines[j].text.trim())) continue; break }
        const v = p.length === 2 && /%\s*$/.test(p[1]) ? pct(p[1]) : null
        if (v == null) break
        rates.push({ currency: p[0], tenor_months: 0, rate: v, as_of: month?.from ?? null, kind: 'drawdown' })
        seen++
      }
    }
  }
  // The same currency, tenor and date twice can't be told apart: neither is kept.
  const key = (r: FinRate) => `${r.kind}|${r.currency}|${String(r.tenor_months)}|${r.as_of}`
  const count = new Map<string, number>()
  for (const r of rates) count.set(key(r), (count.get(key(r)) ?? 0) + 1)
  return { rates: rates.filter((r) => count.get(key(r)) === 1), notes }
}

/** Spread tiers ("S$0 to S$2,999,999 (Singapore) | IGB COF + 1.15%"): each tier of balances with its spread. */
function spreadTiers(lines: Line[]): { v: string; page: number } | null {
  const tiers: { cur: string; text: string; page: number }[] = []
  const spreads: { text: string; page: number }[] = []
  let head = ''
  for (const l of lines) {
    const t = tidy(l.text)
    if (/\bAUA\b|assets under (?:administration|management)|relationship balance/i.test(t) && !head) head = t.replace(/\s*\($/, '')
    const tier = t.match(/^((S|HK|US)\$)[\d,]+(?:\s+to\s+\1[\d,]+|\s+and above)(?:\s*\([A-Za-z ]+\))?$/)
    if (tier) tiers.push({ cur: tier[1], text: t, page: l.page })
    else if (/^[A-Z]{2,5}\s+COF\s*\+\s*\d{1,2}(?:\.\d{1,3})?\s*%$|^COF\s*\+\s*\d{1,2}(?:\.\d{1,3})?\s*%$/.test(t)) spreads.push({ text: t, page: l.page })
  }
  if (!tiers.length || !spreads.length) return null
  // Tiers are grouped by their rank within their currency (the 1st S$ tier with the 1st HK$ tier ...).
  const rank = new Map<string, number>()
  const groups: string[][] = []
  for (const x of tiers) {
    const r = rank.get(x.cur) ?? 0
    rank.set(x.cur, r + 1)
    ;(groups[r] ??= []).push(x.text)
  }
  if (groups.length !== spreads.length) return null
  const v = groups.map((g, k) => `${g.join(' or ')}: ${spreads[k].text}`).join('; ')
  return { v: head ? `${head}: ${v}` : v, page: spreads[0].page }
}

/** Reads a premium financing document. Never throws. */
export function readFinancing(doc: ReadDoc): FinancingResult {
  const lines = linesOf(doc)
  const text = lines.map((l) => l.text).join('\n')
  const record: Partial<ProductRecord> = { product_type: FINANCING }
  const facts: FinancingResult['facts'] = {}
  const filled: string[] = []
  const notes: string[] = []
  const put = (key: string, h: { v: string; page: number } | null | undefined) => { if (h?.v && h.v.length >= 3) facts[key] = { v: h.v.slice(0, 600), page: h.page } }

  // The lender: the first bank the document names (the longest match first).
  const firstAt = LENDERS.map(([re, name]) => ({ name, at: text.search(re) })).filter((x) => x.at >= 0).sort((a, b) => a.at - b.at)[0]
  if (firstAt) { record.insurer = firstAt.name; filled.push('lender (bank)') }
  // The product's name: a title line naming premium financing ("CIMB Premium Financing Factsheet").
  const title = lines.slice(0, 12).map((l) => tidy(l.text)).find((t) => /^[A-Za-z][\w&.' -]{0,40}premium financing(?:\s+(?:factsheet|fact sheet|product summary|programme|program|facility))?$/i.test(t))
  if (title) record.name = title.replace(/\s+(?:factsheet|fact sheet|product summary)$/i, '')
  else if (record.insurer) {
    record.name = `${record.insurer} Premium Financing`
    notes.push(`The document has no product name, so the record is named "${record.name}" after the bank. Change it if the bank calls it something else.`)
  }
  if (record.name) filled.push('product name')

  for (const r of LABELS) {
    const h = labelled(lines, r.re)
    if (!h) continue
    if (r.key === 'currency') {
      const c = codesIn(h.v)
      if (c.length) { record.currencies = c; filled.push('loan currencies') }
      continue
    }
    if (r.key === 'finPricing') {
      // The pricing row's first line is the basis; what carries on ("At every rollover ...") is the repricing.
      const [basis, ...rest] = h.v.split(/(?<=Spread)\s+(?=For [A-Z]{3}:|At every|It should)/)
      put('finPricing', { v: basis.replace(/\s+For [A-Z]{3}:.*$/, '').trim(), page: h.page })
      const re = rest.join(' ').match(/At every [^.]*\.(?:\s*It should be noted[^.]*\.)?/)
      if (re) put('finReprice', { v: tidy(re[0]), page: h.page })
      continue
    }
    put(r.key, h)
  }
  const margin = underHeading(lines, HEADINGS[0].re), close = underHeading(lines, HEADINGS[1].re)
  if (margin || close) put('finMargin', { v: [margin && `Margin maintenance: ${margin.v}`, close && `Close out: ${close.v}`].filter(Boolean).join(' '), page: (margin ?? close)!.page })

  const ss = sentences(lines)
  // The policies it finances: a sentence about financing that names the kind of policy.
  const POLICY = /universal life|whole[- ]life|single premium|endowment|investment[- ]linked|\bILP\b|indexed/i
  const pol = ss.find((x) => POLICY.test(x.s) && /financ|funds? (?:part of|the)|loan/i.test(x.s) && !/hold harmless|distributor other than|purchased from|illustration is based|applies for a death benefit/i.test(x.s) && x.s.length <= 320)
  put('finPolicies', pol ? { v: pol.s, page: pol.page } : null)
  if (!facts.finReprice) {
    const rp = ss.find((x) => /repric|fixed for the chosen cycle|reset (?:only )?(?:up)?on rollover|refreshed on the next cycle/i.test(x.s) && x.s.length <= 300)
    put('finReprice', rp ? { v: rp.s, page: rp.page } : null)
  }
  const cond = ss.find((x) => /commissions? sharing|rates? (?:are|is) (?:only )?applicable (?:with|to|for)/i.test(x.s) && x.s.length <= 320)
  put('finTerms', cond ? { v: cond.s.replace(/^\*/, ''), page: cond.page } : null)
  put('finSpread', spreadTiers(lines))
  // Key risks: the names of the risks the document lists ("i. Borrower's Liquidity Risk – ...").
  const risks = lines.map((l) => ({ m: l.text.trim().match(/^(?:[ivx]{1,4}\.|\d{1,2}\.|[•·▪])\s*([A-Z][\w’' ]{2,40}? Risk)\s*[–—:-]/), page: l.page })).filter((x) => x.m)
  if (risks.length >= 2) put('finRisks', { v: risks.map((x) => x.m![1]).join('; '), page: risks[0].page })

  // Rates.
  const month = monthOf(text)
  const rr = readRates(lines, month)
  notes.push(...rr.notes)
  const finRates = rr.rates
  if (!record.currencies?.length) {
    const c = [...new Set(finRates.filter((r) => r.kind === 'cof').map((r) => r.currency))]
    if (c.length) { record.currencies = FIN_CURRENCIES.filter((x) => c.includes(x)); filled.push('loan currencies (from the rate table)') }
  }
  const cof = finRates.filter((r) => r.kind === 'cof')
  if (cof.length) {
    const dates = [...new Set(cof.map((r) => r.as_of).filter(Boolean))] as string[]
    filled.push(`${fmtNum(cof.length)} cost-of-funds rate${cof.length === 1 ? '' : 's'}${dates.length > 1 ? ` (${plain(dates.length)} dates)` : ''}`)
    if (/for illustration only|cannot be used to forecast/i.test(text) && dates.length > 1) notes.push('The cost-of-funds rates in this document are historical, for illustration only. Ask the bank for the current rate.')
  }
  const dd = finRates.filter((r) => r.kind === 'drawdown')
  if (dd.length) filled.push(`${fmtNum(dd.length)} policy cash drawdown rate${dd.length === 1 ? '' : 's'}`)
  const nf = Object.keys(facts).length
  if (nf) filled.push(`${fmtNum(nf)} fact${nf === 1 ? '' : 's'}`)
  filled.push('category (Premium financing)')

  const version = text.match(/\bV(20\d{2})\s?(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\b/i)
  // A monthly sheet (rates and little else) is the record's cost-of-funds sheet; anything else is its factsheet.
  const source: FinancingResult['source'] = month && cof.length && nf <= 4 ? '_cof' : '_ps'
  if (month) notes.push(`The rates are for ${month.label}, so the document is valid until ${month.to.split('-').reverse().join('/')}. Upload next month's sheet as a new version.`)
  return { record, facts, filled, notes, kind: '', planType: FINANCING, finRates, effectiveFrom: month?.from, validUntil: month?.to,
    version: version ? `V${version[1]} ${version[2].toUpperCase()}` : undefined, source }
}

/** Rates as CSV lines for the record page: currency,tenor_months,rate,as_of,kind. */
export const FIN_RATES_HEADER = 'currency,tenor_months,rate_percent,as_of,kind'
export const finRatesCsv = (rates: FinRate[]) => [FIN_RATES_HEADER, ...rates.map((r) => [r.currency, r.tenor_months, r.rate, r.as_of ?? '', r.kind].join(','))].join('\n')
export function parseFinRates(text: string): { rates: FinRate[]; error: string } {
  const rates: FinRate[] = []
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  for (const [i, line] of lines.entries()) {
    const c = line.split(/[,\t;]/).map((x) => x.trim())
    if (i === 0 && /currency/i.test(c[0])) continue
    const cur = c[0]?.toUpperCase(), tenor = Number(c[1]), rate = Number(String(c[2] ?? '').replace('%', '')), asOf = c[3] || null
    const kind = /^d/i.test(c[4] ?? '') ? 'drawdown' : 'cof'
    if (!/^[A-Z]{3}$/.test(cur ?? '') || !Number.isInteger(tenor) || tenor < 0 || tenor > 120 || !Number.isFinite(rate) || rate < -5 || rate > 50 || c[2] === '' || (asOf && !/^\d{4}-\d{2}-\d{2}$/.test(asOf))) {
      return { rates: [], error: `Line ${plain(i + 1)} ("${line}") needs: currency (SGD), tenor in months (0 = no fixed tenor), rate in %, and optionally the date (YYYY-MM-DD) and kind (cof or drawdown)` }
    }
    rates.push({ currency: cur, tenor_months: tenor, rate, as_of: asOf, kind })
  }
  return { rates, error: '' }
}

/** What the free AI helper may be asked about a financing document the rules left blank (kbAi.ts): what to ask, the
 *  words that find the lines it reads, and what its quote must (and must not) say. Same checks as for Product
 *  Summaries: the quote must be in the document word for word, and about what was asked. */
export const FIN_AI_FACTS: { key: string; ask: string; find: RegExp; must: RegExp[]; not?: RegExp }[] = [
  { key: 'finPolicies', ask: 'which kinds of insurance policy the loan can pay premiums for', find: /universal life|whole[- ]life|single premium|endowment/i, must: [/universal life|whole[- ]life|single premium|endowment|investment[- ]linked/i, /financ|funds?|loan|premium/i], not: /hold harmless|distributor other|illustration|death benefit of|chooses to pay/i },
  { key: 'finPricing', ask: 'how the loan interest rate is priced (for example the cost of funds plus a spread)', find: /pricing|spread|cof\s*\+|cost of funds/i, must: [/\bCOF\b|cost of funds|SORA|SOFR|reference rate/i, /spread|\+|plus/i], not: /example|assum|illustration|=|scenario/i },
  { key: 'finCof', ask: 'what the cost of funds (COF) is', find: /cost of funds/i, must: [/cost of funds|\bCOF\b/i, /refers|means|is the|internal|borrowing|benchmark/i], not: /historical|illustration|scenario|assum/i },
  { key: 'finReprice', ask: 'how and when the loan interest rate is reset (repricing at rollover)', find: /repric|roll-?over|reset|refresh/i, must: [/repric|reset|refresh|roll-?over/i, /rate|\bCOF\b|interest/i], not: /redeem|redemption|inform you|business day|example/i },
  { key: 'finTenor', ask: 'the financing (loan) tenors', find: /tenor|revolv/i, must: [/tenor|revolv/i, /\d\s*(?:-|\s)?(?:months?|m\b)|month/i], not: /illustration|example|later|scenario/i },
  { key: 'finQuantum', ask: 'how much of the policy value can be borrowed (quantum of finance or loan-to-value)', find: /quantum|loan[- ]to[- ]value|\bltv\b/i, must: [/\d{1,3}\s*%/, /cash value|surrender value|policy value|loan[- ]to[- ]value|quantum/i], not: /margin|close[- ]?out|exceeds|example|assum|scenario/i },
  { key: 'finCancel', ask: 'the cancellation fee', find: /cancel/i, must: [/cancel/i, /fee|charge/i, /%|\$|\d/] },
  { key: 'finMargin', ask: 'when the bank asks for a top-up (margin call) or closes the loan (close out)', find: /margin|close[- ]?out|top[- ]?up/i, must: [/margin|close[- ]?out|top[- ]?up/i, /\d{1,3}\s*%/], not: /example|scenario/i },
]
export const FIN_AI_KEYS = new Set(FIN_AI_FACTS.map((f) => f.key))
