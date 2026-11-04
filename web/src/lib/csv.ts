/** Small CSV parser that handles quoted fields ("S$100,001 to 250,000"). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = [], field = '', quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++ }
      else if (c === '"') quoted = false
      else field += c
    } else if (c === '"') quoted = true
    else if (c === ',') { row.push(field); field = '' }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(field); field = ''
      if (row.some((v) => v.trim() !== '')) rows.push(row)
      row = []
    } else field += c
  }
  row.push(field)
  if (row.some((v) => v.trim() !== '')) rows.push(row)
  return rows
}

export const RATE_COLUMNS = ['age_band', 'gender', 'smoker', 'coverage_term', 'sum_assured_band', 'ci_benefit', 'premium_low', 'premium_high'] as const

export interface RateRowInput {
  age_band: string; gender: string; smoker: boolean; coverage_term: string; sum_assured_band: string
  ci_benefit: boolean; premium_low: number; premium_high: number
}

const yes = (v: string) => /^(yes|y|true|1)$/i.test(v.trim())
const isBool = (v: string) => /^(yes|y|true|1|no|n|false|0)$/i.test(v.trim())

export function parseRateCsv(text: string, allowed: Record<string, string[]>): { rows: RateRowInput[]; errors: string[] } {
  const data = parseCsv(text)
  const errors: string[] = []
  if (!data.length) return { rows: [], errors: ['The file is empty.'] }
  const header = data[0].map((h) => h.trim().toLowerCase())
  const idx = RATE_COLUMNS.map((c) => header.indexOf(c))
  RATE_COLUMNS.forEach((c, i) => { if (idx[i] < 0) errors.push(`Missing column "${c}".`) })
  if (errors.length) return { rows: [], errors }
  const rows: RateRowInput[] = []
  data.slice(1).forEach((r, n) => {
    const line = n + 2
    const get = (c: (typeof RATE_COLUMNS)[number]) => (r[idx[RATE_COLUMNS.indexOf(c)]] ?? '').trim()
    for (const [col, values] of Object.entries(allowed)) {
      const v = get(col as (typeof RATE_COLUMNS)[number])
      if (!values.includes(v)) errors.push(`Line ${line}: "${v}" is not a valid ${col.replace(/_/g, ' ')}.`)
    }
    if (!isBool(get('smoker')) || !isBool(get('ci_benefit'))) errors.push(`Line ${line}: smoker and ci_benefit must be Yes or No.`)
    const lo = Number(get('premium_low').replace(/[S$,\s]/g, '')), hi = Number(get('premium_high').replace(/[S$,\s]/g, ''))
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo <= 0 || lo > hi) errors.push(`Line ${line}: premiums must be numbers with low ≤ high.`)
    rows.push({
      age_band: get('age_band'), gender: get('gender'), smoker: yes(get('smoker')), coverage_term: get('coverage_term'),
      sum_assured_band: get('sum_assured_band'), ci_benefit: yes(get('ci_benefit')), premium_low: lo, premium_high: hi,
    })
  })
  return { rows, errors: errors.slice(0, 20) }
}
