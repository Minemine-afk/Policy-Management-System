// The optional AI helper for the PI reader (Kumar, 25 Nov 2026: "add the free AI option for now").
//
// It runs a small free, open model (Apache 2.0) IN THE BROWSER: the PI text never leaves the user's computer, only the
// model's files are downloaded (once, then cached by the browser). It only fills cells the reader's rules left
// BLANK, and every value it gives must pass checks against the PI's own text before it is used:
//  - an amount, sum assured, term or age must be a number written in the PI (an annual premium may also be a
//    monthly, quarterly or half-yearly amount written in the PI, times 12, 4 or 2);
//  - an insurer or plan name must be words written in the PI;
//  - a premium's frequency (monthly, yearly...) must agree with the PI's own wording next to it;
//  - a rider's value must sit next to the rider's name, and a rider premium can't be the plan's own premium.
// Anything that fails a check is dropped (the cell stays blank). Values it fills are tagged "AI" for ops to check.
// This file holds the prompt and the checks, shared by the browser (aiModel.ts) and the Node tests.
import { KNOWN_INSURERS, detectInsurer, type Found, type Page } from './piExtract.ts'
import { fmtNum, plain } from './num.ts'

/** The fields the AI is asked about. Client particulars (name, date of birth, gender, smoker, residency) are not:
 *  the request form fills those when the PI lacks them. Benefit covers and campaigns are not either: their rules
 *  ("NA" against blank, an optional rider against an included one) are too fine for a small model. */
export const AI_FIELDS: { key: string; ask: string; kind: 'name' | 'money' | 'annual' | 'years' | 'age' }[] = [
  { key: 'insurer', ask: 'the insurance company name', kind: 'name' },
  { key: 'policy_name', ask: 'the plan (product) name, without the company name', kind: 'name' },
  { key: 'policy_term', ask: 'the policy term or coverage period, in years (a number)', kind: 'years' },
  { key: 'premium_term', ask: 'the premium payment term, in years (a number)', kind: 'years' },
  { key: 'cover_age', ask: 'the age the cover ends at (a number), only if the document says it', kind: 'age' },
  { key: 'death_sa', ask: 'the death benefit / sum assured / coverage amount', kind: 'money' },
  { key: 'annual_premium', ask: 'the total premium to pay, with how often it is paid', kind: 'annual' },
  { key: 'base_premium', ask: 'the premium of the basic plan alone (without riders), with how often it is paid', kind: 'annual' },
  { key: 'tpd_sa', ask: 'the total & permanent disability (TPD) rider sum assured, only if there is such a rider', kind: 'money' },
  { key: 'tpd_premium', ask: 'the TPD rider premium, with how often it is paid', kind: 'annual' },
  { key: 'ci_sa', ask: 'the critical illness (CI) rider sum assured, only if there is such a rider', kind: 'money' },
  { key: 'ci_premium', ask: 'the CI rider premium, with how often it is paid', kind: 'annual' },
]

/** About 2,000 tokens: enough for the pages that hold a PI's summary, small enough to read quickly on a laptop. */
export const MAX_CHARS = 7000

const KEYWORDS = /premium|sum\s+(?:assured|insured)|coverage|benefit|death|term|plan|policy|product|insur|age\b|annual|month|year|disab|critical|illness|rider|amount|cost|face/i

/** The PI text the model reads: the first pages whole (they hold the summary), then lines with words that matter,
 *  up to MAX_CHARS. Year-by-year table rows after the first few are left out. */
export function promptText(pages: Page[], max = MAX_CHARS): string {
  const out: string[] = []
  let size = 0
  const add = (s: string) => { if (size + s.length + 1 > max) return false; out.push(s); size += s.length + 1; return true }
  const used = new Set<string>()
  for (const p of pages.slice(0, 2)) {
    for (const l of p.lines) {
      const t = l.text.trim()
      if (!t || used.has(t)) continue
      used.add(t)
      if (!add(t)) return out.join('\n')
    }
  }
  let rows = 0
  for (const p of pages.slice(2)) {
    for (const l of p.lines) {
      const t = l.text.trim()
      if (!t || used.has(t)) continue
      const tableRow = /^\d{1,3}\s+\d{1,3}\b/.test(t) && (t.match(/\d[\d,.]*/g) ?? []).length >= 4
      if (tableRow ? ++rows > 6 : !KEYWORDS.test(t)) continue
      used.add(t)
      if (!add(t)) return out.join('\n')
    }
  }
  return out.join('\n')
}

/** The chat messages for the model: the PI text and the fields still blank. */
export function buildMessages(pages: Page[], keys: string[]): { role: 'system' | 'user'; content: string }[] {
  const ask = AI_FIELDS.filter((f) => keys.includes(f.key))
  const shape = ask.map((f) => f.kind === 'annual' ? `"${f.key}": {"amount": "...", "per": "year|month|quarter|half-year"}` : `"${f.key}": "..."`).join(', ')
  return [
    { role: 'system', content: 'You read life insurance policy illustrations and quotes. You copy values exactly as the document writes them. When the document does not clearly state a value, you answer null. You never guess or calculate.' },
    {
      role: 'user',
      content: `Document:\n"""\n${promptText(pages)}\n"""\n\nFrom the document, give:\n${ask.map((f) => `- ${f.key}: ${f.ask}`).join('\n')}\n\n`
        + `Answer with one JSON object only, like {${shape}}. Copy numbers as written. Use null for anything the document does not state.`,
    },
  ]
}

/** The first {...} object in the model's answer, or null. */
export function parseAnswer(text: string): Record<string, unknown> | null {
  const s = text.replace(/<think>[\s\S]*?<\/think>/g, '')
  const start = s.indexOf('{')
  if (start < 0) return null
  let depth = 0
  for (let i = start; i < s.length; i++) {
    if (s[i] === '{') depth++
    else if (s[i] === '}' && --depth === 0) {
      try { return JSON.parse(s.slice(start, i + 1)) } catch { return null }
    }
  }
  return null
}

const amountOf = (raw: unknown): number | null => {
  if (typeof raw === 'number') return Number.isFinite(raw) && raw > 0 ? raw : null
  if (typeof raw !== 'string') return null
  const m = raw.replace(/\s/g, '').match(/^(?:[A-Z]{0,3}\$|[A-Z]{3}|RM)?(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)(?:[A-Z]{3})?$/i)
  if (!m) return null
  const n = Number(m[1].replace(/,/g, ''))
  return n > 0 ? n : null
}
/** Every number written in the PI (commas dropped), e.g. "$1,000,000.00" -> 1000000. */
export function numbersIn(pages: Page[]): Set<number> {
  const set = new Set<number>()
  for (const p of pages) for (const l of p.lines) {
    for (const m of l.text.matchAll(/(?<![\d.])(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)(?![\d]|\s*%)/g)) set.add(Number(m[1].replace(/,/g, '')))
  }
  return set
}
/** A line and up to 8 lines above it on the same page, as one text. */
const contextOf = (lines: { page: number; text: string }[], line: { page: number; text: string }) => {
  const i = lines.indexOf(line)
  return lines.slice(Math.max(0, i - 8), i + 1).filter((l) => l.page === line.page).map((l) => l.text).join(' \n ')
}
/** Names that say only what kind of plan it is ("Term Life Insurance"), not which. */
const GENERIC = /^(?:(?:level|renewable|decreasing|term|life|whole|insurance|assurance|plan|policy|product|basic|coverage|protection|the|a|of|and|premium)\s*)+$/
/** Words that make an answer a description, not a plan's name ("Non-Participating Term Plan", "Life Client Quote"). */
const NOT_A_NAME = /\b(?:non participating|participating|client|quote|illustration|summary|disclosure|sheet|proposal|benefit illustration)\b/
/** A company's name: "... Ltd", "... Insurance", "... Assurance", "... Financial", "... Bank", "... Berhad". */
const COMPANY = /\b(?:ltd|limited|inc|insurance|assurance|financial|bank|berhad|bhd|company|co\.|group|corporation)\b/i
/** Words in plan names, not company names. */
const PLAN_WORDS = /\b(?:term|protect\w*|plan|secure|shield|cover|guard|care|essential|plus|saver|elite|first)\b/i
const LIMIT = /\bup\s+to\b|maximum|\bmax\b|minimum|\bmin\b|\blimit|exceed|\bcap\b/i
const WORKED = /\d\s*[x×]\s*[\d.]+\s*=/i
/** An age in such a line is a renewal, conversion or benefit limit, not the age this policy's cover ends. */
const NOT_COVER_END = /renew|convert|conversion|prior\s+to|before|attain|entry|issue\s+age|disab|\btpd\b|critical|minimum|maximum|illustrat|years?[\s-]+old/i
/** An age where the cover ends is written as such: "expires at age 85", "cover up to age 80", "maturity age", or under a
 *  column heading such as "Coverage Provided To Age" (the line or the 3 above it). */
const COVER_END = /expir|matur|\bends?\b|until\s+(?:the\s+)?age|till\s+age|to\s+age|cover(?:ed|age|s)?\s+(?:to|until|till)|terminat/i
/** A list number ("5. What are...") or a row of year numbers ("1 2 3 4 5"), not a term. */
const LIST_LINE = /^\s*\d{1,2}\.\s|\b1\s+2\s+3\b/
const TERM_WORDS = /term|year|yrs?\b|pay|period|age|duration|T-?\d|\d\s*-?\s*(?:yr|year)/i
const DATE_LIKE = /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2}\b|\b\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\b|\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}/i
/** Another amount on the same line within 10% of this one ("RM 102,000.00  RM 100,000.00" for two options): which
 *  one is this policy's can't be told from the line. */
const rivals = (line: string, n: number) => [...line.matchAll(/\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g)].map((m) => Number(m[0].replace(/,/g, ''))).some((x) => x !== n && Math.abs(x - n) <= 0.1 * n)
const flat = (s: string) => s.toLowerCase().replace(/[’']/g, "'").replace(/[^a-z0-9'&]+/g, ' ').trim()
const show = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2))

export interface AiFill { found: Record<string, Found>; dropped: string[] }

/** Checks the model's answer against the PI and turns what passes into reader values tagged `ai`. Only `keys`
 *  (the blank cells) are taken. `known`: the cells already filled (by the rules or by hand), to cross-check
 *  against. `dropped` names the answers that failed a check. */
export function checkAnswer(answer: Record<string, unknown> | null, pages: Page[], keys: string[], known: Record<string, string> = {}): AiFill {
  const found: Record<string, Found> = {}
  const dropped: string[] = []
  if (!answer) return { found, dropped }
  const nums = numbersIn(pages)
  const lines = pages.flatMap((p) => p.lines)
  const text = ' ' + flat(lines.map((l) => l.text).join(' ')) + ' '
  const lineWith = (needle: string) => lines.find((l) => flat(l.text).includes(needle)) ?? null
  const lineWithNum = (n: number) => lines.find((l) => [...l.text.matchAll(/\d[\d,]*(?:\.\d+)?(?![\d.]|\s*%)/g)].some((m) => Number(m[0].replace(/,/g, '')) === n)) ?? null
  const put = (key: string, value: string, line: { page: number; text: string } | null) => {
    found[key] = { value, page: line?.page ?? null, line: line?.text ?? null, ai: true }
  }

  for (const f of AI_FIELDS) {
    if (!keys.includes(f.key)) continue
    const raw = answer[f.key]
    if (raw === null || raw === undefined || raw === '' || (typeof raw === 'string' && /^(?:null|n\/?a|none|unknown|not stated)$/i.test(raw.trim()))) continue
    if (f.kind === 'name') {
      if (typeof raw !== 'string') { dropped.push(f.key); continue }
      const v = raw.replace(/\s+/g, ' ').replace(/[®™]/g, '').trim()
      const words = flat(v)
      if (!words || words.length < 2 || words.length > 60 || !text.includes(` ${words} `) || /^\d+$/.test(words) || GENERIC.test(words) || NOT_A_NAME.test(words)) { dropped.push(f.key); continue }
      if (f.key === 'insurer') {
        // An insurer is one the reader knows (given by its short name), or a name that reads like a company's.
        const known = detectInsurer(v)
        // "Acme Life" is a company's name, "Life Term Protect Secure" a plan's.
        const lifeCo = /\blife\b/i.test(v) && v.split(/\s+/).length <= 3 && !PLAN_WORDS.test(v)
        if (!known && !COMPANY.test(v) && !lifeCo) { dropped.push(f.key); continue }
        put(f.key, known || v, lineWith(words))
        continue
      }
      // The plan name without the insurer in front ("iA Financial Group Term 20" -> "Term 20"), as the reader gives it.
      const ins = (found.insurer?.value ?? known.insurer ?? '').trim()
      const heads = [ins.split(/\s+/)[0], ...KNOWN_INSURERS.flatMap((x) => [x.name, ...x.aliases])].filter(Boolean).sort((a, b) => b.length - a.length)
      const head = heads.find((h) => flat(v).startsWith(flat(h) + ' '))
      const name = head ? v.replace(new RegExp(`^\\s*${head.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')}\\s+`, 'i'), '').replace(/^\s*(?:financial\s+group|life(?:\s+assurance|\s+insurance)?|insurance|assurance)?\s+/i, '').trim() : v
      if (!flat(name) || GENERIC.test(flat(name))) { dropped.push(f.key); continue }
      put(f.key, name, lineWith(words))
    } else if (f.kind === 'money') {
      const n = amountOf(raw)
      const line = n === null ? null : lineWithNum(n)
      // "up to RM1,000,000", "maximum", "minimum": a product limit, not this policy's cover.
      if (n === null || !nums.has(n) || n < 1000 || !line || LIMIT.test(line.text) || WORKED.test(line.text) || rivals(line.text, n)) { dropped.push(f.key); continue }
      put(f.key, show(n), line)
    } else if (f.kind === 'years' || f.kind === 'age') {
      const n = amountOf(raw)
      // A term under 5 years is too rare in term plans to tell from a footnote number ("® 1"): left for ops.
      const ok = n !== null && Number.isInteger(n) && nums.has(n) && (f.kind === 'years' ? n >= 5 && n <= 100 : n >= 30 && n <= 120)
      // A term in years is never the N of "To Age N" (that is an age).
      // Nor the N of "every N policy years" (how often a benefit is paid).
      const isAge = (t: string) => new RegExp(`\\b(?:age\\s*(?:of\\s*)?|every\\s+)${plain(n!)}\\b`, 'i').test(t)
      // Its line must be about a term or an age, not a date ("September 12, 2024") or a phone number.
      // A premium term's line must speak of paying ("premium", "pay"), so the cover's length is not taken for it.
      const words = f.key === 'premium_term' ? /premium|pay/i : TERM_WORDS
      const l = ok ? lines.find((x) => [...x.text.matchAll(/\d[\d,]*(?:\.\d+)?(?![\d.]|\s*%)/g)].some((m) => Number(m[0].replace(/,/g, '')) === n) && words.test(x.text) && !DATE_LIKE.test(x.text) && !LIST_LINE.test(x.text) && !(f.kind === 'years' && isAge(x.text)) && !(f.kind === 'age' && (NOT_COVER_END.test(x.text) || !COVER_END.test(contextOf(lines, x).split(' \n ').slice(-4).join(' '))))) : undefined
      if (!ok || !l) { dropped.push(f.key); continue }
      put(f.key, String(n), l)
    } else {
      const o = (raw && typeof raw === 'object' ? raw : { amount: raw, per: 'year' }) as { amount?: unknown; per?: unknown }
      const n = amountOf(o.amount)
      const per = String(o.per ?? 'year').toLowerCase()
      const times = /month/.test(per) ? 12 : /quarter/.test(per) ? 4 : /half|semi/.test(per) ? 2 : /year|annual|^$/.test(per) ? 1 : 0
      if (n === null || !times || !nums.has(n)) { dropped.push(f.key); continue }
      const line = lineWithNum(n)
      // How often the PI says this amount is paid: its own line and the lines above it on that page (a column
      // heading such as "Initial Monthly Premium"). The model's "per" must agree, so a monthly figure is never taken
      // as yearly, and a yearly one is never multiplied by 12.
      const ctx = line ? contextOf(lines, line) : ''
      const says = { 12: /month|\/\s*mo\b/i, 4: /quarter/i, 2: /half[\s-]*year|semi[\s-]*annual/i, 1: /annual|yearly|per\s+year|\/\s*y(?:ea)?r\b|per\s+annum|p\.\s?a\./i } as Record<number, RegExp>
      // The amount's own line decides when it names a frequency; else the lines above it.
      const freq = (t: string) => Object.keys(says).map(Number).filter((k) => says[k].test(t))
      const named = line && freq(line.text).length ? freq(line.text) : freq(ctx)
      // The distribution cost (commission) is not a premium, though it sits beside one in SG PIs.
      if (/distribution|commission/i.test(contextOf(lines, line ?? { page: -1, text: '' }).split(' \n ').slice(-3).join(' '))) { dropped.push(f.key); continue }
      // A single premium is not a yearly one; a worked example ("RM200,000 x 4.92 = RM984.00") is not this policy's.
      if (!line || (times > 1 ? !named.includes(times) : named.length > 0 && !named.includes(1)) || /single\s+premium/i.test(ctx) || WORKED.test(line.text) || rivals(line.text, n)) { dropped.push(f.key); continue }
      // A monthly premium times 12 only when the PI shows no yearly premium at all (paying yearly is often cheaper).
      if (times > 1 && /annual|yearly|per\s+annum/i.test(text)) { dropped.push(f.key); continue }
      // When the PI has a "Total" premium line, the total premium must be read from it, not from the plan's own line.
      if (f.key === 'annual_premium' && !/total/i.test(line.text) && lines.some((x) => /^\s*total\b[^\d]*\d/i.test(x.text) || /total\s+(?:annual\s+)?premium/i.test(x.text))) { dropped.push(f.key); continue }
      const value = (Math.round(n * times * 100) / 100).toFixed(2)
      put(f.key, value, line)
      if (times > 1) found[f.key].line = `${line!.text} (${fmtNum(n)} × ${plain(times)} a year)`
    }
  }
  // A rider value must sit next to the rider's name (TPD / critical illness) in the PI, and a rider premium can't be
  // the plan's own premium: a small model easily copies the base premium into every premium cell.
  const rider: Record<string, RegExp> = { tpd: /disab|\btpd\b/i, ci: /critical|\bci\b|dread/i }
  const premiums = ['annual_premium', 'base_premium'].map((k) => found[k]?.value ?? known[k] ?? '').filter(Boolean).map(Number)
  for (const k of ['tpd_sa', 'tpd_premium', 'ci_sa', 'ci_premium']) {
    const fd = found[k]
    if (!fd) continue
    const l = lines.find((x) => x.page === fd.page && fd.line?.startsWith(x.text))
    const near = l ? (rider[k.slice(0, k.indexOf('_'))].test(l.text) || rider[k.slice(0, k.indexOf('_'))].test(contextOf(lines, l).split(' \n ').slice(-3).join(' '))) : false
    if (!near || (k.endsWith('premium') && premiums.includes(Number(fd.value)))) { delete found[k]; dropped.push(k) }
  }
  if (found.tpd_premium && found.ci_premium && found.tpd_premium.value === found.ci_premium.value) { delete found.tpd_premium; delete found.ci_premium; dropped.push('tpd_premium', 'ci_premium') }
  // A premium term longer than the policy term, or a rider larger than the death cover, means the model mixed things up.
  const nv = (k: string) => (found[k] ? Number(found[k].value) : null)
  if (nv('premium_term') !== null && nv('policy_term') !== null && nv('premium_term')! > nv('policy_term')!) { delete found.premium_term; delete found.policy_term; dropped.push('premium_term', 'policy_term') }
  for (const k of ['tpd_sa', 'ci_sa']) if (nv(k) !== null && nv('death_sa') !== null && nv(k)! > nv('death_sa')!) { delete found[k]; dropped.push(k) }
  const kv = (k: string) => nv(k) ?? (known[k] && !isNaN(Number(known[k])) ? Number(known[k]) : null)
  if (nv('death_sa') === null && kv('death_sa') !== null) for (const k of ['tpd_sa', 'ci_sa']) if (nv(k) !== null && nv(k)! > kv('death_sa')!) { delete found[k]; dropped.push(k) }
  // A premium is a small part of the cover: one at 20% or more of the death sum assured is a sum assured misread.
  if (kv('death_sa') !== null) for (const k of ['annual_premium', 'base_premium', 'tpd_premium', 'ci_premium']) if (nv(k) !== null && nv(k)! >= 0.2 * kv('death_sa')!) { delete found[k]; dropped.push(k) }
  // The base plan's premium equal to the total, where the PI says its amounts include riders: the total was copied.
  if (found.base_premium && nv('base_premium') === kv('annual_premium')) {
    const l = lines.find((x) => x.page === found.base_premium.page && found.base_premium.line?.startsWith(x.text))
    if (!l || /rider|supplementary/i.test(contextOf(lines, l))) { delete found.base_premium; dropped.push('base_premium') }
  }
  if (nv('base_premium') !== null && kv('annual_premium') !== null && nv('base_premium')! > kv('annual_premium')!) { delete found.base_premium; dropped.push('base_premium') }
  return { found, dropped }
}

/** The cells the AI may fill: blank after the reader's rules and the taught places. */
export const blankKeys = (found: Record<string, Found | undefined>) => AI_FIELDS.map((f) => f.key).filter((k) => !found[k]?.value)
