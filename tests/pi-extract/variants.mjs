// Rewords the labels in real PIs the way other insurers write them, then checks the reading still gives the expected
// values. Catches rules that only work for one insurer's wording.
// Usage: node tests/pi-extract/variants.mjs <folder with PDFs> <expected.json>
// Needs `npm ci` in web/ first. Node 22.18+.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pdfjs = await import(path.join(here, '../../web/node_modules/pdfjs-dist/legacy/build/pdf.mjs'))
const { extract, readWith, FIELDS } = await import(path.join(here, '../../web/src/lib/piExtract.ts'))

const [dir, expectedPath] = process.argv.slice(2)
if (!dir || !expectedPath) { console.error('Usage: node tests/pi-extract/variants.mjs <folder> <expected.json>'); process.exit(2) }
const expected = JSON.parse(fs.readFileSync(expectedPath, 'utf8'))

// Each variant: a name and [find, replace] pairs applied to every line of text. Only labels change, never values.
const VARIANTS = [
  ['name: Name of Life Assured', [[/^Life Assured Name(\s*):/, 'Name of Life Assured$1:'], [/^Life Assured(\s+):/, 'Name of Life Assured$1:']]],
  ['name: Life Insured', [[/^Life Assured(?: Name)?(\s*):/, 'Life Insured$1:']]],
  ['name: Insured Person', [[/^Life Assured(?: Name)?(\s*):/, 'Insured Person$1:'], [/^Person insured\b/, 'Life assured']]],
  ['name: Proposed Life Assured', [[/^Life Assured(?: Name)?(\s*):/, 'Proposed Life Assured$1:']]],
  ['gender/smoker: Sex / Smoker', [[/^Gender \/ Smoker Status(\s*):/, 'Sex / Smoker$1:'], [/^Gender(\s+):/, 'Sex$1:'], [/^Smoking Status(\s*):/, 'Smoker Status$1:']]],
  ['gender/smoker: short values', [[/: Male\/Non-Smoker/, ': M / NS'], [/: Female\/Non-Smoker/, ': F / NS']]],
  ['smoker: Tobacco Use', [[/^Smoking Status(\s*):/, 'Tobacco Use$1:'], [/^Smoker Status(\s*):/, 'Tobacco Use$1:']]],
  ['residency: Country of Residence', [[/^Residency \/ Nationality(\s*):/, 'Country of Residence$1:'], [/^Residency(\s*):/, 'Country of Residence$1:'], [/^Residential Status(\s*):/, 'Country of Residence$1:']]],
  ['dob: D.O.B.', [[/^Date of Birth(\s*):/, 'D.O.B.$1:']]],
  ['payment mode: Mode of Payment', [[/^Payment Mode(\s*):/, 'Mode of Payment$1:'], [/^Premium (?:Payment )?(?:Mode|Frequency)(\s*):/, 'Mode of Payment$1:']]],
  ['terms: Premium Payment Term / Coverage Term', [[/^(\s*)Premium Term(\s{2,})/, '$1Premium Payment Term$2'], [/^(\s*)Policy Term(\s{2,})/, '$1Coverage Term$2']]],
  ['sum assured: Sum Insured', [[/\bSum Assured(\s*(?:\([^)]*\))?\s*):/, 'Sum Insured$1:']]],
]

const files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.pdf') && expected[f]).sort()
const loaded = []
for (const f of files) {
  const data = fs.readFileSync(path.join(dir, f))
  loaded.push([f, await readWith(pdfjs, data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength))])
}
let pass = 0, fail = 0, applied = 0
for (const [vname, pairs] of VARIANTS) {
  for (const [f, pages] of loaded) {
    let changed = 0
    const copy = pages.map((p) => ({ ...p, lines: p.lines.map((l) => {
      let t = l.text
      for (const [re, to] of pairs) t = t.replace(re, to)
      if (t !== l.text) changed++
      return { ...l, text: t }
    }) }))
    if (!changed) continue // this PI doesn't use that label
    applied++
    const r = extract(copy, f)
    const bad = FIELDS.filter((fd) => expected[f][fd.key] !== undefined && r.found[fd.key].value !== expected[f][fd.key])
    if (bad.length) { fail++; console.log(`✗ ${vname} on ${f}: ${bad.map((fd) => `${fd.label} "${r.found[fd.key].value}" (expected "${expected[f][fd.key]}")`).join('; ')}`) }
    else { pass++; console.log(`✓ ${vname} on ${f} (${changed} lines reworded)`) }
  }
}
console.log(`\n${pass} passed, ${fail} failed (${applied} rewordings applied)`)
process.exit(fail ? 1 : 0)
