// Builds the comparison workbook. ExcelJS is loaded only when someone exports.
import { FIELDS } from './piExtract'

export interface ExportColumn {
  fileName: string
  insurer: string
  values: Record<string, string>
  edited: Record<string, boolean>
  pages: Record<string, number | null>
}

const MONEY_KEYS = new Set(FIELDS.filter((f) => f.kind === 'money').map((f) => f.key))

export async function buildWorkbook(cols: ExportColumn[], title: string): Promise<Blob> {
  const ExcelJS = (await import('exceljs')).default
  const wb = new ExcelJS.Workbook()
  wb.creator = 'PI Request Tracker'
  const ws = wb.addWorksheet('Comparison', { views: [{ state: 'frozen', xSplit: 1, ySplit: 3 }] })

  ws.getCell('A1').value = title
  ws.getCell('A1').font = { bold: true, size: 14 }
  ws.getCell('A2').value = `Prepared ${new Date().toLocaleString('en-SG')}. Values read from the PI PDFs and checked by ops.`
  ws.getCell('A2').font = { italic: true, color: { argb: 'FF4A5668' } }

  const header = ws.getRow(3)
  header.values = ['', ...cols.map((c, i) => c.insurer || `PI ${i + 1}`)]
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } }
  header.eachCell((cell) => { cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0B5C75' } } })

  FIELDS.forEach((f, r) => {
    const row = ws.getRow(4 + r)
    row.getCell(1).value = f.label
    row.getCell(1).font = { bold: true }
    cols.forEach((c, i) => {
      const cell = row.getCell(2 + i)
      const v = c.values[f.key] ?? ''
      if (MONEY_KEYS.has(f.key) && v !== '' && !isNaN(Number(v))) {
        cell.value = Number(v)
        cell.numFmt = '"S$"#,##0.00'
      } else if (f.kind === 'money_or_yes_no' && v !== '' && !isNaN(Number(v))) {
        cell.value = Number(v)
        cell.numFmt = '"S$"#,##0.00'
      } else {
        cell.value = v
      }
      if (!v) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFDECEC' } }
    })
  })
  ws.getColumn(1).width = 30
  cols.forEach((_, i) => { ws.getColumn(2 + i).width = 26 })

  const src = wb.addWorksheet('Sources')
  src.addRow(['Column', 'File', 'Field', 'Value', 'Page found on', 'Changed by hand'])
  src.getRow(1).font = { bold: true }
  cols.forEach((c, i) => FIELDS.forEach((f) => src.addRow([
    c.insurer || `PI ${i + 1}`, c.fileName, f.label, c.values[f.key] ?? '',
    c.pages[f.key] ?? '', c.edited[f.key] ? 'Yes' : '',
  ])))
  src.columns.forEach((col) => { col.width = 24 })

  const buf = await wb.xlsx.writeBuffer()
  return new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
}
