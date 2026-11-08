// Reads key fields out of policy illustration (PI) PDFs, in the browser.
// Nothing leaves the user's computer. Results are suggestions: ops must check every value.
//
// How it works: pdf.js returns each piece of text with its position. We rebuild the text into
// lines (same height on the page = same line), then look for a label on each line ("Sum Assured",
// "Annual Premium", ...) and read the value after it, or on the next line.
// The generic labels below cover common layouts. When a real insurer's PI reads wrongly,
// add an entry for that insurer in INSURER_RULES instead of changing the generic rules.

export type FieldKind = 'text' | 'money' | 'age' | 'term' | 'gender' | 'smoker' | 'money_or_yes_no'

export interface FieldDef {
  key: string
  label: string
  kind: FieldKind
  labels: RegExp[]          // first match wins
  exclude?: RegExp          // skip lines that also match this
}

export const FIELDS: FieldDef[] = [
  { key: 'plan_name', label: 'Plan name', kind: 'text',
    labels: [/\b(?:plan|product|policy)\s+name\b/i, /^\s*plan\b(?=\s*[:\-])/i] },
  { key: 'age', label: 'Life assured age', kind: 'age',
    labels: [/\bage\s+(?:next|last)\s+birthday\b/i, /\b(?:entry\s+age|age\s+at\s+entry)\b/i, /\b(?:ANB|ALB)\b/, /\bage\b(?=\s*[:\-(])/i],
    exclude: /\bto\s+age\b|\bage\s+\d{2,3}\b.*\bterm\b/i },
  { key: 'gender', label: 'Gender', kind: 'gender', labels: [/\b(?:gender|sex)\b/i] },
  { key: 'smoker', label: 'Smoker status', kind: 'smoker', labels: [/\bsmoker(?:\s+status)?\b/i, /\bsmoking\s+status\b/i] },
  { key: 'sum_assured', label: 'Sum assured (death / TPD)', kind: 'money',
    labels: [/\bbasic\s+sum\s+assured\b/i, /\bsum\s+assured\b/i, /\bsum\s+insured\b/i, /\bdeath\s+benefit\b/i, /\bcoverage\s+amount\b/i],
    exclude: /critical|\bCI\b|premium/i },
  { key: 'ci_cover', label: 'Critical illness cover', kind: 'money_or_yes_no',
    labels: [/\b(?:early\s+)?critical\s+illness(?:\s+(?:benefit|cover|sum\s+assured|rider))?\b/i, /\bCI\s+(?:benefit|cover|rider|sum\s+assured)\b/i],
    exclude: /premium/i },
  { key: 'policy_term', label: 'Policy term', kind: 'term',
    labels: [/\bpolicy\s+term\b/i, /\bcoverage\s+(?:term|period)\b/i, /\bbenefit\s+term\b/i, /\bterm\s+of\s+(?:policy|cover)\b/i] },
  { key: 'premium_term', label: 'Premium payment term', kind: 'term',
    labels: [/\bpremium\s+(?:payment|paying)\s+term\b/i, /\bpremium\s+term\b/i, /\bpayment\s+term\b/i] },
  { key: 'annual_premium', label: 'Annual premium', kind: 'money',
    labels: [/\btotal\s+annual\s+premium\b/i, /\bannual\s+premium\b/i, /\byearly\s+premium\b/i, /\bpremium\s*\(\s*annual(?:ly)?\s*\)/i],
    exclude: /\btotal\s+premiums?\s+(?:payable|paid)\b/i },
  { key: 'monthly_premium', label: 'Monthly premium', kind: 'money',
    labels: [/\bmonthly\s+premium\b/i, /\bpremium\s*\(\s*monthly\s*\)/i] },
  { key: 'total_premium', label: 'Total premiums payable', kind: 'money',
    labels: [/\btotal\s+premiums?\s+(?:payable|paid)\b/i, /\btotal\s+premiums?\s+over\b/i] },
  { key: 'riders', label: 'Riders', kind: 'text', labels: [/\briders?\b(?=\s*[:\-])/i, /\bsupplementary\s+benefits?\b/i] },
]

export const KNOWN_INSURERS = [
  'AIA', 'Great Eastern', 'Prudential', 'Income Insurance', 'NTUC Income', 'Manulife', 'HSBC Life', 'Singlife',
  'Tokio Marine', 'FWD', 'China Life', 'China Taiping', 'Etiqa', 'Raffles Health', 'AXA', 'Aviva',
]

/** Per-insurer label overrides, tried before the generic labels. Fill in from real PIs. */
export const INSURER_RULES: Record<string, Partial<Record<string, RegExp[]>>> = {
  // Example: 'Great Eastern': { annual_premium: [/\bannualised\s+premium\b/i] },
}

export interface TextItem { str: string; x: number; y: number; w: number }
export interface Line { page: number; text: string }

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

const MONEY = /(?:S\$|SGD|\$)\s*([\d,]+(?:\.\d{1,2})?)/i
const PLAIN_NUMBER = /\b(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d{3,}(?:\.\d{1,2})?)\b/

function parse(kind: FieldKind, raw: string): string | null {
  const s = raw.replace(/^[\s:\-–|]+/, '').trim()
  if (!s) return null
  switch (kind) {
    case 'text': return s.split(/\s{2,}/)[0].slice(0, 120) || null
    case 'money': {
      const m = s.match(MONEY) ?? s.match(PLAIN_NUMBER)
      return m ? Number(m[1].replace(/,/g, '')).toFixed(2) : null
    }
    case 'money_or_yes_no': {
      const m = s.match(MONEY) ?? s.match(PLAIN_NUMBER)
      if (m) return Number(m[1].replace(/,/g, '')).toFixed(2)
      if (/\b(?:no|nil|none|not\s+(?:included|covered|applicable)|n\/a)\b/i.test(s)) return 'No'
      if (/\b(?:yes|included|covered)\b/i.test(s)) return 'Yes'
      return null
    }
    case 'age': {
      const m = s.match(/\b(\d{1,2})\b/)
      return m ? m[1] : null
    }
    case 'term': {
      const toAge = s.match(/\b(?:to|until|up\s+to)\s+age\s+(\d{2,3})\b/i)
      if (toAge) return `To age ${toAge[1]}`
      const yrs = s.match(/\b(\d{1,2})\s*(?:years?|yrs?)\b/i)
      if (yrs) return `${yrs[1]} years`
      if (/\bsingle\b/i.test(s)) return 'Single premium'
      const bare = s.match(/^(\d{1,2})\b/)
      return bare ? `${bare[1]} years` : null
    }
    case 'gender': {
      if (/\bfemale\b|^F\b/i.test(s)) return 'Female'
      if (/\bmale\b|^M\b/i.test(s)) return 'Male'
      return null
    }
    case 'smoker': {
      if (/\bnon[\s-]?smoker\b|\bnonsmoker\b|^NS\b|^no\b/i.test(s)) return 'Non-smoker'
      if (/\bsmoker\b|^S\b|^yes\b/i.test(s)) return 'Smoker'
      return null
    }
  }
}

export function detectInsurer(lines: Line[], fileName: string): string {
  const hay = lines.slice(0, 80).map((l) => l.text).join('\n') + '\n' + fileName
  for (const name of KNOWN_INSURERS) {
    if (new RegExp(`\\b${name.replace(/\s+/g, '\\s+')}\\b`, 'i').test(hay)) return name
  }
  return ''
}

export function extractFields(lines: Line[], insurer: string): Record<string, Found> {
  const out: Record<string, Found> = {}
  for (const f of FIELDS) {
    const labels = [...(INSURER_RULES[insurer]?.[f.key] ?? []), ...f.labels]
    out[f.key] = { value: '', page: null, line: null }
    search: for (const re of labels) {
      for (let i = 0; i < lines.length; i++) {
        const l = lines[i]
        const m = l.text.match(re)
        if (!m || (f.exclude && f.exclude.test(l.text))) continue
        const after = l.text.slice((m.index ?? 0) + m[0].length)
        const same = parse(f.kind, after)
        if (same) { out[f.key] = { value: same, page: l.page, line: l.text }; break search }
        const next = i + 1 < lines.length && lines[i + 1].page === l.page ? lines[i + 1] : null
        const v = next ? parse(f.kind, next.text) : null
        if (v && next) { out[f.key] = { value: v, page: l.page, line: `${l.text} / ${next.text}` }; break search }
      }
    }
  }
  return out
}

/** Reads a PDF into lines with pdf.js (loaded only when needed). */
export async function readPdf(data: ArrayBuffer): Promise<Line[]> {
  const pdfjs = await import('pdfjs-dist')
  const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl
  const doc = await pdfjs.getDocument({ data }).promise
  const lines: Line[] = []
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p)
    const content = await page.getTextContent()
    const items: TextItem[] = []
    for (const it of content.items) {
      if (!('str' in it)) continue
      items.push({ str: it.str, x: it.transform[4], y: it.transform[5], w: it.width })
    }
    lines.push(...toLines(p, items))
  }
  return lines
}
