// Checks the PI issue date rules (web/src/lib/piIssueDate.ts) on the real Singapore sample PIs and on reworded lines.
// Usage: node tests/pi-extract/check-issue-date.mjs [folder with the sample PIs]
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pdfjs = await import(path.join(here, '../../web/node_modules/pdfjs-dist/legacy/build/pdf.mjs'))
const { readWith } = await import(path.join(here, '../../web/src/lib/piExtract.ts'))
const { findIssueDate, issueDateHeading, showDate } = await import(path.join(here, '../../web/src/lib/piIssueDate.ts'))

let pass = 0, fail = 0
const check = (what, got, want) => { if (got === want) pass++; else { fail++; console.log(`✗ ${what}: got "${got}", expected "${want}"`) } }

const dir = process.argv[2]
const SAMPLES = {
  'SG_HSBC_TermProtectSecure.pdf': '10/11/2026',
  'SG_Singlife_EliteTermII_2024.pdf': '18/12/2024',
  'SG_TokioMarine-CIMB_TermProtectPlus_2022.pdf': '17/03/2023',
  'SG_FWD_FutureFirst.pdf': '',
}
if (dir) for (const [f, want] of Object.entries(SAMPLES)) {
  if (!fs.existsSync(path.join(dir, f))) { console.log(`(skipped ${f}: not in ${dir})`); continue }
  const data = fs.readFileSync(path.join(dir, f))
  const pages = await readWith(pdfjs, data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength))
  const got = findIssueDate(pages)
  check(f, got?.value ?? '', want)
  console.log(`${got?.value === want || (!got && !want) ? '✓' : ' '} ${f}: ${got ? `${got.value} [p${got.page}] "${got.line.slice(0, 60)}"` : '(none)'}`)
}

const one = (text) => findIssueDate([{ page: 1, lines: [{ page: 1, text }] }])?.value ?? ''
const VARIANTS = [
  ['Date of Illustration : 5 March 2026', '05/03/2026'],
  ['Illustration Date: 05-03-2026', '05/03/2026'],
  ['Prepared on November 10, 2026', '10/11/2026'],
  ['Quotation Date 1st Jan 2026', '01/01/2026'],
  ['Date Printed: 10.11.2026', '10/11/2026'],
  ['Date of Birth : 24/08/1980', ''],
  ['Policy Effective Date: 01/12/2026', ''],
  ['Age : 46 (As At 10/11/2026)', ''],
  ['Date: 31/02/2026', ''],
  ['10 November 2026', '10/11/2026'],
]
for (const [line, want] of VARIANTS) check(line, one(line), want)

check('heading same', issueDateHeading(['10/11/2026', '10/11/2026']).text, 'PI issue date: 10 Nov 2026')
check('heading differ', issueDateHeading(['10/11/2026', '', '18/12/2024']).text, 'PI issue dates: PI1 10 Nov 2026 · PI2 not shown · PI3 18 Dec 2024')
check('heading none', issueDateHeading(['', ''], '12/11/2026').text, 'PI issue date: 12 Nov 2026 (date of comparison)')
check('heading one missing note', issueDateHeading(['10/11/2026', '']).note, 'No issue date was found in PI2.')
check('showDate', showDate('01/01/2026'), '1 Jan 2026')

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
