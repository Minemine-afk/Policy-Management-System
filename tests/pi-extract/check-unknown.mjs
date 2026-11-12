// Measures how the reader does on PI layouts it has no rules for: for each field, right, left blank, or WRONG.
// Wrong values are the ones that matter most: a blank cell is shaded for ops, a wrong one can slip through.
// Usage: node tests/pi-extract/check-unknown.mjs <folder with PDFs> <expected.json> [--general-only] [--max-wrong N]
//   --general-only  uses only the general rules (piGeneric.ts), as if no layout rules matched: how the reader
//                   would do on a brand new layout. Run it on expected-sg-samples.json for a held-out test.
// Needs `npm ci` in web/ first. Node 22.18+.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pdfjs = await import(path.join(here, '../../web/node_modules/pdfjs-dist/legacy/build/pdf.mjs'))
const { extract, readWith, FIELDS } = await import(path.join(here, '../../web/src/lib/piExtract.ts'))
const { extractGeneric } = await import(path.join(here, '../../web/src/lib/piGeneric.ts'))

const args = process.argv.slice(2)
const [dir, expectedPath] = args.filter((a) => !a.startsWith('--') && !/^\d+$/.test(a))
const generalOnly = args.includes('--general-only')
const maxWrong = args.includes('--max-wrong') ? +args[args.indexOf('--max-wrong') + 1] : null
if (!dir || !expectedPath) { console.error('Usage: node tests/pi-extract/check-unknown.mjs <folder> <expected.json> [--general-only] [--max-wrong N]'); process.exit(2) }
const expected = JSON.parse(fs.readFileSync(expectedPath, 'utf8'))

const same = (got, want) => {
  if (want.startsWith('NOT:')) return got !== want.slice(4)
  if (want.startsWith('~')) return !!got && got.toLowerCase().includes(want.slice(1).toLowerCase())
  return got === want
}
let right = 0, blank = 0, wrong = 0
for (const f of Object.keys(expected).filter((k) => !k.startsWith('_')).sort()) {
  const file = path.join(dir, f)
  if (!fs.existsSync(file)) { console.log(`- ${f}: not in ${dir}, skipped`); continue }
  const data = fs.readFileSync(file)
  const pages = await readWith(pdfjs, data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength))
  const found = generalOnly ? extractGeneric(pages).found : extract(pages, f).found
  const out = []
  let r = 0, b = 0, w = 0
  for (const fd of FIELDS) {
    const want = expected[f][fd.key]
    if (want === undefined) continue
    const got = found[fd.key]?.value ?? ''
    // A field the PI states but the reader left blank is "blank"; "" expected and blank given is right.
    if (same(got, want)) r++
    else if (!got) { b++; out.push(`    · ${fd.label}: blank (PI says ${want.replace(/^~/, '')})`) }
    else { w++; out.push(`    ✗ ${fd.label}: "${got}" but PI says ${want.replace(/^NOT:/, 'anything but ').replace(/^~/, '')}`) }
  }
  right += r; blank += b; wrong += w
  console.log(`${f}: ${r} right, ${b} blank, ${w} wrong`)
  for (const o of out) console.log(o)
}
const total = right + blank + wrong
console.log(`\n${generalOnly ? 'General rules only' : 'Full reader'}: ${right}/${total} right (${Math.round((100 * right) / total)}%), ${blank} blank, ${wrong} wrong`)
if (maxWrong !== null && wrong > maxWrong) { console.log(`More than ${maxWrong} wrong`); process.exit(1) }
