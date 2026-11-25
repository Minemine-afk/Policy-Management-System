// Checks the premium financing reader (web/src/lib/kbFinancing.ts) on 2 real bank documents: the CIMB Premium
// Financing Factsheet (key features, historical cost of funds by date) and iFAST Global Bank's monthly cost-of-funds
// sheet (spread tiers, COF by currency and tenor for one month, policy cash drawdown rates). The PDFs are kept in the
// project files (product-matrix/kb-real-summaries/), not in git. Every value must be right; a value the rules can't
// place must stay blank (0 wrong).
// With --ai, also runs the free AI helper (kbAi.ts, the same model as the browser, on the CPU) on both documents
// with EVERY financing fact treated as blank, a hard test of the checks: each value it keeps must be right.
// Usage: node tests/kb-extract/check-financing.mjs [folder] [--ai] [--verbose]   (Node 22.18+, `npm ci` in web/)
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const here = path.dirname(fileURLToPath(import.meta.url))
const web = path.join(here, '../../web')
const args = process.argv.slice(2)
const dir = args.find((a) => !a.startsWith('--')) ?? '/mnt/project-files/product-matrix/kb-real-summaries'
const pdfjs = await import(path.join(web, 'node_modules/pdfjs-dist/legacy/build/pdf.mjs'))
const { readWith } = await import(path.join(web, 'src/lib/piExtract.ts'))
const fin = await import(path.join(web, 'src/lib/kbFinancing.ts'))
const kb = await import(path.join(web, 'src/lib/kbExtract.ts'))

let bad = 0, ok = 0
const check = (cond, what) => { if (cond) ok++; else { bad++; console.log('  WRONG:', what) } }
const cof = (cur, tenor, rate, as_of) => ({ currency: cur, tenor_months: tenor, rate, as_of, kind: 'cof' })

const CIMB_DATES = ['2026-05-29', '2026-06-30', '2026-07-31', '2026-08-31', '2026-09-30', '2026-10-30']
const WANT = {
  'CIMB_Premium_Financing_Factsheet_Nov2026.pdf': {
    record: { insurer: 'CIMB Bank', name: 'CIMB Premium Financing', currencies: ['SGD', 'USD'], product_type: 'Premium financing' },
    source: '_ps', validUntil: undefined, version: 'V2026 NOV',
    facts: {
      finPolicies: 'CIMB Premium Financing is a facility whereby CIMB Bank Berhad, Singapore Branch (“CIMB Bank” or “Bank”) funds part of the insurance premium of a Universal Life or Single Premium Whole Life Insurance Policy on your behalf.',
      finPricing: 'Cost of Funds (“COF”) + Spread',
      finReprice: 'At every rollover, the loan will be repriced according to the prevailing COF rate. It should be noted that regardless of COF, the minimum rate that will be used will be zero (not inclusive of spread).',
      finCof: '~Refers to CIMB Bank’s internal cost of funds. Components of this include: internal borrowing cost, liquidity premium, credit premium',
      finTenor: '1 or 3 months with revolving options',
      finQuantum: 'Up to 90% on Day 1 Cash Value of the Insurance Policy',
      finCancel: '1.5% of facility limit or $500 (denominated in loan currency), whichever is higher (Applicable without any prior drawdown)',
      finMargin: '~Margin maintenance: If the outstanding loan exceeds 90% of the Day 1 Cash Value',
      finRisks: 'Borrower’s Liquidity Risk; Interest Rate Risk; Renewal Risk; Crediting Rate Risk',
    },
    rates: [
      ...[[1.44, 1.55], [1.43, 1.54], [1.53, 1.65], [1.54, 1.67], [1.75, 1.97], [1.72, 1.88]].flatMap(([a, b], i) => [cof('SGD', 1, a, CIMB_DATES[i]), cof('SGD', 3, b, CIMB_DATES[i])]),
      ...[[3.85, 4.0], [4.0, 4.25], [3.83, 4.15], [3.9, 4.2], [4.1, 4.47], [4.1, 4.5]].flatMap(([a, b], i) => [cof('USD', 1, a, CIMB_DATES[i]), cof('USD', 3, b, CIMB_DATES[i])]),
    ],
  },
  'iFAST_Global_Bank_Premium_Financing_COF_Nov2026.pdf': {
    record: { insurer: 'iFAST Global Bank', name: 'iFAST Global Bank Premium Financing', currencies: ['SGD', 'USD', 'HKD', 'GBP', 'EUR', 'CHF', 'JPY', 'CNY'], product_type: 'Premium financing' },
    source: '_cof', validUntil: '2026-11-30', effectiveFrom: '2026-11-01',
    facts: {
      finPolicies: 'Pricing above applies exclusively to premium financing applications for the purchase of new whole-life insurance policy.',
      finReprice: 'The applicable COF rate will be fixed for the chosen cycle until it is automatically refreshed on the next cycle.',
      finTerms: 'The above rates are applicable with 10% commissions sharing with iFAST Global Bank for Premium Financing, otherwise the rates below (same as Policy Cash Drawdown) applies.',
      finSpread: 'Client’s AUA Balance with iFAST Group: S$0 to S$2,999,999 (Singapore) or HK$0 to HK$17,999,999 (Hong Kong): IGB COF + 1.15%; S$3,000,000 and above (Singapore) or HK$18,000,000 and above (Hong Kong): IGB COF + 0.95%',
    },
    rates: [
      ...[['SGD', 1.77, 1.77], ['USD', 3.16, 3.16], ['HKD', 2.83, 2.83], ['CHF', 0.08, 0.08], ['JPY', 1.31, 1.31], ['CNY', 1.45, 1.45], ['GBP', 3.24, 3.74], ['EUR', 0.85, 1.97]]
        .flatMap(([c, a, b]) => [cof(c, 1, a, '2026-11-01'), cof(c, 3, b, '2026-11-01')]),
      ...[['SGD', 3.75], ['USD', 5.45], ['HKD', 4.7], ['CHF', 1.7], ['JPY', 2.65], ['CNY', 3.5], ['GBP', 5.5], ['EUR', 3.2]]
        .map(([c, r]) => ({ currency: c, tenor_months: 0, rate: r, as_of: '2026-11-01', kind: 'drawdown' })),
    ],
  },
}
const same = (got, want) => (want.startsWith('~') ? String(got).includes(want.slice(1)) : got === want)
const pdf = async (file) => { const d = fs.readFileSync(file); return { pages: await readWith(pdfjs, d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength)), rows: [], kind: 'pdf' } }

const docs = []
for (const [f, want] of Object.entries(WANT)) {
  const file = path.join(dir, f)
  if (!fs.existsSync(file)) { console.log(`(skipped ${f}: not in ${dir})`); continue }
  const doc = await pdf(file)
  docs.push({ f, doc, want })
  console.log(f)
  check(fin.isFinancingDoc(doc), 'not seen as a financing document')
  const r = fin.readFinancing(doc)
  for (const [k, v] of Object.entries(want.record)) check(JSON.stringify(r.record[k]) === JSON.stringify(v), `${k}: ${JSON.stringify(r.record[k])} (want ${JSON.stringify(v)})`)
  check(r.source === want.source, `source ${r.source}`)
  check(r.validUntil === want.validUntil, `valid until ${r.validUntil}`)
  if (want.effectiveFrom) check(r.effectiveFrom === want.effectiveFrom, `effective ${r.effectiveFrom}`)
  if (want.version) check(r.version === want.version, `version ${r.version}`)
  for (const [k, v] of Object.entries(want.facts)) check(r.facts[k] && same(r.facts[k].v, v), `${k}: ${JSON.stringify(r.facts[k]?.v)} (want ${JSON.stringify(v)})`)
  for (const k of Object.keys(r.facts)) check(k in want.facts, `${k} found but the document does not state it: ${r.facts[k].v}`)
  check(JSON.stringify(r.finRates) === JSON.stringify(want.rates), `rates differ:\n${JSON.stringify(r.finRates)}\nwant\n${JSON.stringify(want.rates)}`)
  // The CSV round trip of the record page.
  const back = fin.parseFinRates(fin.finRatesCsv(r.finRates))
  check(!back.error && JSON.stringify(back.rates) === JSON.stringify(r.finRates), `CSV round trip: ${back.error}`)
}
// A Product Summary is not a financing document, and the financing reader does not read policy facts.
{
  const f = path.join(dir, 'FWD_Future_First_Term_Product_Summary.pdf')
  if (fs.existsSync(f)) { const d = await pdf(f); check(!fin.isFinancingDoc(d), 'FWD Product Summary seen as financing'); check(kb.readSummary(d).planType === 'Term life', 'FWD plan type changed') }
}
console.log(`\nPremium financing reader: ${ok} right, ${bad} wrong`)

if (args.includes('--ai')) {
  const ai = await import(path.join(web, 'src/lib/kbAi.ts'))
  const cfg = await import(path.join(web, 'src/lib/aiConfig.ts'))
  const { pipeline } = await import(path.join(web, 'node_modules/@huggingface/transformers/dist/transformers.node.mjs'))
  const gen = await pipeline('text-generation', cfg.AI_MODEL, { dtype: cfg.AI_DTYPE_CPU })
  // What a kept AI value must contain, per document; a key not listed must stay blank.
  const AI_WANT = {
    'CIMB_Premium_Financing_Factsheet_Nov2026.pdf': {
      finPolicies: 'Universal Life or Single Premium Whole Life', finPricing: 'Spread', finCof: 'internal cost of funds', finReprice: 'repriced',
      finTenor: '1 or 3 months', finQuantum: '90%', finCancel: '1.5% of facility limit', finMargin: ['90%', '95%'], currencies: 'SGD,USD',
    },
    'iFAST_Global_Bank_Premium_Financing_COF_Nov2026.pdf': {
      finPolicies: 'new whole-life insurance policy', finReprice: 'fixed for the chosen cycle', finPricing: 'COF +',
    },
  }
  let right = 0, wrong = 0, blank = 0
  for (const { f, doc } of docs) {
    const s = fin.readFinancing(doc)
    const known = { ...s, record: { name: s.record.name, product_type: s.record.product_type }, facts: {} }
    const qs = ai.kbQuestions(doc, ai.blankOf(known))
    const answers = []
    for (const q of qs) {
      const out = await gen(q.messages, { max_new_tokens: q.maxTokens, do_sample: false })
      const text = out[0].generated_text.at(-1).content
      if (args.includes('--verbose')) console.log(`  [${q.keys.join(',')}] ${text.replace(/\s+/g, ' ').slice(0, 900)}`)
      answers.push(ai.parseAnswer(text))
    }
    const fill = ai.checkKbAnswers(doc, qs, answers, known)
    const got = Object.fromEntries(Object.entries(fill.facts).map(([k, x]) => [k, x.v]))
    if (fill.record.currencies) got.currencies = fill.record.currencies.join(',')
    console.log(`${f} (AI, every fact blank): asked ${qs.reduce((a, q) => a + q.keys.length, 0)}, kept ${Object.keys(got).length}, dropped ${fill.dropped.length}`)
    const want = AI_WANT[f]
    for (const [k, v] of Object.entries(got)) {
      const w = want[k]
      if (w && [].concat(w).every((x) => String(v).includes(x))) { right++; console.log(`    ✓ ${k} = ${String(v).slice(0, 120)}`) }
      else { wrong++; console.log(`    ✗ ${k} = "${String(v).slice(0, 160)}" (want ${JSON.stringify(w ?? 'blank')})`) }
    }
    blank += Object.keys(want).filter((k) => !(k in got)).length
  }
  console.log(`\nAI helper on financing documents: ${right} right, ${wrong} wrong, ${blank} left blank`)
  if (wrong) bad += wrong
}
process.exit(bad ? 1 : 0)
