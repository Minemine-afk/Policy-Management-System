// The AI helper's safety checks (lib/piAi.ts checkAnswer), without a model: made-up answers, right and wrong, for a
// made-up PI. Every wrong answer must be dropped. Usage: node tests/pi-extract/check-ai-checks.mjs
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const here = path.dirname(fileURLToPath(import.meta.url))
const { checkAnswer, parseAnswer, buildMessages, blankKeys } = await import(path.join(here, '../../web/src/lib/piAi.ts'))

const lines = [
  'Acme Life Assurance', 'Quote for Life Term 20', 'Coverage amount $250,000.00', 'Insurance cost $21.50 / Month',
  'Annual premium $240.00', 'Policy term 20 years  Premium term 20 years', 'Cover ends at age 85', 'TPD rider $100,000',
]
const pages = [{ page: 1, items: [], lines: lines.map((text) => ({ page: 1, text })) }]
const keys = ['insurer', 'policy_name', 'policy_term', 'premium_term', 'cover_age', 'death_sa', 'annual_premium', 'base_premium', 'tpd_sa', 'ci_sa']
let pass = 0, fail = 0
const t = (name, answer, want, ks = keys) => {
  const got = Object.fromEntries(Object.entries(checkAnswer(answer, pages, ks).found).map(([k, v]) => [k, v.value]))
  const ok = JSON.stringify(got) === JSON.stringify(want)
  ok ? pass++ : fail++
  console.log(`${ok ? '✓' : '✗'} ${name}${ok ? '' : `\n    got  ${JSON.stringify(got)}\n    want ${JSON.stringify(want)}`}`)
}
t('right answers are kept', { insurer: 'Acme Life', policy_name: 'Life Term 20', policy_term: '20', premium_term: 20, cover_age: '85', death_sa: '$250,000.00', annual_premium: { amount: '240.00', per: 'year' }, tpd_sa: '100,000', ci_sa: null },
  { insurer: 'Acme Life', policy_name: 'Life Term 20', policy_term: '20', premium_term: '20', cover_age: '85', death_sa: '250000', annual_premium: '240.00', tpd_sa: '100000' })
t('a monthly premium is not multiplied by 12 when the PI also shows a yearly premium', { base_premium: { amount: '21.50', per: 'month' } }, {})
t('a yearly amount is never multiplied as if monthly', { annual_premium: { amount: '240.00', per: 'month' } }, {})
t('numbers not in the PI are dropped', { death_sa: '300,000', policy_term: '25', annual_premium: { amount: '250', per: 'year' }, cover_age: '99' }, {})
t('names not in the PI are dropped', { insurer: 'Great Eastern', policy_name: 'Term Shield' }, {})
t('a small number is not a sum assured', { death_sa: '20' }, {})
t('a premium term read from a line that is not about paying is dropped', { policy_term: '20', premium_term: '85' }, { policy_term: '20' })
t('a rider larger than the death cover is dropped', { death_sa: '100000', tpd_sa: '250000' }, { death_sa: '100000' })
t('a base premium above the total premium is dropped', { annual_premium: { amount: '240', per: 'year' }, base_premium: { amount: '258', per: 'year' } }, { annual_premium: '240.00' })
t('"null", "N/A" and nothing are blanks', { insurer: 'null', policy_name: 'N/A', death_sa: '' }, {})
t('only the blank cells asked about are filled', { insurer: 'Acme Life', death_sa: '250000' }, { death_sa: '250000' }, ['death_sa'])
t('a garbled answer fills nothing', parseAnswer('I cannot tell {not json'), {})
const p = parseAnswer('<think>hmm</think> Here: {"death_sa": "250,000", "x": {"a": 1}} done')
p?.death_sa === '250,000' ? pass++ : fail++; console.log(`${p?.death_sa === '250,000' ? '✓' : '✗'} the JSON is found in a chatty answer`)
// Empire Life's layout: the frequency is in a column heading above the amount, not on its line.
const empire = [{ page: 2, items: [], lines: ['Selected Coverage  Initial Monthly Premium  Coverage Amount', 'Solution 20  $11.43  $100,000', 'Policy Fee  $4.50', 'Total  $15.93'].map((text) => ({ page: 2, text })) }]
const e1 = checkAnswer({ annual_premium: { amount: '15.93', per: 'year' } }, empire, ['annual_premium']).found
const e2 = checkAnswer({ annual_premium: { amount: '15.93', per: 'month' } }, empire, ['annual_premium']).found
const okE = !e1.annual_premium && e2.annual_premium?.value === '191.16'
okE ? pass++ : fail++; console.log(`${okE ? '✓' : '✗'} a monthly amount under a "Monthly Premium" heading is never taken as yearly (and x12 when called monthly)`)
// Desjardins: no riders, the plan premium is the only premium. A model copying it into the rider cells is caught.
const desj = [{ page: 1, items: [], lines: ['Life Term 20  Regular (S) / R2  $100,000  $34.56', 'TOTAL INITIAL MONTHLY PREMIUM  $34.56', 'Disability waiver not included'].map((text) => ({ page: 1, text })) }]
const d1 = checkAnswer({ tpd_premium: { amount: '34.56', per: 'month' }, ci_premium: { amount: '34.56', per: 'month' }, tpd_sa: '100,000' }, desj, ['tpd_premium', 'ci_premium', 'tpd_sa'], { annual_premium: '414.72' }).found
const okD = !Object.keys(d1).length
okD ? pass++ : fail++; console.log(`${okD ? '✓' : '✗'} rider values away from a rider name, or equal to the plan premium, are dropped${okD ? '' : ' ' + JSON.stringify(d1)}`)
const rid = [{ page: 1, items: [], lines: ['Basic plan  $500,000  $600.00 yearly', 'Critical Illness Rider  $200,000  $310.00 yearly'].map((text) => ({ page: 1, text })) }]
const r1 = checkAnswer({ ci_sa: '200,000', ci_premium: { amount: '310.00', per: 'year' } }, rid, ['ci_sa', 'ci_premium'], { death_sa: '500000', annual_premium: '910' }).found
const okR = r1.ci_sa?.value === '200000' && r1.ci_premium?.value === '310.00'
okR ? pass++ : fail++; console.log(`${okR ? '✓' : '✗'} a rider written beside its name is kept`)
const r2 = checkAnswer({ ci_sa: '500,000' }, rid, ['ci_sa'], { death_sa: '200000' }).found
const okR2 = !r2.ci_sa; okR2 ? pass++ : fail++; console.log(`${okR2 ? '✓' : '✗'} a rider above the death cover already read is dropped`)
const man = [{ page: 1, items: [], lines: ['September 12, 2024', 'Family Term', 'Term-20  $100,000  $14.90  $166.44'].map((text) => ({ page: 1, text })) }]
const m1 = checkAnswer({ premium_term: '12', policy_term: '20', base_premium: { amount: '100,000', per: 'year' } }, man, ['premium_term', 'policy_term', 'base_premium'], { death_sa: '100000' }).found
const okM = !m1.premium_term && m1.policy_term?.value === '20' && !m1.base_premium
okM ? pass++ : fail++; console.log(`${okM ? '✓' : '✗'} a term read from a date, or a premium as big as the cover, is dropped${okM ? '' : ' ' + JSON.stringify(m1)}`)
const my = [{ page: 1, items: [], lines: ['Acme Life Term Life Insurance', 'Benefit of up to RM1,000,000 per life', 'for a single premium of RM2,000.00 payable', 'Example: RM200,000 x 4.92 = RM984.00', 'Duration: 50 years', 'Acme Life Super Term 20'].map((text) => ({ page: 1, text })) }]
const y1 = checkAnswer({ death_sa: 'RM1,000,000', annual_premium: { amount: '2,000.00', per: 'year' }, base_premium: { amount: '984.00', per: 'year' }, premium_term: '50', policy_term: '50' }, my, ['death_sa', 'annual_premium', 'base_premium', 'premium_term', 'policy_term']).found
const okY = Object.keys(y1).join() === 'policy_term'
okY ? pass++ : fail++; console.log(`${okY ? '✓' : '✗'} limits ("up to"), single premiums, worked examples and a premium term from the cover length are dropped${okY ? '' : ' ' + JSON.stringify(y1)}`)
const n1 = checkAnswer({ policy_name: 'Term Life Insurance' }, my, ['policy_name']).found
const n2 = checkAnswer({ policy_name: 'Acme Life Super Term 20' }, my, ['policy_name'], { insurer: 'Acme' }).found
const okN = !n1.policy_name && n2.policy_name?.value === 'Super Term 20'
okN ? pass++ : fail++; console.log(`${okN ? '✓' : '✗'} a plan name that only says "Term Life Insurance" is dropped, the insurer is taken off the front${okN ? '' : ' ' + JSON.stringify(n2)}`)
const opt = [{ page: 1, items: [], lines: ['Initial Sum Assured (RM)', 'Financed  Non-Financed', 'RM 102,000.00  RM 100,000.00', 'The amount stated below includes any premium of rider(s).', 'Annual premium 475.00'].map((text) => ({ page: 1, text })) }]
const o1 = checkAnswer({ death_sa: '100,000', base_premium: { amount: '475.00', per: 'year' } }, opt, ['death_sa', 'base_premium'], { annual_premium: '475.00' }).found
const okO = !Object.keys(o1).length
okO ? pass++ : fail++; console.log(`${okO ? '✓' : '✗'} one of two option amounts on a line, and a "base" premium that is the total with riders, are dropped${okO ? '' : ' ' + JSON.stringify(o1)}`)
const sg = [{ page: 1, items: [], lines: ['FWD Singapore Pte. Ltd.', 'Plan name  Non-Participating Term Plan', 'Future First  S$8,866.00  Annually  S$1,000,000', 'Total  S$8,974.20', 'Singlife Elite Term II'].map((text) => ({ page: 1, text })) }]
const s1 = checkAnswer({ insurer: 'Future First', policy_name: 'Non-Participating Term Plan', annual_premium: { amount: '8,866.00', per: 'year' } }, sg, ['insurer', 'policy_name', 'annual_premium']).found
const s2 = checkAnswer({ insurer: 'FWD Singapore Pte. Ltd.', annual_premium: { amount: '8,974.20', per: 'year' } }, sg, ['insurer', 'annual_premium']).found
const s3 = checkAnswer({ policy_name: 'Singlife Elite Term II' }, sg, ['policy_name']).found
const okS = !Object.keys(s1).length && s2.insurer?.value === 'FWD' && s2.annual_premium?.value === '8974.20' && s3.policy_name?.value === 'Elite Term II'
okS ? pass++ : fail++; console.log(`${okS ? '✓' : '✗'} a plan name as insurer, a description as plan name, and a plan line instead of the Total line are dropped; known insurers get their short name${okS ? '' : ' ' + JSON.stringify([s1, s2, s3])}`)
const ages = [{ page: 1, items: [], lines: ['Term-20 is renewable to age 80 and convertible to age 75', 'TPD cover prior to attaining age 70', 'MANULIFE  % of premium  65.00% 40.00% 10.00%', 'Premium payable for 10.00% of the term'].map((text) => ({ page: 1, text })) }]
const a1 = checkAnswer({ cover_age: '80', premium_term: '10' }, ages, ['cover_age', 'premium_term']).found
const okA = !Object.keys(a1).length
okA ? pass++ : fail++; console.log(`${okA ? '✓' : '✗'} a renewal or rider age is not the cover's end, and a percentage is not a term${okA ? '' : ' ' + JSON.stringify(a1)}`)
const ages2 = [{ page: 1, items: [], lines: ['Policy illustrated to age 100, this does not mean the policy terminates', 'based on a healthy 30-year old male', 'Plan  Year  1  2  3  4  5  6', '5.  WHAT ARE SOME OF THE KEY TERMS', 'Your benefit shall not exceed RM10,000,000 per life', '20 YRCT coverage expires at age 85'].map((text) => ({ page: 1, text })) }]
const g1 = checkAnswer({ cover_age: '100', policy_term: '5', premium_term: '5', tpd_sa: '10,000,000' }, ages2, ['cover_age', 'policy_term', 'premium_term', 'tpd_sa']).found
const g2 = checkAnswer({ cover_age: '30' }, ages2, ['cover_age']).found
const g3 = checkAnswer({ cover_age: '85' }, ages2, ['cover_age']).found
const eq = [{ page: 1, items: [], lines: ['Coverage  Initial', 'Selected Coverage:  Insured  To Age  Premium', '20 YRCT  $100,000  85  $11.44'].map((text) => ({ page: 1, text })) }]
const g4 = checkAnswer({ cover_age: '85' }, eq, ['cover_age']).found
const okG = !Object.keys(g1).length && !g2.cover_age && g3.cover_age?.value === '85' && g4.cover_age?.value === '85'
okG ? pass++ : fail++; console.log(`${okG ? '✓' : '✗'} a cover-end age must be written as one; list numbers and "shall not exceed" limits are dropped${okG ? '' : ' ' + JSON.stringify([g1, g2, g3])}`)
const sg2 = [{ page: 1, items: [], lines: ['HSBC Life Term Protect Secure (To Age)  Policy Term To Age 85', 'Annual premium  651.00', 'The Total Distribution Cost for this plan is $1,089 as shown', '6/42  3,338  1,089', 'A benefit is paid at the end of every 5 policy years'].map((text) => ({ page: 1, text })) }]
const h1 = checkAnswer({ insurer: 'Life Term Protect Secure', policy_term: '85', premium_term: '5', annual_premium: { amount: '1,089', per: 'year' } }, sg2, ['insurer', 'policy_term', 'premium_term', 'annual_premium']).found
const okH = !Object.keys(h1).length
okH ? pass++ : fail++; console.log(`${okH ? '✓' : '✗'} a plan name as insurer, "To Age 85" or "every 5 policy years" as a term, and the distribution cost as a premium are dropped${okH ? '' : ' ' + JSON.stringify(h1)}`)
const msg = buildMessages(pages, ['death_sa', 'annual_premium'])[1].content
const okMsg = msg.includes('Coverage amount $250,000.00') && msg.includes('"annual_premium": {"amount"') && !msg.includes('policy_term')
okMsg ? pass++ : fail++; console.log(`${okMsg ? '✓' : '✗'} the prompt holds the PI text and only the fields asked`)
const bk = blankKeys({ insurer: { value: 'Acme', page: 1, line: '' }, death_sa: { value: '', page: null, line: null } })
const okB = !bk.includes('insurer') && bk.includes('death_sa'); okB ? pass++ : fail++; console.log(`${okB ? '✓' : '✗'} only blank cells go to the AI`)
console.log(`\n${pass}/${pass + fail} passed`)
process.exit(fail ? 1 : 0)
