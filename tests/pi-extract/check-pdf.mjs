// Builds the PI pack (comparison page + the PIs, edit-restricted) from up to 3 PI PDFs, outside the browser.
// Usage: node tests/pi-extract/check-pdf.mjs out.pdf <PI1.pdf> [PI2.pdf] [PI3.pdf]
// Fills client particulars from a sample request form (Male, non-smoker, 45 to 49) when a PI lacks them.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pdfjs = await import(path.join(here, '../../web/node_modules/pdfjs-dist/legacy/build/pdf.mjs'))
const { extract, readWith, FIELDS } = await import(path.join(here, '../../web/src/lib/piExtract.ts'))
const { fillFromForm, isFromForm } = await import(path.join(here, '../../web/src/lib/formFill.ts'))
const { findIssueDate } = await import(path.join(here, '../../web/src/lib/piIssueDate.ts'))
const { buildPack, sha256 } = await import(path.join(here, '../../web/src/lib/piPdf.ts'))

const [out, ...files] = process.argv.slice(2)
if (!out || !files.length) { console.error('Usage: node tests/pi-extract/check-pdf.mjs out.pdf PI1.pdf [PI2.pdf] [PI3.pdf]'); process.exit(2) }
const form = { gender: process.env.FORM_GENDER ?? 'Male', smoker: process.env.FORM_SMOKER === 'yes', age_band: '45 to 49' }
const cols = [], pis = []
for (const f of files) {
  const data = fs.readFileSync(f)
  const ab = () => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
  const pages = await readWith(pdfjs, ab())
  const r = extract(pages, path.basename(f))
  const filled = fillFromForm(r.found, Object.fromEntries(FIELDS.map((x) => [x.key, r.found[x.key]?.value ?? ''])), form)
  cols.push({ fileName: path.basename(f), values: filled.values, notes: [...r.notes, ...filled.notes], edited: {}, pages: {},
    fromForm: Object.fromEntries(FIELDS.map((x) => [x.key, isFromForm(filled.found[x.key])])), issueDate: findIssueDate(pages)?.value ?? '' })
  pis.push({ name: path.basename(f), data: ab() })
}
const blob = await buildPack(cols.slice(0, 3), pis, 'PI-00099', new Date('2026-11-12T10:00:00'))
fs.writeFileSync(out, Buffer.from(await blob.arrayBuffer()))
console.log(`${out}: ${(blob.size / 1024).toFixed(0)} KB, sha256 ${await sha256(blob)}`)
for (const c of cols) console.log(`  ${c.fileName}: issue date ${c.issueDate || '(none)'}; from form: ${Object.keys(c.fromForm).filter((k) => c.fromForm[k]).join(', ') || 'nothing'}`)
