// The made-up Product Summary and rates used by make-samples.mjs and check.mjs.
export const SUMMARY = [
  ['Product name', 'Orchard TermShield'],
  ['Insurer', 'Marina Life Assurance Pte. Ltd.'],
  ['Policy currency', 'SGD and USD'],
  ['Entry age', '18 to 60 (age next birthday)'],
  ['Sum assured', 'Minimum S$100,000; maximum S$5 million'],
  ['Who can apply', 'Singapore Citizens, Permanent Residents and Employment Pass holders'],
  ['Underwriting', 'Full medical underwriting'],
  ['Premium term', 'Same as the policy term'],
  ['Premium rates', 'Not guaranteed; the insurer may revise them'],
  ['Payment modes', 'Annual, half-yearly, quarterly or monthly'],
  ['Policy term', 'To age 65, 70, 75 or 85'],
  ['Death benefit', '100% of the sum assured'],
  ['Terminal illness', '100% of the sum assured, paid in advance'],
  ['Total and permanent disability', 'Included, before age 70'],
  ['Critical illness', 'Optional rider (CI Accelerator)'],
  ['Early critical illness', 'Not available'],
  ['Accidental death', 'Not covered'],
  '--page--',
  ['Conversion option', 'Convert to a whole life plan before age 60 without medical evidence'],
  ['Renewal', 'Not renewable'],
  ['Cash value', 'None'],
  ['Distribution cost', 'Up to 45% of the first-year premium'],
  ['Free-look period', '14 days'],
  ['Grace period', '30 days'],
  ['Reinstatement', 'Within 2 years of lapse, with evidence of health'],
  ['Exclusions', 'Suicide within 1 year; pre-existing conditions'],
  ['Important considerations', 'Term cover has no savings value'],
]
// Per S$1,000 a year: male non-smoker, male smoker, female non-smoker, female smoker; CI rider the same order.
export const rateAt = (age) => {
  const b = 0.6 + (age - 18) * 0.05
  const r = (x) => Math.round(x * 100) / 100
  return { mn: r(b), ms: r(b * 1.6), fn: r(b * 0.8), fs: r(b * 1.3), cmn: r(b * 0.9), cms: r(b * 1.4), cfn: r(b * 0.85), cfs: r(b * 1.2) }
}

