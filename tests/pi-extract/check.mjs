// Checks the Compare PIs reading rules against real PI PDFs, outside the browser.
// Usage: node tests/pi-extract/check.mjs <folder with PDFs> [expected.json]
// expected.json maps file name -> { field key: expected value }. "" means the field must be left blank.
// Needs `npm ci` in web/ first. Node 22.18+ (runs the TypeScript rules file directly).
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pdfjs = await import(path.join(here, '../../web/node_modules/pdfjs-dist/legacy/build/pdf.mjs'))
const { extract, readWith, FIELDS } = await import(path.join(here, '../../web/src/lib/piExtract.ts'))

const [dir, expectedPath] = process.argv.slice(2)
if (!dir) { console.error('Usage: node tests/pi-extract/check.mjs <folder> [expected.json]'); process.exit(2) }
const expected = expectedPath ? JSON.parse(fs.readFileSync(expectedPath, 'utf8')) : {}
const files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.pdf')).sort()
let pass = 0, fail = 0
for (const f of files) {
  const data = fs.readFileSync(path.join(dir, f))
  const pages = await readWith(pdfjs, data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength))
  const r = extract(pages, f)
  console.log(`\n${f}`)
  for (const fd of FIELDS) {
    const got = r.found[fd.key].value
    const want = expected[f]?.[fd.key]
    let mark = ' '
    if (want !== undefined) { if (want === got) { mark = '✓'; pass++ } else { mark = '✗'; fail++ } }
    console.log(`  ${mark} ${fd.label.padEnd(30)} ${got || '(blank)'}${mark === '✗' ? `   expected ${want || '(blank)'}` : ''}${got ? `   [p${r.found[fd.key].page}]` : ''}`)
  }
  for (const n of r.notes) console.log(`    note: ${n}`)
  if (expected[f]?.discounted !== undefined) {
    if (expected[f].discounted === r.discounted) pass++; else { fail++; console.log(`  ✗ discounted flag ${r.discounted}, expected ${expected[f].discounted}`) }
  }
}
if (expectedPath) { console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0) }
