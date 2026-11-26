// A bare upload becomes a searchable product (Kumar, 25 Nov 2026): a Product Summary or rate sheet is read in the
// browser (fixed rules, nothing leaves the computer) and kb_auto_product puts what was found on a product record,
// which goes into Compare products at once, tagged "Auto-read, not yet reviewed".
// Only what the reader actually found is sent; anything it did not find stays blank (never guessed). Optionally the
// free AI helper (kbAi.ts, in the browser too) is asked about what the rules left blank; what it fills is tagged "AI".
import { supabase } from './supabase'
import { readFile, readRates, readSummary, readableName, type ReadDoc, type RatesResult, type SummaryResult } from './kbExtract'
import { askKbAi, blankOf, kbAskKeys, mergeKbFill } from './kbAi'
import { fmtNum, plain } from './num'
import { AI_NO_MEMORY, AI_SWITCHED, AI_SWITCH_TEXT } from './aiConfig'
import { aiHow } from './aiSay'
import { missingText } from './kbAdmin'
import { FINANCING, TERM, planLabel } from './families'
import { readFinancing, type FinancingResult } from './kbFinancing'

/** Document types read into a product record on upload. A bank's Product Financing document is read into a
 *  Premium financing record (kbFinancing.ts). */
export const READ_TYPES = ['Product Summary', 'Rate sheet', 'Product Financing']
export const FINANCING_DOC = 'Product Financing'
export const readsInto = (docType: string, fileName: string | null | undefined) => READ_TYPES.includes(docType) && readableName(fileName)

export interface Reading {
  kind: 'summary' | 'rates' | 'financing'; summary?: SummaryResult; rates?: RatesResult; error?: string
  /** A financing document as read (its `summary` is the same reading, for the shared steps). */
  financing?: FinancingResult
  /** The document as read, for the AI helper. */
  doc?: ReadDoc
  /** What the AI helper filled (record field names and fact keys). */
  ai?: string[]
}

/** The AI prefix in a record's auto_fields: "ai:entry_age" = the entry ages were filled by the AI helper. */
export const AI_MARK = 'ai:'
export const aiKeysOf = (fields: string[] | null | undefined) => (fields ?? []).filter((x) => x.startsWith(AI_MARK)).map((x) => x.slice(AI_MARK.length))

/** Reads a file the person picked (or downloaded). Never throws: a file it can't read comes back with an error. */
export async function readUpload(data: ArrayBuffer, name: string, docType: string, onProgress?: (t: string) => void): Promise<Reading> {
  const kind = docType === 'Rate sheet' ? 'rates' : docType === FINANCING_DOC ? 'financing' : 'summary'
  try {
    const doc = await readFile(data, name, (done, total, ocr) => onProgress?.(`Reading ${name}: page ${plain(Math.min(total, Math.floor(done) + 1))} of ${plain(total)}${ocr ? ' (scanned, reading the picture)' : ''}…`))
    if (kind === 'financing') { const f = readFinancing(doc); return { kind, financing: f, summary: f, doc } }
    if (kind === 'summary') return { kind, summary: readSummary(doc), doc }
    const r = readRates(doc)
    return { kind, rates: r, error: r.error || undefined }
  } catch (e) {
    return { kind, error: `Couldn't read ${name}: ${e instanceof Error ? e.message : String(e)}` }
  }
}

/** What the reading sends to kb_auto_product (only the values found). */
export function autoPayload(r: Reading, target: Target) {
  const found: string[] = []
  const record: Record<string, unknown> = {}
  const facts: Record<string, { v: string; page?: number }> = {}
  if (r.summary) {
    for (const [k, v] of Object.entries(r.summary.record)) {
      if (k === 'name' || k === 'insurer') continue
      record[k] = v
      found.push(k === 'entry_age_min' || k === 'entry_age_max' ? 'entry_age' : k)
    }
    for (const [k, f] of Object.entries(r.summary.facts)) { facts[k] = { v: f.v, page: f.page }; found.push(k) }
  }
  for (const k of r.ai ?? []) found.push(AI_MARK + k)
  const rates = r.rates && !r.rates.error ? r.rates.rates : []
  if (rates.length) found.push('_rates')
  const notes = [...(r.summary?.notes ?? []), ...(r.rates?.notes ?? []), ...(r.error ? [r.error] : [])].join(' ')
  // The plan type: the one chosen on the upload form, else the one the document says (never guessed: left out when neither).
  const product_type = r.financing ? FINANCING : target.product_type || r.summary?.planType || undefined
  const fin = r.financing ? { fin_rates: r.financing.finRates, source: r.financing.source } : {}
  if (r.financing?.finRates.length) found.push('_fin_rates')
  return { product_id: target.product_id || null, insurer: target.insurer.trim(), name: target.name.trim(), product_type, record, facts, rates, ...fin, found: [...new Set(found)], notes }
}

/** How many things the AI helper would be asked about (what the rules left blank); 0 for rate sheets and documents
 *  with nothing on them to ask. Any plan type. */
export function aiAskCount(r: Reading | null): number {
  if (!r?.summary || !r.doc || r.ai) return 0
  return kbAskKeys(r.doc, blankOf(r.summary), r.summary).length
}

/** Asks the free AI helper about what the rules left blank and adds what passes the checks. The model is shared
 *  with the PI comparison (aiModel.ts): loaded once per page. `onText`: a line on how far it has got. */
export async function fillWithAi(r: Reading, onText?: (t: string) => void): Promise<Reading> {
  if (!r.summary || !r.doc) return r
  const { runAi, isOutOfMemory, releaseAi } = await import('./aiModel')
  let how = '', pre = ''
  const fill = await askKbAi(r.doc, blankOf(r.summary), r.summary, async (messages, maxTokens, i, n) => {
    const step = n > 1 ? `, question ${plain(i)} of up to ${plain(n)}` : ''
    onText?.(`${pre}The AI helper is reading the document${how}${step}…`)
    return runAi(messages, (p) => {
      if (p.stage === 'download') { onText?.(`${pre}Downloading the AI model (first time only): ${fmtNum(Math.round((p.pct ?? 0) * 100))}%`); return }
      if (p.model) how = ` (${p.model}${p.device === 'webgpu' ? ', graphics chip' : ', processor: slower'})`
      if (p.stage === 'switch') { how = ''; pre = AI_SWITCHED; onText?.(AI_SWITCH_TEXT); return }
      onText?.(`${pre}The AI helper is reading the document${how}${step}${aiHow({ tokens: p.tokens })}…`)
    }, maxTokens)
  }).catch((e) => {
    // Out of memory: the engine is let go (a reload starts it afresh), and the screen says so in plain words.
    if (!isOutOfMemory(e)) throw e
    releaseAi()
    throw new Error(AI_NO_MEMORY)
  })
  const { summary, aiKeys } = mergeKbFill(r.summary, fill)
  return { ...r, summary, ai: aiKeys }
}

/** Where a reading goes: a product record (by id, or insurer and name), and its plan type (families.ts key). */
export interface Target { product_id?: string | null; insurer: string; name: string; product_type?: string }

/** Every plan type can be a searchable product (Kumar, 25 Nov 2026), once 1v-upgrade.sql has run. Before that the
 *  database knows only term plans: another plan type is kept as a document and makes no product record, so it never
 *  shows up in Compare products as a term plan. */
let plansReady: Promise<boolean> | null = null
export function allPlanTypesReady(): Promise<boolean> {
  plansReady ??= Promise.resolve(supabase.rpc('kb_plan_types')).then(({ error }) => !error, () => false)
  return plansReady
}
/** Empty when the reading can go on a record; else why not (only before 1v-upgrade.sql). */
let finReady: Promise<boolean> | null = null
/** Premium financing records need 1x-upgrade.sql. */
export function financingReady(): Promise<boolean> {
  finReady ??= Promise.resolve(supabase.rpc('kb_plan_types')).then(({ data, error }) => !error && JSON.stringify(data ?? []).includes(FINANCING), () => false)
  return finReady
}
export async function notSavedLine(r: Reading, type: string | undefined): Promise<string> {
  if (r.financing && !await financingReady()) return 'The database does not have the Premium financing category yet (1x-upgrade.sql has not been run), so no product record was made from it. The document is kept in the Knowledge Bank.'
  const t = type || r.summary?.planType || ''
  if (!t || t === TERM || await allPlanTypesReady()) return ''
  return `This Product Summary is for ${planLabel(t)}. The database still takes term plans only (1v-upgrade.sql has not been run), so no product record was made from it. The document is kept in the Knowledge Bank.`
}

/** Puts the reading on a product record. Returns the record's id, and whether it can be found in search; or
 *  `skipped` with the reason (nothing is saved). */
export async function saveReading(docId: string, r: Reading, target: Target) {
  const skip = await notSavedLine(r, target.product_type)
  if (skip) return { skipped: skip }
  const { data, error } = await supabase.rpc('kb_auto_product', { p_doc: docId, p: autoPayload(r, target) })
  if (error) return { error: error.message }
  const id = data as string
  const { data: row } = await supabase.from('kb_products').select('missing, status').eq('id', id).maybeSingle()
  const live = await supabase.from('kb_checked_products').select('id').eq('id', id).maybeSingle()
  return { id, missing: ((row as { missing: string[] } | null)?.missing ?? []), searchable: !!live.data }
}

/** The product name the reader found, for the upload form. */
export const readName = (r: Reading | null) => r?.summary?.record.name?.trim() ?? ''
export const readInsurer = (r: Reading | null) => r?.summary?.record.insurer?.trim() ?? ''

/** One line on what was read, for the upload form. */
export function readingLine(r: Reading): string {
  if (r.financing) {
    const f = r.financing.filled
    return f.length > 1 ? `Read: ${f.join(', ')}.` : 'Nothing could be read from this file. The product record is made; fill in its details on the record.'
  }
  if (r.summary) {
    const f = r.summary.filled
    return f.length ? `Read: ${f.join(', ')}.` : 'Nothing could be read from this file. The product record is made, but it is not searchable until its details are filled in.'
  }
  if (r.rates && !r.rates.error) {
    const ages = r.rates.rates.map((x) => x.age)
    return `Read ${fmtNum(r.rates.rates.length)} premium rates (ages ${plain(Math.min(...ages))} to ${plain(Math.max(...ages))}).`
  }
  return r.error ?? ''
}

/** After a reading is saved: is the product in search, and if not, why. */
export function afterRead(r: { missing: string[]; searchable: boolean }, financing = false) {
  if (financing) return r.missing.length ? `The Premium financing record is made, but the ${missingText(r.missing)} ${r.missing.length > 1 ? 'were' : 'was'} not found: open the record to fill ${r.missing.length > 1 ? 'them' : 'it'} in.`
    : 'It is saved as a Premium financing product record, marked "Auto-read, not yet reviewed". Premium financing is not offered in Compare products for now.'
  const noAges = r.missing.includes('entry_age') ? ' The document does not state the entry ages, so it is marked "Entry ages not stated in the document" and the age filter skips it; open the record to type them in.' : ''
  if (r.searchable) return `The product is in search now (Compare products and the Product Comparison Matrix), marked "Auto-read, not yet reviewed".${noAges}`
  if (r.missing.length) return `The product record is made but is not searchable yet: the ${missingText(r.missing)} ${r.missing.length > 1 ? 'were' : 'was'} not found in the document.`
  return 'The product record is not searchable (withdrawn, or a source document is out of date).'
}
