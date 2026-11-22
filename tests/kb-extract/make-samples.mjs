// Makes made-up Knowledge Bank documents for testing the reader: a two-page Product Summary (PDF and Excel),
// and rate sheets in three shapes (Excel grid with merged headings, PDF grid per S$100,000, CSV list).
// Usage: node tests/kb-extract/make-samples.mjs <out folder>
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const here = path.dirname(fileURLToPath(import.meta.url))
const web = path.join(here, '../../web/node_modules')
const { PDFDocument, StandardFonts, rgb } = await import(path.join(web, '@cantoo/pdf-lib/cjs/index.js')).then((m) => m.default ?? m)
const ExcelJS = (await import(path.join(web, 'exceljs/dist/es5/index.js'))).default
const out = process.argv[2] ?? path.join(here, 'samples')
fs.mkdirSync(out, { recursive: true })

import { SUMMARY, rateAt } from './make-samples-data.mjs'
const AGES = Array.from({ length: 43 }, (_, i) => 18 + i)
async function pdf(pagesOfLines, name) {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const bold = await doc.embedFont(StandardFonts.HelveticaBold)
  for (const lines of pagesOfLines) {
    const page = doc.addPage([595, 842])
    let y = 800
    for (const l of lines) {
      if (typeof l === 'string') { page.drawText(l, { x: 50, y, size: 14, font: bold, color: rgb(0, 0, 0) }); y -= 22; continue }
      l.forEach((cell, i) => page.drawText(String(cell), { x: l.xs ? l.xs[i] : 50 + i * 180, y, size: 9, font: i ? font : bold }))
      y -= 15
      if (y < 50) throw new Error('page full')
    }
  }
  fs.writeFileSync(path.join(out, name), await doc.save())
}

// Product Summary PDF
const pages = [['Product Summary', 'Orchard TermShield']]
for (const r of SUMMARY) { if (r === '--page--') pages.push(['Product Summary (continued)']); else pages[pages.length - 1].push(r) }
await pdf(pages, 'Orchard_TermShield_Product_Summary.pdf')

// Product Summary Excel (label | value)
{
  const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('Summary')
  ws.addRow(['Product Summary']); ws.addRow([])
  for (const r of SUMMARY) if (r !== '--page--') ws.addRow(r)
  await wb.xlsx.writeFile(path.join(out, 'Orchard_TermShield_Product_Summary.xlsx'))
}

// Rate sheet Excel: two heading rows with merged cells
{
  const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('Rates')
  ws.addRow(['Orchard TermShield annual premium rates per S$1,000 sum assured, cover to age 65'])
  ws.addRow([])
  ws.addRow(['Age next birthday', 'Male', '', 'Female', '', 'CI rider Male', '', 'CI rider Female', ''])
  ws.addRow(['', 'Non-Smoker', 'Smoker', 'Non-Smoker', 'Smoker', 'Non-Smoker', 'Smoker', 'Non-Smoker', 'Smoker'])
  for (const c of ['B3:C3', 'D3:E3', 'F3:G3', 'H3:I3']) ws.mergeCells(c)
  for (const a of AGES) { const r = rateAt(a); ws.addRow([a, r.mn, r.ms, r.fn, r.fs, r.cmn, r.cms, r.cfn, r.cfs]) }
  await wb.xlsx.writeFile(path.join(out, 'Orchard_TermShield_Rates.xlsx'))
}

// Rate sheet PDF: per S$100,000, two heading rows (Male / Female over NS / S), no CI
{
  const xs = [50, 140, 230, 320, 410]
  const head = [['Age', 'Male', 'Female'], ['', 'Non-Smoker', 'Smoker', 'Non-Smoker', 'Smoker']]
  const rows = AGES.map((a) => { const r = rateAt(a); return [a, r.mn * 100, r.ms * 100, r.fn * 100, r.fs * 100].map((x, i) => (i ? x.toFixed(2) : x)) })
  const pageRows = (rs) => [...rs.map((r) => Object.assign(r, { xs }))]
  const h1 = Object.assign(head[0], { xs: [50, 185, 365] }), h2 = Object.assign(head[1].slice(1), { xs: xs.slice(1) })
  await pdf([['Orchard TermShield rate sheet', ['Annual premium per S$100,000 sum assured, cover to age 65'], h1, h2, ...pageRows(rows)]], 'Orchard_TermShield_Rates.pdf')
}

// Rate sheet CSV list
{
  const lines = ['Age,Gender,Smoker status,Annual rate,CI rate']
  for (const a of AGES) { const r = rateAt(a); lines.push(`${a},Male,Non-smoker,${r.mn},${r.cmn}`, `${a},Male,Smoker,${r.ms},${r.cms}`, `${a},Female,Non-smoker,${r.fn},${r.cfn}`, `${a},Female,Smoker,${r.fs},${r.cfs}`) }
  fs.writeFileSync(path.join(out, 'Orchard_TermShield_Rates.csv'), lines.join('\n'))
}
console.log('made samples in', out)
