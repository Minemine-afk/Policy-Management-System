// Builds the comparison Excel template (public/templates/pi-comparison-template.xlsx) in the layout of Kumar's
// "Term Quotation Comparison Excel" spec. Run it again after changing it: node web/scripts/make-template.mjs
// The template can also be restyled by hand in Excel, as long as the labels in column A and the PI1/PI2/PI3
// placeholders on the "Insurer" row stay (money rows are matched without their "(SGD)" part).
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ExcelJS from 'exceljs'

const web = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const NAVY = 'FF0B1F4D', CREAM = 'FFFFF2CC'
const wb = new ExcelJS.Workbook()
const ws = wb.addWorksheet('PI comparison', { views: [{ showGridLines: false }] })
ws.columns = [{ width: 30 }, { width: 22 }, { width: 22 }, { width: 22 }]
const thin = { style: 'thin', color: { argb: 'FF7F7F7F' } }
const box = { top: thin, left: thin, bottom: thin, right: thin }
const fill = (argb) => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } })

let r = 1
for (const label of ['Insured Name:', 'Date of Birth:', 'Gender:', 'Residency:', 'Underwriting Class:']) ws.getCell(r++, 1).value = label
r++
const band = (text = '', centred = false) => {
  for (let c = 1; c <= 4; c++) ws.getCell(r, c).fill = fill(NAVY)
  if (text) { const cell = ws.getCell(r, centred ? 2 : 1); cell.value = text; cell.font = { bold: true, color: { argb: 'FFFFFFFF' } }; if (centred) cell.alignment = { horizontal: 'center' } }
  r++
}
band('PLAN TYPE: TERM PLAN')
r++
for (const label of ['Sum Assured:', 'Policy Term:']) {
  for (let c = 1; c <= 4; c++) ws.getCell(r, c).fill = fill(CREAM)
  ws.getCell(r, 1).value = label; ws.getCell(r, 1).font = { bold: true, color: { argb: NAVY } }
  r++
}
r++
const row = (label, values = [null, null, null]) => {
  ws.getCell(r, 1).value = label
  values.forEach((v, i) => { ws.getCell(r, i + 2).value = v })
  for (let c = 1; c <= 4; c++) { const cell = ws.getCell(r, c); cell.border = box; if (c > 1) cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true } }
  r++
}
row('Insurer', ['PI1', 'PI2', 'PI3'])
for (const l of ['Policy Name', 'Policy Term (Years)', 'Premium Term (Years)', 'Annual Premium (SGD)', 'Total Premium (SGD)']) row(l)
band()
for (const l of ['Death', 'Terminal Illness', 'Accidental Death', 'Premium (SGD)']) row(l)
band('Riders', true)
for (const l of ['Total & Permanent Disability', 'TPD Premium (SGD)', 'Critical Illness', 'CI Premium (SGD)']) row(l)
band()
r++
for (const l of ['Cash Value', 'Campaigns']) row(l)

await wb.xlsx.writeFile(path.join(web, 'public/templates/pi-comparison-template.xlsx'))
console.log('Template written to public/templates/pi-comparison-template.xlsx')
