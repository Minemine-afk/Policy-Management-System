// Lists for the PI request form (the deck's wireframe 2, 23 Nov 2026). Field numbers match the deck.

/** Field 4. The six client profiles from the Product Matrix (wireframe 4, field 1). */
export const CLIENT_TYPES = ['HNW individual', 'Family', 'Business owner', 'Offshore', 'Professional', 'Family office']

/** Field 5. Also checked against who can apply for each Knowledge Bank product. */
export const RESIDENCIES = ['Singapore citizen', 'Singapore PR', 'Foreigner living in Singapore', 'Non-resident']

/** Field 6 (searchable). */
export const NATIONALITIES = [
  'Singaporean', 'Malaysian', 'Indonesian', 'Vietnamese', 'Thai', 'Filipino', 'Myanmar', 'Cambodian', 'Bruneian',
  'Chinese', 'Hong Konger', 'Taiwanese', 'Japanese', 'Korean', 'Indian', 'Sri Lankan', 'Bangladeshi', 'Pakistani',
  'Australian', 'New Zealander', 'British', 'American', 'Canadian', 'French', 'German', 'Dutch', 'Swiss', 'Other',
]

/** Field 8. Insurers in the Knowledge Bank come first; these are always offered too. */
export const STANDARD_INSURERS = [
  'AIA', 'China Life', 'Etiqa', 'FWD', 'Great Eastern', 'HSBC Life', 'Income Insurance', 'Manulife', 'Prudential',
  'Singlife', 'Tokio Marine',
]
/** Field 9, for a plan that is not (yet) in the Knowledge Bank. */
export const OTHER_PLAN = 'Other term plan (name it in the remarks)'

/** Field 10. */
export const CURRENCIES = ['SGD', 'USD', 'AUD', 'GBP', 'EUR', 'HKD']

/** Field 11: one amount, either the cover wanted or the premium the client wants to pay a year. */
export const AMOUNT_BASES = [{ value: 'sum_assured', label: 'Sum assured' }, { value: 'premium', label: 'Premium (a year)' }]

/** Field 14. */
export const DOC_ACCEPT = '.pdf,.jpg,.jpeg,.png,.heic,.doc,.docx,.xls,.xlsx'
export const DOC_MAX_MB = 10

/** Field 15: what the introducer confirms before submitting. */
export const ACKNOWLEDGEMENT = 'I confirm these details are correct, and the client agreed to share them so that we can prepare policy illustrations.'

/** Everyone but the introducer who submitted the request sees this instead of the client's name (Kumar, 22 Nov 2026). */
export const vipName = (gender: string | null | undefined) => (gender === 'Female' ? 'Ms VIP' : 'Mr VIP')

/** "1000000" -> "SGD 1,000,000". */
export const fmtMoney = (amount: number | string | null | undefined, currency: string | null | undefined) => {
  const n = Number(amount)
  if (!Number.isFinite(n)) return '—'
  return `${currency ?? ''} ${n.toLocaleString('en-SG', { maximumFractionDigits: 2 })}`.trim()
}
