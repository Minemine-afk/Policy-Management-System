// "Teach a new insurer": when ops fill in or correct the PI comparison and save it, remember WHERE each value sat in
// that PI (the words beside it, or the column heading above it), per insurer. The next PI from that insurer is read
// with those places first. Only label words and positions are kept, never a value: no client name, date of birth,
// sum or premium is stored. A place is kept only when it finds exactly the value ops gave in the PI it came from.
//
// Reading with learned places follows the general rules' safety rule: when two places disagree, the cell stays blank.

import { FIELDS, type Found, type Line, type Page, type TextItem } from './piExtract.ts'
import { fmtNum, plain } from './num.ts'

/** One remembered place. `how`: 'beside' = the value is `offset` pieces after the label on the same line (0 = in the
 *  label's own piece, after it); 'under' = the value is the first value under the column heading `label`;
 *  'row' = the value is in a year-by-year table under the column heading `label`, on the row given by `row`;
 *  'na' = ops set this field to NA for this plan (no such rider, no cash value, no campaign); `label` is "na".
 *  `factor`: the PI shows the value divided by this (12 = a monthly premium that ops turned into a yearly one).
 *  `cut`: for words, the character the value ends at in its piece ("," in "Client Quote, Male, 40"), or "". */
export interface LearnedRule {
  insurer: string
  field: string
  how: 'beside' | 'under' | 'row' | 'na'
  label: string
  offset: number
  factor: number
  cut: string
  /** The plan (policy name) of the PI it was learned from. A place found only once is trusted only on PIs of that
   *  plan; for another plan of the same insurer, two places must agree. */
  plan: string
  /** For 'row': 'term' = the row of the last policy year (the policy term), 'last' = the table's last row. */
  row?: '' | 'term' | 'last'
  /** Ops corrected the reader's own value here (not just filled a blank): on the next PI of this insurer the learned
   *  value replaces the reader's, as the reader's rules got this field wrong for this insurer before. */
  corrects?: boolean
}

/** What a 'row' place needs to find its row: the policy term of the PI being read. */
export interface ReadContext { policyTerm?: string }

/** Fields that can be learned: values copied (or worked out by a fixed factor) from one place in the PI. Benefits
 *  ("Included"), campaigns and the currency code are not, as ops write those in their own words. */
const KINDS: Record<string, 'number' | 'words'> = {}
for (const f of FIELDS) {
  if (['money', 'sum', 'years', 'age'].includes(f.kind)) KINDS[f.key] = 'number'
  else if (f.kind === 'text' && f.key !== 'campaigns') KINDS[f.key] = 'words'
}
const FACTORS: Record<string, number[]> = { money: [1, 12, 4, 2] }

/** Gender and smoker status are written many ways ("Man", "M", "non-smoker", "Non-tobacco"); they are learned and
 *  read as the comparison's own words, and anything else at that place reads as blank. */
const CANON: Record<string, (s: string) => string> = {
  gender: (s) => (s = s.replace(/\(.*?\)/g, ''), /^(?:male|man|m)$/i.test(s.trim()) ? 'Male' : /^(?:female|woman|f)$/i.test(s.trim()) ? 'Female' : ''),
  underwriting_class: (s) => {
    const t = s.replace(/\(.*?\)/g, '').trim().toLowerCase().replace(/[\s-]+/g, ' ')
    if (/^(?:non smoker|nonsmoker|non tobacco|non tobacco user|ns)$/.test(t)) return 'Non-Smoker'
    if (/^(?:smoker|tobacco|tobacco user|s)$/.test(t)) return 'Smoker'
    return ''
  },
}

export const normLabel = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').replace(/\s*:\s*$/, '').trim()
/** A label without a bracketed currency sign ("Paid To-Date ($)" -> "paid to-date"): labels never keep "$". */
export const cleanLabel = (s: string) => normLabel(s).replace(/\(\s*(?:[a-z]{0,2}\$|sgd|usd|myr|rm|cad)\s*\)/g, ' ').replace(/\s+/g, ' ').replace(/\s*:\s*$/, '').trim()
/** A label as compared when reading: OCR often reads "II" as "Il" or "l1", "O" as "0", and drops or adds brackets
 *  and dots, so those are made the same on both sides. */
export const labelKey = (s: string) => cleanLabel(s).replace(/[()[\]{}.,:;'"`’]/g, '').replace(/[il1|!]/g, 'i').replace(/0/g, 'o').replace(/\s+/g, ' ').trim()
/** The part of `piece` after a label written as `label` (OCR-tolerant), or null when the piece does not start with it. */
function afterLabel(piece: string, label: string): string | null {
  const lower = piece.toLowerCase().replace(/\s+/g, ' ')
  if (lower.startsWith(label)) return piece.slice(lower.indexOf(label) + label.length)
  const want = labelKey(label)
  if (!want || !labelKey(piece).startsWith(want)) return null
  for (let k = 1; k <= piece.length; k++) if (labelKey(piece.slice(0, k)) === want && !/[a-z0-9]/i.test(piece[k] ?? '')) return piece.slice(k)
  return null
}
/** Leading ":" or "-" that some layouts put in a piece of their own or before the value (": Mr VIP"). */
const stripLead = (s: string) => s.replace(/^\s*[:–-]\s*/, '')
const isPunct = (s: string) => /^[\s:–\-.]*$/.test(s)
const normWords = (s: string) => s.replace(/\s+/g, ' ').replace(/\s+([,.])/g, '$1').trim()
export const insurerKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
/** insurerKey, OCR-tolerant: "Term (Il)" and "Term (II)" give the same key. */
const fuzzyKey = (s: string) => insurerKey(s).replace(/[il1]/g, 'i').replace(/0/g, 'o')
/** Fields ops may set to NA for a plan, and that are remembered as such. */
export const NA_FIELDS = ['accidental_death', 'tpd_sa', 'tpd_premium', 'ci_sa', 'ci_premium', 'cash_value', 'campaigns']

const NUM_IN = /(?:^|[\s($:])(?:S\$|US\$|C\$|A\$|HK\$|RM|SGD|USD|MYR|CAD|\$)?\s?(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)(?![\d,]|\.\d)/gi
/** Every number in a piece of text. */
function numbersIn(s: string): number[] {
  return [...(' ' + s).matchAll(NUM_IN)].map((m) => Number(m[1].replace(/,/g, '')))
}
const close = (a: number, b: number) => Math.abs(a - b) <= Math.max(0.006, Math.abs(b) * 0.0001)
const hasLetters = (s: string) => (s.match(/[A-Za-z]/g) ?? []).length >= 3
const isNumberish = (s: string) => /^[\s\d,.$%()\-–/:]*(?:S\$|US\$|RM|SGD|MYR|USD)?[\s\d,.$%()\-–/:]*$/i.test(s)

/** How a field's value is written in the comparison. */
function format(field: string, n: number): string {
  const kind = FIELDS.find((f) => f.key === field)?.kind
  if (kind === 'money') return n.toFixed(2)
  if (kind === 'years' || kind === 'age') return String(Math.round(n))
  return Number.isInteger(n) ? String(n) : n.toFixed(2)
}

const parts = (l: Line) => l.text.split(/\s{2,}/)
const overlapX = (a: TextItem, b: TextItem) => a.x <= b.x + b.w + 6 && b.x <= a.x + a.w + 6

/** A label is not kept when it carries anything about the client (their name, date of birth) or looks like a contact
 *  detail, so nothing personal is ever stored. */
function safeLabel(label: string, personal: string[], colon = false): boolean {
  const l = label.toLowerCase()
  if (!hasLetters(label) || label.length > 60) return false
  if (/@|www\.|https?:|\+?\d[\d\s-]{7,}\d|\b\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}\b/.test(label)) return false
  // No amounts in a label ("Monthly payment: $31.00"): a label must never carry a value.
  if (/[$€£]|\bRM\b|\d,\d{3}|\d\.\d|\d{3,}/i.test(label)) return false
  // A label looks like a label: a few words, not a piece of a sentence ("as an illustration, for").
  const w = l.replace(/[^a-z0-9 ]+/g, ' ').trim().split(/\s+/)
  if (w.length > 6 || label.length > 45 || /[;•]|\($/.test(label)) return false
  // "Specially prepared for  :  Mr VIP": a label may end in "for" when the PI puts a ":" after it.
  if (!colon && /^(?:for|of|the|to|in|within|is|are|at|by|and|or|a|an|with|from|on|we|you|your|shall|pay|will|be)$/.test(w[w.length - 1])) return false
  return !personal.some((p) => p.trim().length >= 2 && l.includes(p.toLowerCase().trim()))
}

// ---------- Reading with remembered places ----------

interface Hit { value: string; page: number; line: string }

/** The numbers in the column under heading `h`, top to bottom: the rows of a year-by-year table. Pieces with no
 *  letters ("($)") are passed over; the column ends at words or at a wide gap (another table or page part). */
function columnBelow(items: TextItem[], h: TextItem): TextItem[] {
  const below = items.filter((i) => i !== h && i.y < h.y - 2 && overlapX(i, h)).sort((a, b) => b.y - a.y)
  const out: TextItem[] = []
  let lastY = h.y
  for (const b of below) {
    if (lastY - b.y > 80) break
    if (hasLetters(b.str) && !/^\s*age\s+\d/i.test(b.str)) { if (out.length) break; else continue }
    lastY = b.y
    if (numbersIn(b.str).length === 1 && isNumberish(b.str)) out.push(b)
  }
  return out
}
/** The policy year that starts the row of `cell` ("5/49", or "5" in a column of its own); null when none. */
function rowYear(items: TextItem[], cell: TextItem): number | null {
  const first = items.filter((i) => Math.abs(i.y - cell.y) < 3).sort((a, b) => a.x - b.x)[0]
  const m = first?.str.trim().match(/^(\d{1,3})(?:\s*\/\s*\d{1,3})?(?:\s|$)/)
  return m && first !== cell ? +m[1] : null
}

function readRule(pages: Page[], r: LearnedRule, ctx: ReadContext = {}): Hit[] {
  const kind = KINDS[r.field]
  const out: Hit[] = []
  // NA needs no place in the PI; it holds only on the same plan (readLearned checks the plan is named in the PI).
  if (r.how === 'na') return [{ value: 'NA', page: 0, line: `Ops set this to NA for ${r.plan || 'this plan'} before` }]
  if (r.how === 'beside') {
    for (const p of pages) for (const l of p.lines) {
      const ps = parts(l)
      for (let i = 0; i < ps.length; i++) {
        let piece: string | undefined
        if (r.offset === 0) {
          const rest = afterLabel(ps[i], r.label)
          if (rest === null || !rest.trim()) continue
          piece = rest.replace(/^\s*:?\s*/, '')
        } else {
          if (labelKey(ps[i]) !== labelKey(r.label)) continue
          piece = ps[i + r.offset]
        }
        if (!piece) continue
        const v = valueFrom(piece, kind, r)
        if (v) out.push({ value: v, page: l.page, line: l.text })
      }
    }
  } else if (r.how === 'row') {
    for (const p of pages) {
      const items = p.items.filter((i) => i.str.trim())
      for (const h of items.filter((i) => labelKey(i.str) === labelKey(r.label))) {
        const cells = columnBelow(items, h)
        let cell: TextItem | undefined
        if (r.row === 'last') cell = cells[cells.length - 1]
        else if (r.row === 'term' && ctx.policyTerm && /^\d+$/.test(ctx.policyTerm)) cell = cells.find((c) => rowYear(items, c) === +ctx.policyTerm!)
        if (!cell) continue
        const v = valueFrom(cell.str, kind, r)
        if (v) out.push({ value: v, page: p.page, line: `${h.str.trim()} … ${r.row === 'last' ? 'last row' : `policy year ${ctx.policyTerm}`}: ${cell.str.trim()}` })
      }
    }
  } else {
    for (const p of pages) {
      const items = p.items.filter((i) => i.str.trim())
      for (const h of items.filter((i) => labelKey(i.str) === labelKey(r.label))) {
        const below = items.filter((i) => i !== h && i.y < h.y - 2 && i.y > h.y - 60 && overlapX(i, h)).sort((a, b) => b.y - a.y)
        for (const b of below.slice(0, 2)) {
          const v = valueFrom(b.str, kind, r)
          if (v) { out.push({ value: v, page: p.page, line: `${h.str.trim()} … ${b.str.trim()}` }); break }
          if (/\d/.test(b.str)) break
        }
      }
    }
  }
  return out
}

function valueFrom(piece: string, kind: 'number' | 'words', r: LearnedRule): string {
  if (kind === 'number') {
    const n = numbersIn(piece)[0]
    return n === undefined ? '' : format(r.field, n * r.factor)
  }
  let v = stripLead(piece).trim()
  if (CANON[r.field]) {
    // `cut` "," + n: the n-th comma part ("Male, 40, Non-Smoker"); "" = the whole piece.
    if (r.cut) { const n = Number(r.cut.slice(1)) || 0; v = v.split(/[,/]/)[n] ?? '' }
    return CANON[r.field](v)
  }
  if (r.cut) { const at = v.indexOf(r.cut); if (at > 0) v = v.slice(0, at) }
  v = v.replace(/\s+([,.])/g, '$1').replace(/[\s,;:]+$/, '').trim()
  return v && hasLetters(v) && v.length <= 80 ? v : ''
}

/** The insurer whose remembered places fit this PI: the one the reader found, or else one whose name (as ops wrote
 *  it when teaching) is written in the PI, the most often written one when there are several. Labels alone never
 *  pick an insurer: many insurers use the same headings. */
export function pickInsurer(pages: Page[], rules: LearnedRule[], insurerFound: string): string {
  const keys = [...new Set(rules.map((r) => insurerKey(r.insurer)))].filter(Boolean)
  const found = insurerKey(insurerFound)
  if (found && keys.includes(found)) return found
  const text = ' ' + insurerKey(pages.flatMap((p) => p.lines.map((l) => l.text)).join(' ')) + ' '
  const count = (k: string) => text.split(` ${k} `).length - 1
  const named = keys.map((k) => ({ k, n: count(k) })).filter((x) => x.n > 0)
  if (found) { const near = named.find((x) => x.k.startsWith(found) || found.startsWith(x.k)); if (near) return near.k }
  named.sort((a, b) => b.n - a.n)
  return named[0]?.k ?? ''
}

/** Values read with the remembered places of this PI's insurer. A field whose places disagree is left out. */
export function readLearned(pages: Page[], rules: LearnedRule[], insurerFound: string, ctx: ReadContext = {}): { found: Record<string, Found & { learned: true; corrects?: boolean }>; insurer: string; conflicts: string[] } {
  const key = pickInsurer(pages, rules, insurerFound)
  const found: Record<string, Found & { learned: true; corrects?: boolean }> = {}
  const conflicts: string[] = []
  if (!key) return { found, insurer: '', conflicts }
  const mine = rules.filter((r) => insurerKey(r.insurer) === key)
  const text = ' ' + insurerKey(pages.flatMap((p) => p.lines.map((l) => l.text)).join(' ')) + ' '
  const fuzzyText = ' ' + fuzzyKey(text) + ' '
  const planNamed = (plan: string) => fuzzyKey(plan).length >= 3 && fuzzyText.includes(` ${fuzzyKey(plan)} `)
  // The policy term first: 'row' places of other fields find their row with it.
  const fields = [...new Set(mine.map((r) => r.field))].sort((a, b) => +(b === 'policy_term') - +(a === 'policy_term'))
  const here = { ...ctx }
  // The same place saved twice in OCR spellings ("term (ii)", "term (il)") counts once.
  const placeKey = (r: LearnedRule) => [r.how, labelKey(r.label), r.offset, r.factor, r.cut, r.row ?? ''].join('|')
  for (const field of fields) {
    const all = mine.filter((r) => r.field === field)
    const places = all.filter((r, i) => all.findIndex((x) => placeKey(x) === placeKey(r) && insurerKey(x.plan) === insurerKey(r.plan)) === i)
    // An NA counts only on a PI of the plan ops set it for.
    const read = places.filter((r) => r.how !== 'na' || (!!r.plan && planNamed(r.plan))).map((r) => ({ r, hits: readRule(pages, r, here) })).filter((x) => x.hits.length)
    const hits = read.flatMap((x) => x.hits)
    const values = [...new Set(hits.map((h) => h.value))]
    // One place alone may be a heading that means something else in this PI (another plan from the same insurer),
    // so it counts only on a PI of the plan it was learned from, and only when ops' value sat in that one place.
    if (values.length === 1 && read.length === 1) {
      const r = read[0].r
      const samePlan = !!r.plan && planNamed(r.plan)
      if (!samePlan || places.filter((p) => p.plan === r.plan).length > 1) continue
    }
    if (values.length === 1) {
      found[field] = { value: values[0], page: hits[0].page || null, line: hits[0].line, learned: true, corrects: read.some((x) => x.r.corrects) }
      if (field === 'policy_term' && !here.policyTerm) here.policyTerm = values[0]
    }
    else if (values.length > 1) conflicts.push(FIELDS.find((f) => f.key === field)?.label ?? field)
  }
  return { found, insurer: mine[0].insurer, conflicts }
}

// ---------- Learning ----------

/** The places in this PI that hold `value` for `field`, as rules. */
function placesFor(pages: Page[], field: string, value: string, personal: string[], ctx: ReadContext = {}): Omit<LearnedRule, 'insurer' | 'plan'>[] {
  const kind = KINDS[field]
  const fkind = FIELDS.find((f) => f.key === field)?.kind ?? ''
  const out: Omit<LearnedRule, 'insurer' | 'plan'>[] = []
  const add = (r: Omit<LearnedRule, 'insurer' | 'plan' | 'field'>, colon = false) => {
    // A label kept as ops' PI shows it, without a bracketed currency sign; an offset-0 label stays as written, as the
    // value follows it in the same piece.
    if (r.offset !== 0 || r.how !== 'beside') r = { ...r, label: cleanLabel(r.label) }
    if (!safeLabel(r.label, personal, colon)) return
    if (!out.some((o) => o.how === r.how && labelKey(o.label) === labelKey(r.label) && o.offset === r.offset && (o.row ?? '') === (r.row ?? ''))) out.push({ field, ...r })
  }
  if (kind === 'number') {
    const v = Number(value.replace(/[^\d.]/g, ''))
    if (!Number.isFinite(v) || v <= 0 || !/^\s*[\d,]+(?:\.\d+)?\s*$/.test(value)) return []
    for (const factor of FACTORS[fkind] ?? [1]) {
      const want = v / factor
      for (const p of pages) {
        // Beside: the nearest piece before it on the line that is words, not numbers.
        for (const l of p.lines) {
          const ps = parts(l)
          ps.forEach((piece, i) => {
            const n = numbersIn(piece)[0]
            if (n === undefined || !close(n, want)) return
            // In its own piece: "Annualized Premium: $372.00".
            const before = piece.slice(0, piece.search(/(?:S\$|US\$|C\$|RM|SGD|USD|MYR|\$)?\s?\d/i)).trim()
            if (hasLetters(before) && numbersIn(piece).length === 1) add({ how: 'beside', label: normLabel(before), offset: 0, factor, cut: '' })
            for (let j = i - 1; j >= 0 && i - j <= 4; j--) {
              if (isNumberish(ps[j])) continue
              add({ how: 'beside', label: normLabel(ps[j]), offset: i - j, factor, cut: '' })
              break
            }
          })
        }
        // Under: a column heading straight above it, with no other value between.
        const items = p.items.filter((i) => i.str.trim())
        for (const it of items) {
          const n = numbersIn(it.str)[0]
          if (n === undefined || !close(n, want) || numbersIn(it.str).length > 1) continue
          const above = items.filter((i) => i !== it && i.y > it.y + 2 && i.y < it.y + 60 && overlapX(i, it)).sort((a, b) => a.y - b.y)
          const first = above[0]
          if (!first) continue
          const head = !/\d/.test(first.str) || hasLetters(first.str) ? (hasLetters(first.str) ? first : above[1] && hasLetters(above[1].str) && !/\d{2}/.test(first.str) ? above[1] : null) : null
          if (head && head.str.trim().length <= 45 && !isNumberish(head.str)) add({ how: 'under', label: normLabel(head.str), offset: 0, factor, cut: '' })
          // Row: deeper in a year-by-year table, under its column heading, on the policy term's row or the last row.
          // Only sums and premiums (totals to date, values at the end): terms and ages are not read from tables.
          if (!['money', 'sum'].includes(fkind)) continue
          const col = items.filter((i) => i !== it && i.y > it.y + 2 && overlapX(i, it)).sort((a, b) => a.y - b.y)
          const heading = col.find((i) => hasLetters(i.str) && !isNumberish(i.str) && !/^\s*age\s+\d/i.test(i.str))
          if (!heading || heading.str.trim().length > 45 || !columnBelow(items, heading).includes(it)) continue
          if (columnBelow(items, heading)[0] === it) continue // the first value under the heading: that is 'under'
          const label = normLabel(heading.str)
          if (ctx.policyTerm && rowYear(items, it) === +ctx.policyTerm) add({ how: 'row', label, offset: 0, factor, cut: '', row: 'term' })
          const cells = columnBelow(items, heading)
          if (cells[cells.length - 1] === it) add({ how: 'row', label, offset: 0, factor, cut: '', row: 'last' })
        }
      }
      if (out.length) break // the plainest factor that finds the value wins (monthly x 12 only when the yearly is nowhere)
    }
  } else if (CANON[field]) {
    const want = CANON[field](value)
    if (!want) return []
    for (const p of pages) {
      for (const l of p.lines) {
        const ps = parts(l)
        ps.forEach((piece, i) => {
          const bits = piece.split(/[,/]/)
          // "Gender: Male" in one piece.
          const m = piece.match(/^([^:]{3,40}):\s*(.+)$/)
          if (m && CANON[field](m[2]) === want && hasLetters(m[1])) add({ how: 'beside', label: normLabel(m[1]), offset: 0, factor: 1, cut: '' })
          // The label is the piece before, passing over a ":" written as a piece of its own.
          let j = i - 1
          while (j > 0 && isPunct(ps[j])) j--
          bits.forEach((bit, n) => {
            if (CANON[field](stripLead(bit)) !== want || j < 0 || i === 0 || isNumberish(ps[j])) return
            add({ how: 'beside', label: normLabel(ps[j]), offset: i - j, factor: 1, cut: bits.length > 1 ? `,${plain(n)}` : '' })
          })
        })
      }
      const items = p.items.filter((i) => i.str.trim())
      for (const it of items) {
        if (CANON[field](it.str) !== want) continue
        const above = items.filter((i) => i !== it && i.y > it.y + 2 && i.y < it.y + 40 && overlapX(i, it)).sort((a, b) => a.y - b.y)[0]
        if (above && hasLetters(above.str) && above.str.trim().length <= 45 && !CANON[field](above.str)) add({ how: 'under', label: normLabel(above.str), offset: 0, factor: 1, cut: '' })
      }
    }
  } else if (kind === 'words') {
    const want = normWords(value)
    if (want.length < 2) return []
    for (const p of pages) {
      for (const l of p.lines) {
        const ps = parts(l)
        ps.forEach((piece, i) => {
          const np = normWords(stripLead(piece))
          const at = np.indexOf(want)
          if (at < 0) return
          const after = np.slice(at + want.length)
          const cut = after.trim() ? after.trim()[0] : ''
          // "Plan: Term 20" in one piece.
          const before = np.slice(0, at).trim()
          // The label is the piece before, passing over a ":" written as a piece of its own ("Plan  :  Term 20").
          let j = i - 1
          while (j > 0 && isPunct(ps[j])) j--
          if (before && hasLetters(before) && /:$/.test(before) && !cut) add({ how: 'beside', label: normLabel(before), offset: 0, factor: 1, cut: '' }, true)
          else if (at === 0 && j >= 0 && i > 0 && !isNumberish(ps[j])) add({ how: 'beside', label: normLabel(ps[j]), offset: i - j, factor: 1, cut: /[,;(/]/.test(cut) ? cut : '' }, /:\s*$/.test(ps[j]) || ps.slice(j + 1, i).some((x) => x.includes(':')) || /^\s*:/.test(piece))
        })
      }
      const items = p.items.filter((i) => i.str.trim())
      for (const it of items) {
        if (normWords(it.str) !== want) continue
        const above = items.filter((i) => i !== it && i.y > it.y + 2 && i.y < it.y + 40 && overlapX(i, it)).sort((a, b) => a.y - b.y)[0]
        if (above && hasLetters(above.str) && above.str.trim().length <= 45) add({ how: 'under', label: normLabel(above.str), offset: 0, factor: 1, cut: '' })
      }
    }
  }
  return out
}

/**
 * The places to remember from a saved comparison column: for each field ops filled in or corrected (or kept as read
 * by the general rules), where that value sits in the PI. A place is kept only when, read back on this same PI, it
 * gives exactly that value (every time it appears). `found` is what the reader gave; values from layout rules that
 * ops kept are already known and not learned again. Values the AI helper filled that ops kept are learned, so the
 * next PI of that insurer needs no AI for them.
 */
export function learn(pages: Page[], values: Record<string, string>, found: Record<string, Found | undefined>, insurer: string): LearnedRule[] {
  if (!insurer.trim()) return []
  const personal = [values.insured_name, values.date_of_birth].filter(Boolean)
  const out: LearnedRule[] = []
  const plan = (values.policy_name ?? '').trim()
  // NA (no such rider, no cash value, no campaign): remembered for this plan, unless the reader gave NA itself.
  for (const field of NA_FIELDS) {
    if (!plan || !/^(?:NA|N\/A|-)$/i.test((values[field] ?? '').trim())) continue
    const f = found[field]
    if (f?.value === 'NA' && !f.guess && !(f as { learned?: boolean }).learned) continue
    const corrects = !!f?.value && f.value !== 'NA' && !f.guess && !(f as { learned?: boolean }).learned
    out.push({ insurer: insurer.trim(), plan, field, how: 'na', label: 'na', offset: 0, factor: 1, cut: '', ...(corrects ? { corrects: true } : {}) })
  }
  for (const field of Object.keys(KINDS)) {
    const value = (values[field] ?? '').trim()
    if (!value || /^(?:NA|N\/A|-)$/i.test(value)) continue
    const f = found[field]
    const fromLayout = f && f.value === value && !f.guess && !f.ai && !(f as { learned?: boolean }).learned && !/^Calculated:/.test(f.line ?? '') && f.page !== null
    if (fromLayout) continue
    const ctx = { policyTerm: (values.policy_term ?? '').trim() }
    // Ops changed what the reader's own rules gave (not a blank, not a general-rules guess): remember that too.
    const corrects = !!f?.value && !f.guess && !f.ai && !(f as { learned?: boolean }).learned && f.value !== value
    for (const r of placesFor(pages, field, value, field === 'insured_name' || field === 'date_of_birth' ? [] : personal, ctx)) {
      const rule: LearnedRule = { insurer: insurer.trim(), plan: (values.policy_name ?? '').trim(), ...r, ...(corrects ? { corrects: true } : {}) }
      const back = [...new Set(readRule(pages, rule, ctx).map((h) => h.value))]
      const same = (a: string) => CANON[field] ? a === CANON[field](value) : (KINDS[field] === 'number' ? close(Number(a), Number(value)) || Math.abs(Number(a) - Number(value)) < 0.011 : normWords(a) === normWords(value))
      if (back.length === 1 && same(back[0])) out.push(rule)
    }
  }
  return out
}

/**
 * Adds the values read with learned places to what the reader found. Values from layout rules stay as they are.
 * A learned value takes the place of a blank, or of a general-rules guess (ops taught the place for this insurer,
 * so it is the better reading). Returns the notes to show ops.
 */
export function applyLearned(found: Record<string, Found>, pages: Page[], rules: LearnedRule[]): { found: Record<string, Found>; notes: string[]; insurer: string } {
  if (!rules.length) return { found, notes: [], insurer: '' }
  const { found: learned, insurer, conflicts } = readLearned(pages, rules, found.insurer?.value ?? '', { policyTerm: found.policy_term?.value })
  const out = { ...found }
  let used = 0
  const replaced: string[] = []
  for (const [k, f] of Object.entries(learned)) {
    const now = out[k]
    if (now?.value === f.value) continue
    // The reader's own value stays, unless ops corrected that field for this insurer before.
    if (now?.value && !now.guess && !now.check && !f.corrects) continue
    if (now?.value && !now.guess && !now.check) replaced.push(`${FIELDS.find((x) => x.key === k)?.label ?? k} (the reader gave ${now.value})`)
    const { corrects: _c, ...keep } = f
    out[k] = keep
    used++
  }
  // Names as ops wrote them before: an OCR spelling ("Term (Il)") of a plan name ops saved for this insurer
  // ("Term (II)") is put back to theirs.
  const mineRules = rules.filter((r) => insurerKey(r.insurer) === insurerKey(insurer))
  const fixed: string[] = []
  const pn = out.policy_name
  if (pn?.value) {
    const known = [...new Set(mineRules.map((r) => r.plan).filter(Boolean))].find((p) => p !== pn.value && fuzzyKey(p) === fuzzyKey(pn.value))
    if (known) { fixed.push(`Policy Name (read as ${pn.value})`); out.policy_name = { ...pn, value: known, line: `${pn.line ?? ''} (spelled as ops saved it for ${insurer})` } }
  }
  const ins = out.insurer
  if (ins?.value && insurer && ins.value !== insurer && fuzzyKey(ins.value) === fuzzyKey(insurer)) { fixed.push(`Insurer (read as ${ins.value})`); out.insurer = { ...ins, value: insurer } }
  const notes: string[] = []
  if (fixed.length) notes.push(`Spelled as ops saved before for ${insurer}: ${fixed.join(', ')}.`)
  if (used) notes.push(`${fmtNum(used)} value${used === 1 ? '' : 's'} read from places ops taught for ${insurer} (tagged "Learned"). Please check them.`)
  if (replaced.length) notes.push(`Ops corrected these for ${insurer} before, so the taught place was used instead of the reader's rules: ${replaced.join(', ')}.`)
  if (conflicts.length) notes.push(`Places taught for ${insurer} gave different values for ${conflicts.join(', ')}, so ${conflicts.length === 1 ? 'it was' : 'they were'} left blank.`)
  return { found: out, notes, insurer }
}
