// Reads a Product Summary or a rate sheet (PDF or Excel) into a draft Knowledge Bank product record, in the
// browser. Like the PI reader: fixed reading rules, no AI, nothing leaves the computer. What it finds only
// fills in the draft; the maker checks each value against the document, and a BSD person checks it again.
// Shared with the Node tests (tests/kb-extract), so it imports types only from files that need the browser.
import { detectInsurer, readPdf, toLines, type Line, type Page, type TextItem } from './piExtract.ts'
import type { ProductRecord, Rate } from './kbAdmin'
import { fmtNum, plain } from './num.ts'
import { planLabel } from './families.ts'

export interface Row { page: number; cells: string[] }
export interface ReadDoc { pages: Page[]; rows: Row[]; kind: 'pdf' | 'excel' }

export const READABLE = /\.(pdf|xlsx|xlsm|csv)$/i
export const readableName = (name: string | null | undefined) => !!name && READABLE.test(name)

// ---------------------------------------------------------------------------------------------------------------
// Reading files
// ---------------------------------------------------------------------------------------------------------------

/** Excel (or CSV): each sheet becomes a "page", each row a line (cells joined with wide gaps) and a row of cells. */
export async function readExcel(data: ArrayBuffer, ExcelJS?: typeof import('exceljs')): Promise<ReadDoc> {
  const X = ExcelJS ?? ((await import('exceljs')) as unknown as { default: typeof import('exceljs') }).default
  const wb = new X.Workbook()
  await wb.xlsx.load(data)
  const pages: Page[] = []
  const rows: Row[] = []
  let n = 0
  wb.eachSheet((ws) => {
    if (ws.state && ws.state !== 'visible') return
    n++
    const lines: Line[] = []
    for (let r = 1; r <= ws.rowCount; r++) {
      const row = ws.getRow(r)
      const cells: string[] = []
      for (let c = 1; c <= Math.max(ws.columnCount, row.cellCount); c++) cells.push(cellText(row.getCell(c)))
      while (cells.length && !cells[cells.length - 1]) cells.pop()
      if (!cells.some(Boolean)) continue
      rows.push({ page: n, cells })
      lines.push({ page: n, text: cells.filter(Boolean).join('  ') })
    }
    pages.push({ page: n, items: [], lines })
  })
  return { pages, rows, kind: 'excel' }
}

function cellText(cell: { value: unknown; text?: string; isMerged?: boolean; master?: { value: unknown; text?: string } }): string {
  const c = cell.isMerged && cell.master ? cell.master : cell
  const v = c.value as any
  if (v == null) return ''
  if (typeof v === 'number') return String(v)
  if (typeof v === 'object') {
    if ('result' in v) return v.result == null ? '' : String(v.result)
    if ('richText' in v) return (v.richText as { text: string }[]).map((t) => t.text).join('').trim()
    if (v instanceof Date) return v.toISOString().slice(0, 10)
    if ('text' in v) return String(v.text).trim()
  }
  return String(c.text ?? v).trim()
}

export function readCsv(text: string): ReadDoc {
  const rows: Row[] = text.split(/\r?\n/).filter((l) => l.trim()).map((l) => ({ page: 1, cells: l.split(/[,\t;]/).map((x) => x.trim().replace(/^"|"$/g, '')) }))
  return { pages: [{ page: 1, items: [], lines: rows.map((r) => ({ page: 1, text: r.cells.filter(Boolean).join('  ') })) }], rows, kind: 'excel' }
}

/** Reads a PDF (scans with OCR), Excel (.xlsx) or CSV file in the browser. */
export async function readFile(data: ArrayBuffer, name: string, onPage?: (done: number, total: number, ocr: boolean) => void): Promise<ReadDoc> {
  if (/\.pdf$/i.test(name)) {
    return { pages: await readPdf(data, onPage, 60_000, true), rows: [], kind: 'pdf' }
  }
  if (/\.csv$/i.test(name)) return readCsv(new TextDecoder().decode(data))
  if (/\.(xlsx|xlsm)$/i.test(name)) return readExcel(data)
  throw new Error('Only PDF, Excel (.xlsx) or CSV files can be read. Older .xls files: save them as .xlsx first. Or fill in the record by hand.')
}

/** PDF lines split into cells where the gaps are wide (toLines puts two spaces there). */
export function rowsFromPages(pages: Page[]): Row[] {
  // Numbers printed close together ("11.1981 13.5896") come out as one piece: each number is its own cell.
  const split = (x: string) => (/^\d[\d.,]*(?:\s+\d[\d.,]*)+$/.test(x) ? x.split(/\s+/) : [x])
  return pages.flatMap((p) => p.lines.map((l) => ({ page: p.page, cells: l.text.split(/\s{2,}/).map((x) => x.trim()).filter(Boolean).flatMap(split) })))
}

/** For tests: positioned text into a page. */
export const pageOf = (page: number, items: TextItem[]): Page => ({ page, items, lines: toLines(page, items) })

/** A page's lines with side-by-side text columns read one after the other (the left column, then the right), as a
 *  person reads them. pdf.js gives a line across the whole page, so two columns would otherwise be mixed line by
 *  line. Only real text columns are split: the left column's lines are long and end at about the same place (they
 *  wrap), with a clear gap before the right column. A label | value table (short labels) is left as it is. */
export function columnLines(p: Page): Line[] {
  const items = p.items.filter((it) => it.str.trim())
  if (items.length < 20) return p.lines
  const rows: { y: number; items: TextItem[] }[] = []
  for (const it of items) {
    const row = rows.find((r) => Math.abs(r.y - it.y) <= 3)
    if (row) row.items.push(it); else rows.push({ y: it.y, items: [it] })
  }
  rows.sort((a, b) => b.y - a.y)
  const L = Math.min(...items.map((i) => i.x)), R = Math.max(...items.map((i) => i.x + i.w))
  if (R - L < 200) return p.lines
  const crossed = (r: { items: TextItem[] }, s: number) => r.items.some((i) => i.x < s - 2 && i.x + i.w > s + 2)
  const sides = (r: { items: TextItem[] }, s: number) => {
    const l = r.items.filter((i) => i.x + i.w <= s), rt = r.items.filter((i) => i.x >= s)
    return { l, rt, lEnd: l.length ? Math.max(...l.map((i) => i.x + i.w)) : -1, rStart: rt.length ? Math.min(...rt.map((i) => i.x)) : -1 }
  }
  // Runs of rows that a gutter at x = s does not cross, with at least 4 rows of text on both sides.
  type Run = { from: number; to: number }
  let best: { s: number; runs: Run[]; n: number } | null = null
  for (let s = L + (R - L) * 0.38; s <= L + (R - L) * 0.62; s += 2) {
    const runs: Run[] = []
    let n = 0, from = -1
    const close = (to: number) => {
      if (from < 0) return
      const all = rows.slice(from, to).map((r) => sides(r, s))
      const both = all.filter((x) => x.l.length && x.rt.length && x.rStart - x.lEnd >= 8)
      const left = all.filter((x) => x.l.length && x.l.map((i) => i.str).join(' ').trim().length >= 12)
      if (both.length >= 3 && left.length >= 4) {
        const maxEnd = Math.max(...left.map((x) => x.lEnd))
        const leftLen = both.map((x) => x.l.map((i) => i.str).join(' ').trim().length)
        const wrapped = left.filter((x) => maxEnd - x.lEnd <= (maxEnd - L) * 0.12).length
        if (leftLen.reduce((a, b) => a + b, 0) / both.length >= 25 && wrapped >= left.length * 0.5) { runs.push({ from, to }); n += both.length }
      }
      from = -1
    }
    // A crossing line, or a numbered heading ("2.4. Guaranteed Renewable Option"), ends a run of columns.
    rows.forEach((r, i) => {
      if (crossed(r, s) || HEADING.test(r.items.map((x) => x.str).join(' ').trim())) close(i)
      else if (from < 0) from = i
    })
    close(rows.length)
    if (n && (!best || n > best.n)) best = { s, runs, n }
  }
  if (!best) return p.lines
  const out: Line[] = []
  let i = 0
  for (const run of best.runs) {
    out.push(...toLines(p.page, rows.slice(i, run.from).flatMap((r) => r.items)))
    const block = rows.slice(run.from, run.to).flatMap((r) => r.items)
    const isLeft = (it: TextItem) => it.x + it.w / 2 < best!.s
    out.push(...toLines(p.page, block.filter(isLeft)), ...toLines(p.page, block.filter((it) => !isLeft(it))))
    i = run.to
  }
  out.push(...toLines(p.page, rows.slice(i).flatMap((r) => r.items)))
  return out
}

/** The plan types a Product Summary can say it is (families.ts keys), with the words that say so, and the kind
 *  as the document names it (kept for notes). Term life is matched last: other kinds are told apart first. */
const PLAN_WORDS: [RegExp, string, string][] = [
  [/\bindexed universal life\b/i, 'Universal life', 'Indexed Universal Life'],
  [/\b(?:variable )?universal life\b/i, 'Universal life', 'Universal Life'],
  [/\binvestment[- ]linked\b|\(ILP\)/i, 'Investment-linked', 'Investment-linked'],
  [/\bwhole[- ]life (?:insurance |assurance )?(?:plan|policy|product)\b|\bwhole[- ]life (?:insurance|assurance)\b/i, 'Whole life', 'Whole life'],
  [/\bendowment (?:insurance |assurance )?(?:plan|policy|product)\b|\bendowment (?:insurance|assurance)\b/i, 'Endowment', 'Endowment'],
  [/\bannuity (?:plan|policy|product)\b|\b(?:deferred|immediate|life) annuity\b|\bretirement (?:income )?(?:plan|policy)\b/i, 'Retirement and annuity', 'Annuity / retirement income'],
  [/\bintegrated shield\b|\bmedishield\b|\bhospital(?:isation)?(?: and surgical)? (?:insurance|plan|policy)\b|\bhealth insurance (?:plan|policy)\b|\bmedical (?:expense )?insurance (?:plan|policy)\b/i, 'Health', 'Health / hospital'],
  [/\bpersonal accident (?:insurance |plan|policy|product)|\bpersonal accident insurance\b/i, 'Personal accident', 'Personal accident'],
  [/\bdisability income\b|\bincome (?:protection|replacement) (?:insurance|plan|policy)\b/i, 'Disability income', 'Disability income'],
  [/\blong[- ]term care\b|\bcareshield\b|\beldershield\b|\bsevere disability (?:insurance|plan|policy)\b/i, 'Long-term care', 'Long-term care'],
  [/\bmortgage (?:reducing term|insurance|protection|cover|plan)\b|\b(?:decreasing|reducing) term (?:life )?(?:insurance |assurance )?(?:plan|policy|cover)\b/i, 'Mortgage cover', 'Mortgage cover'],
  [/\b(?:early(?:[- ]stage)? |multi[- ]?stage )?critical illness (?:insurance |plan|policy|product)|\bcritical illness insurance\b|\bdread disease (?:plan|policy|insurance)\b/i, 'Critical illness', 'Critical illness'],
]
const TERM = /\bterm (?:life )?(?:insurance |assurance )?(?:plan|policy|product|cover)\b|\bterm (?:life )?(?:insurance|assurance)\b/i
/** Words just before a plan word that make it another plan, not this one: "convert to a whole life plan", a CI rider. */
const NOT_THIS = /conver|switch|change to|exchange|rider|supplementary|attach|add(?:ed)? (?:on|to)|optional|together with|with (?:an? )?$/i

/** The plan type a Product Summary describes (a families.ts key), or '' when it does not say. Only the first pages
 *  are looked at, where the product is described (later pages talk about converting to other plans and riders).
 *  The plan named first wins; a whole life plan that says it is universal life ("whole life non-participating
 *  universal life") is universal life. `named` is the kind as the document words it. */
export function planType(doc: ReadDoc): { type: string; named: string } {
  const text = doc.pages.slice(0, 3).flatMap((p) => p.lines.map((l) => l.text)).join('\n')
  const hits: { at: number; type: string; named: string }[] = []
  for (const [re, type, named] of PLAN_WORDS) {
    const at = [...text.matchAll(new RegExp(re.source, 'gi'))].map((m) => m.index!).find((i) => !NOT_THIS.test(text.slice(Math.max(0, i - 50), i)))
    if (at !== undefined) hits.push({ at, type, named })
  }
  const t = [...text.matchAll(new RegExp(TERM.source, 'gi'))].map((m) => m.index!).find((i) => !NOT_THIS.test(text.slice(Math.max(0, i - 50), i)))
  if (t !== undefined) hits.push({ at: t, type: 'Term life', named: '' })
  if (!hits.length) return { type: '', named: '' }
  hits.sort((a, b) => a.at - b.at)
  let first = hits[0]
  if (first.type === 'Whole life') {
    const inv = hits.find((h) => (h.type === 'Universal life' || h.type === 'Investment-linked') && h.at - first.at < 120)
    if (inv) first = inv
  }
  // A mortgage (reducing) term plan says "term plan" too: the mortgage words win when they come with it.
  if (first.type === 'Term life') {
    const m = hits.find((h) => h.type === 'Mortgage cover' && Math.abs(h.at - first.at) < 40)
    if (m) first = m
  }
  return { type: first.type, named: first.named }
}

/** Empty for a term plan (or when the document does not say); else the kind of plan as the document names it. */
export function planKind(doc: ReadDoc): string {
  const p = planType(doc)
  return p.type && p.type !== 'Term life' ? p.named : ''
}

// ---------------------------------------------------------------------------------------------------------------
// Product Summary
// ---------------------------------------------------------------------------------------------------------------

/** Labels that start a fact in a Product Summary (at the start of a line or a table cell). First match wins. */
export const FACT_RULES: { key: string; re: RegExp }[] = [
  { key: 'uw', re: /^(?:type of )?underwriting(?: requirements?| type)?\b/i },
  { key: 'premTerm', re: /^(?:premium (?:payment |paying )?term|premium payment (?:period|duration)|premiums? (?:are )?payable (?:for|until))\b/i },
  { key: 'guaranteed', re: /^(?:are (?:the )?premium rates? guaranteed\??|premium rates?(?: guarantee)?|guaranteed premiums?|premiums? guarantee)\b/i },
  { key: 'modes', re: /^(?:(?:premium )?payment (?:modes?|frequenc(?:y|ies))|premium (?:modes?|frequenc(?:y|ies))|modes? of payment)\b/i },
  { key: 'coverTo', re: /^(?:choice of (?:coverage|policy) terms?|(?:coverage|policy) term options?|policy term|coverage term|cover(?:age)? (?:until|up to|period)|term of (?:cover|policy)|expiry age|maturity age)\b/i },
  { key: 'eci', re: /^(?:early(?:[- ]stage)? critical illness|multi[- ]?stage critical illness|eci)\b/i },
  { key: 'ci', re: /^(?:critical illness|dread disease|ci)(?: benefit| cover| rider)?\b/i },
  { key: 'tpd', re: /^(?:total (?:and|&) permanent disability|tpd)(?: benefit| cover)?\b/i },
  { key: 'ti', re: /^terminal illness(?: benefit)?\b/i },
  { key: 'ad', re: /^accidental death(?: benefit)?\b/i },
  { key: 'death', re: /^death(?: benefit)?\b/i },
  { key: 'conversion', re: /^(?:conversion (?:option|privilege|benefit)|option to convert|guaranteed convert(?:ibility|ible) option|(?:what is (?:the )?)?['‘’"]?guaranteed conversion['‘’"]?(?: option)?)/i },
  { key: 'renew', re: /^(?:renewa(?:l|bility)(?: option| privilege)?|guaranteed renewab\w*(?: option)?|can i renew)/i },
  { key: 'inc', re: /^(?:guaranteed (?:insurability|issuance) option(?: for life stage events?)?|guaranteed insurability|can i increase the sum (?:insured|assured)|life (?:event|stage) (?:option|benefit)|increase (?:in )?cover)/i },
  { key: 'invest', re: /^(?:investment (?:component|element|feature)s?|participating|is this a participating)/i },
  { key: 'cash', re: /^(?:cash value|surrender value|cash (?:and|&) surrender value)s?\b/i },
  // Facts of other plan types (universal life, investment-linked, endowment, health, accident, disability).
  { key: 'minRate', re: /^(?:guaranteed minimum crediting (?:interest )?rate|minimum guaranteed crediting (?:interest )?rate)\b/i },
  { key: 'account', re: /^(?:policy|account) value\b/i },
  { key: 'surrCharge', re: /^surrender charges?\b/i },
  { key: 'funds', re: /^(?:fund (?:choices?|options?|selection)|choice of funds|available funds|investment funds?)\b/i },
  { key: 'bonus', re: /^(?:(?:reversionary|terminal|non-guaranteed|cash) )?bonus(?:es)?\b/i },
  { key: 'maturity', re: /^maturity benefit\b/i },
  { key: 'payout', re: /^(?:income (?:payout|benefit)s?|monthly income(?: benefit)?|lifetime income benefit|annuity (?:payouts?|income|payments?)|retirement income(?: benefit)?|payout (?:options?|period))\b/i },
  { key: 'hospital', re: /^(?:hospital(?:isation)?(?: and surgical)? benefits?|ward (?:class|entitlement)|room and board|inpatient (?:hospital )?benefits?)\b/i },
  { key: 'deduct', re: /^(?:deductibles?(?: and co-?insurance)?|co-?insurance)\b/i },
  { key: 'paBen', re: /^(?:accidental medical (?:expenses?|reimbursement)|medical expenses? (?:due to|from) (?:an )?accident|fractures?(?: benefit)?)\b/i },
  { key: 'income', re: /^(?:monthly (?:disability )?(?:income )?benefit|disability income benefit)\b/i },
  { key: 'dist', re: /^(?:total )?distribution cost/i },
  { key: 'fees', re: /^(?:other )?(?:fees(?: and charges)?|charges)\b/i },
  { key: 'freelook', re: /^free[- ]?look(?: period)?\b/i },
  { key: 'grace', re: /^grace period\b/i },
  { key: 'reinstate', re: /^reinstate(?:ment)?\b/i },
  { key: 'excl', re: /^(?:main |key |general )?exclusions?\b/i },
  { key: 'special', re: /^special provisions?\b/i },
  { key: 'consider', re: /^(?:important (?:considerations|notes?|things to note)|things to note)\b/i },
]

/** Labels for the record's own fields. */
const REC = {
  name: /^(?:product|plan|policy) name\b/i,
  insurer: /^(?:name of )?(?:insurer|insurance company|life insurance company|issued by|underwritten by)\b/i,
  age: /^(?:entry age|age at entry|issue ages?|entry age limits?|eligible entry age|minimum and maximum entry age)\b/i,
  ageMin: /^(?:minimum|min\.?) (?:entry|issue) age\b/i,
  ageMax: /^(?:maximum|max\.?) (?:entry|issue) age\b/i,
  sa: /^(?:sum (?:assured|insured)(?: limits?| range)?|coverage amount)\b/i,
  saMin: /^(?:minimum|min\.?) sum (?:assured|insured)\b/i,
  saMax: /^(?:maximum|max\.?) sum (?:assured|insured)\b/i,
  currency: /^(?:policy )?currenc(?:y|ies)(?: available)?\b/i,
  residency: /^(?:who can apply|residency(?: requirements?)?|eligibility|eligible (?:applicants|persons))\b/i,
}
const ALL_LABELS = [...FACT_RULES.map((r) => r.re), ...Object.values(REC)]

/** A piece that is only a heading of the document ("Product Summary", "Benefits"), not a fact. */
const NOISE = /^(?:product summary|benefits?|page \d+(?: of \d+)?|\d+|note:?)$/i
/** Sub-headings inside a benefit's box: skipped when looking for its text. */
const SUBHEAD = /^(?:what we pay(?:\s+what we do not pay)?|what we do not pay|your (?:guaranteed )?benefits?\s*\*?)$/i
const NEGATIVE = /^(?:no|nil|none|n\.?a\.?|not (?:applicable|available|covered|included|offered)|not provided)\b|\bnot (?:covered|included|available|offered)\b/i

interface Hit { value: string; page: number }

const LIST_MARK = /^\(?\d{1,2}[.)]\s+|^\d{1,2}\.\d{1,2}\.\s+|^[a-z][.)]\s+|^[ivx]{1,4}[.)]\s+/i
function rawPieces(l: Line) { return l.text.split(/\s{2,}|\s+[|•]\s+/).map((x) => x.trim()).filter(Boolean) }
const clean = (x: string) => x.replace(/^[\s•\-–*·]+/, '').replace(LIST_MARK, '').trim()
function pieces(l: Line) { return rawPieces(l).map(clean).filter(Boolean) }
const isLabel = (l: Line) => ALL_LABELS.some((r) => pieces(l).some((p) => r.test(p)))
/** A question used as a heading ("Can I renew my policy?"). */
const QUESTION = /^(?:can|what|is|are|will|how|when|do|does)\b/i
const BULLET = /^[•·▪]/
const ITEM = /^[-–]\s*/
const HEADING = /^\d{1,2}(?:\.\d{1,2})*\.\s+\S/
/** A sentence cut off just before a number ("before reaching age" / "80."). */
const WANTS_NUMBER = /\b(?:age|ages|of|than|to|on page|page|is|are|at|by|within|up to)$/i
const DANGLING = /\b(?:the|a|an|and|or|of|to|from|with|by|last|first)$/i
const ends = (s: string) => /[.!?;]["”’)]?$/.test(s)
const joinText = (a: string, b: string) => (!a ? b : /[A-Za-z]-$/.test(a) && /^[a-z]/.test(b) ? a + b : `${a} ${b}`)

/** The value after a label: the rest of the line, else the next line(s) up to the next label. A label counts
 *  only when it stands alone (a heading or a table cell) or is followed by a colon, so words in the middle of
 *  a paragraph ("contact the insurer directly") are not read as labels. A value that wraps onto the next lines
 *  (a sentence that has not ended, or a list after "...:") is read on to its end. */
function find(lines: Line[], re: RegExp, used: Set<number>): Hit | null {
  for (let i = 0; i < lines.length; i++) {
    if (used.has(i)) continue
    const raw = rawPieces(lines[i])
    for (let j = 0; j < raw.length; j++) {
      const part = clean(raw[j])
      const m = part.match(re)
      if (!m) continue
      const after = part.slice(m[0].length)
      let alone = /^\s*(?:benefits?|\(s\)|\([^)]{1,40}\))?\s*[:?]?\s*$/i.test(after)
      // A question heading, maybe running onto the next line: "Can I increase the sum insured ... a / life event?"
      let skip = 0
      if (!alone && QUESTION.test(part) && j === raw.length - 1) {
        if (/\?\s*$/.test(part)) alone = true
        else if (lines[i + 1] && lines[i + 1].page === lines[i].page && /\?\s*$/.test(lines[i + 1].text) && lines[i + 1].text.length < 60) { alone = true; skip = 1 }
      }
      if (!alone && !/^\s*(?:\([^)]{1,40}\))?\s*[:–=]/.test(after)) continue
      // A numbered list of illnesses or benefits: the next piece is another item, not this one's value.
      if (alone && raw[j + 1] && LIST_MARK.test(raw[j + 1]) && clean(raw[j + 1]).length < 40) continue
      if (LIST_MARK.test(raw[j]) && raw.filter((x) => LIST_MARK.test(x)).length > 1) continue
      let rest = (alone ? raw.slice(j + 1).map(clean).join(' ') : after.replace(/^\s*(?:\([^)]{1,40}\))?\s*[:–=]/, '') + ' ' + raw.slice(j + 1).map(clean).join(' '))
        .replace(/^[\s:–\-=?]+/, '').trim()
      const cell = alone && j + 1 < raw.length   // label | value on one line (a table row)
      const colon = /:\s*$/.test(part)
      let k = i + 1 + skip
      let list = false
      const mine = [i]
      for (let s = 0; s < skip; s++) mine.push(i + 1 + s)
      while (!rest && k < lines.length && k <= i + 3 + skip && lines[k].page === lines[i].page) {
        const t = lines[k].text.trim()
        if (isLabel(lines[k])) break
        k++
        if (SUBHEAD.test(t) || NOISE.test(clean(t)) || /^(?:for the full list|please refer|refer to)\b/i.test(t)) continue
        // "Choice of coverage term:" then "- of 5 years ..." items: the items are the value.
        if (colon && ITEM.test(t)) list = true
        rest = clean(t).replace(/^what is it\?\s*/i, '')
        mine.push(k - 1)
      }
      if (!rest || NOISE.test(rest)) continue
      // A value that starts mid-sentence (lower case or punctuation) belongs to some other text.
      if (!list && /^[a-z.,;)&/]/.test(rest)) continue
      if (list) rest = rest.replace(/^of\s+/i, '')
      // Read on while the sentence (or the list) goes on.
      let bullets = false
      for (let n = 0; n < 6 && k < lines.length && lines[k].page === lines[i].page && rest.length < 240; n++, k++) {
        const t = lines[k].text.trim(), ps = rawPieces(lines[k])
        // "(Applicable to Policy Term of 5 years and 10 years only)" then "What is it?  This option allows ...".
        if (/^\(.*\)$/.test(rest) && /^what is it\?/i.test(t)) { rest = joinText(rest, t.replace(/^what is it\?\s*/i, '')); mine.push(k); continue }
        // "... before reaching age" / "80. We'll only ...": a number that ends the sentence, not a numbered heading.
        // "... from the latest of the Issue Date ... and the last" / "Reinstatement Date (if any), then ...": a sentence cut
        // off after "the" or "and" goes on, even when the next line starts with a word that is also a label.
        const numGoesOn = (WANTS_NUMBER.test(rest) && /^\d{1,3}(?:\.\d+)?[.,;]?(?:\s|$)/.test(t)) || (!list && DANGLING.test(rest) && ps.length === 1 && !HEADING.test(t) && !BULLET.test(t) && !ITEM.test(t))
        if (!numGoesOn && (isLabel(lines[k]) || HEADING.test(t) || SUBHEAD.test(t) || QUESTION.test(t) && /\?/.test(t))) break
        if (numGoesOn) { rest = joinText(rest, t); mine.push(k); continue }
        // "The Death Benefit is the higher of:" then bullets: the bullets are the value.
        if (!list && (bullets || /:$/.test(rest)) && BULLET.test(t)) { bullets = true; rest = joinText(rest, clean(t)); mine.push(k); continue }
        if (bullets) {
          if (ps.length === 1 && /^[a-z]/.test(t)) { rest = joinText(rest, t); mine.push(k); continue }
          break
        }
        if (list) {
          if (BULLET.test(t)) break
          if (ITEM.test(t)) { rest = joinText(rest, clean(t).replace(/^of\s+/i, '')); mine.push(k); continue }
          if (ps.length > 1) break
          rest = joinText(rest, t); mine.push(k); continue
        }
        if (ends(rest) || BULLET.test(t) || ITEM.test(t)) break
        if (cell) {
          // The label cell and the value cell both wrap: "Terminal Illness  100% ... terminal" / "benefit  illness and ...",
          // or "Terminal illness (TI)  ... we may pay the TI" / "Benefit  Benefit in a lump sum ...".
          if (ps.length === 2 && ps[0].length <= 30 && (/^[a-z]/.test(ps[1]) || /^[A-Za-z]+(?: [A-Za-z]+)?$/.test(ps[0]) && /\b(?:the|a|an|of|to|and|or)\s*$|[a-z]$/i.test(rest) && !/[.:;]$/.test(rest))) { rest = joinText(rest, ps[1]); mine.push(k); continue }
          // The value wraps onto a short line ("... on page" / "23.") or one that opens with a bracket ("(less any Policy Loan):").
          if (ps.length === 1 && (/^[a-z]/.test(ps[0]) || /^\d[\d,.]*[.;]?$/.test(ps[0]) || /^\(/.test(ps[0]))) { rest = joinText(rest, ps[0]); mine.push(k); continue }
          break
        }
        if (ps.length > 1) break
        rest = joinText(rest, t); mine.push(k)
      }
      // A long paragraph: keep its first sentence or two.
      if (rest.length > 240) rest = rest.slice(0, 240).replace(/\s+\S*$/, '') + '…'
      for (const x of mine) used.add(x)
      return { value: rest, page: lines[i].page }
    }
  }
  return null
}

/** The document as running text, one paragraph per bullet or list item, for the facts said in a sentence. */
function sentencesOf(lines: Line[]): { s: string; page: number }[] {
  const out: { s: string; page: number }[] = []
  let cur = '', page = 0
  const flush = () => { if (cur) for (const s of cur.split(/(?<=[.!?])\s+(?=[A-Z(])/)) out.push({ s: s.trim(), page }); cur = '' }
  for (const l of lines) {
    const t = l.text.trim()
    if (!t) continue
    const ps = rawPieces({ ...l, text: t.replace(/^[•·▪\-–]\s*/, '') })
    if (BULLET.test(t) || ITEM.test(t) || HEADING.test(t) || l.page !== page || ps.length > 1) flush()
    if (!cur) page = l.page
    cur = joinText(cur, ps.length > 1 ? ps.map(clean).join('  ') : clean(t))
    if (ps.length > 1) flush()
  }
  flush()
  return out
}

/** Facts of the other plan types (not term). */
const OTHER_PLAN_FACTS = new Set(['minRate', 'account', 'surrCharge', 'funds', 'bonus', 'maturity', 'payout', 'hospital', 'deduct', 'paBen', 'income'])

/** Facts a Product Summary often says in a sentence instead of under a label. Used only when no label was found. */
const SENTENCE_RULES: { key: string; re: RegExp }[] = [
  { key: 'guaranteed', re: /^(?:the )?premiums?(?: rates?)?\b[^.]{0,60}?\b(?:are|is|will be)\s+(?:level\s+(?:and|but)\s+)?(?:(?:are\s+)?not\s+)?guaranteed\b/i },
  { key: 'modes', re: /\b(?:premiums?\b[^.]{0,40}\b(?:pay|paid|payable)|(?:choose|choice|option) to pay)\b[^.]{0,30}\b(?:monthly|quarterly|half[- ]yearly|yearly|annually)\b[^.]*\b(?:monthly|quarterly|half[- ]yearly|yearly|annually)\b/i },
  { key: 'cash', re: /\b(?:no|not have any|does not have(?: any)?)\s+cash (?:surrender )?values?\b/i },
  { key: 'minRate', re: /\b(?:guaranteed minimum|minimum guaranteed) crediting (?:interest )?rate\b[^.]{0,20}?\b(?:is|of)\s+\d+(?:\.\d+)?\s*%/i },
  { key: 'account', re: /^(?:the |your )?(?:policy|account) value (?:at any time )?is the sum of\b/i },
]

export const ints = (s: string) => [...s.replace(/\b\d+\s*(?:days?|weeks?|months?)\b/gi, '0').matchAll(/\b(\d{1,3})\b/g)].map((m) => +m[1]).filter((n) => n <= 100)

/** "S$50,000", "5 million", "$1.5m", "100k" -> numbers in the text. */
export function amounts(s: string): number[] {
  const out: number[] = []
  for (const m of s.matchAll(/(\d[\d,]*(?:\.\d+)?)\s*(million|mil|mio|m\b|k\b|thousand)?/gi)) {
    let n = Number(m[1].replace(/,/g, ''))
    if (!Number.isFinite(n)) continue
    const u = (m[2] ?? '').toLowerCase()
    if (u.startsWith('m')) n *= 1_000_000
    else if (u === 'k' || u === 'thousand') n *= 1000
    if (n >= 1000) out.push(n)
  }
  return out
}

const CURRENCY_CODES = ['SGD', 'USD', 'AUD', 'GBP', 'EUR', 'HKD']
export function currenciesIn(s: string): string[] {
  const found = new Set<string>()
  for (const c of CURRENCY_CODES) if (new RegExp(`\\b${c}\\b`).test(s)) found.add(c)
  if (/S\$|singapore dollars?/i.test(s)) found.add('SGD')
  if (/US\$|us dollars?|united states dollars?/i.test(s)) found.add('USD')
  if (/A\$|australian dollars?/i.test(s)) found.add('AUD')
  if (/£|pounds? sterling/i.test(s)) found.add('GBP')
  // Whole words only: "neurologist" and "Neuro-muscular" are not euros (FWD's summary).
  if (/€|\beuros?\b/i.test(s)) found.add('EUR')
  if (/HK\$|hong kong dollars?/i.test(s)) found.add('HKD')
  return CURRENCY_CODES.filter((c) => found.has(c))
}

export interface SummaryResult {
  /** The record fields found (only those found). */
  record: Partial<ProductRecord>
  /** Facts found, each with the page it is on. */
  facts: Record<string, { v: string; page: number }>
  /** Plain-English names of what was filled in. */
  filled: string[]
  /** Things to check about what was read. */
  notes: string[]
  /** Empty for a term plan; else the kind of plan the document says it is ("Indexed Universal Life"). */
  kind: string
  /** The plan type (families.ts key) the document says it is; '' when it does not say. */
  planType: string
}

/** "(Regular Pay)" and the like after a plan's name: how it is paid, not part of the name. */
const PAY_SUFFIX = /\s*\((?:regular|single|limited|annual|monthly)[^)]*(?:pay|premium)[^)]*\)\s*$/i
const nameOf = (s: string) => s.replace(PAY_SUFFIX, '').replace(/\s{2,}/g, ' ').trim()
const FOOTER_PAGE = /^page \d+ of \d+$/i

/** The plan's name when the document has no "Product name" label: from a footer ("Genesis III | Product Summary",
 *  "Singlife Elite Term II (Regular Pay)  Page 1 of 8") or the title above or below "Product Summary" on page 1,
 *  but only a title that the document repeats (a name, not a slogan). */
function nameFromLayout(doc: ReadDoc, text: string): string {
  const lines = doc.pages.slice(0, 2).flatMap((p) => p.lines)
  for (const l of lines) {
    const m = l.text.match(/^(?:\d+\s*\|\s*)?(.{3,80}?)\s*\|\s*product summary\b/i)
    if (m) return nameOf(m[1])
  }
  const p1 = doc.pages[0]?.lines ?? []
  for (const l of p1) {
    const ps = rawPieces(l)
    const at = ps.findIndex((x) => FOOTER_PAGE.test(x))
    if (at > 0 && ps[at - 1].length <= 80) return nameOf(ps[at - 1])
  }
  const ps = p1.slice(0, 15).map((l) => l.text.match(/^(?:product summary\s*(?:for|[:\-–])\s*(.+)|(.+?)\s*[:\-–]?\s*product summary)$/i)).find(Boolean)
  const n = ps?.[1] ?? ps?.[2]
  if (n && n.length < 80) return nameOf(n)
  const at = p1.slice(0, 8).findIndex((l) => /^product summary$/i.test(l.text.trim()))
  if (at < 0) return ''
  const t = (i: number) => p1[i]?.text.trim() ?? ''
  const cands = [[at - 2, at - 1], [at - 1], [at + 1, at + 2], [at + 1]]
    .filter((ix) => ix.every((i) => i >= 0 && i < p1.length && i !== at && t(i).length <= 60 && !/www\.|\.com|^note/i.test(t(i))))
    .map((ix) => ix.map(t).join(' '))
  const times = (c: string) => text.toLowerCase().split(c.toLowerCase()).length - 1
  const ok = cands.filter((c) => c.length >= 4 && times(nameOf(c)) >= 3)
  return ok.length ? nameOf(ok.sort((a, b) => b.length - a.length)[0]) : ''
}

/** A Product Summary file often holds the base plan and then each rider's own summary. The name of the plan or
 *  rider each page is about: its "Product name" label, its footer, or the page before's. */
export function sectionsOf(doc: ReadDoc): Map<number, string> {
  const out = new Map<number, string>()
  let cur = ''
  for (const p of doc.pages) {
    let name = ''
    for (const l of p.lines) {
      const ps = rawPieces(l)
      const m = ps.length >= 2 && REC.name.test(clean(ps[0])) && clean(ps[0]).replace(REC.name, '').trim().length === 0 ? ps[1] : ''
      if (m) { name = m; break }
    }
    if (!name) {
      // The title just above or below "Product Summary" at the top of the page starts a new section.
      const top = p.lines.slice(0, 4).map((l) => l.text.trim())
      const at = top.findIndex((x) => /^product summary$/i.test(x))
      if (at >= 0) {
        const near = [top[at + 1], top[at - 1]].find((x) => x && x.length <= 60 && /[a-z]/i.test(x) && !/www\.|\.com|^note/i.test(x))
        if (near) name = near
      }
    }
    if (!name) for (const l of p.lines) {
      const ps = rawPieces(l)
      const at = ps.findIndex((x) => FOOTER_PAGE.test(x))
      if (at > 0 && ps[at - 1].length <= 80) { name = ps[at - 1]; break }
    }
    if (name) cur = nameOf(name)
    out.set(p.page, cur)
  }
  return out
}
export const sameName = (a: string, b: string) => a.toLowerCase().replace(/[^a-z0-9]/g, '') === b.toLowerCase().replace(/[^a-z0-9]/g, '')

/** Who can apply, from a document's words, as the record's choices. */
export function residencyOf(v: string): string[] {
  const r: string[] = []
  if (/citizens?/i.test(v)) r.push('Singapore citizen')
  if (/\bPRs?\b|permanent residen/i.test(v)) r.push('Singapore PR')
  if (/foreigner|pass holders?|employment pass|work pass|s pass|dependant/i.test(v)) r.push('Foreigner living in Singapore')
  if (/non[- ]residents?|overseas|outside singapore/i.test(v)) r.push('Non-resident')
  return r
}

/** The page lines a Product Summary is read from: two-column pages column by column (PDF pages with positions). */
export const summaryPages = (doc: ReadDoc): Page[] => (doc.kind === 'pdf' ? doc.pages.map((p) => ({ ...p, lines: p.items.length ? columnLines(p) : p.lines })) : doc.pages)

/** Puts "Rider (name): " in front of a fact found in a rider's own summary later in the same file. */
export function riderLabel(doc: ReadDoc, recordName: string): (page: number, v: string) => string {
  const sections = sectionsOf(doc)
  const base = sections.get(doc.pages[0]?.page ?? 1) || recordName || ''
  return (page, v) => {
    const s = sections.get(page) ?? ''
    return s && base && !sameName(s, base) && !sameName(s, recordName) ? `Rider (${s}): ${v}` : v
  }
}

/** A fact that says the cover is not there ("No", "Not covered"). */
export const isNegative = (v: string) => NEGATIVE.test(v.replace(/^Rider \([^)]*\):\s*/, ''))

/** A table row whose label is wrapped over two lines: "Minimum Sum | USD1,000,000" then "Assured" under the label. */
function wrapped(lines: Line[], first: RegExp, used: Set<number>): { value: string } | null {
  for (let i = 0; i + 1 < lines.length; i++) {
    if (used.has(i)) continue
    const raw = rawPieces(lines[i]).map(clean)
    if (raw.length < 2 || !first.test(raw[0]) || lines[i + 1].page !== lines[i].page) continue
    if (!/^(?:assured|insured)\b/i.test(clean(rawPieces(lines[i + 1])[0] ?? ''))) continue
    used.add(i)
    return { value: raw.slice(1).join(' ') }
  }
  return null
}

export function readSummary(doc: ReadDoc): SummaryResult {
  // Two-column pages are read column by column (PDF pages with positions only).
  const pages = summaryPages(doc)
  const cdoc: ReadDoc = { ...doc, pages }
  const lines = pages.flatMap((p) => p.lines)
  const text = lines.map((l) => l.text).join('\n')
  const used = new Set<number>()
  const record: Partial<ProductRecord> = {}
  const filled: string[] = []
  const notes: string[] = []
  const facts: SummaryResult['facts'] = {}
  const pt = planType(cdoc)
  const kind = pt.type && pt.type !== 'Term life' ? pt.named : ''

  // The plan's own fields come first, so their lines are not read as facts.
  const name = find(lines, REC.name, used)
  if (name) record.name = nameOf(name.value)
  else {
    const n = nameFromLayout(cdoc, text)
    if (n) record.name = n
  }
  if (record.name) filled.push('product name')
  const ins = find(lines, REC.insurer, used)
  const insurer = (ins && (detectInsurer(ins.value) || ins.value.replace(/(?:[\s,]*(?:pte\.?|ltd\.?|limited|berhad|\(.*?\)))+\s*$/i, '').trim())) || detectInsurer(text)
  if (insurer) { record.insurer = insurer; filled.push('insurer') }

  const age = find(lines, REC.age, used)
  const aMin = find(lines, REC.ageMin, used), aMax = find(lines, REC.ageMax, used)
  // Numbers in brackets are not ages ("15 days - 80 (Region 1S & Region 1)"), and the policy owner's ages are not
  // the insured person's ("Policy Owner: Individuals: Age 18 or above").
  const ageText = age ? age.value.split(/\b(?:policy ?owners?|policyholders?|proposers?|payors?)\b/i)[0].replace(/\([^)]*\)/g, ' ') : ''
  const ageNums0 = ints(ageText)
  // Several ranges, one per region or plan option ("15 days - 80", "15 days - 75"): the widest is taken, with a note
  // (Kumar, 26 Nov 2026: Genesis III's Issue Ages were left blank). Ages in days or months count as 0.
  const ranges = [...ageText.matchAll(/\b(\d{1,3})\s*(days?|weeks?|months?)?\s*(?:-|–|—|to)\s*(?:age\s*)?(\d{1,3})\b/gi)]
    .map((m) => [m[2] ? 0 : +m[1], +m[3]]).filter(([a, b]) => a < b && b <= 100)
  let ageNums = !aMin && !aMax && ageNums0.length > 2 ? [] : ageNums0
  if (!ageNums.length && !aMin && !aMax && ranges.length > 1) {
    ageNums = [Math.min(...ranges.map((r) => r[0])), Math.max(...ranges.map((r) => r[1]))]
    if (new Set(ranges.map((r) => r.join('-'))).size > 1) notes.push(`The document gives several entry age ranges (${ranges.map((r) => `${plain(r[0])} to ${plain(r[1])}`).join(', ')}), for example by region: the widest, ${plain(ageNums[0])} to ${plain(ageNums[1])}, was taken. Check this.`)
  }
  const min = aMin ? ints(aMin.value)[0] : ageNums[0]
  const max = aMax ? ints(aMax.value)[0] : ageNums.length > 1 ? ageNums[ageNums.length - 1] : undefined
  if (min != null && max != null && min < max) { record.entry_age_min = min; record.entry_age_max = max; filled.push('entry age') }

  const sMin = find(lines, REC.saMin, used) ?? wrapped(lines, /^(?:minimum|min\.?) sum$/i, used)
  const sMax = find(lines, REC.saMax, used) ?? wrapped(lines, /^(?:maximum|max\.?) sum$/i, used)
  const sa = !sMin || !sMax ? find(lines, REC.sa, used) : null
  const saNums = sa ? amounts(sa.value) : []
  const lo = sMin ? amounts(sMin.value)[0] : saNums[0]
  const hi = sMax ? amounts(sMax.value)[0] : saNums.length > 1 ? saNums[saNums.length - 1] : undefined
  if (lo != null) { record.sa_min = lo; filled.push('minimum sum assured') }
  if (hi != null && (lo == null || hi > lo)) { record.sa_max = hi; filled.push('maximum sum assured') }

  const sentences = sentencesOf(lines)
  const cur = find(lines, REC.currency, used)
  let curs = cur ? currenciesIn(cur.value) : []
  if (!curs.length) curs = currencySentence(sentences)
  if (!curs.length && onlySgd(text)) {
    curs = ['SGD']
    notes.push('The document does not name the policy currency; every amount in it is in S$, so SGD was taken. Check this.')
  }
  if (curs.length) { record.currencies = curs; filled.push('policy currencies') }

  const res = find(lines, REC.residency, used)
  if (res) {
    const r = residencyOf(res.value)
    if (r.length) { record.residency = r; filled.push('who can apply') }
  }
  if (/direct purchase insurance/i.test(text)) { record.dpi = true; filled.push('Direct Purchase Insurance') }
  if (/\boffshore\b/i.test(text) && !/\bonshore\b/i.test(text)) { record.jurisdiction = 'Offshore'; filled.push('offshore') }

  // Facts. A fact found in a rider's own summary (later in the same file) says which rider it is from.
  const from = riderLabel(cdoc, record.name ?? '')
  for (const r of FACT_RULES) {
    const h = find(lines, r.re, used)
    // The other plan types' labels also turn up in diagrams ("Account Value" / "Less  Less"): their value must read
    // as a phrase (three words or more) or hold a number.
    if (h && OTHER_PLAN_FACTS.has(r.key) && !(h.value.match(/[A-Za-z]{2,}/g)?.length! >= 3 || /\d/.test(h.value))) continue
    if (h) facts[r.key] = { v: from(h.page, h.value), page: h.page }
  }
  for (const r of SENTENCE_RULES) {
    // A rate given as a definition ("Minimum interest rate used to ... shown in the Policy Schedule") gives way to a
    // sentence that states it ("The Guaranteed Minimum Crediting Rate is 2.00%").
    if (facts[r.key] && !(r.key === 'minRate' && !/\d/.test(facts[r.key].v))) continue
    const h = sentences.find((x) => r.re.test(x.s) && x.s.length <= 300)
    if (h) facts[r.key] = { v: from(h.page, h.s), page: h.page }
  }
  const yes = (k: string) => !!facts[k] && !isNegative(facts[k].v)
  if (facts.tpd) record.has_tpd = yes('tpd')
  if (facts.ci || facts.eci) record.has_ci = yes('ci') || yes('eci')
  const n = Object.keys(facts).length
  if (n) filled.push(`${fmtNum(n)} fact${n === 1 ? '' : 's'}`)
  if (pt.type) filled.push(`plan type (${planLabel(pt.type)})`)
  else notes.push('The document does not say what kind of plan it is. Choose the plan type.')
  return { record, facts, filled, notes, kind, planType: pt.type }
}

const CUR_WORD = String.raw`(?:SGD|USD|AUD|GBP|EUR|HKD|S\$|US\$|singapore dollars?|us dollars?|united states dollars?|australian dollars?|pounds? sterling|euros?|hong kong dollars?)`
const NUM_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7 }
/** "6 currency options are available: SGD, USD, GBP, EUR, AUD and HKD", "denominated in US currency",
 *  "available in SGD and USD". A stated number of currencies must match the list. */
function currencySentence(sentences: { s: string }[]): string[] {
  for (const { s } of sentences) {
    const m = s.match(/\b(\d|one|two|three|four|five|six|seven)?\s*(?:policy )?currency options? (?:are |is )?(?:available|offered)\s*(?:[:\-–]|in|for)?\s*(.+)$/i)
    if (m) {
      const c = currenciesIn(m[2].split(/[.;]/)[0])
      const want = m[1] ? Number(m[1]) || NUM_WORDS[m[1].toLowerCase()] : 0
      if (c.length && (!want || want === c.length)) return c
      continue
    }
    const d = s.match(/\b(?:denominated|issued) in (?:the )?(US|Singapore|SG|Australian|Hong Kong) (?:dollar )?currency\b/i)
    if (d) return [{ us: 'USD', singapore: 'SGD', sg: 'SGD', australian: 'AUD', 'hong kong': 'HKD' }[d[1].toLowerCase()]!]
    const a = s.match(new RegExp(String.raw`\b(?:policy|plan|product) (?:is )?(?:available|offered|denominated) (?:only )?in\s+(${CUR_WORD}(?:\s*(?:,|and|or)\s*${CUR_WORD})*)`, 'i'))
    if (a) return currenciesIn(a[1])
  }
  return []
}

/** Every amount in S$ (at least 3), no other currency named and the word "currency" not used at all (as a word:
 *  "occurrence" does not count, FWD's summary uses it often). */
function onlySgd(text: string): boolean {
  const n = (text.match(/S\$\s?\d|\bSGD\s?\d/g) ?? []).length
  return n >= 3 && !/\bcurrenc/i.test(text) && JSON.stringify(currenciesIn(text)) === '["SGD"]' && !/(?<![A-Z])\$\s?\d/.test(text.replace(/S\$/g, ''))
}

// ---------------------------------------------------------------------------------------------------------------
// Rate sheet
// ---------------------------------------------------------------------------------------------------------------

export interface RatesResult { rates: Rate[]; notes: string[]; error: string }

const num = (s: string | undefined) => {
  if (s == null) return NaN
  const t = s.replace(/[S$US,\s]/g, '').replace(/^\((.*)\)$/, '$1')
  return /^\d+(?:\.\d+)?$/.test(t) ? Number(t) : NaN
}
const ageOf = (s: string | undefined) => {
  const m = (s ?? '').trim().match(/^(?:age\s*)?(\d{1,3})$/i)
  return m && +m[1] <= 100 ? +m[1] : null
}
const gender = (s: string): Rate['gender'] | '' => (/\bfemale|\bwomen|\bf\b/i.test(s) ? 'Female' : /\bmale|\bmen\b|\bm\b/i.test(s) ? 'Male' : '')
const smoker = (s: string): boolean | null => (/non[- ]?smok|\bns\b|\bnon\b/i.test(s) ? false : /smok|\bs\b/i.test(s) ? true : null)
const isCi = (s: string) => /critical|\bci\b|\beci\b|dread/i.test(s)

/** Per how much sum assured the sheet's rates are, from its text ("per S$1,000 sum assured"). */
function scaleTo1000(text: string): { f: number; note: string } {
  const m = text.match(/per\s+(?:every\s+)?(?:S\$|US\$|\$|SGD|USD)?\s*([\d,]+)\s*(?:of\s+)?(?:sum\s+(?:assured|insured)|SA|cover|coverage)?/i)
  const per = m ? Number(m[1].replace(/,/g, '')) : 1000
  if (!per || per === 1000) return { f: 1, note: m ? '' : 'The sheet does not say per how much cover its rates are, so they were read as per 1,000 of sum assured. Check this.' }
  return { f: 1000 / per, note: `The sheet's rates are per ${fmtNum(per)} of sum assured; they were converted to per 1,000.` }
}

/** Reads the premium rates table: one row per age, with columns for gender and smoker status (and the critical
 *  illness rider), or a long list with age, gender, smoker and rate columns. */
export function readRates(doc: ReadDoc): RatesResult {
  const rows = doc.kind === 'pdf' ? rowsFromPages(doc.pages) : doc.rows
  const text = doc.pages.flatMap((p) => p.lines.map((l) => l.text)).join('\n')
  const { f, note } = scaleTo1000(text)
  const notes = note ? [note] : []
  const out = new Map<string, Rate>()
  const add = (r: Rate) => {
    const k = `${plain(r.age)}|${r.gender}|${r.smoker}`
    const was = out.get(k)
    if (!was) out.set(k, r)
    else if (r.ci_rate != null && was.ci_rate == null && was.rate === r.rate) was.ci_rate = r.ci_rate
    else dup = true
  }
  let dup = false
  const round = (n: number) => Math.round(n * f * 10000) / 10000

  // 1. A long list: age | gender | smoker | rate | (ci rate).
  const hi = rows.findIndex((r) => r.cells.some((c) => /^age/i.test(c)) && r.cells.some((c) => /gender|sex/i.test(c)) && r.cells.some((c) => /smok/i.test(c)))
  if (hi >= 0) {
    const h = rows[hi].cells.map((c) => c.toLowerCase())
    const col = (re: RegExp, not?: RegExp) => h.findIndex((c) => re.test(c) && !(not && not.test(c)))
    const a = col(/^age/), g = col(/gender|sex/), s = col(/smok/), ci = col(/critical|\bci\b|eci/), r = col(/rate|premium/, /critical|\bci\b|eci/)
    if (r >= 0) {
      for (const row of rows.slice(hi + 1)) {
        const age = ageOf(row.cells[a]), gg = gender(row.cells[g] ?? ''), ss = smoker(row.cells[s] ?? ''), rate = num(row.cells[r])
        if (age == null || !gg || ss == null || !(rate > 0)) continue
        const c = ci >= 0 ? num(row.cells[ci]) : NaN
        add({ age, gender: gg, smoker: ss, rate: round(rate), ci_rate: c > 0 ? round(c) : null })
      }
    }
  }

  // 2. A grid: age down the side, a column per gender and smoker status (headings can be on two rows).
  if (!out.size) {
    let i = 0
    while (i < rows.length) {
      const first = dataStart(rows, i)
      if (first < 0) break
      const ageCol = rows[first].cells.findIndex((c) => ageOf(c) != null)
      let width = rows[first].cells.length - ageCol - 1
      let end = first
      while (end < rows.length && ageOf(rows[end].cells[ageCol]) != null && rows[end].page === rows[first].page) end++
      // Two tables side by side ("17 ... | 47 ..."): an age again halfway along the row. Read the left one, then the right.
      const half = (width - 1) / 2
      const block = rows.slice(first, end)
      const sideBySide = Number.isInteger(half) && half >= 2 &&
        block.filter((r) => ageOf(r.cells[ageCol + 1 + half]) != null).length >= block.length * 0.6
      if (sideBySide) width = half
      const labels = headerLabels(rows, first, ageCol, width, doc.kind, text, sideBySide)
      if (labels) {
        const parts = sideBySide
          ? [...block.map((r) => r.cells.slice(ageCol, ageCol + 1 + half)), ...block.map((r) => r.cells.slice(ageCol + 1 + half, ageCol + 2 + 2 * half))]
          : block.map((r) => r.cells.slice(ageCol))
        const got: Rate[] = []
        for (const cells of parts) {
          const age = ageOf(cells[0])
          if (age == null) continue
          const vals = cells.slice(1)
          labels.forEach((l, k) => {
            if (!l.g || l.s == null || l.ci) return
            const rate = num(vals[k])
            if (!(rate > 0)) return
            const ciK = labels.findIndex((x) => x.ci && x.g === l.g && x.s === l.s)
            const c = ciK >= 0 ? num(vals[ciK]) : NaN
            got.push({ age, gender: l.g, smoker: l.s, rate: round(rate), ci_rate: c > 0 ? round(c) : null })
          })
        }
        // A later table for ages already read (another policy term): left out as a whole, never mixed in.
        if (got.some((r) => out.has(`${plain(r.age)}|${r.gender}|${r.smoker}`))) dup = true
        else got.forEach(add)
      }
      i = Math.max(end, first + 1)
    }
  }

  const rates = [...out.values()].sort((a, b) => a.age - b.age || a.gender.localeCompare(b.gender) || Number(a.smoker) - Number(b.smoker))
  if (dup) {
    const titles = [...new Set([...text.matchAll(/(?:policy|coverage|cover) term (?:to|until|of) (?:age )?\d{1,3}(?: years)?/gi)].map((m) => m[0].replace(/\s+/g, ' ')))]
    notes.push(titles.length > 1
      ? `The sheet has ${fmtNum(titles.length)} tables for the same ages, one per policy term (${titles.join('; ')}). Only the first, ${titles[0]}, was used; the others were left out.`
      : 'The sheet has more than one table for the same ages (for example one per policy term). Only the first table was used; the others were left out. Check it is the one you want.')
  }
  if (!rates.length) return { rates, notes, error: "Couldn't find a premium rates table (ages down the side, with columns for male/female and smoker/non-smoker). Paste the rates in by hand." }
  return { rates, notes, error: '' }
}

/** The first row at or after `from` that starts a run of at least 2 rows: an age, then 2 or more rates. */
function dataStart(rows: Row[], from: number): number {
  const ok = (r?: Row) => {
    if (!r) return false
    const a = r.cells.findIndex((c) => ageOf(c) != null)
    return a >= 0 && r.cells.slice(0, a).every((c) => !c) && r.cells.slice(a + 1).filter((c) => num(c) > 0).length >= 2
  }
  for (let i = from; i < rows.length; i++) if (ok(rows[i]) && ok(rows[i + 1])) return i
  return -1
}

interface Col { g: Rate['gender'] | ''; s: boolean | null; ci: boolean }

/** What each rate column is, from the 1 to 3 heading rows above the data. */
function headerLabels(rows: Row[], first: number, ageCol: number, width: number, kind: ReadDoc['kind'], text: string, sideBySide = false): Col[] | null {
  const heads: string[][] = []
  for (let k = first - 1; k >= 0 && k >= first - 3; k--) {
    const r = rows[k]
    if (r.page !== rows[first].page && kind === 'pdf') break
    if (r.cells.filter((c) => num(c) > 0).length >= 2) break
    let cells: string[]
    if (kind === 'excel') {
      cells = r.cells.slice(ageCol + 1, ageCol + 1 + width)
      // Merged heading cells come out blank after the first: carry the heading across.
      for (let j = 1; j < cells.length; j++) if (!cells[j] && cells[j - 1] && j < width) cells[j] = cells[j - 1]
    } else {
      let c = r.cells.filter((x) => !/^age\b|next birthday|last birthday|^(?:next|last|birthday|anb|alb)$/i.test(x))
      if (!c.length) continue
      // Side-by-side tables repeat their headings: one copy is enough.
      if (sideBySide && c.length % 2 === 0 && c.slice(0, c.length / 2).join('|') === c.slice(c.length / 2).join('|')) c = c.slice(0, c.length / 2)
      // A top heading with fewer cells ("Male  Female" over four columns) spans the columns evenly.
      if (c.length < width && width % c.length === 0) cells = c.flatMap((x) => Array(width / c.length).fill(x))
      else if (c.length <= width) cells = [...Array(width - c.length).fill(''), ...c]
      else cells = c.slice(c.length - width)
    }
    heads.unshift(cells)
    if (heads.length >= 1 && cells.every((x) => gender(x) || smoker(x) != null || isCi(x))) {
      // Enough when the columns can all be told apart.
    }
  }
  if (!heads.length) return null
  const cols: Col[] = Array.from({ length: width }, (_, j) => {
    const l = heads.map((h) => h[j] ?? '').join(' ')
    return { g: gender(l), s: smoker(l), ci: isCi(l) }
  })
  // One smoker status for the whole sheet (said in its title).
  if (cols.every((c) => c.s == null)) {
    const s = /non[- ]?smoker/i.test(text) && !/\bsmoker\b(?![\s-]*status)/i.test(text.replace(/non[- ]?smoker/gi, '')) ? false : null
    if (s != null) cols.forEach((c) => { c.s = s })
  }
  return cols.some((c) => c.g && c.s != null && !c.ci) ? cols : null
}

// ---------------------------------------------------------------------------------------------------------------
// Rates as CSV (the record page's text box)
// ---------------------------------------------------------------------------------------------------------------
export const ratesCsv = (rates: Rate[]) =>
  ['age,gender,smoker,rate,ci_rate', ...rates.map((r) => [r.age, r.gender, r.smoker ? 'yes' : 'no', r.rate, r.ci_rate ?? ''].join(','))].join('\n')
