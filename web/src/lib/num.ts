// One place that writes numbers for people to read (Kumar, 25 Nov 2026): a comma at every thousand,
// so 1000000 shows as 1,000,000 and 12345.67 as 12,345.67. Not for things that are not quantities
// (years, dates, phone numbers, PI / request reference numbers, ids, page numbers): write those with plain().
// scripts/check-number-format.mjs fails the build when a number is shown without one of these.

const cache = new Map<string, Intl.NumberFormat>()
function nf(min: number, max: number) {
  const k = `${min}/${max}`
  let f = cache.get(k)
  if (!f) cache.set(k, (f = new Intl.NumberFormat('en-SG', { minimumFractionDigits: min, maximumFractionDigits: max })))
  return f
}

/** 1234567.891 -> "1,234,567.89". dp fixes the decimals (dp 2: 1000 -> "1,000.00"); by default up to 2 are kept. */
export function fmtNum(n: number | string | null | undefined, dp?: number): string {
  const x = typeof n === 'string' ? Number(n.replace(/,/g, '')) : n
  if (x == null || !Number.isFinite(x)) return ''
  return dp == null ? nf(0, 2).format(x) : nf(dp, dp).format(x)
}

/** "1000000", "SGD" -> "SGD 1,000,000"; "—" when there is no amount. */
export function fmtMoney(amount: number | string | null | undefined, currency?: string | null, dp?: number): string {
  const s = fmtNum(amount, dp)
  if (!s) return '—'
  return `${currency ?? ''} ${s}`.trim()
}

/** A number that is not a quantity (a year, page, version, age, reference or id): written as it is, no commas. */
export const plain = (n: number | null | undefined): string => (n == null ? '' : String(n))

/** "1,000,000" -> "1000000": what is saved and calculated with. */
export const ungroup = (s: string) => s.replace(/(\d),(?=\d)/g, '$1')

/**
 * Commas in an amount written as text: "2478.51" -> "2,478.51", "SGD 500000" -> "SGD 500,000".
 * Only for text that is an amount (an amount box, a money cell); anything else is left as it is.
 */
export function groupDigits(s: string): string {
  return s.replace(/(^|[^\d.,])(\d{4,})(?=\.\d|[^\d,]|$)/g, (_, pre: string, int: string) => pre + int.replace(/\B(?=(\d{3})+(?!\d))/g, ','))
}

const CUR = String.raw`(?:S\$|US\$|C\$|A\$|HK\$|NZ\$|B\$|\$|SGD|USD|CAD|AUD|HKD|NZD|BND|MYR|RM|EUR|GBP|CNY|JPY)`
const MONEY_IN_TEXT = new RegExp(String.raw`(${CUR}\s?)(\d{4,})(?=\.\d|[^\d,]|$)`, 'g')
/**
 * Commas in the amounts inside a sentence, such as a note or a fact copied from a document:
 * "premium S$2478.51 a year" -> "premium S$2,478.51 a year". Only numbers written after a currency
 * are changed, so years, phone numbers and reference numbers in the same text stay as they are.
 */
export function groupMoneyInText(s: string): string {
  return s.replace(MONEY_IN_TEXT, (_, cur: string, int: string) => cur + int.replace(/\B(?=(\d{3})+(?!\d))/g, ','))
}
