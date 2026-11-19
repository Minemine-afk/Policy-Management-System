// "Teach a new insurer": when ops fill in or correct the PI comparison and save it, remember WHERE each value sat in
// that PI (the words beside it, or the column heading above it), per insurer. The next PI from that insurer is read
// with those places first. Only label words and positions are kept, never a value: no client name, date of birth,
// sum or premium is stored. A place is kept only when it finds exactly the value ops gave in the PI it came from.
//
// Reading with learned places follows the general rules' safety rule: when two places disagree, the cell stays blank.

import { FIELDS, type Found, type Line, type Page, type TextItem } from './piExtract.ts'

/** One remembered place. `how`: 'beside' = the value is `offset` pieces after the label on the same line (0 = in the
 *  label's own piece, after it); 'under' = the value is the first value under the column heading `label`.
 *  `factor`: the PI shows the value divided by this (12 = a monthly premium that ops turned into a yearly one).
 *  `cut`: for words, the character the value ends at in its piece ("," in "Client Quote, Male, 40"), or "". */
export interface LearnedRule {
  insurer: string
  field: string
  how: 'beside' | 'under'
  label: string
  offset: number
  factor: number
  cut: string
  /** The plan (policy name) of the PI it was learned from. A place found only once is trusted only on PIs of that
   *  plan; for another plan of the same insurer, two places must agree. */
  plan: string
}

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
const normWords = (s: string) => s.replace(/\s+/g, ' ').replace(/\s+([,.])/g, '$1').trim()
export const insurerKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

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
function safeLabel(label: string, personal: string[]): boolean {
  const l = label.toLowerCase()
  if (!hasLetters(label) || label.length > 60) return false
  if (/@|www\.|https?:|\+?\d[\d\s-]{7,}\d|\b\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}\b/.test(label)) return false
  // No amounts in a label ("Monthly payment: $31.00"): a label must never carry a value.
  if (/[$€£]|\bRM\b|\d,\d{3}|\d\.\d|\d{3,}/i.test(label)) return false
  // A label looks like a label: a few words, not a piece of a sentence ("as an illustration, for").
  const w = l.replace(/[^a-z0-9 ]+/g, ' ').trim().split(/\s+/)
  if (w.length > 6 || label.length > 45 || /[;•]|\($/.test(label)) return false
  if (/^(?:for|of|the|to|in|within|is|are|at|by|and|or|a|an|with|from|on|we|you|your|shall|pay|will|be)$/.test(w[w.length - 1])) return false
  return !personal.some((p) => p.trim().length >= 2 && l.includes(p.toLowerCase().trim()))
}

// ---------- Reading with remembered places ----------

interface Hit { value: string; page: number; line: string }

function readRule(pages: Page[], r: LearnedRule): Hit[] {
  const kind = KINDS[r.field]
  const out: Hit[] = []
  if (r.how === 'beside') {
    for (const p of pages) for (const l of p.lines) {
      const ps = parts(l)
      for (let i = 0; i < ps.length; i++) {
        const own = normLabel(ps[i])
        let piece: string | undefined
        if (r.offset === 0) {
          if (!own.startsWith(r.label) || own === r.label) continue
          piece = ps[i].slice(ps[i].toLowerCase().replace(/\s+/g, ' ').indexOf(r.label) + r.label.length).replace(/^\s*:?\s*/, '')
        } else {
          if (own !== r.label) continue
          piece = ps[i + r.offset]
        }
        if (!piece) continue
        const v = valueFrom(piece, kind, r)
        if (v) out.push({ value: v, page: l.page, line: l.text })
      }
    }
  } else {
    for (const p of pages) {
      const items = p.items.filter((i) => i.str.trim())
      for (const h of items.filter((i) => normLabel(i.str) === r.label)) {
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
  let v = piece.trim()
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
export function readLearned(pages: Page[], rules: LearnedRule[], insurerFound: string): { found: Record<string, Found & { learned: true }>; insurer: string; conflicts: string[] } {
  const key = pickInsurer(pages, rules, insurerFound)
  const found: Record<string, Found & { learned: true }> = {}
  const conflicts: string[] = []
  if (!key) return { found, insurer: '', conflicts }
  const mine = rules.filter((r) => insurerKey(r.insurer) === key)
  const text = ' ' + insurerKey(pages.flatMap((p) => p.lines.map((l) => l.text)).join(' ')) + ' '
  const planNamed = (plan: string) => insurerKey(plan).length >= 3 && text.includes(` ${insurerKey(plan)} `)
  for (const field of new Set(mine.map((r) => r.field))) {
    const places = mine.filter((r) => r.field === field)
    const read = places.map((r) => ({ r, hits: readRule(pages, r) })).filter((x) => x.hits.length)
    const hits = read.flatMap((x) => x.hits)
    const values = [...new Set(hits.map((h) => h.value))]
    // One place alone may be a heading that means something else in this PI (another plan from the same insurer),
    // so it counts only on a PI of the plan it was learned from, and only when ops' value sat in that one place.
    if (values.length === 1 && read.length === 1) {
      const r = read[0].r
      const samePlan = !!r.plan && planNamed(r.plan)
      if (!samePlan || places.filter((p) => p.plan === r.plan).length > 1) continue
    }
    if (values.length === 1) found[field] = { value: values[0], page: hits[0].page, line: hits[0].line, learned: true }
    else if (values.length > 1) conflicts.push(FIELDS.find((f) => f.key === field)?.label ?? field)
  }
  return { found, insurer: mine[0].insurer, conflicts }
}

// ---------- Learning ----------

/** The places in this PI that hold `value` for `field`, as rules. */
function placesFor(pages: Page[], field: string, value: string, personal: string[]): Omit<LearnedRule, 'insurer' | 'plan'>[] {
  const kind = KINDS[field]
  const fkind = FIELDS.find((f) => f.key === field)?.kind ?? ''
  const out: Omit<LearnedRule, 'insurer' | 'plan'>[] = []
  const add = (r: Omit<LearnedRule, 'insurer' | 'plan' | 'field'>) => {
    if (!safeLabel(r.label, personal)) return
    if (!out.some((o) => o.how === r.how && o.label === r.label && o.offset === r.offset)) out.push({ field, ...r })
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
          bits.forEach((bit, n) => {
            if (CANON[field](bit) !== want || i === 0 || isNumberish(ps[i - 1])) return
            add({ how: 'beside', label: normLabel(ps[i - 1]), offset: 1, factor: 1, cut: bits.length > 1 ? `,${n}` : '' })
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
          const np = normWords(piece)
          const at = np.indexOf(want)
          if (at < 0) return
          const after = np.slice(at + want.length)
          const cut = after.trim() ? after.trim()[0] : ''
          // "Plan: Term 20" in one piece.
          const before = np.slice(0, at).trim()
          if (before && hasLetters(before) && /:$/.test(before) && !cut) add({ how: 'beside', label: normLabel(before), offset: 0, factor: 1, cut: '' })
          else if (at === 0 && i > 0 && !isNumberish(ps[i - 1])) add({ how: 'beside', label: normLabel(ps[i - 1]), offset: 1, factor: 1, cut: /[,;(/]/.test(cut) ? cut : '' })
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
 * ops kept are already known and not learned again.
 */
export function learn(pages: Page[], values: Record<string, string>, found: Record<string, Found | undefined>, insurer: string): LearnedRule[] {
  if (!insurer.trim()) return []
  const personal = [values.insured_name, values.date_of_birth].filter(Boolean)
  const out: LearnedRule[] = []
  for (const field of Object.keys(KINDS)) {
    const value = (values[field] ?? '').trim()
    if (!value || /^(?:NA|N\/A|-)$/i.test(value)) continue
    const f = found[field]
    const fromLayout = f && f.value === value && !f.guess && !(f as { learned?: boolean }).learned && !/^Calculated:/.test(f.line ?? '') && f.page !== null
    if (fromLayout) continue
    for (const r of placesFor(pages, field, value, field === 'insured_name' || field === 'date_of_birth' ? [] : personal)) {
      const rule: LearnedRule = { insurer: insurer.trim(), plan: (values.policy_name ?? '').trim(), ...r }
      const back = [...new Set(readRule(pages, rule).map((h) => h.value))]
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
  const { found: learned, insurer, conflicts } = readLearned(pages, rules, found.insurer?.value ?? '')
  const out = { ...found }
  let used = 0
  for (const [k, f] of Object.entries(learned)) {
    const now = out[k]
    if (now?.value && !now.guess) continue
    out[k] = f
    used++
  }
  const notes: string[] = []
  if (used) notes.push(`${used} value${used === 1 ? '' : 's'} read from places ops taught for ${insurer} (tagged "Learned"). Please check them.`)
  if (conflicts.length) notes.push(`Places taught for ${insurer} gave different values for ${conflicts.join(', ')}, so ${conflicts.length === 1 ? 'it was' : 'they were'} left blank.`)
  return { found: out, notes, insurer }
}
