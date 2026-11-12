// Fills the comparison Excel template (web/public/templates/pi-comparison-template.xlsx, built by
// web/scripts/make-template.mjs) in the layout of Kumar's "Term Quotation Comparison Excel" spec:
//  - a header block about the insured person ("Insured Name: ...", from PI1),
//  - a "Sum Assured: SGD 1,000,000" / "Policy Term: Up till age 85" banner (from PI1),
//  - a table with one column per PI: the "Insurer" row holds PI1/PI2/PI3 placeholders, which become the insurer
//    names; the other rows are matched on their label in column A.
// Amounts follow each policy's own currency: money row labels say "(SGD)" when every PI is in SGD, and each
// amount carries its currency in its number format, so a USD policy never shows as SGD.
// ExcelJS is loaded in the background when the comparison first shows (preloadExcel), not with the app.
import { FIELDS, labelWith, type FieldDef } from './piExtract.ts'

export interface ExportColumn {
  fileName: string
  values: Record<string, string>
  notes: string[]
  edited: Record<string, boolean>
  pages: Record<string, number | null>
}

/** The comparison file ops save onto a request; the introducer gets it with the PIs. */
export const isComparisonFile = (name: string) => /pi-comparison\.xlsx$/i.test(name)

export const TEMPLATE_URL = `${import.meta.env?.BASE_URL ?? "/"}templates/pi-comparison-template.xlsx`

const HEADER_KEYS = ['insured_name', 'date_of_birth', 'gender', 'residency', 'underwriting_class']
/** Fields that are only used for the banner or the labels, not table rows. */
const NOT_IN_TABLE = new Set([...HEADER_KEYS, 'currency', 'cover_age'])
/** Currencies written with a "$" sign, as in the spec ("$2,653.10" under "Annual Premium (SGD)"). */
const DOLLAR = new Set(['SGD', 'USD', 'AUD', 'CAD', 'HKD', 'BND', 'NZD'])

const toNumber = (v: string): number | null => {
  const s = v.replace(/,/g, '').trim()
  return s !== '' && !isNaN(Number(s)) ? Number(s) : null
}
const withCommas = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 2 })

/** "Annual Premium (SGD)" -> "annual premium". */
const norm = (s: unknown) => String(s ?? '').replace(/\([^)]*\)/g, '').replace(/:\s*.*$/, '').toLowerCase().replace(/\s+/g, ' ').trim()

/** The currency shown in a money row's label: the policies' currency when they all share one. */
export function commonCurrency(cols: { values: Record<string, string> }[]): string {
  const set = new Set(cols.map((c) => (c.values.currency ?? '').trim().toUpperCase()).filter(Boolean))
  return set.size === 1 ? [...set][0] : ''
}

function numFmt(f: FieldDef, cur: string, inLabel: boolean, n: number): string {
  const dp = f.kind === 'money' || !Number.isInteger(n) ? '#,##0.00' : '#,##0'
  if (f.kind === 'years' || f.kind === 'age') return '0'
  // Money rows: "$" when the label already names the currency (as in the spec), else the code itself.
  const prefix = f.kind === 'money' && inLabel && DOLLAR.has(cur) ? '$' : cur ? `${cur} ` : ''
  return prefix ? `"${prefix}"${dp}` : dp
}

let excelLoad: Promise<{ default: typeof import('exceljs') }> | null = null
/** Loads ExcelJS. Called when the comparison first shows, so the file is fetched while it still matches the page:
 *  after a site update the old file is gone, and loading it only at export time would fail. */
export function preloadExcel() {
  excelLoad ??= import('exceljs').catch((e) => { excelLoad = null; throw e })
  return excelLoad
}

export async function buildWorkbook(cols: ExportColumn[], template: ArrayBuffer): Promise<Blob> {
  let ExcelJS: typeof import('exceljs')
  try { ExcelJS = (await preloadExcel()).default }
  catch { throw new Error('The site was updated after this page was opened, so the Excel tool could not load. Note any values you changed, refresh the page, then export again.') }
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(template)
  const ws = wb.worksheets[0]
  if (!ws) throw new Error('The Excel template has no sheet.')
  const common = commonCurrency(cols)

  // Find the rows by their label in column A.
  const rowOf: Record<string, number> = {}
  let insurerRow = 0, bannerSa = 0, bannerTerm = 0, lastRow = 1
  ws.eachRow((row, r) => {
    const raw = String(row.getCell(1).value ?? '')
    const label = norm(raw)
    lastRow = Math.max(lastRow, r)
    if (/^sum assured\s*:/i.test(raw)) { bannerSa = r; return }
    if (/^policy term\s*:/i.test(raw)) { bannerTerm = r; return }
    const f = FIELDS.find((x) => x.section !== 'banner' && x.section !== 'meta' && norm(x.label) === label)
    if (f && !rowOf[f.key]) { rowOf[f.key] = r; if (f.key === 'insurer') insurerRow = r }
  })
  const needed = FIELDS.filter((f) => f.key !== 'currency' && f.key !== 'cover_age')
  const missing = needed.filter((f) => !rowOf[f.key]).map((f) => f.label)
  if (missing.length) throw new Error(`The Excel template is missing these rows: ${missing.join(', ')}`)
  // Columns: the PI1/PI2/PI3 placeholders on the Insurer row.
  const colOf: number[] = []
  ws.getRow(insurerRow).eachCell((cell, c) => {
    const m = String(cell.value ?? '').match(/^PI\s*(\d)$/i)
    if (m) colOf[Number(m[1]) - 1] = c
  })
  if (colOf.length < cols.length || colOf.slice(0, cols.length).some((c) => !c)) throw new Error('The Excel template needs PI1, PI2 and PI3 on the Insurer row.')
  colOf.forEach((c) => { ws.getCell(insurerRow, c).value = null })

  // Header block and banner: the insured person and the plan asked for are the same in every PI, so PI1's
  // values are used (the first PI that has one). A PI that says something else gets a note.
  const extraNotes: string[] = []
  const first = (k: string) => cols.find((c) => (c.values[k] ?? '').trim())?.values[k]?.trim() ?? ''
  for (const k of HEADER_KEYS) {
    const f = FIELDS.find((x) => x.key === k)!
    const v = first(k)
    ws.getCell(rowOf[k], 1).value = `${f.label}: ${v}`.trim()
    const differ = cols.map((c, i) => [i, (c.values[k] ?? '').trim()] as const).filter(([, x]) => x && x.toLowerCase() !== v.toLowerCase())
    for (const [i, x] of differ) extraNotes.push(`PI${i + 1}: ${f.label} is "${x}" in this PI (the header shows "${v}").`)
  }
  const sa = first('death_sa'), saCur = cols.find((c) => (c.values.death_sa ?? '').trim())?.values.currency ?? common
  const saN = toNumber(sa)
  if (bannerSa) ws.getCell(bannerSa, 1).value = `Sum Assured: ${saN !== null ? `${saCur ? saCur + ' ' : ''}${withCommas(saN)}` : sa}`.trim()
  const age = first('cover_age')
  if (bannerTerm) ws.getCell(bannerTerm, 1).value = `Policy Term: ${age ? `Up till age ${age}` : first('policy_term') ? `${first('policy_term')} years` : ''}`.trim()

  for (const [k, what] of [['death_sa', 'Sum assured'], ['cover_age', 'Cover until age']] as const) {
    const base = toNumber(first(k))
    cols.forEach((c, i) => {
      const n = toNumber(c.values[k] ?? '')
      if (base !== null && n !== null && n !== base) extraNotes.push(`PI${i + 1}: ${what} is ${withCommas(n)}, not ${withCommas(base)} as in the banner above the table.`)
    })
  }

  // Money row labels carry the currency, as in the spec: "Annual Premium (SGD)".
  for (const f of FIELDS) if (f.kind === 'money' && rowOf[f.key]) ws.getCell(rowOf[f.key], 1).value = labelWith(f, common)

  // The table: one column per PI.
  cols.forEach((c, i) => {
    const cur = (c.values.currency ?? '').trim().toUpperCase()
    for (const f of FIELDS) {
      if (NOT_IN_TABLE.has(f.key)) continue
      const cell = ws.getCell(rowOf[f.key], colOf[i])
      const v = (c.values[f.key] ?? '').trim()
      const n = f.kind === 'text' || f.kind === 'cover' ? null : toNumber(v)
      if (v === '') cell.value = null
      // A fresh style object: template cells share theirs, and setting numFmt on one would change them all.
      else if (n !== null) { cell.value = n; cell.style = { ...cell.style, numFmt: numFmt(f, cur, !!common, n) } }
      else cell.value = v
    }
  })

  // Notes under the table, one line per PI (for example a discounted premium).
  let r = lastRow + 2
  const all = [...cols.flatMap((c, i) => c.notes.map((n) => `PI${i + 1}: ${n}`)), ...extraNotes]
  for (const n of all) {
    const cell = ws.getCell(r++, 1)
    cell.value = n
    cell.font = { color: { argb: 'FF666666' } }
  }

  // Audit trail: where each value came from and what ops changed.
  const src = wb.addWorksheet('Sources')
  src.addRow(['Column', 'File', 'Field', 'Value', 'Page found on', 'Changed by hand'])
  src.getRow(1).font = { bold: true }
  cols.forEach((c, i) => FIELDS.forEach((f) => src.addRow([
    `PI${i + 1}`, c.fileName, labelWith(f, (c.values.currency ?? '').trim().toUpperCase()), c.values[f.key] ?? '', c.pages[f.key] ?? '', c.edited[f.key] ? 'Yes' : '',
  ])))
  src.columns.forEach((col) => { col.width = 24 })

  const buf = await wb.xlsx.writeBuffer()
  return new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
}
