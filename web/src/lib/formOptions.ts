// Every drop-down list on the PI request form, in one place. Kumar marked most of these lists "Open" (not
// decided yet), so these are sensible Singapore defaults: change them here and redeploy. Nothing in the database
// depends on the exact wording, so old requests keep whatever value they were saved with.

export const GENDERS = ['Male', 'Female']

/** Client segments (mockup field 4). */
export const CLIENT_TYPES = ['Individual', 'Mass affluent', 'High net worth (HNW)', 'Business owner / key person', 'Corporate']

/** Country the client lives in (mockup field 5). */
export const RESIDENCIES = [
  'Singapore', 'Malaysia', 'Indonesia', 'Vietnam', 'Thailand', 'Philippines', 'Myanmar', 'Cambodia',
  'China', 'Hong Kong', 'Taiwan', 'India', 'Australia', 'United Kingdom', 'Other',
]

/** Nationality (mockup field 6, searchable). */
export const NATIONALITIES = [
  'Singaporean', 'Malaysian', 'Indonesian', 'Vietnamese', 'Thai', 'Filipino', 'Myanmar', 'Cambodian', 'Bruneian',
  'Chinese', 'Hong Konger', 'Taiwanese', 'Japanese', 'Korean', 'Indian', 'Sri Lankan', 'Bangladeshi', 'Pakistani',
  'Australian', 'New Zealander', 'British', 'American', 'Canadian', 'French', 'German', 'Dutch', 'Swiss', 'Other',
]

/** Insurers and their term plans (mockup fields 8 and 9: the product list is filtered by insurer). Term only for now.
 *  SAMPLE LIST: check the plan names with the insurers before go-live. "Other" lets the introducer name a plan in the remarks. */
export const OTHER_PLAN = 'Other term plan (say which in remarks)'
export const INSURER_PRODUCTS: Record<string, string[]> = {
  'AIA': ['AIA Secure Flexi Term'],
  'China Life': ['Term plan'],
  'Etiqa': ['Etiqa Term Life'],
  'FWD': ['FWD Term Life', 'Future First'],
  'Great Eastern': ['GREAT Term'],
  'HSBC Life': ['Term Protector'],
  'Income Insurance': ['Complete Term Infinite'],
  'Manulife': ['ManuProtect Term II'],
  'Prudential': ['PRUActive Term'],
  'Singlife': ['Singlife Elite Term II', 'Singlife Term CI'],
  'Tokio Marine': ['TM TermProtect Plus'],
}
export const INSURERS = Object.keys(INSURER_PRODUCTS)
export const productsFor = (insurer: string) => (insurer ? [...(INSURER_PRODUCTS[insurer] ?? []), OTHER_PLAN] : [])

/** Every term plan as "Insurer · Plan", for the term comparison (mockup fields 12 and 13). */
export const ALL_TERM_PRODUCTS = INSURERS.flatMap((i) => (INSURER_PRODUCTS[i] ?? []).map((p) => `${i} · ${p}`))

export const CURRENCIES = ['SGD', 'USD', 'AUD', 'GBP', 'EUR', 'HKD']

/** Mockup field 11: one amount, either the cover wanted or the premium the client wants to pay. */
export const AMOUNT_BASES = [{ value: 'sum_assured', label: 'Sum assured' }, { value: 'premium', label: 'Premium' }]

// Not on the mockup's form but on its request page, and needed to quote a term plan.
export const SMOKER = [{ value: false, label: 'Non-smoker' }, { value: true, label: 'Smoker' }]
export const POLICY_TERMS = [
  '5 years', '10 years', '15 years', '20 years', '25 years', '30 years', '35 years', '40 years',
  'To age 65', 'To age 70', 'To age 75', 'To age 85', 'To age 99', 'To age 100',
]
export const SAME_AS_POLICY = 'Same as policy term'
export const PREMIUM_TERMS = [SAME_AS_POLICY, '5 years', '10 years', '15 years', '20 years', '25 years', 'To age 65', 'To age 70']
export const PAYMENT_FREQUENCIES = ['Annual', 'Half-yearly', 'Quarterly', 'Monthly']
export const RIDERS = [
  'Critical illness', 'Early critical illness', 'Total and permanent disability', 'Terminal illness',
  'Accidental death', 'Waiver of premium',
]

/** Supporting documents (mockup field 14). Type and size limits were left open; these are the defaults. */
export const DOC_ACCEPT = '.pdf,.jpg,.jpeg,.png,.heic,.doc,.docx,.xls,.xlsx'
export const DOC_MAX_MB = 10
export const DOC_MAX_FILES = 10

/** Mockup field 15: what the introducer confirms before submitting. */
export const ACKNOWLEDGEMENT = 'I confirm these details are correct, and the client agreed to share them so that we can prepare policy illustrations.'

/** Ages for the date-of-birth check. */
export const MIN_AGE = 0
export const MAX_AGE = 85
