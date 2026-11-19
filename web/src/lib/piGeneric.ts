// General reading rules for PIs whose layout we have no rules for (a new insurer, or a changed layout).
// They run after the layout rules in piExtract.ts and only fill fields those left blank. Every value they
// give is marked `guess`, so the screen shades it for ops to check.
//
// How they work, without knowing the layout:
//  - Labels are matched by meaning, from lists of the wordings insurers use ("sum assured", "sum insured",
//    "coverage amount", "face amount", "amount of insurance", "death benefit", ...).
//  - A value is taken from beside its label ("Label: value", or the next piece of the same line), or from
//    under it when the label is a column heading (the nearest value straight below it).
//  - Values must have the right shape (an amount, a number of years, a date), and amounts keep their period:
//    a monthly premium becomes a yearly one (x12) with a note, never silently.
//  - When two readings disagree, the field is left blank and the note says what was seen. A blank cell is
//    better than a wrong one.
// Measured on PIs these rules were not written for: see docs/pi-reading/unknown-formats.md.

import { detectInsurer, type Found, type Line, type Page, type TextItem } from './piExtract.ts'

/** A note about one field. `used`: shown only when that field's value came from these rules;
 *  otherwise shown only while the field is still blank. */
export interface GenericNote { key: string; text: string; used?: boolean }
export interface GenericResult { found: Record<string, Found>; notes: GenericNote[] }

const AMOUNT = /(?:^|[\s(:])(?:(S\$|US\$|C\$|A\$|HK\$|RM|SGD|USD|MYR|CAD|AUD|HKD|\$)\s?)?(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+\.\d{2}|\d{4,9}(?:\.\d{1,2})?)(?![\d,]|\.\d|\s*%|\s*(?:years?|yrs?)\b)/i
const toNum = (s: string) => Number(s.replace(/,/g, ''))
const fmtMoney = (n: number) => n.toFixed(2)
const fmtSum = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2))

/** The first amount in a piece of text, with the currency mark written next to it. */
function amountIn(s: string): { n: number; mark: string } | null {
  const m = s.match(AMOUNT)
  return m ? { n: toNum(m[2]), mark: (m[1] ?? '').toUpperCase() } : null
}
/** An amount that starts the text (after a currency mark): what follows a label. "rates per RM1,000" is not one. */
function leadingAmount(s: string): { n: number; mark: string } | null {
  const t = s.replace(/^\s*:?\s*\(?/, '')
  if (!/^(?:S\$|US\$|C\$|A\$|HK\$|RM|SGD|USD|MYR|CAD|AUD|HKD|\$)?\s?\d/i.test(t)) return null
  return amountIn(' ' + t)
}

/** The period an amount is paid for, from words near it. */
function periodOf(s: string): 'year' | 'month' | 'quarter' | 'half' | 'single' | null {
  if (/\bsingle\s+premium\b/i.test(s)) return 'single'
  if (/semi[\s-]?annual|half[\s-]?year/i.test(s)) return 'half'
  if (/quarter/i.test(s)) return 'quarter'
  if (/month|\/\s*mo\b/i.test(s)) return 'month'
  if (/annual|annually|yearly|per\s+year|a\s+year|\/\s*yr\b/i.test(s)) return 'year'
  return null
}
const FACTOR = { year: 1, half: 2, quarter: 4, month: 12 } as const

interface Cand { value: number; text: string; page: number; how: string }

/** Values beside a label on the same line: "Label: value", "Label  value", or "value" in the next piece. */
function besideLabel(lines: Line[], label: RegExp, pick: (rest: string) => number | null): Cand[] {
  const out: Cand[] = []
  for (const l of lines) {
    const parts = l.text.split(/\s{2,}/)
    for (let i = 0; i < parts.length; i++) {
      const m = parts[i].match(label)
      if (!m) continue
      // The label should start the piece, or follow only a few words ("Total Initial Annual Premium:").
      if ((m.index ?? 0) > 30) continue
      let rest = parts[i].slice((m.index ?? 0) + m[0].length).replace(/^\s*(?:\([^)]{0,6}\))?\s*:?\s*/, '')
      if (!rest.trim() && parts[i + 1]) rest = parts[i + 1]
      const v = pick(rest.slice(0, 40))
      if (v !== null) out.push({ value: v, text: l.text, page: l.page, how: 'beside' })
    }
  }
  return out
}

/** Values under a column heading: the nearest piece of text straight below it, on the same page. */
function underHeading(pages: Page[], label: RegExp, pick: (s: string) => number | null): Cand[] {
  const out: Cand[] = []
  const seen = new Set<string>()
  for (const p of pages) {
    const items = p.items.filter((i) => i.str.trim())
    for (const h of items.filter((i) => label.test(i.str) && i.str.trim().length <= 45)) {
      // A table carried over to the next page repeats its headings over later years: only its first page counts.
      const key = h.str.trim().toLowerCase()
      if (seen.has(key) && !items.some((i) => i !== h && i.y < h.y && i.y > h.y - 60 && /^1$/.test(i.str.trim()))) continue
      seen.add(key)
      const below = items
        .filter((i) => i !== h && i.y < h.y - 2 && i.y > h.y - 60 && overlapX(i, h))
        .sort((a, b) => b.y - a.y)
      // Skip one more heading line ("($)", "Financed") before the first value.
      for (const b of below.slice(0, 3)) {
        const v = pick(b.str)
        if (v !== null) { out.push({ value: v, text: `${h.str.trim()} … ${b.str.trim()}`, page: p.page, how: 'under' }); break }
        if (/\d/.test(b.str)) break
      }
    }
  }
  return out
}
/** Looks like a person's name: a few words, letters only, not a heading word. */
const isName = (v: string) => /^[A-Za-z][A-Za-z .'-]{1,40}$/.test(v) && v.split(/\s+/).length <= 5
  && !/\b(?:quote\s+for|initial|premium|healthy|based|insurance|policy|plan|insured|age|year|amount|date|benefit|coverage|male|female)\b/i.test(v)
const overlapX = (a: TextItem, b: TextItem) => a.x <= b.x + b.w + 6 && b.x <= a.x + a.w + 6

/** One value when every reading agrees, otherwise null (with what was seen, for a note). */
function agree(cands: Cand[], tolerance = 0.005): { c: Cand | null; seen: number[] } {
  const seen = [...new Set(cands.map((c) => c.value))]
  if (!cands.length) return { c: null, seen }
  const ok = seen.every((v) => Math.abs(v - seen[0]) <= tolerance)
  return { c: ok ? cands[0] : null, seen }
}

// ----- Label wordings -----
const SUM_LABELS = /\b(?:basic\s+|initial\s+|total\s+)?(?:sum\s+(?:assured|insured)|death\s*\/\s*(?:TPD|total\s+(?:and|&)\s+permanent\s+disability)\s+benefit|face\s+amount|coverage\s+amount|amount\s+of\s+(?:insurance|cover(?:age)?)|death\s+benefit|insurance\s+amount|amount\s+insured|desired\s+coverage\s+amount)\b/i
const SUM_HEADINGS = /^(?:basic\s+|initial\s+)?(?:sum\s+(?:assured|insured)|coverage\s+amount|face\s+amount|amount\s+of\s+insurance|amount\s*\(\s*\$\s*\))(?:\s*\([^)]{0,4}\))?\s*$/i

const PREMIUM_BESIDE = /\b(?:(?:total\s+)?(?:initial\s+)?(?:annual(?:ised|ized)?|yearly|monthly|quarterly|semi[\s-]?annual|half[\s-]?yearly)\s+(?:premium|payment)|(?:monthly|annual)\s+payment|premium\s+(?:payable|amount)|insurance\s+cost|premium)\b/i
const PREMIUM_HEADING = /^(?:total\s+)?(?:initial\s+)?(?:annual(?:ly)?|monthly|annual\s+premium|monthly\s+premium|total\s+(?:annual|monthly)\s+premium)\b/i

export function extractGeneric(pages: Page[]): GenericResult {
  const lines = pages.flatMap((p) => p.lines)
  const found: Record<string, Found> = {}
  const notes: GenericNote[] = []
  const note = (key: string, text: string, used = false) => notes.push({ key, text, used })
  const set = (key: string, value: string, page: number | null, line: string) => { if (value) found[key] = { value, page, line, guess: true } }
  const text = lines.map((l) => l.text).join('\n')

  // ----- Currency: only from amounts written with a currency mark. A bare "$" says nothing. -----
  const marks = new Map<string, number>()
  for (const m of text.matchAll(/(S\$|US\$|C\$|A\$|HK\$|\bRM|\bSGD|\bUSD|\bMYR|\bCAD|\bAUD|\bHKD)\s?\d/g)) {
    const code = ({ S$: 'SGD', US$: 'USD', C$: 'CAD', A$: 'AUD', HK$: 'HKD', RM: 'MYR' } as Record<string, string>)[m[1]] ?? m[1]
    marks.set(code, (marks.get(code) ?? 0) + 1)
  }
  if (marks.size === 1) {
    const [code] = [...marks.keys()]
    const at = lines.find((l) => new RegExp(code === 'MYR' ? '\\bRM\\s?\\d' : code === 'SGD' ? 'S\\$|SGD' : code).test(l.text))
    set('currency', code, at?.page ?? null, at?.text ?? '')
  } else if (marks.size > 1) note('currency', `Amounts are written in more than one currency (${[...marks.keys()].join(', ')}): fill in the policy currency.`)
  else if (/\$\s?\d/.test(text)) note('currency', 'Amounts show only "$", without saying which dollar: fill in the policy currency.')

  // ----- Insurer: the company that issues the policy, e.g. "Sun Life Assurance Company of Canada" -> "Sun Life" -----
  const companies = new Map<string, { n: number; line: Line }>()
  for (const l of lines) {
    for (const m of l.text.matchAll(/\b((?:[A-Z][\w&'.-]*\s+){0,4}?[A-Z][\w&'.-]*)\s+(?:Assurance|Insurance)\s+(?:(?:Singapore|Malaysia|Canada|\(Singapore\))\s+)?(?:Company|Co\.|Berhad|Bhd|Limited|Ltd|Inc|Corporation|Pte)\b/g)) {
      const name = m[1].replace(/^The\s+/, '').replace(/\s+Financial\s+Security\s+Life$/i, '').replace(/^(\S+)\s+Life$/, (x, a: string) => (/^(?:Sun|Pacific|Empire|Equitable|China|Great)$/i.test(a) ? x : a)).trim()
      // Not the deposit insurance scheme (SDIC, PIDM) that PIs name in their small print.
      if (!name || /^(?:Life|The|This|Your|Our|Any|Other|An?)$/i.test(name) || /\bDeposit\b/i.test(name)) continue
      const c = companies.get(name)
      if (c) c.n++; else companies.set(name, { n: 1, line: l })
    }
  }
  const topCo = [...companies.entries()].sort((a, b) => b[1].n - a[1].n)[0]
  if (topCo) set('insurer', detectInsurer(topCo[0]) || topCo[0], topCo[1].line.page, topCo[1].line.text)

  // ----- The insured person, written as a short description: "Male, 40, Standard Non-Smoker",
  //       "(Male, 40 years old, 1984/09/10)", "Male Age 45 / Preferred No Nicotine Use", "30-year old male non-smoker" -----
  const GENDER = /\b(male|female|man|woman)\b/i
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    const g = l.text.match(GENDER)
    if (!g) continue
    // A description, not prose: an age next to it, or a list of short items.
    const window = [l.text, lines[i + 1]?.page === l.page ? lines[i + 1].text : ''].join('  ').replace(/-\s+/g, '-')
    const isDesc = /\b(?:age\s*\d{1,2}|\d{1,2}\s*(?:years?\s*old|-?year[\s-]old)|,\s*\d{1,2}\b)/i.test(window) || (l.text.length < 60 && /,/.test(l.text))
    if (!isDesc) continue
    if (!found.gender) set('gender', /^(?:male|man)$/i.test(g[1]) ? 'Male' : 'Female', l.page, l.text)
    const sm = window.replace(/\b(?:smok(?:ing|er)|tobacco)\s+(?:status|habit|class|use)\b/gi, ' ').match(/\b(non[\s-]?smoker|nonsmoker|no\s+nicotine(?:\s+use)?|non[\s-]?tobacco|smoker|tobacco\s+user)\b/i)
    if (sm && !found.underwriting_class) set('underwriting_class', /^(?:non|no)/i.test(sm[1]) ? 'Non-Smoker' : 'Smoker', l.page, window.trim())
    const dob = window.match(/\b(\d{4}[\/-]\d{1,2}[\/-]\d{1,2}|\d{1,2}[\/-]\d{1,2}[\/-]\d{4})\b/)
    if (dob && !found.date_of_birth) set('date_of_birth', dob[1], l.page, window.trim())
    // "Life Client Quote, Male, 40" / "Designed for: Client Quote, Male, Age 40": the name before the gender.
    const before = l.text.slice(0, g.index).replace(/^.*?\b(?:insured(?:\s+person)?|designed\s+for|prepared\s+for|for)\s*:?\s*/i, '').replace(/[\s,(]+$/, '').trim()
    if (!found.insured_name && isName(before)) set('insured_name', before, l.page, l.text)
    else if (!found.insured_name && !before && /^\(/.test(l.text.trim()) && lines[i - 1]?.page === l.page && isName(lines[i - 1].text.trim())) set('insured_name', lines[i - 1].text.trim(), l.page, `${lines[i - 1].text} ${l.text}`)
    if (found.gender && found.underwriting_class) break
  }
  // Smoker status written on its own line ("Tobacco use ... Non-smoker", "Life Classification: Non Smoker").
  if (!found.underwriting_class) {
    const noLabel = (t: string) => t.replace(/\b(?:smok(?:ing|er)|tobacco)\s+(?:status|habit|class|use)\b/gi, ' ')
    const l = lines.find((x) => /\b(?:tobacco\s+use|smok(?:ing|er)\s+status|life\s+classification|risk\s+class)\b/i.test(x.text) && /\b(?:non[\s-]?smoker|smoker)\b/i.test(noLabel(x.text)))
    const sm = l ? noLabel(l.text).match(/\b(non[\s-]?smoker|smoker)\b/i) : null
    if (l && sm) set('underwriting_class', /^non/i.test(sm[1]) ? 'Non-Smoker' : 'Smoker', l.page, l.text)
  }
  if (!found.insured_name) {
    // "Insured  Life Client Quote , Male, 40" or "Life Insured(s):  Client Quote": the label is the first piece.
    for (const l of lines) {
      const parts = l.text.split(/\s{2,}/)
      if (!/^(?:insured\s+person|life\s+(?:insured|assured)(?:\s*\(s\))?|person\s+insured|insured)\s*:?$/i.test(parts[0].trim()) || parts.length < 2) continue
      const v = parts[1].replace(/\s*,.*$/, '').trim()
      if (isName(v)) { set('insured_name', v, l.page, l.text); break }
    }
    // "Insured person:" with the name on the next line.
    if (!found.insured_name) {
      const i = lines.findIndex((l) => /^(?:insured\s+person|life\s+(?:insured|assured)|person\s+insured)\s*:$/i.test(l.text.trim()))
      const v = i >= 0 ? lines[i + 1]?.text.trim() ?? '' : ''
      if (i >= 0 && isName(v) && lines[i + 1].page === lines[i].page) set('insured_name', v, lines[i].page, `${lines[i].text} ${v}`)
    }
  }

  // ----- Sum assured -----
  const sumPick = (s: string) => { const a = leadingAmount(s); return a && a.n >= 1000 ? a.n : null }
  const sumC = [...besideLabel(lines, SUM_LABELS, sumPick), ...underHeading(pages, SUM_HEADINGS, sumPick)]
  const sa = agree(sumC)
  if (sa.c) set('death_sa', fmtSum(sa.c.value), sa.c.page, sa.c.text)
  else if (sa.seen.length > 1) note('death_sa', `More than one sum assured is written (${sa.seen.slice(0, 4).map((v) => v.toLocaleString('en-US')).join(', ')}): fill in Death by hand.`)

  // ----- Annual premium, from the total the PI states for a period. Yearly first; else monthly etc. x payments a year. -----
  const premC: (Cand & { period: keyof typeof FACTOR; total: boolean })[] = []
  const pushPrem = (cands: Cand[], labelText: (c: Cand) => string) => {
    for (const c of cands) {
      const lt = labelText(c)
      const period = periodOf(lt)
      if (!period || period === 'single') continue
      premC.push({ ...c, period, total: /\btotal\b/i.test(lt) })
    }
  }
  const premPick = (s: string) => { const a = leadingAmount(s); return a && a.n > 0 && a.n < 1_000_000 ? a.n : null }
  // Beside the label: the period is in the label ("Annual Premium", "Monthly Payment") or just after the value ("$16.38 / Month", "(annually)").
  for (const l of lines) {
    const parts = l.text.split(/\s{2,}/)
    for (let i = 0; i < parts.length; i++) {
      const m = parts[i].match(PREMIUM_BESIDE)
      if (!m || (m.index ?? 0) > 30) continue
      let rest = parts[i].slice((m.index ?? 0) + m[0].length).replace(/^\s*(?:\([^)]{0,6}\))?\s*:?\s*/, '')
      let tail = ''
      if (!rest.trim() && parts[i + 1]) { rest = parts[i + 1]; tail = parts[i + 2] ?? '' }
      const v = premPick(rest.slice(0, 30))
      if (v === null) continue
      const labelText = `${parts[i].slice(0, (m.index ?? 0) + m[0].length)} ${rest.replace(AMOUNT, ' ').slice(0, 25)} ${tail.slice(0, 15)}`
      pushPrem([{ value: v, text: l.text, page: l.page, how: 'beside' }], () => labelText)
    }
  }
  // Sentences: "for RM 5,215.00 annually", "based on the premium of $31.00 ... Monthly".
  for (const l of lines) {
    const m = l.text.match(/\bfor\s+((?:RM|S\$|US\$|\$)\s?\d[\d,]*(?:\.\d{2})?)\s+(annually|yearly|monthly|a\s+year|a\s+month|per\s+year|per\s+month)\b/i)
    if (m) pushPrem([{ value: amountIn(' ' + m[1])!.n, text: l.text, page: l.page, how: 'sentence' }], () => m[2])
  }
  pushPrem(underHeading(pages, PREMIUM_HEADING, premPick), (c) => c.text.split(' … ')[0])
  // Yearly totals first, then yearly, then other periods' totals, then the rest.
  // With riders in the PI, a premium that is not labelled as a total may be the base plan's alone.
  const big = /\d{1,3}(?:,\d{3})+/
  const hasRiders = lines.some((l, i) => (/^(?:supplementary\s+benefits?(?:\s*\(s\))?|riders?(?:\s*\(s\))?|rider\s+benefits?|optional\s+benefits?)\s*:?$/i.test(l.text.trim())
      && lines.slice(i + 1, i + 7).some((x) => x.page === l.page && big.test(x.text)))
    || (/\b(?:supplementary\s+benefit|rider)\b/i.test(l.text) && big.test(l.text) && l.text.length < 120))
  if (hasRiders) for (let i = premC.length - 1; i >= 0; i--) if (!premC[i].total) premC.splice(i, 1)
  const rank = (c: (typeof premC)[number]) => (c.period === 'year' ? 0 : 2) + (c.total ? 0 : 1)
  const best = premC.length ? Math.min(...premC.map(rank)) : -1
  const top = premC.filter((c) => rank(c) === best)
  const pr = agree(top.map((c) => ({ ...c, value: c.value * FACTOR[c.period] })), 0.02)
  if (pr.c) {
    const c = top[0]
    set('annual_premium', fmtMoney(pr.c.value), c.page, c.text)
    if (c.period !== 'year') note('annual_premium', `Only a ${c.period === 'month' ? 'monthly' : c.period === 'quarter' ? 'quarterly' : 'half-yearly'} premium is shown (${c.value.toFixed(2)}): the annual premium is ${FACTOR[c.period]} × that. The insurer's own annual rate may be a little lower.`, true)
  } else if (pr.seen.length > 1) note('annual_premium', `Different premiums are written (${pr.seen.slice(0, 4).map((v) => v.toFixed(2)).join(', ')} a year): fill in Annual Premium by hand.`)
  if (/\bsingle\s+premium\b/i.test(text) && !found.annual_premium) note('annual_premium', 'This looks like a single premium policy: fill in the premiums by hand.')

  // ----- Base premium: only when the PI names it ("Basic Annual Premium", "Base Premium" column). -----
  const baseC = underHeading(pages, /^(?:basic|base)\s+(?:annual\s+)?premium\b/i, premPick)
  const baseLabelYearly = baseC.filter((c) => periodOf(c.text.split(' … ')[0]) === 'year' || /annual/i.test(lines.find((l) => l.page === c.page && /\b(?:year|annual)\b/i.test(l.text) && l.text.includes(c.text.split(' … ')[0]))?.text ?? ''))
  const bp = agree(baseLabelYearly)
  if (bp.c) set('base_premium', fmtMoney(bp.c.value), bp.c.page, bp.c.text)

  // ----- Policy term: "Term  20 years", "Duration: 50 years", "provides coverage ... for 15 years" -----
  const termC: Cand[] = []
  for (const l of lines) {
    const parts = l.text.split(/\s{2,}/)
    const lab = parts.findIndex((p) => /^(?:term|duration|policy\s+term|coverage\s+(?:term|period)|policy\s+duration)\s*:?\s*(?:\d|$)/i.test(p.trim()))
    if (lab >= 0) {
      const s = parts[lab].replace(/^[^:\d]*:?\s*/, '') || parts[lab + 1] || ''
      const y = s.match(/^(\d{1,2})\s*(?:years?|yrs?)\b/i)
      if (y) termC.push({ value: +y[1], text: l.text, page: l.page, how: 'beside' })
    }
    const sent = l.text.match(/\b(?:coverage|cover|protection)\b[^.]{0,80}?\bfor\s+(\d{1,2})\s+years\b/i)
    if (sent) termC.push({ value: +sent[1], text: l.text, page: l.page, how: 'sentence' })
  }
  const tm = agree(termC, 0)
  if (tm.c) set('policy_term', String(tm.c.value), tm.c.page, tm.c.text)

  // ----- Policy name: "Plan: Term 20", "Plan Name: ...", "What is Zurich TermLife?", "Policy Quoted" + next line -----
  const planBeside = lines.map((l) => l.text.match(/^(?:plan|plan\s+name|product(?:\s+name)?|policy\s+name)\s*:\s*(.{2,60}?)\s*(?:\s{2,}|$)/i)).find(Boolean)
  const planAt = planBeside ? lines.find((l) => l.text.startsWith(planBeside[0].trim().slice(0, 10))) : undefined
  const whatIs = lines.find((l) => /^\d?\s*what\s+is\s+(?:this\s+product|the\s+product)?\s*([A-Z][^?]{2,70})\?/i.test(l.text))
  const quoted = lines.findIndex((l) => /^policy\s+quoted$/i.test(l.text.trim()))
  if (planBeside && planAt) set('policy_name', planBeside[1].trim(), planAt.page, planAt.text)
  else if (whatIs) set('policy_name', whatIs.text.match(/what\s+is\s+(.+?)\?/i)![1].trim(), whatIs.page, whatIs.text)
  else if (quoted >= 0 && lines[quoted + 1]) set('policy_name', lines[quoted + 1].text.trim(), lines[quoted + 1].page, `${lines[quoted].text} ${lines[quoted + 1].text}`)

  return { found, notes }
}
