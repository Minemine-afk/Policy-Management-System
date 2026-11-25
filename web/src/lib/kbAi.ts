// The free AI helper for the Knowledge Bank's Product Summary reader (Kumar, 25 Nov 2026: "the same high level of
// accuracy for all file reading functions on this webapp").
//
// The same in-browser model as the PI comparison's AI helper (aiConfig.ts, aiModel.ts): the document never leaves
// the computer. It is asked ONLY about what the reader's rules left blank, and must answer with the document's own
// words: an exact quote for every value. Each answer is checked against the document before it is used:
//  - the quote must be written in the document (word for word, ignoring capitals and punctuation);
//  - the quote must be about what was asked (a grace period quote must speak of a grace period, an entry age quote
//    of entry or issue ages, not of the age cover ends ...);
//  - numbers (ages, sums assured) must be written in that quote, and make sense (youngest age below oldest ...);
//  - a currency must be named in a quote about the policy's currency.
// Anything that fails stays blank: a blank is better than a wrong value. Values it fills are tagged "AI".
// Rate sheets are not given to the AI: a rate that is written in the sheet can still be put in the wrong age, gender
// or smoker cell, and no check against the text can catch that. The rate reader's table rules stay alone there.
// This file holds the prompts and the checks, shared by the browser and the Node tests (tests/kb-extract).
import { amounts, currenciesIn, ints, isNegative, residencyOf, riderLabel, summaryPages, type ReadDoc, type SummaryResult } from './kbExtract.ts'
import type { ProductRecord } from './kbAdmin'
import { parseAnswer } from './piAi.ts'
import { plain } from './num.ts'
import { FIN_AI_FACTS, FIN_AI_KEYS } from './kbFinancing.ts'
import { isFinancing } from './families.ts'

/** Record fields the AI may fill. Each is one key in the model's answer. */
export const KB_AI_RECORD = ['entry_age', 'sum_assured', 'currencies', 'residency'] as const
type RecKey = (typeof KB_AI_RECORD)[number]

/** Facts the AI may fill: what to ask, the words that find the lines it reads, and what its quote must say.
 *  Exclusions, special provisions, fees, investment and "important considerations" are left out: their text is
 *  too open for a check to tell a right quote from a wrong one. */
export const KB_AI_FACTS: { key: string; ask: string; find: RegExp; must: RegExp[]; not?: RegExp }[] = [
  { key: 'uw', ask: 'the underwriting (medical checks, health questions, guaranteed acceptance)', find: /underwrit|medical (?:exam|evidence|check)|health (?:declaration|question)|guaranteed acceptance/i, must: [/underwrit|medical (?:exam|evidence|check|question)|health (?:declaration|question)|guaranteed acceptance|simplified issue/i], not: /spouse|convert|conversion|renew|increase the sum|without any underwriting|(?:may|can|will) (?:vary|change|differ)|depending on (?:our )?underwriting/i },
  { key: 'premTerm', ask: 'how long premiums are paid (premium payment term)', find: /premium/i, must: [/premium/i, /payable|pay(?:ing|ment)? |term|until|years?|age/i], not: /grace|free[- ]?look|renewal|discount/i },
  { key: 'guaranteed', ask: 'whether the premium rates are guaranteed or can change', find: /guarantee|reviewable|revis/i, must: [/guaranteed|not guaranteed|reviewable|may (?:be )?(?:change|revise|review)|can (?:change|be revised)/i, /premium|rate/i], not: /conversion|convert|insurability|renew/i },
  { key: 'modes', ask: 'how often premiums can be paid (monthly, quarterly, half-yearly, yearly)', find: /monthly|quarterly|half[- ]yearly|semi[- ]annual|annually|yearly|payment (?:mode|frequenc)/i, must: [/monthly|quarterly|half[- ]yearly|semi[- ]annual|annual(?:ly)?|yearly/i, /pay|premium|mode|frequenc/i], not: /grace|for a period of|diagnos/i },
  { key: 'coverTo', ask: 'how long the cover lasts: the policy terms or the age cover ends', find: /policy term|coverage term|cover(?:age)? (?:until|up to|period)|expir|matur|to age|up to age/i, must: [/policy term|coverage (?:term|period)|cover(?:age)? (?:until|up to|ends)|expiry|maturity|term of/i, /\d/], not: /spouse|renew|convert|conversion|rider|grace|days|increase|premium/i },
  { key: 'eci', ask: 'the early or multi-stage critical illness benefit', find: /early|multi[- ]?stage|intermediate/i, must: [/early|multi[- ]?stage|intermediate/i, /critical illness|stage/i, /pay|benefit|cover|sum/i] },
  { key: 'ci', ask: 'the critical illness benefit', find: /critical illness|dread disease/i, must: [/critical illness|dread disease|\bci\b/i, /pay|benefit|cover|sum (?:assured|insured)/i], not: /early|multi[- ]?stage|intermediate|exclu|definition/i },
  { key: 'tpd', ask: 'the total and permanent disability (TPD) benefit', find: /disab|\btpd\b/i, must: [/disab|\btpd\b/i, /pay|benefit|cover|sum (?:assured|insured)/i] },
  { key: 'ti', ask: 'the terminal illness benefit', find: /terminal illness/i, must: [/terminal illness|\bti\b/i, /pay|benefit|cover|sum (?:assured|insured)/i] },
  { key: 'ad', ask: 'the accidental death benefit', find: /accident/i, must: [/accident/i, /death|dies|pay|benefit/i] },
  { key: 'death', ask: 'the death benefit', find: /death|dies|passes away/i, must: [/death|dies|passes away/i, /pay|benefit|sum (?:assured|insured)/i], not: /accident|spouse/i },
  { key: 'conversion', ask: 'the option to convert the policy to another plan', find: /conver/i, must: [/convert|conversion/i] },
  { key: 'renew', ask: 'the option to renew the policy', find: /renew/i, must: [/renew/i], not: /premium amount upon renewal|cancel the automatic renewal/i },
  { key: 'inc', ask: 'the option to increase the cover without medical checks (life events)', find: /increase|insurability/i, must: [/increase|insurability/i, /sum (?:assured|insured)|cover/i] },
  { key: 'cash', ask: 'whether the policy has a cash or surrender value', find: /cash value|surrender value/i, must: [/cash value|surrender value/i] },
  { key: 'dist', ask: 'the total distribution cost', find: /distribution cost/i, must: [/distribution cost/i] },
  { key: 'freelook', ask: 'the free-look period (days to cancel and get premiums back)', find: /free[- ]?look|cancel/i, must: [/free[- ]?look|cancel/i, /\d+\s*days|\b(?:fourteen|twenty[- ]one|thirty) days/i], not: /grace|renew/i },
  { key: 'grace', ask: 'the grace period for paying premiums', find: /grace/i, must: [/grace period/i, /\d+\s*days|\b(?:thirty|sixty|thirty[- ]one) days/i] },
  { key: 'reinstate', ask: 'how a lapsed policy can be reinstated', find: /reinstat|revive|restore/i, must: [/reinstat|revive|restore/i, /lapse|apply|request|within|evidence|health|arrears/i], not: /suicide|will not pay|exclu|date we last|reinstatement date|date of reinstatement/i },
]

// A bank's premium financing document has its own facts (kbFinancing.ts).
KB_AI_FACTS.push(...FIN_AI_FACTS)

/** About 1,500 tokens per question: small enough to read quickly on an office laptop. */
export const KB_MAX_CHARS = 5500
/** Questions are asked a few facts at a time, each with the lines about them: a small model reads better that way. */
const FACT_GROUP = 4

const flat = (s: string) => s.toLowerCase().replace(/[’‘']/g, "'").replace(/[^a-z0-9$]+/g, ' ').trim()

/** The lines a question is read from: lines with its words, the line before and two after (sentences wrap), in
 *  page order, up to `max` characters. */
export function contextFor(doc: ReadDoc, find: RegExp[], max = KB_MAX_CHARS): string {
  const lines = summaryPages(doc).flatMap((p) => p.lines)
  const take = new Set<number>()
  lines.forEach((l, i) => { if (find.some((re) => re.test(l.text))) for (let j = i - 1; j <= i + 2; j++) if (j >= 0 && j < lines.length) take.add(j) })
  const out: string[] = []
  let size = 0, last = -2
  for (const i of [...take].sort((a, b) => a - b)) {
    const t = lines[i].text.trim()
    if (!t) continue
    const s = (i !== last + 1 && out.length ? '...\n' : '') + t
    if (size + s.length + 1 > max) break
    out.push(s); size += s.length + 1; last = i
  }
  return out.join('\n')
}

/** Whether any line of the document has these words. */
const mentions = (doc: ReadDoc, re: RegExp) => doc.pages.some((p) => p.lines.some((l) => re.test(l.text)))

const SYSTEM = 'You read insurance Product Summaries. You copy text exactly as the document writes it, word for word. When the document does not clearly state something, you answer null. You never guess, calculate or reword.'
const ending = (shape: string) => `Answer with one JSON object only, like {${shape}}. Every "quote" must be copied word for word from the document. Use null for anything the document does not state.`

export interface KbQuestion { kind: 'record' | 'facts'; keys: string[]; messages: { role: 'system' | 'user'; content: string }[]; maxTokens: number }

const REC_ASK: Record<RecKey, { ask: string; shape: string; find: RegExp }> = {
  entry_age: { ask: 'the youngest and oldest age a person can be to buy the policy (entry age / issue age), with the sentence that says it', shape: '"entry_age": {"min": 0, "max": 0, "quote": "..."}', find: /entry age|issue age|age at entry|age next birthday|aged? (?:from|between)|eligib|who can (?:apply|buy)/i },
  sum_assured: { ask: 'the minimum and maximum sum assured (sum insured) a policy can have, with the sentence that says it', shape: '"sum_assured": {"min": 0, "max": 0, "quote": "..."}', find: /(?:minimum|maximum|min\.?|max\.?) sum (?:assured|insured)|sum (?:assured|insured) (?:limit|range)/i },
  currencies: { ask: 'the currencies the policy can be bought in (as codes like SGD, USD), with the sentence that says it', shape: '"currencies": {"list": ["SGD"], "quote": "..."}', find: /currenc|denominat/i },
  residency: { ask: 'who can apply for the policy (citizens, permanent residents, foreigners), the sentence that says it', shape: '"residency": {"quote": "..."}', find: /who can apply|citizen|permanent resident|pass holder|foreigner|residen/i },
}

/** The questions for what the reader left blank: one about the record's fields, then the facts a few at a time.
 *  A question whose words the document never uses is not asked (its answer would be blank anyway). */
export function kbQuestions(doc: ReadDoc, blank: { record: string[]; facts: string[] }): KbQuestion[] {
  const out: KbQuestion[] = []
  const rec = (blank.record as RecKey[]).filter((k) => KB_AI_RECORD.includes(k) && mentions(doc, REC_ASK[k].find))
  if (rec.length) {
    const text = contextFor(doc, rec.map((k) => REC_ASK[k].find))
    out.push({
      kind: 'record', keys: rec, maxTokens: 120 + 110 * rec.length,
      messages: [{ role: 'system', content: SYSTEM }, {
        role: 'user',
        content: `Document:\n"""\n${text}\n"""\n\nFrom the document, give:\n${rec.map((k) => `- ${k}: ${REC_ASK[k].ask}`).join('\n')}\n\n${ending(rec.map((k) => REC_ASK[k].shape).join(', '))}`,
      }],
    })
  }
  const facts = KB_AI_FACTS.filter((f) => blank.facts.includes(f.key) && mentions(doc, f.find))
  for (let i = 0; i < facts.length; i += FACT_GROUP) {
    const g = facts.slice(i, i + FACT_GROUP)
    const text = contextFor(doc, g.map((f) => f.find))
    out.push({
      kind: 'facts', keys: g.map((f) => f.key), maxTokens: 60 + 110 * g.length,
      messages: [{ role: 'system', content: SYSTEM }, {
        role: 'user',
        content: `Document:\n"""\n${text}\n"""\n\nFor each item, copy the one sentence from the document that states it:\n${g.map((f) => `- ${f.key}: ${f.ask}`).join('\n')}\n\n${ending(g.map((f) => `"${f.key}": "..."`).join(', '))}`,
      }],
    })
  }
  return out
}

/** What the reader's rules left blank, for kbQuestions. */
export function blankOf(s: SummaryResult): { record: string[]; facts: string[] } {
  const r = s.record
  // A financing document: only its loan currencies and its own facts (a loan has no entry ages or sum assured).
  if (isFinancing(s.planType)) {
    return { record: r.currencies?.length ? [] : ['currencies'], facts: FIN_AI_FACTS.map((f) => f.key).filter((k) => !s.facts[k]?.v) }
  }
  const record: string[] = []
  if (r.entry_age_min == null || r.entry_age_max == null) record.push('entry_age')
  if (r.sa_min == null && r.sa_max == null) record.push('sum_assured')
  if (!r.currencies?.length) record.push('currencies')
  if (!r.residency?.length) record.push('residency')
  return { record, facts: KB_AI_FACTS.map((f) => f.key).filter((k) => !FIN_AI_KEYS.has(k) && !s.facts[k]?.v) }
}

/** What passed the checks: record fields and facts (each fact with its page), and the keys whose answers failed. */
export interface KbAiFill { record: Partial<ProductRecord>; facts: Record<string, { v: string; page: number }>; filled: string[]; dropped: string[] }

/** Where a quote sits in the document: its page, or null when the document does not have it word for word. */
function locate(doc: ReadDoc, quote: string): { page: number; sentence: string; cell?: string } | null {
  const q = flat(quote).split(' ')
  if (!q[0]) return null
  // A short answer (fewer than 4 words) must be a whole table cell next to its label ("Grace period | 30 days"):
  // the checks then read the label and the cell together.
  for (const p of summaryPages(doc)) for (const l of p.lines) {
    const cells = l.text.split(/\s{2,}|\s+[|•]\s+/).map((x) => x.trim()).filter(Boolean)
    const i = cells.findIndex((c) => flat(c) === q.join(' '))
    if (i > 0) return { page: p.page, sentence: cells.join(' | '), cell: cells[i] }
  }
  if (q.length < 4) return null
  for (const p of summaryPages(doc)) {
    // Lines joined both ways: the page as read (columns apart) and as pdf.js gives it (straight across).
    for (const ls of [p.lines, doc.pages.find((x) => x.page === p.page)?.lines ?? []]) {
      const raw = ls.map((l) => l.text).join('\n')
      const words = [...raw.replace(/[’‘]/g, "'").matchAll(/[A-Za-z0-9$']+/g)].map((m) => ({ w: m[0].toLowerCase(), at: m.index!, end: m.index! + m[0].length }))
      for (let i = 0; i + q.length <= words.length; i++) {
        if (!q.every((w, j) => words[i + j].w === w)) continue
        // A quote that runs across rows of a table (label | value) mixes several facts: not one fact's words.
        const spanned = raw.slice(words[i].at, words[i + q.length - 1].end).split('\n')
        if (spanned.length > 1 && (spanned.length > 5 || ls.filter((l) => spanned.some((x) => x.trim() && l.text.includes(x.trim()))).some((l) => l.text.trim().split(/\s{2,}|\s+[|•]\s+/).length >= 2))) return null
        // Inside one row of a table: the row is what the checks read, and the cell is the value (as the rules give it).
        if (spanned.length === 1) {
          const row = ls.find((l) => l.text.includes(spanned[0].trim()))
          const cells = row ? row.text.split(/\s{2,}|\s+[|•]\s+/).map((x) => x.trim()).filter(Boolean) : []
          const cell = cells.find((c) => flat(c).includes(q.join(' ')))
          if (cells.length >= 2 && cell) return { page: p.page, sentence: cells.join(' | '), cell }
        }
        return { page: p.page, sentence: sentenceAround(raw, words[i].at, words[i + q.length - 1].end) }
      }
    }
  }
  return null
}

/** The whole sentence a quote sits in (a model may quote only part of it): from the end of the sentence or bullet
 *  before to the end of this one. The checks read the whole sentence, so a fragment ("with no medical checks")
 *  can't be taken out of a sentence about something else (renewing). */
function sentenceAround(raw: string, from: number, to: number): string {
  let a = from
  // A new line that starts with a capital, a number or a bullet starts a new sentence (after a heading); a wrapped
  // sentence goes on in small letters.
  while (a > 0 && !/[.!?;•]/.test(raw[a - 1]) && !(raw[a - 1] === '\n' && /^\s*(?:[-–•·(\dA-Z])/.test(raw.slice(a)) && !/[,(]\s*$/.test(raw.slice(Math.max(0, a - 3), a - 1)))) a--
  let b = to
  while (b < raw.length && !/[.!?;]/.test(raw[b]) && !(raw[b] === '\n' && /^\s*(?:[-–•·(\dA-Z])/.test(raw.slice(b + 1)) && !/[,(]\s*$/.test(raw.slice(Math.max(0, b - 2), b)))) b++
  const s = raw.slice(a, Math.min(raw.length, b + 1)).replace(/\s+/g, ' ').trim()
  return s.length <= 450 ? s : raw.slice(from, to).replace(/\s+/g, ' ').trim()
}
const quoteOf = (v: unknown): string => (typeof v === 'string' ? v : v && typeof v === 'object' && typeof (v as { quote?: unknown }).quote === 'string' ? (v as { quote: string }).quote : '').replace(/\s+/g, ' ').trim()
const isNull = (v: unknown) => v == null || v === '' || (typeof v === 'string' && /^(?:null|n\/?a|none|unknown|not stated)$/i.test(v.trim()))
const tidy = (q: string) => q.replace(/^[\s•\-–*·]+/, '').replace(/^\(?\d{1,2}[.)]\s+/, '').trim()

/** Checks the model's answers and keeps those that pass. `answers`: the parsed JSON of each question, in order. */
export function checkKbAnswers(doc: ReadDoc, questions: KbQuestion[], answers: (Record<string, unknown> | null)[], known: SummaryResult): KbAiFill {
  const fill: KbAiFill = { record: {}, facts: {}, filled: [], dropped: [] }
  const label = riderLabel({ ...doc, pages: summaryPages(doc) }, known.record.name ?? '')
  // The rules' facts: a quote that repeats one of them belongs to that fact, not to a blank one.
  const usedQuotes = [...Object.values(known.facts).map((f) => flat(f.v.replace(/^Rider \([^)]*\):\s*/, '')))]
  const clash = (q: string) => usedQuotes.some((u) => u.length >= 20 && (u.includes(q) || q.includes(u)))
  questions.forEach((qn, i) => {
    const a = answers[i]
    if (!a) return
    for (const key of qn.keys) {
      const raw = a[key]
      if (isNull(raw) || (typeof raw === 'object' && raw && isNull((raw as { quote?: unknown }).quote) && !('list' in raw) && !('min' in raw))) continue
      const quote = quoteOf(raw)
      const at = quote ? locate(doc, quote) : null
      const drop = () => { fill.dropped.push(key) }
      if (!at || quote.length > 500) { drop(); continue }
      // The checks read the whole sentence the quote is in.
      const sent = at.sentence
      if (qn.kind === 'record') {
        const o = raw as Record<string, unknown>
        if (key === 'entry_age') {
          // An entry age quote speaks of entering or applying, not of when cover ends or renews.
          const ns = ints(sent)
          const min = Number(o.min), max = Number(o.max)
          const ok = /entry|issue age|age at (?:entry|inception|application)|aged?\s+(?:from|between)|age next birthday|eligib|who can (?:apply|buy)|to apply/i.test(sent)
            && !/expir|matur|cover(?:age)? (?:until|up to|ends?)|renew|conver|reaches age|policy term|terminat/i.test(sent)
            && Number.isInteger(min) && Number.isInteger(max) && min >= 0 && max <= 100 && min < max && max >= 18 && ns.includes(min) && ns.includes(max)
          if (!ok) { drop(); continue }
          fill.record.entry_age_min = min; fill.record.entry_age_max = max; fill.filled.push('entry age')
        } else if (key === 'sum_assured') {
          const ns = amounts(sent)
          const min = o.min == null ? null : Number(String(o.min).replace(/[^\d.]/g, '')), max = o.max == null ? null : Number(String(o.max).replace(/[^\d.]/g, ''))
          const ok = /sum (?:assured|insured)|coverage amount/i.test(sent) && /minimum|maximum|\bmin\b|\bmax\b|at least|up to|from|between|limit/i.test(sent)
            && !/spouse|counsel|legal|session|premium (?:of|is)|per (?:day|month)|claim/i.test(sent)
            && (min == null || (min >= 1000 && ns.includes(min))) && (max == null || (max >= 1000 && ns.includes(max))) && (min != null || max != null) && (min == null || max == null || min < max)
          if (!ok) { drop(); continue }
          if (min != null) { fill.record.sa_min = min; fill.filled.push('minimum sum assured') }
          if (max != null) { fill.record.sa_max = max; fill.filled.push('maximum sum assured') }
        } else if (key === 'currencies') {
          const list = Array.isArray(o.list) ? [...new Set(o.list.map((x) => String(x).toUpperCase().trim()))].sort() : []
          const named = currenciesIn(sent).sort()
          // The quote must be about the policy's currency and name exactly the currencies given.
          if (!/currenc|denominat/i.test(sent) || !list.length || JSON.stringify(list) !== JSON.stringify(named)) { drop(); continue }
          fill.record.currencies = currenciesIn(sent); fill.filled.push('policy currencies')
        } else if (key === 'residency') {
          const r = residencyOf(sent)
          if (!r.length || !/apply|eligib|must be|open to|available to|offered to|can (?:buy|be insured)/i.test(sent) || /beneficiar|nominee|payout|claim|tax|fatca|crs/i.test(sent)) { drop(); continue }
          fill.record.residency = r; fill.filled.push('who can apply')
        }
        continue
      }
      const rule = KB_AI_FACTS.find((f) => f.key === key)!
      const q = tidy(at.sentence)
      // A table row read as one line: drop its heading ("Underwriting Full medical underwriting").
      const value = (at.cell ?? q).replace(key === 'uw' ? /^underwriting\s*:?\s+(?=\S.*underwrit)/i : /^$/, '')
      if (q.length < 8 || !rule.must.every((re) => re.test(q)) || (rule.not && rule.not.test(q)) || clash(flat(value))) { drop(); continue }
      fill.facts[key] = { v: label(at.page, value), page: at.page }
    }
  })
  // One quote given for two facts: which it belongs to can't be told, so neither is kept.
  const byQuote = new Map<string, string[]>()
  for (const [k, f] of Object.entries(fill.facts)) byQuote.set(flat(f.v), [...(byQuote.get(flat(f.v)) ?? []), k])
  for (const ks of byQuote.values()) if (ks.length > 1) for (const k of ks) { delete fill.facts[k]; fill.dropped.push(k) }
  const n = Object.keys(fill.facts).length
  if (n) fill.filled.push(`${plain(n)} fact${n === 1 ? '' : 's'}`)
  return fill
}

/** The reading with the AI's values added (only where it was blank), the AI's keys (as the record names them, for
 *  the "AI" tag), and TPD / critical illness ticked when the AI found such a cover and the rules said nothing. */
export function mergeKbFill(s: SummaryResult, fill: KbAiFill): { summary: SummaryResult; aiKeys: string[] } {
  const summary: SummaryResult = { ...s, record: { ...s.record }, facts: { ...s.facts }, filled: [...s.filled], notes: [...s.notes] }
  const aiKeys: string[] = []
  for (const [k, v] of Object.entries(fill.record) as [keyof ProductRecord, never][]) {
    if (summary.record[k] != null && !(Array.isArray(summary.record[k]) && !(summary.record[k] as unknown[]).length)) continue
    ;(summary.record as Record<string, unknown>)[k] = v
    aiKeys.push(k === 'entry_age_min' || k === 'entry_age_max' ? 'entry_age' : k)
  }
  for (const [k, f] of Object.entries(fill.facts)) {
    if (summary.facts[k]?.v) continue
    summary.facts[k] = f; aiKeys.push(k)
  }
  const yes = (k: string) => !!summary.facts[k] && !isNegative(summary.facts[k].v)
  if (summary.record.has_tpd == null && aiKeys.includes('tpd')) summary.record.has_tpd = yes('tpd')
  if (summary.record.has_ci == null && (aiKeys.includes('ci') || aiKeys.includes('eci'))) summary.record.has_ci = yes('ci') || yes('eci')
  if (aiKeys.length) summary.filled.push(`by the AI helper: ${fill.filled.join(', ')}`)
  return { summary, aiKeys: [...new Set(aiKeys)] }
}

export { parseAnswer }
