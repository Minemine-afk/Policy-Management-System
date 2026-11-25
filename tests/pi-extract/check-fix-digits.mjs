// OCR clean-up of amounts (web/src/lib/paddleOcr.ts fixDigits): "S$" read as "$$" on rough scans, letters for digits.
// Usage: node tests/pi-extract/check-fix-digits.mjs
import path from 'node:path'; import { fileURLToPath } from 'node:url'
const here = path.dirname(fileURLToPath(import.meta.url))
const { fixDigits } = await import(path.join(here, '../../web/src/lib/paddleOcr.ts'))
const cases = [['$$2,000,000', 'S$2,000,000'], ['5$10,884.00', 'S$10,884.00'], ['Total s$10,955.80', 'Total S$10,955.80'], ['S$71.80', 'S$71.80'],
  ['$500', '$500'], ['US$5', 'US$5'], ['$$', '$$'], ['S$5,oo0', 'S$5,000'], ['Plan 5', 'Plan 5']]
let fail = 0
for (const [i, want] of cases) { const got = fixDigits(i); if (got !== want) { fail++; console.log(`✗ ${i} -> ${got}, want ${want}`) } }
console.log(`${cases.length - fail} passed, ${fail} failed`); process.exit(fail ? 1 : 0)
