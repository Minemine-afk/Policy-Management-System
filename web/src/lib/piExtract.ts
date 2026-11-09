// Reads the six comparison fields out of Singapore policy illustration (PI) PDFs, in the browser.
// Nothing leaves the user's computer, and no AI is used: only fixed reading rules. Results are
// suggestions, so ops must check every value. When a rule is not sure, the field is left blank
// for ops to fill in, rather than guessed.
//
// Singapore PIs follow the LIA format (LIA guidelines MU 22/18), which helps a lot:
//  - The Cover Page has the plan name above "Product Type", then "Premium Term", "Policy Term"
//    and "Name of Insurer" rows, and the fixed sentence
//    "The Total Distribution Cost for this plan is $X ... This makes up Y% of the total premiums payable."
//  - The Policy Illustration has a summary table (plan, terms, sum assured, premium). We read
//    that table by position: each value sits under its column heading.
// When a real insurer's PI reads wrongly, add an entry for that insurer in INSURER_RULES
// instead of changing the generic rules.

export type FieldKind = 'text' | 'money' | 'years'

export interface FieldDef {
  key: string
  /** The row label in the Excel template (column A). Rows are matched on this text. */
  label: string
  kind: FieldKind
}

export const FIELDS: FieldDef[] = [
  { key: 'insurer_plan', label: 'Insurer / plan', kind: 'text' },
  { key: 'sum_assured', label: 'Sum assured (S$)', kind: 'money' },
  { key: 'policy_term', label: 'Policy term (years)', kind: 'years' },
  { key: 'premium_term', label: 'Premium term (years)', kind: 'years' },
  { key: 'monthly_premium', label: 'Premium (S$, monthly)', kind: 'money' },
  { key: 'distribution_cost', label: 'Total distribution cost (S$)', kind: 'money' },
]

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
  // Example: 'Great Eastern': { monthly_premium: [/\bmonthly\s+instalment\b/i] },
}

export interface TextItem { str: string; x: number; y: number; w: number }
export interface Line { page: number; text: string }
export interface Page { page: number; items: TextItem[]; lines: Line[] }

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
  values: Partial<Record<'plan' | 'policy_term' | 'premium_term' | 'sum_assured' | 'premium' | 'before' | 'discount', string>>
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

export function extract(pages: Page[], fileName: string): Extracted {
  const lines = pages.flatMap((p) => p.lines)
  const found: Record<string, Found> = Object.fromEntries(FIELDS.map((f) => [f.key, { value: '', page: null, line: null }]))
  const notes: string[] = []
  const set = (key: string, value: string | null | undefined, page: number, line: string) => {
    if (value && !found[key].value) found[key] = { value, page, line }
  }

  // Cover page rows (only the first page or two, where the cover page sits).
  const cover = lines.filter((l) => l.page <= 2)
  const prt = coverRow(cover, /^premium\s+term\b/i)
  if (prt) set('premium_term', parseYears(prt.value), prt.line.page, prt.line.text)
  const pt = coverRow(cover, /^policy\s+term\b/i)
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

  // Total distribution cost: the fixed LIA cover page sentence.
  for (const l of lines) {
    const m = l.text.match(/total\s+distribution\s+cost\s+for\s+this\s+plan\s+is\s*(.*)$/i)
    if (!m) continue
    const v = m[1].replace(/\$\s+(?=\d)/, '$').replace(/([\d.,])\s+(?=[\d.,])/g, '$1').match(MONEY_IN_TEXT)
    if (v) set('distribution_cost', money(v[1]), l.page, l.text)
    const pct = l.text.match(/makes\s+up\s+(\d{1,3}(?:\.\d+)?)\s*%/i)
    if (pct) notes.push(`Total distribution cost is ${pct[1]}% of total premiums.`)
    break
  }

  // Payment mode, so we only put a premium in the monthly row when it really is monthly.
  const modeLine = lines.find((l) => /\bpayment\s+mode\b/i.test(l.text))
  const mode = modeLine?.text.match(/payment\s+mode\s*:?\s*(monthly|quarterly|half[\s-]?yearly|semi[\s-]?annual(?:ly)?|annual(?:ly)?|yearly|single)/i)?.[1] ?? ''
  const monthlyMode = /monthly/i.test(mode)

  // Summary table.
  let table: TableRead | null = null
  for (const p of pages) { table = readSummaryTable(p); if (table) break }
  if (table) {
    const t = table.values
    set('sum_assured', t.sum_assured ? money(t.sum_assured.replace(/[^\d.,]/g, '')) : '', table.page, table.line)
    set('policy_term', t.policy_term ? parseYears(t.policy_term) : '', table.page, table.line)
    set('premium_term', t.premium_term ? parseYears(t.premium_term) : '', table.page, table.line)
    const headerSaysMonthly = /monthly/i.test(table.premiumHeader)
    if (t.premium && (headerSaysMonthly || monthlyMode)) set('monthly_premium', money(t.premium.replace(/[^\d.,]/g, '')), table.page, table.line)
    if (!plan && t.plan) plan = t.plan
    if (t.discount) {
      const pctNote = `Premium is after a ${t.discount.replace(/\s+/g, '')} discount`
      notes.unshift(t.before ? `${pctNote} (S$${num(t.before.replace(/[^\d.,]/g, '')).toFixed(2)} before the discount).` : `${pctNote}.`)
    }
  }

  // Fallbacks: "label: value" on one line (never the next line, to avoid picking up the wrong number).
  const insurerForRules = detectInsurer(insurerRow?.value ?? '') || detectInsurer(lines.slice(0, 80).map((l) => l.text).join('\n') + '\n' + fileName)
  const labelRules: Record<string, RegExp[]> = {
    sum_assured: [/\b(?:basic\s+)?sum\s+assured\s*(?:\(S\$\))?\s*:/i],
    monthly_premium: [/\bMP\s*:/, /\bmonthly\s+premium\s*(?:\(S\$\))?\s*:/i],
  }
  for (const [key, generic] of Object.entries(labelRules)) {
    for (const re of [...(INSURER_RULES[insurerForRules]?.[key] ?? []), ...generic]) {
      for (const l of lines) {
        const m = l.text.match(re)
        if (!m) continue
        const after = l.text.slice((m.index ?? 0) + m[0].length).trim()
        const v = after.match(/^(?:S\$|SGD|\$)?\s*(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)\b/i)
        if (v) { set(key, money(v[1]), l.page, l.text); break }
      }
      if (found[key].value) break
    }
  }

  if (!found.monthly_premium.value && mode && !monthlyMode) {
    notes.push(`Payment mode is ${mode}, so the monthly premium was left blank. Fill it in by hand if you have it.`)
  }

  // Discount mentioned elsewhere (for example a promo code) but not read from the table.
  if (!table?.values.discount && lines.some((l) => /\b(?:promo(?:tion(?:al)?)?\s+(?:code|discount)|premium\s+discount|discount\s*\(%\))/i.test(l.text))) {
    notes.unshift('This PI mentions a premium discount. Check whether the premium shown is before or after it.')
  }

  // Riders (supplementary benefits) are not in the six fields; say so, with the total premium if shown.
  const riderIdx = lines.findIndex((l) => /^supplementary\s+benefits?$/i.test(l.text.trim()))
  if (riderIdx >= 0) {
    const page = lines[riderIdx].page
    const after = lines.slice(riderIdx + 1).filter((l) => l.page === page).slice(0, 12)
    const totalLine = after.find((l) => /^total\s*:/i.test(l.text))
    const totals = totalLine?.text.match(/\d{1,3}(?:,\d{3})*\.\d{2}/g)
    notes.push(`This PI also has supplementary benefits (riders). The premium above is for the main plan only${totals ? `; the total premium with riders is S$${totals[totals.length - 1]}` : ''}.`)
  }

  const insurer = insurerForRules || (insurerRow?.value ?? '').replace(/\s+(?:Pte\.?\s+)?Ltd\.?$/i, '')
  if (plan || insurer) {
    const value = insurer && plan ? `${insurer} – ${plan}` : insurer || plan
    found.insurer_plan = { value, page: planAt?.page ?? insurerRow?.line.page ?? null, line: [planAt?.text, insurerRow?.line.text].filter(Boolean).join(' / ') || null }
  }

  return { found, notes, discounted: !!table?.values.discount }
}

/** Called as pages are read: pages done so far, the PDF's page count, and whether OCR is being used. */
export type PageProgress = (done: number, total: number, ocr: boolean) => void
/** Reads a page that has no text inside it (a scanned picture). */
export type OcrPage = (page: unknown) => Promise<TextItem[]>

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
    return readWith(pdfjs, data, (d, t, o) => { arm(); onPage?.(d, t, o) }, (t) => { task = t }, ocr)
  })()
  try {
    return await Promise.race([read, stalled])
  } finally {
    clearTimeout(timer)
  }
}

/** Shared by the browser and the Node test script. */
export async function readWith(pdfjs: { getDocument: (src: { data: Uint8Array }) => { promise: Promise<unknown> } }, data: ArrayBuffer,
  onPage?: PageProgress, onTask?: (task: { destroy?: () => unknown }) => void, ocr?: OcrPage): Promise<Page[]> {
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
      onPage?.(p - 1, doc.numPages, true)
      items = await ocr(page)
    }
    pages.push({ page: p, items, lines: toLines(p, items) })
    onPage?.(p, doc.numPages, false)
  }
  return pages
}
