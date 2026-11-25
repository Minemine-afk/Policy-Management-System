// Checks the Knowledge Bank Product Summary reader (web/src/lib/kbExtract.ts) on 5 real Singapore Product Summaries
// with no rate sheet: 2 term plans (FWD Future First, Singlife Elite Term II) and 3 universal life plans, which must be
// told apart (plan type) and read with the universal life facts (crediting rate, policy value, surrender charges ...).
// The PDFs are public insurer documents kept in the project files (product-matrix/kb-real-summaries/), not in git.
// Usage: node tests/kb-extract/check-real.mjs [folder with the PDFs]   (Node 22.18+, needs `npm ci` in web/)
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const here = path.dirname(fileURLToPath(import.meta.url))
const web = path.join(here, '../../web')
const pdfjs = await import(path.join(web, 'node_modules/pdfjs-dist/legacy/build/pdf.mjs'))
const { readWith } = await import(path.join(web, 'src/lib/piExtract.ts'))
const { readSummary, planKind, planType } = await import(path.join(web, 'src/lib/kbExtract.ts'))

let bad = 0, ok = 0
const check = (cond, what) => { if (cond) ok++; else { bad++; console.log('  WRONG:', what) } }

// Each fact: the words its value must start with (or contain, after "~"). Facts not listed must not be found.
const WANT = {
  'FWD_Future_First_Term_Product_Summary.pdf': {
    record: { name: 'FWD Future First', insurer: 'FWD', has_tpd: true, has_ci: true },
    kind: '', planType: 'Term life',
    facts: {
      premTerm: 'Regular premiums are payable for the full coverage term', guaranteed: 'The premiums for FWD Future First are guaranteed',
      death: '100% of sum insured will be paid.', ti: '~diagnosed with terminal illness and policy will terminate.',
      tpd: 'Rider (FWD TPD Rider): 100% of sum insured', ci: 'Rider (FWD CI Rider): 100% of sum insured will be paid if the person insured suffers any one of the covered CI conditions.',
      conversion: 'If we offer any plan that has cash value', renew: 'This is only applicable if you have chosen a 10-year renewable term',
      inc: 'Yes, you can apply to increase the sum insured by 25%', cash: '~there is no cash value',
      freelook: '~you have 14 days', grace: 'A grace period of 60 days', excl: 'This policy has certain exclusions',
    },
  },
  'Singlife_Elite_Term_II_Product_Summary.pdf': {
    record: { name: 'Singlife Elite Term II', insurer: 'Singlife', currencies: ['SGD', 'USD', 'AUD', 'GBP', 'EUR', 'HKD'], has_tpd: true, has_ci: true },
    kind: '', planType: 'Term life',
    facts: {
      coverTo: '5 years or 10 years (with Guaranteed Renewable Option), 11 years up to Age 85, at every one-year interval, or to Age 99.',
      death: 'If the Life Assured dies, We will pay the Sum Assured in one lump sum.',
      ti: 'If the Life Assured is diagnosed with Terminal Illness, We will pay the TI Benefit in one lump sum',
      tpd: 'Rider (TPD ADVANCE COVER PLUS III): If the Life Assured suffers from Total and Permanent Disability',
      ci: 'Rider (CI Advance Cover Plus (2025)): The CI Benefit will be 100% of the Sum Assured',
      guaranteed: 'The premiums are level and guaranteed throughout the policy term.', modes: 'Choose to pay either monthly, quarterly, half-yearly or yearly.',
      cash: 'This plan does not have any cash value.', renew: '(Applicable to Policy Term of 5 years and 10 years only) This option allows You to renew',
      conversion: '(Applicable to all Policy Terms) This option allows You to convert', inc: 'This option allows You to increase the Sum Assured',
      freelook: 'You have 14 days',
    },
  },
  'Genesis_III_IUL_Product_Summary.pdf': {
    record: { name: 'Genesis III Indexed Universal Life', insurer: 'Transamerica Life', currencies: ['USD'] }, kind: 'Indexed Universal Life', planType: 'Universal life',
    facts: {
      ti: 'If the Insured is diagnosed with a TI while the policy is in force, we may pay the TI Benefit in a lump sum upon your request as an accelerated payment of Death Benefit',
      death: 'We will pay benefits upon the death of the Insured. The Death Benefit is the higher of (less any Policy Loan): The Sum Assured of the policy; and The Account Value on the date of the Insured’s death.',
      minRate: '2.00% p.a. for the first 10 Policy Years and thereafter, 1.50% p.a.',
      consider: 'We may use fixed and non-fixed income assets',
    },
  },
  'HSBC_Indexed_Flexi_Income_Product_Summary.pdf': {
    record: { name: 'HSBC Life Indexed Flexi Income', insurer: 'HSBC Life', currencies: ['USD'] }, kind: 'Universal Life', planType: 'Universal life',
    facts: {
      ad: 'We’ll pay the Accidental Death Benefit when the Life Insured dies as a result of an Accident before reaching age 80.',
      death: 'We’ll pay the Death Benefit when the Life Insured dies.',
      cash: 'The value acquired by the Policy over time.',
      minRate: 'The Guaranteed Minimum Crediting Rate is 2.00%.',
      account: 'Sum of values in the General Account and Index Account.',
      surrCharge: 'We’ll charge the Surrender Charge over Surrender Charge Period',
      payout: 'Apply in writing to elect this benefit and receive Monthly Income until the Life Insured reaches age 120.',
      fees: 'Charges applicable to the Policy, refer to the Section on Charges on page 23.',
      freelook: 'You may cancel your Policy within 14 days of receiving it.',
      grace: '60 days from the date when your Policy Value is less than or equals to zero.',
      excl: 'If the Life Insured commits suicide within 1 year from the latest of the Issue Date, Policy Effective Date and the last Reinstatement Date (if any)',
      consider: 'This document isn’t a legal contract',
    },
  },
  'Manulife_Signature_IUL_Select_III_Product_Summary.pdf': {
    record: { name: 'Signature Indexed Universal Life Select (III)', insurer: 'Manulife', currencies: ['USD'] }, kind: 'Indexed Universal Life', planType: 'Universal life',
    facts: {
      death: 'If the life insured dies during the policy term, we will pay the death benefit (as determined at the date of death) being the higher of: (a) the face amount; or (b) the policy value.',
      cash: 'If you surrender your policy, we will pay you the net surrender value',
      account: 'Your policy value is the sum of the values in the Fixed Account and the Index Account.',
      minRate: 'The minimum guaranteed crediting rate is 2.00% per annum.',
      freelook: 'You may cancel this policy by writing to us within 14 days after you receive this policy.',
      consider: 'The S&P PRISM is an index of indices',
    },
  },
}

const dir = process.argv[2] ?? '/mnt/project-files/product-matrix/kb-real-summaries'
for (const [f, want] of Object.entries(WANT)) {
  const file = path.join(dir, f)
  if (!fs.existsSync(file)) { console.log(`(skipped ${f}: not in ${dir})`); continue }
  console.log(f)
  const data = fs.readFileSync(file)
  const pages = await readWith(pdfjs, data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength))
  const s = readSummary({ pages, rows: [], kind: 'pdf' })
  check(s.kind === want.kind, `kind "${s.kind}" (want "${want.kind}")`)
  check(s.planType === want.planType, `plan type "${s.planType}" (want "${want.planType}")`)
  for (const [k, v] of Object.entries(want.record)) check(JSON.stringify(s.record[k]) === JSON.stringify(v), `${k}: ${JSON.stringify(s.record[k])} (want ${JSON.stringify(v)})`)
  // Neither term summary states entry ages or sum assured limits: they must stay blank (not guessed).
  for (const k of ['entry_age_min', 'entry_age_max', 'sa_min', 'sa_max', 'residency']) check(s.record[k] == null, `${k} should be blank, got ${s.record[k]}`)
  if (!want.facts) continue
  for (const [k, v] of Object.entries(want.facts)) {
    const got = s.facts[k]?.v ?? ''
    check(v.startsWith('~') ? got.includes(v.slice(1)) : got.startsWith(v), `${k}: "${got.slice(0, 120)}" (want ${v.startsWith('~') ? 'it to contain' : 'it to start with'} "${v.replace(/^~/, '')}")`)
  }
  const extra = Object.keys(s.facts).filter((k) => !(k in want.facts))
  check(!extra.length, `facts that should not be found: ${extra.map((k) => `${k}="${s.facts[k].v.slice(0, 60)}"`).join('; ')}`)
}

// A real rate sheet: Great Eastern Cares Term Plan (public). Two tables side by side on each page (ages 17-46 and
// 47-75), and a second table for another policy term, which must be left out (never mixed in).
{
  const f = 'GE_Cares_Term_Plan_Premium_Rates.pdf', file = path.join(dir, f)
  if (!fs.existsSync(file)) console.log(`(skipped ${f}: not in ${dir})`)
  else {
    console.log(f)
    const { readRates } = await import(path.join(web, 'src/lib/kbExtract.ts'))
    const want = JSON.parse(fs.readFileSync(path.join(here, 'expected-ge-cares-rates.json'), 'utf8')).rows
    const data = fs.readFileSync(file)
    const r = readRates({ pages: await readWith(pdfjs, data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)), rows: [], kind: 'pdf' })
    check(!r.error, r.error)
    check(r.rates.length === want.length * 4, `${r.rates.length} rates (want ${want.length * 4})`)
    let wrong = 0
    for (const [age, mn, ms, fn, fs_] of want) {
      for (const [g, sm, v] of [['Male', false, mn], ['Male', true, ms], ['Female', false, fn], ['Female', true, fs_]]) {
        const x = r.rates.find((y) => y.age === age && y.gender === g && y.smoker === sm)
        if (!x || x.rate !== v || x.ci_rate != null) { wrong++; if (wrong < 5) console.log('   ', age, g, sm, x?.rate, 'want', v) }
      }
    }
    check(!wrong, `${wrong} wrong or missing rates`)
    check(r.notes.some((n) => /Policy Term to Age 100/.test(n) && /left out/.test(n)), `says which table was used: ${r.notes}`)
    check(!r.notes.some((n) => /per 1,000 of sum assured\. Check/.test(n)), 'knows the rates are per $1000')
  }
}

// Plan kind from the first pages: the first kind named wins (a term plan's later pages mention converting to whole life).
const doc = (text) => ({ pages: [{ page: 1, items: [], lines: text.split('\n').map((t) => ({ page: 1, text: t })) }], rows: [], kind: 'pdf' })
check(planKind(doc('This plan is a non-participating level term insurance plan.\nYou may convert to a whole life policy.')) === '', 'term plan that mentions whole life')
check(planKind(doc('This is a whole life non-participating universal life insurance plan')) === 'Universal Life', 'universal life')
check(planKind(doc('An investment-linked plan (ILP)')) === 'Investment-linked', 'investment-linked')
check(planKind(doc('Product Summary\nBenefits')) === '', 'no kind said')
// Plan types (product categories) for every kind of plan, with the riders and conversions of other plans ignored.
for (const [t, want] of [
  ['This plan is a non-participating level term insurance plan.\nYou may convert to a whole life policy.', 'Term life'],
  ['A term plan with an optional critical illness rider', 'Term life'],
  ['This is a whole life non-participating universal life insurance plan', 'Universal life'],
  ['A regular premium investment-linked plan (ILP)', 'Investment-linked'],
  ['A participating whole life plan that covers you for life', 'Whole life'],
  ['This is a participating endowment plan with a 10-year policy term', 'Endowment'],
  ['A deferred annuity that pays you a monthly income for life', 'Retirement and annuity'],
  ['An Integrated Shield plan that covers hospital stays in private hospitals', 'Health'],
  ['A personal accident plan that pays for accidental death, disablement and medical expenses', 'Personal accident'],
  ['A disability income plan that pays a monthly benefit if you cannot work', 'Disability income'],
  ['A long-term care plan for severe disability', 'Long-term care'],
  ['A mortgage reducing term plan to cover your home loan', 'Mortgage cover'],
  ['A standalone critical illness plan that pays on diagnosis', 'Critical illness'],
  ['Product Summary\nBenefits', ''],
]) check(planType(doc(t)).type === want, `plan type of "${t}": "${planType(doc(t)).type}" (want "${want}")`)

console.log(`${ok} right, ${bad} wrong`)
process.exit(bad ? 1 : 0)
