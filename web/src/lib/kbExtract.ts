// Reads a Product Summary or a rate sheet (PDF or Excel) into a draft Knowledge Bank product record, in the
// browser. Like the PI reader: fixed reading rules, no AI, nothing leaves the computer. What it finds only
// fills in the draft; the maker checks each value against the document, and a BSD person checks it again.
// Shared with the Node tests (tests/kb-extract), so it imports types only from files that need the browser.
import { detectInsurer, readPdf, toLines, type Line, type Page, type TextItem } from './piExtract.ts'
import type { ProductRecord, Rate } from './kbAdmin'

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
  return pages.flatMap((p) => p.lines.map((l) => ({ page: p.page, cells: l.text.split(/\s{2,}/).map((x) => x.trim()).filter(Boolean) })))
}

/** For tests: positioned text into a page. */
export const pageOf = (page: number, items: TextItem[]): Page => ({ page, items, lines: toLines(page, items) })

// ---------------------------------------------------------------------------------------------------------------
// Product Summary
// ---------------------------------------------------------------------------------------------------------------

/** Labels that start a fact in a Product Summary (at the start of a line or a table cell). First match wins. */
export const FACT_RULES: { key: string; re: RegExp }[] = [
  { key: 'uw', re: /^(?:type of )?underwriting(?: requirements?| type)?\b/i },
  { key: 'premTerm', re: /^(?:premium (?:payment |paying )?term|premium payment period|premiums? (?:are )?payable (?:for|until))\b/i },
  { key: 'guaranteed', re: /^(?:are (?:the )?premium rates? guaranteed\??|premium rates?(?: guarantee)?|guaranteed premiums?|premiums? guarantee)\b/i },
  { key: 'modes', re: /^(?:(?:premium )?payment (?:modes?|frequenc(?:y|ies))|premium (?:modes?|frequenc(?:y|ies))|modes? of payment)\b/i },
  { key: 'coverTo', re: /^(?:policy term|coverage term|cover(?:age)? (?:until|up to|period)|term of (?:cover|policy)|expiry age|maturity age)\b/i },
  { key: 'eci', re: /^(?:early(?:[- ]stage)? critical illness|multi[- ]?stage critical illness|eci)\b/i },
  { key: 'ci', re: /^(?:critical illness|dread disease|ci)(?: benefit| cover| rider)?\b/i },
  { key: 'tpd', re: /^(?:total (?:and|&) permanent disability|tpd)(?: benefit| cover)?\b/i },
  { key: 'ti', re: /^terminal illness(?: benefit)?\b/i },
  { key: 'ad', re: /^accidental death(?: benefit)?\b/i },
  { key: 'death', re: /^death(?: benefit)?\b/i },
  { key: 'conversion', re: /^(?:conversion (?:option|privilege|benefit)|option to convert)\b/i },
  { key: 'renew', re: /^(?:renewa(?:l|bility)(?: option| privilege)?|guaranteed renewab)/i },
  { key: 'inc', re: /^(?:guaranteed insurability(?: option)?|life (?:event|stage) (?:option|benefit)|increase (?:in )?cover)/i },
  { key: 'invest', re: /^(?:investment (?:component|element|feature)s?|participating|is this a participating)/i },
  { key: 'cash', re: /^(?:cash value|surrender value|cash (?:and|&) surrender value)s?\b/i },
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
  age: /^(?:entry age|age at entry|issue age|entry age limits?|eligible entry age|minimum and maximum entry age)\b/i,
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
const NOISE = /^(?:product summary|benefits?|page \d+(?: of \d+)?|\d+)$/i
const NEGATIVE = /^(?:no|nil|none|n\.?a\.?|not (?:applicable|available|covered|included|offered)|not provided)\b|\bnot (?:covered|included|available|offered)\b/i

interface Hit { value: string; page: number }

const LIST_MARK = /^\(?\d{1,2}[.)]\s+|^[a-z][.)]\s+|^[ivx]{1,4}[.)]\s+/i
function rawPieces(l: Line) { return l.text.split(/\s{2,}|\s+[|•]\s+/).map((x) => x.trim()).filter(Boolean) }
const clean = (x: string) => x.replace(/^[\s•\-–*·]+/, '').replace(LIST_MARK, '').trim()
function pieces(l: Line) { return rawPieces(l).map(clean).filter(Boolean) }

/** The value after a label: the rest of the line, else the next line(s) up to the next label. A label counts
 *  only when it stands alone (a heading or a table cell) or is followed by a colon, so words in the middle of
 *  a paragraph ("contact the insurer directly") are not read as labels. */
function find(lines: Line[], re: RegExp, used: Set<number>): Hit | null {
  for (let i = 0; i < lines.length; i++) {
    if (used.has(i)) continue
    const raw = rawPieces(lines[i])
    for (let j = 0; j < raw.length; j++) {
      const part = clean(raw[j])
      const m = part.match(re)
      if (!m) continue
      const after = part.slice(m[0].length)
      const alone = /^\s*(?:benefits?|\(s\)|\([^)]{1,40}\))?\s*[:?]?\s*$/i.test(after)
      if (!alone && !/^\s*(?:\([^)]{1,40}\))?\s*[:–=]/.test(after)) continue
      // A numbered list of illnesses or benefits: the next piece is another item, not this one's value.
      if (alone && raw[j + 1] && LIST_MARK.test(raw[j + 1]) && clean(raw[j + 1]).length < 40) continue
      if (LIST_MARK.test(raw[j]) && raw.filter((x) => LIST_MARK.test(x)).length > 1) continue
      let rest = (alone ? raw.slice(j + 1).map(clean).join(' ') : after.replace(/^\s*(?:\([^)]{1,40}\))?\s*[:–=]/, '') + ' ' + raw.slice(j + 1).map(clean).join(' '))
        .replace(/^[\s:–\-=?]+/, '').trim()
      let k = i + 1
      while (!rest && k < lines.length && k <= i + 2 && lines[k].page === lines[i].page) {
        if (ALL_LABELS.some((r) => pieces(lines[k]).some((p) => r.test(p)))) break
        rest = clean(lines[k].text)
        k++
      }
      // A value that starts mid-sentence (lower case or punctuation) belongs to some other text.
      if (!rest || NOISE.test(rest) || /^[a-z.,;)&/]/.test(rest)) continue
      // A long paragraph: keep its first sentence or two.
      if (rest.length > 240) rest = rest.slice(0, 240).replace(/\s+\S*$/, '') + '…'
      used.add(i)
      return { value: rest, page: lines[i].page }
    }
  }
  return null
}

const ints = (s: string) => [...s.matchAll(/\b(\d{1,3})\b/g)].map((m) => +m[1]).filter((n) => n <= 100)

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
function currenciesIn(s: string): string[] {
  const found = new Set<string>()
  for (const c of CURRENCY_CODES) if (new RegExp(`\\b${c}\\b`).test(s)) found.add(c)
  if (/S\$|singapore dollars?/i.test(s)) found.add('SGD')
  if (/US\$|us dollars?|united states dollars?/i.test(s)) found.add('USD')
  if (/A\$|australian dollars?/i.test(s)) found.add('AUD')
  if (/£|pounds? sterling/i.test(s)) found.add('GBP')
  if (/€|euros?\b/i.test(s)) found.add('EUR')
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
}

export function readSummary(doc: ReadDoc): SummaryResult {
  const lines = doc.pages.flatMap((p) => p.lines)
  const text = lines.map((l) => l.text).join('\n')
  const used = new Set<number>()
  const record: Partial<ProductRecord> = {}
  const filled: string[] = []
  const facts: SummaryResult['facts'] = {}

  // The plan's own fields come first, so their lines are not read as facts.
  const name = find(lines, REC.name, used)
  if (name) record.name = name.value.replace(/\s*\(.*?\)\s*$/, '')
  else {
    const ps = lines.slice(0, 15).map((l) => l.text.match(/^(?:product summary\s*(?:for|[:\-–])\s*(.+)|(.+?)\s*[:\-–]?\s*product summary)$/i)).find(Boolean)
    const n = ps?.[1] ?? ps?.[2]
    if (n && n.length < 80) record.name = n.trim()
  }
  if (record.name) filled.push('product name')
  const ins = find(lines, REC.insurer, used)
  const insurer = (ins && (detectInsurer(ins.value) || ins.value.replace(/(?:[\s,]*(?:pte\.?|ltd\.?|limited|berhad|\(.*?\)))+\s*$/i, '').trim())) || detectInsurer(text)
  if (insurer) { record.insurer = insurer; filled.push('insurer') }

  const age = find(lines, REC.age, used)
  const aMin = find(lines, REC.ageMin, used), aMax = find(lines, REC.ageMax, used)
  const ageNums = age ? ints(age.value) : []
  const min = aMin ? ints(aMin.value)[0] : ageNums[0]
  const max = aMax ? ints(aMax.value)[0] : ageNums.length > 1 ? ageNums[ageNums.length - 1] : undefined
  if (min != null && max != null && min < max) { record.entry_age_min = min; record.entry_age_max = max; filled.push('entry age') }

  const sMin = find(lines, REC.saMin, used), sMax = find(lines, REC.saMax, used)
  const sa = !sMin || !sMax ? find(lines, REC.sa, used) : null
  const saNums = sa ? amounts(sa.value) : []
  const lo = sMin ? amounts(sMin.value)[0] : saNums[0]
  const hi = sMax ? amounts(sMax.value)[0] : saNums.length > 1 ? saNums[saNums.length - 1] : undefined
  if (lo != null) { record.sa_min = lo; filled.push('minimum sum assured') }
  if (hi != null && (lo == null || hi > lo)) { record.sa_max = hi; filled.push('maximum sum assured') }

  const cur = find(lines, REC.currency, used)
  const curs = cur ? currenciesIn(cur.value) : []
  if (curs.length) { record.currencies = curs; filled.push('policy currencies') }

  const res = find(lines, REC.residency, used)
  if (res) {
    const r: string[] = []
    const v = res.value
    if (/citizens?/i.test(v)) r.push('Singapore citizen')
    if (/\bPRs?\b|permanent residen/i.test(v)) r.push('Singapore PR')
    if (/foreigner|pass holders?|employment pass|work pass|s pass|dependant/i.test(v)) r.push('Foreigner living in Singapore')
    if (/non[- ]residents?|overseas|outside singapore/i.test(v)) r.push('Non-resident')
    if (r.length) { record.residency = r; filled.push('who can apply') }
  }
  if (/direct purchase insurance/i.test(text)) { record.dpi = true; filled.push('Direct Purchase Insurance') }
  if (/\boffshore\b/i.test(text) && !/\bonshore\b/i.test(text)) { record.jurisdiction = 'Offshore'; filled.push('offshore') }

  for (const r of FACT_RULES) {
    const h = find(lines, r.re, used)
    if (h) facts[r.key] = { v: h.value, page: h.page }
  }
  const yes = (k: string) => !!facts[k] && !NEGATIVE.test(facts[k].v)
  if (facts.tpd) record.has_tpd = yes('tpd')
  if (facts.ci || facts.eci) record.has_ci = yes('ci') || yes('eci')
  const n = Object.keys(facts).length
  if (n) filled.push(`${n} fact${n === 1 ? '' : 's'}`)
  return { record, facts, filled }
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
  return { f: 1000 / per, note: `The sheet's rates are per ${per.toLocaleString('en-SG')} of sum assured; they were converted to per 1,000.` }
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
    const k = `${r.age}|${r.gender}|${r.smoker}`
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
      const width = rows[first].cells.length - ageCol - 1
      const labels = headerLabels(rows, first, ageCol, width, doc.kind, text)
      let end = first
      while (end < rows.length && ageOf(rows[end].cells[ageCol]) != null && rows[end].page === rows[first].page) end++
      if (labels) {
        for (const row of rows.slice(first, end)) {
          const age = ageOf(row.cells[ageCol])!
          const vals = row.cells.slice(ageCol + 1)
          labels.forEach((l, k) => {
            if (!l.g || l.s == null || l.ci) return
            const rate = num(vals[k])
            if (!(rate > 0)) return
            const ciK = labels.findIndex((x) => x.ci && x.g === l.g && x.s === l.s)
            const c = ciK >= 0 ? num(vals[ciK]) : NaN
            add({ age, gender: l.g, smoker: l.s, rate: round(rate), ci_rate: c > 0 ? round(c) : null })
          })
        }
      }
      i = Math.max(end, first + 1)
    }
  }

  const rates = [...out.values()].sort((a, b) => a.age - b.age || a.gender.localeCompare(b.gender) || Number(a.smoker) - Number(b.smoker))
  if (dup) notes.push('The sheet has more than one table for the same ages (for example one per policy term). The first table was used; check it is the one for cover to age 65.')
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
function headerLabels(rows: Row[], first: number, ageCol: number, width: number, kind: ReadDoc['kind'], text: string): Col[] | null {
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
      const c = r.cells.filter((x) => !/^age\b|next birthday|^anb$|^alb$/i.test(x))
      if (!c.length) continue
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
