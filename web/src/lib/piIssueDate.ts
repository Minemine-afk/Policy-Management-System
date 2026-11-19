// Finds the date a PI was issued (printed), for the "PI issue date" at the top right of the comparison.
// Singapore PIs print it on the cover page and in each page header, in a few ways:
//   HSBC     "CONFIDENTIAL  Date: 10/11/2026"         Singlife "Date of Issue : 18/12/2024"
//   Tokio    a line holding only "17/03/2023" near the foot of the cover page
// Dates of birth, "as at" ages, effective or commencement dates are never taken.
import type { Page } from './piExtract.ts'

export interface IssueDate { value: string; page: number; line: string }

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const MONTH = '(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?'
const NUMERIC = '(\\d{1,2})[/.-](\\d{1,2})[/.-]((?:19|20)\\d{2})'
const DMY = `(\\d{1,2})(?:st|nd|rd|th)?\\s+${MONTH},?\\s+((?:19|20)\\d{2})`
const MDY = `${MONTH}\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+((?:19|20)\\d{2})`
const ANY_DATE = `(?:${NUMERIC}|${DMY}|${MDY})`

const pad = (n: number) => String(n).padStart(2, '0')

/** "10/11/2026", "10 Nov 2026" or "November 10, 2026" -> "10/11/2026" (day first, as in Singapore). */
export function toDmy(raw: string): string {
  const s = raw.trim()
  let m = s.match(new RegExp(`^${NUMERIC}$`))
  if (m) return valid(Number(m[1]), Number(m[2]), Number(m[3]))
  m = s.match(new RegExp(`^${DMY}$`, 'i'))
  if (m) return valid(Number(m[1]), MONTHS.indexOf(m[2].slice(0, 3).toLowerCase()) + 1, Number(m[3]))
  m = s.match(new RegExp(`^${MDY}$`, 'i'))
  if (m) return valid(Number(m[2]), MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()) + 1, Number(m[3]))
  return ''
}
function valid(d: number, mo: number, y: number): string {
  const dt = new Date(Date.UTC(y, mo - 1, d))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d ? `${pad(d)}/${pad(mo)}/${y}` : ''
}

/** "10/11/2026" -> "10 Nov 2026". Anything else is returned as typed. */
export function showDate(dmy: string): string {
  const m = dmy.trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/)
  if (!m) return dmy.trim()
  const mo = MONTHS[Number(m[2]) - 1]
  return `${Number(m[1])} ${mo[0].toUpperCase()}${mo.slice(1)} ${m[3]}`
}

export const todayDmy = (d = new Date()) => `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`

// In order of trust. Each must be followed (after an optional colon) by the date.
const LABELLED = [
  /\b(?:date\s+of\s+(?:issue|illustration|quotation|proposal|printing)|(?:issue|illustration|quotation|quote|proposal|print(?:ed)?|preparation|generated)\s+date|date\s+(?:prepared|printed|generated|issued)|(?:prepared|printed|generated|issued)\s+on)\s*:?\s*/i,
  // A bare "Date:" label, not "Date of Birth", "Effective Date" and so on (those have a word between).
  /(?:^|\s)date\s*:\s*/i,
]
const NOT_ISSUE = /\b(birth|dob|effective|commencement|inception|expiry|maturity|cessation|as\s+at|backdat)/i

export function findIssueDate(pages: Page[]): IssueDate | null {
  const lines = pages.flatMap((p) => p.lines.map((l) => ({ page: p.page, text: l.text })))
  for (const label of LABELLED) {
    const re = new RegExp(label.source + `(${ANY_DATE})`, 'i')
    for (const l of lines) {
      const m = l.text.match(re)
      if (!m) continue
      // the words just before the date must not make it some other date
      const before = l.text.slice(Math.max(0, (m.index ?? 0) - 20), (m.index ?? 0) + m[0].length - m[1].length)
      if (NOT_ISSUE.test(before)) continue
      const value = toDmy(m[1])
      if (value) return { value, page: l.page, line: l.text }
    }
  }
  // A line that is only a date, on the first pages (the cover page's print date).
  for (const l of lines.filter((x) => x.page <= 3)) {
    const value = new RegExp(`^${ANY_DATE}$`, 'i').test(l.text.trim()) ? toDmy(l.text) : ''
    if (value) return { value, page: l.page, line: l.text }
  }
  return null
}

/** The text at the top right of the comparison. dates: each PI's issue date ("" when not found). */
export function issueDateHeading(dates: string[], generated = todayDmy()): { text: string; note: string } {
  const found = dates.map((d) => d.trim())
  const distinct = [...new Set(found.filter(Boolean))]
  if (!distinct.length) return { text: `PI issue date: ${showDate(generated)} (date of comparison)`, note: 'No issue date was found in the PIs, so the date of the comparison is shown.' }
  if (distinct.length === 1) {
    const missing = found.map((d, i) => (d ? 0 : i + 1)).filter(Boolean)
    return { text: `PI issue date: ${showDate(distinct[0])}`, note: missing.length ? `No issue date was found in ${missing.map((i) => `PI${i}`).join(' and ')}.` : '' }
  }
  return { text: `PI issue dates: ${found.map((d, i) => `PI${i + 1} ${d ? showDate(d) : 'not shown'}`).join(' · ')}`, note: '' }
}
