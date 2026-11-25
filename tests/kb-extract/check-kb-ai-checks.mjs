// Checks the Knowledge Bank AI helper's safety checks (web/src/lib/kbAi.ts) without a model: made-up model answers,
// right and wrong, against real and made-up Product Summaries. Every wrong answer must be dropped; right ones kept.
// Usage: node tests/kb-extract/check-kb-ai-checks.mjs [folder with the real PDFs]   (needs `npm ci` in web/)
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const here = path.dirname(fileURLToPath(import.meta.url))
const web = path.join(here, '../../web')
const dir = process.argv[2] ?? '/mnt/project-files/product-matrix/kb-real-summaries'
const pdfjs = await import(path.join(web, 'node_modules/pdfjs-dist/legacy/build/pdf.mjs'))
const { readWith } = await import(path.join(web, 'src/lib/piExtract.ts'))
const kb = await import(path.join(web, 'src/lib/kbExtract.ts'))
const ai = await import(path.join(web, 'src/lib/kbAi.ts'))
const { VARIANTS } = await import('./kb-ai-variants.mjs')

let bad = 0, ok = 0
const check = (cond, what) => { if (cond) ok++; else { bad++; console.log('  WRONG:', what) } }
const textDoc = (text) => ({ pages: [{ page: 1, items: [], lines: text.trim().split('\n').map((t) => ({ page: 1, text: t.trim() })) }], rows: [], kind: 'excel' })
/** Runs the checks on one made-up answer for one question kind. */
const run = (doc, kind, keys, answer) => {
  const s = kb.readSummary(doc)
  const q = { kind, keys, messages: [], maxTokens: 0 }
  return ai.checkKbAnswers(doc, [q], [answer], { ...s, facts: {} })
}

const v = textDoc(VARIANTS['variant-entry-age-sentence'])
let f = run(v, 'record', ['entry_age'], { entry_age: { min: 19, max: 64, quote: 'The life assured must be between 19 and 64 years old (age next birthday) when the policy starts.' } })
check(f.record.entry_age_min === 19 && f.record.entry_age_max === 64, 'entry ages from a plain sentence are kept')
f = run(v, 'record', ['entry_age'], { entry_age: { min: 18, max: 65, quote: 'The life assured must be between 19 and 64 years old (age next birthday) when the policy starts.' } })
check(f.record.entry_age_min == null, 'entry ages not written in the quote are dropped')
f = run(v, 'record', ['entry_age'], { entry_age: { min: 19, max: 64, quote: 'The life assured must be between 19 and 64 years old when the plan begins.' } })
check(f.record.entry_age_min == null, 'a quote that is not in the document (reworded) is dropped')
f = run(v, 'record', ['entry_age'], { entry_age: { min: 65, max: 99, quote: 'You may choose to be covered until age 65, 75 or 99.' } })
check(f.record.entry_age_min == null, 'cover-end ages are not taken as entry ages')
f = run(v, 'record', ['sum_assured'], { sum_assured: { min: 50000, max: 3000000, quote: 'The smallest sum assured we accept is S$50,000 and the largest is S$3,000,000.' } })
check(f.record.sa_min == null, 'a sum assured sentence without min/max words is dropped (blank is safer)')
f = run(v, 'record', ['currencies'], { currencies: { list: ['SGD', 'USD'], quote: 'This plan is offered in Singapore Dollars (SGD) and US Dollars (USD) only.' } })
check(f.record.currencies == null, 'a currency quote must use the word currency or denominated')
f = run(v, 'record', ['residency'], { residency: { quote: 'Singapore Citizens, Singapore Permanent Residents and Employment Pass holders residing in Singapore may apply.' } })
check(JSON.stringify(f.record.residency) === '["Singapore citizen","Singapore PR","Foreigner living in Singapore"]', `who can apply: ${f.record.residency}`)
f = run(v, 'facts', ['grace', 'freelook', 'modes', 'reinstate'], {
  grace: 'We allow 30 days after each premium due date for you to pay the premium before the policy lapses.',
  freelook: 'If you change your mind, you may return the policy within 14 days of receiving it for a refund of premiums paid.',
  modes: 'Premiums can be paid on a monthly, quarterly, half-yearly or annual basis.',
  reinstate: 'A lapsed policy may be restored within 2 years of lapse, subject to evidence of good health and payment of all arrears.',
})
check(!f.facts.grace, 'a grace quote must say "grace period"')
check(!f.facts.freelook, 'a free-look quote must say free-look or cancel')
check(f.facts.modes?.v.startsWith('Premiums can be paid on a monthly'), `modes kept: ${f.facts.modes?.v}`)
check(f.facts.reinstate?.v.startsWith('A lapsed policy may be restored'), `reinstatement kept: ${f.facts.reinstate?.v}`)
const both = 'Harbour SecureTerm is a non-participating term insurance plan that pays a lump sum on death or terminal illness.'
f = run(v, 'facts', ['death', 'ti'], { death: both, ti: both })
check(!f.facts.death && !f.facts.ti, 'one quote given for two facts: both dropped')
f = run(v, 'facts', ['guaranteed'], { guaranteed: 'The premium rates are not guaranteed and may be revised by us at the end of each policy year.' })
check(f.facts.guaranteed, 'premium rates (not guaranteed) kept')
f = run(v, 'facts', ['coverTo'], { coverTo: 'You may choose to be covered until age 65, 75 or 99.' })
check(!f.facts.coverTo, 'cover-to quote without policy-term words is dropped (blank is safer)')

const n = textDoc(VARIANTS['variant-no-entry-age'])
f = run(n, 'record', ['entry_age'], { entry_age: { min: 75, max: 85, quote: 'The maximum renewal age is 75 and coverage ends at age 85.' } })
check(f.record.entry_age_min == null, 'renewal / cover-end ages are not entry ages')
f = run(n, 'record', ['entry_age'], { entry_age: { min: 10, max: 30, quote: 'The plan covers the life assured until the end of the chosen policy term of 10, 20 or 30 years.' } })
check(f.record.entry_age_min == null, 'policy terms are not entry ages')
f = run(n, 'facts', ['coverTo'], { coverTo: 'The plan covers the life assured until the end of the chosen policy term of 10, 20 or 30 years.' })
check(f.facts.coverTo, 'cover-to with policy term words kept')
f = run(n, 'facts', ['uw'], { uw: 'with no medical checks' })
check(!f.facts.uw, 'a fragment is read with its whole sentence: "no medical checks" on renewing is not underwriting')
const o = textDoc('Orchard TermShield\nGrace period  30 days\nFree-look period  14 days')
f = run(o, 'facts', ['grace', 'freelook'], { grace: '30 days', freelook: '30 days' })
check(f.facts.grace?.v === '30 days' && !f.facts.freelook, 'a short answer must be a table cell next to the right label')
const t = textDoc('Orchard TermShield\nConversion option  Convert to a whole life plan before age 60 without medical evidence\nRenewal  Not renewable\nCash value  None')
f = run(t, 'facts', ['conversion'], { conversion: 'Conversion option Convert to a whole life plan before age 60 without medical evidence Renewal Not renewable' })
check(!f.facts.conversion, 'a quote running across table rows (several facts) is dropped')
f = run(t, 'facts', ['conversion'], { conversion: 'Convert to a whole life plan before age 60 without medical evidence' })
check(f.facts.conversion?.v === 'Convert to a whole life plan before age 60 without medical evidence', `one table cell is kept: ${f.facts.conversion?.v}`)
f = run(t, 'facts', ['conversion'], { conversion: 'Convert to a whole life plan before age 60' })
check(f.facts.conversion?.v === 'Convert to a whole life plan before age 60 without medical evidence', `part of a cell gives the whole cell, not the rows after it: ${f.facts.conversion?.v}`)

for (const file of ['FWD_Future_First_Term_Product_Summary.pdf', 'Singlife_Elite_Term_II_Product_Summary.pdf']) {
  if (!fs.existsSync(path.join(dir, file))) { console.log(`(skipped ${file})`); continue }
  const d = fs.readFileSync(path.join(dir, file))
  const doc = { pages: await readWith(pdfjs, d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength)), rows: [], kind: 'pdf' }
  const s = kb.readSummary(doc)
  const blank = ai.blankOf(s)
  check(blank.record.includes('entry_age'), `${file}: entry ages are blank after the rules`)
  if (file.startsWith('FWD')) {
    f = ai.checkKbAnswers(doc, [{ kind: 'record', keys: ['sum_assured'], messages: [], maxTokens: 0 }], [{ sum_assured: { min: 250000, max: null, quote: 'with a sum insured of S$250,000, paid if the spouse dies; and' } }], s)
    check(f.record.sa_min == null, 'FWD: the spouse benefit is not the sum assured limit')
    f = ai.checkKbAnswers(doc, [{ kind: 'record', keys: ['entry_age'], messages: [], maxTokens: 0 }], [{ entry_age: { min: 0, max: 100, quote: 'until (i) the person insured reaches age 100; or' } }], s)
    check(f.record.entry_age_min == null, 'FWD: renewal to age 100 is not an entry age')
    f = ai.checkKbAnswers(doc, [{ kind: 'facts', keys: ['reinstate'], messages: [], maxTokens: 0 }], [{ reinstate: 'within one year of the start of your policy cover, or the date we last reinstate (restart) your policy.' }], s)
    check(!f.facts.reinstate, 'FWD: an exclusion that mentions reinstating is not the reinstatement fact')
  } else {
    f = ai.checkKbAnswers(doc, [{ kind: 'record', keys: ['entry_age'], messages: [], maxTokens: 0 }], [{ entry_age: { min: 85, max: 99, quote: '11 years up to Age 85, at every one-year interval, or to Age 99.' } }], s)
    check(f.record.entry_age_min == null, 'Singlife: cover-end ages are not entry ages')
  }
  // A quote made up by the model (not in the document) is always dropped.
  f = ai.checkKbAnswers(doc, [{ kind: 'facts', keys: ['grace'], messages: [], maxTokens: 0 }], [{ grace: 'A grace period of 31 days is given to pay each premium.' }], s)
  check(!f.facts.grace, `${file}: a made-up quote is dropped`)
}
console.log(`${ok} right, ${bad} wrong`)
process.exit(bad ? 1 : 0)
