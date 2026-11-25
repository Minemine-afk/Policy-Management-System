// Checks the Knowledge Bank document reader (web/src/lib/kbExtract.ts) on the made-up documents from
// make-samples.mjs: every record field, fact and rate it should find, and nothing wrong.
// Usage: node tests/kb-extract/check.mjs   (Node 22.18+, needs `npm ci` in web/)
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
const here = path.dirname(fileURLToPath(import.meta.url))
const web = path.join(here, '../../web')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-samples-'))
execFileSync(process.execPath, [path.join(here, 'make-samples.mjs'), dir], { stdio: 'inherit' })
const { SUMMARY, rateAt } = await import('./make-samples-data.mjs')
const pdfjs = await import(path.join(web, 'node_modules/pdfjs-dist/legacy/build/pdf.mjs'))
const ExcelJS = (await import(path.join(web, 'node_modules/exceljs/dist/es5/index.js'))).default
const { readWith } = await import(path.join(web, 'src/lib/piExtract.ts'))
const { readSummary, readRates, readExcel, readCsv } = await import(path.join(web, 'src/lib/kbExtract.ts'))

let bad = 0, ok = 0
const check = (cond, what) => { if (cond) ok++; else { bad++; console.log('  WRONG:', what) } }
const load = async (f) => {
  const data = fs.readFileSync(path.join(dir, f))
  if (f.endsWith('.pdf')) return { pages: await readWith(pdfjs, data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)), rows: [], kind: 'pdf' }
  if (f.endsWith('.csv')) return readCsv(data.toString('utf8'))
  return readExcel(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength), ExcelJS)
}

const FACT_KEY = { 'Underwriting': 'uw', 'Premium term': 'premTerm', 'Premium rates': 'guaranteed', 'Payment modes': 'modes', 'Policy term': 'coverTo',
  'Death benefit': 'death', 'Terminal illness': 'ti', 'Total and permanent disability': 'tpd', 'Critical illness': 'ci', 'Early critical illness': 'eci',
  'Accidental death': 'ad', 'Conversion option': 'conversion', 'Renewal': 'renew', 'Cash value': 'cash', 'Distribution cost': 'dist',
  'Free-look period': 'freelook', 'Grace period': 'grace', 'Reinstatement': 'reinstate', 'Exclusions': 'excl', 'Important considerations': 'consider' }

for (const f of ['Orchard_TermShield_Product_Summary.pdf', 'Orchard_TermShield_Product_Summary.xlsx']) {
  console.log(f)
  const s = readSummary(await load(f))
  const r = s.record
  check(r.name === 'Orchard TermShield', `name ${r.name}`)
  check(r.insurer === 'Marina Life Assurance', `insurer ${r.insurer}`)
  // A term plan whose conversion option names a whole life plan is still a term plan (it must stay searchable).
  check(s.kind === '', `kind "${s.kind}" (a term plan)`)
  check(r.entry_age_min === 18 && r.entry_age_max === 60, `entry age ${r.entry_age_min}-${r.entry_age_max}`)
  check(r.sa_min === 100000 && r.sa_max === 5000000, `sum assured ${r.sa_min}-${r.sa_max}`)
  check(JSON.stringify(r.currencies) === '["SGD","USD"]', `currencies ${r.currencies}`)
  check(JSON.stringify(r.residency) === '["Singapore citizen","Singapore PR","Foreigner living in Singapore"]', `residency ${r.residency}`)
  check(r.has_tpd === true && r.has_ci === true, `tpd ${r.has_tpd} ci ${r.has_ci}`)
  let page = 1
  for (const row of SUMMARY) {
    if (row === '--page--') { page = 2; continue }
    const k = FACT_KEY[row[0]]
    if (!k) continue
    check(s.facts[k]?.v === row[1], `${k}: "${s.facts[k]?.v}" (want "${row[1]}")`)
    if (f.endsWith('.pdf')) check(s.facts[k]?.page === page, `${k} page ${s.facts[k]?.page} (want ${page})`)
  }
  const extra = Object.keys(s.facts).filter((k) => !Object.values(FACT_KEY).includes(k))
  check(!extra.length, `facts not in the document: ${extra}`)
}

for (const [f, ci] of [['Orchard_TermShield_Rates.xlsx', true], ['Orchard_TermShield_Rates.pdf', false], ['Orchard_TermShield_Rates.csv', true]]) {
  console.log(f)
  const res = readRates(await load(f))
  check(!res.error, res.error)
  check(res.rates.length === 43 * 4, `${res.rates.length} rates (want ${43 * 4})`)
  let wrong = 0
  for (const x of res.rates) {
    const r = rateAt(x.age)
    const k = (x.gender === 'Male' ? 'm' : 'f') + (x.smoker ? 's' : 'n')
    if (Math.abs(x.rate - r[k]) > 0.0001) wrong++
    if (ci ? Math.abs((x.ci_rate ?? -1) - r[`c${k}`]) > 0.0001 : x.ci_rate != null) wrong++
  }
  check(!wrong, `${wrong} wrong rate values`)
  if (f.endsWith('.pdf')) check(res.notes.some((n) => /100,000/.test(n)), 'says it converted per 100,000 to per 1,000')
}
fs.rmSync(dir, { recursive: true, force: true })
console.log(`${ok} right, ${bad} wrong`)
process.exit(bad ? 1 : 0)
