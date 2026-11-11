// Reads PI PDFs with the website's rules and fills the comparison Excel template with them, as "Export to Excel"
// does, then checks the layout of Kumar's "Term Quotation Comparison Excel" spec.
// Usage: node tests/pi-extract/check-excel.mjs <folder with up to 3 PDFs> <output.xlsx>
// Needs `npm ci` in web/ first. Node 22.18+.
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const web = path.join(here, '../../web')
const require = createRequire(path.join(web, 'package.json'))
const ExcelJS = require('exceljs')
const pdfjs = await import(path.join(web, 'node_modules/pdfjs-dist/legacy/build/pdf.mjs'))
const { extract, readWith, FIELDS } = await import(path.join(web, 'src/lib/piExtract.ts'))
const { buildWorkbook } = await import(path.join(web, 'src/lib/piExcel.ts'))

const [dir, out] = process.argv.slice(2)
if (!dir || !out) { console.error('Usage: node tests/pi-extract/check-excel.mjs <folder> <output.xlsx>'); process.exit(2) }
const files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.pdf')).sort().slice(0, 3)
const cols = []
for (const f of files) {
  const data = fs.readFileSync(path.join(dir, f))
  const r = extract(await readWith(pdfjs, data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)), f)
  cols.push({ fileName: f, values: Object.fromEntries(FIELDS.map((x) => [x.key, r.found[x.key].value])), notes: r.notes,
    edited: {}, pages: Object.fromEntries(FIELDS.map((x) => [x.key, r.found[x.key].page])) })
}
const tpl = fs.readFileSync(path.join(web, 'public/templates/pi-comparison-template.xlsx'))
const blob = await buildWorkbook(cols, tpl.buffer.slice(tpl.byteOffset, tpl.byteOffset + tpl.byteLength))
fs.writeFileSync(out, Buffer.from(await blob.arrayBuffer()))

// Print the sheet as it would show in Excel (values with their number formats, roughly).
const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(out)
const ws = wb.getWorksheet('PI comparison')
const show = (c) => {
  const v = c.value
  if (typeof v !== 'number') return v ?? ''
  const m = String(c.numFmt ?? '').match(/^"([^"]*)"(#,##0(?:\.00)?)$/)
  const n = v.toLocaleString('en-US', { minimumFractionDigits: /\.00/.test(c.numFmt ?? '') ? 2 : 0, maximumFractionDigits: 2 })
  return m ? m[1] + n : n
}
ws.eachRow({ includeEmpty: true }, (row, r) => console.log(String(r).padStart(2), [1, 2, 3, 4].map((c) => String(show(row.getCell(c))).slice(0, 44).padEnd(c === 1 ? 44 : 22)).join(' | ')))
console.log(`\nWritten to ${out}`)
