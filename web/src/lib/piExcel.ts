// Fills the comparison Excel template (web/public/templates/pi-comparison-template.xlsx).
// The template has "Field" in A1 and PI1/PI2/PI3 across row 1, and one row per field, matched on the
// label in column A. To restyle or reorder the rows, edit the template in Excel and keep the labels.
// ExcelJS is loaded only when someone exports.
import { FIELDS } from './piExtract'

export interface ExportColumn {
  fileName: string
  values: Record<string, string>
  notes: string[]
  edited: Record<string, boolean>
  pages: Record<string, number | null>
}

/** The comparison file ops save onto a request; the introducer gets it with the PIs. */
export const isComparisonFile = (name: string) => /pi-comparison\.xlsx$/i.test(name)

export const TEMPLATE_URL = `${import.meta.env.BASE_URL}templates/pi-comparison-template.xlsx`

const FORMATS: Record<string, string> = { money: '#,##0.00', years: '0' }

function cellValue(kind: string, v: string): string | number {
  if (kind !== 'text' && v.trim() !== '' && !isNaN(Number(v.replace(/,/g, '')))) return Number(v.replace(/,/g, ''))
  return v
}

export async function buildWorkbook(cols: ExportColumn[], template: ArrayBuffer): Promise<Blob> {
  const ExcelJS = (await import('exceljs')).default
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(template)
  const ws = wb.worksheets[0]
  if (!ws) throw new Error('The Excel template has no sheet.')

  // Columns: PI1, PI2, PI3 in row 1.
  const colOf: number[] = []
  ws.getRow(1).eachCell((cell, c) => {
    const m = String(cell.value ?? '').match(/^PI\s*(\d)$/i)
    if (m) colOf[Number(m[1]) - 1] = c
  })
  // Rows: matched on the field label in column A.
  const norm = (s: unknown) => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim()
  const rowOf: Record<string, number> = {}
  let lastRow = 1
  ws.eachRow((row, r) => {
    const f = FIELDS.find((x) => norm(x.label) === norm(row.getCell(1).value))
    if (f) { rowOf[f.key] = r; lastRow = Math.max(lastRow, r) }
  })
  const missing = FIELDS.filter((f) => !rowOf[f.key]).map((f) => f.label)
  if (missing.length) throw new Error(`The Excel template is missing these rows: ${missing.join(', ')}`)
  if (colOf.length < cols.length || colOf.slice(0, cols.length).some((c) => !c)) throw new Error('The Excel template needs PI1, PI2 and PI3 headings in row 1.')

  cols.forEach((c, i) => {
    for (const f of FIELDS) {
      const cell = ws.getCell(rowOf[f.key], colOf[i])
      const v = c.values[f.key] ?? ''
      cell.value = v === '' ? null : cellValue(f.kind, v)
      // Keep the template's number format; use ours only when the template has none.
      if (typeof cell.value === 'number' && (!cell.numFmt || cell.numFmt === 'General')) cell.numFmt = FORMATS[f.kind] ?? 'General'
    }
  })

  // Notes under the table, one line per PI (for example a discounted premium).
  let r = lastRow + 2
  cols.forEach((c, i) => {
    for (const n of c.notes) {
      const cell = ws.getCell(r++, 1)
      cell.value = `PI${i + 1}: ${n}`
      cell.font = { color: { argb: 'FF666666' } }
    }
  })

  // Audit trail: where each value came from and what ops changed.
  const src = wb.addWorksheet('Sources')
  src.addRow(['Column', 'File', 'Field', 'Value', 'Page found on', 'Changed by hand'])
  src.getRow(1).font = { bold: true }
  cols.forEach((c, i) => FIELDS.forEach((f) => src.addRow([
    `PI${i + 1}`, c.fileName, f.label, c.values[f.key] ?? '', c.pages[f.key] ?? '', c.edited[f.key] ? 'Yes' : '',
  ])))
  src.columns.forEach((col) => { col.width = 24 })

  const buf = await wb.xlsx.writeBuffer()
  return new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
}
