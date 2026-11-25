// A bare upload becomes a searchable product (Kumar, 25 Nov 2026): a Product Summary or rate sheet is read in the
// browser (fixed rules, no AI, nothing leaves the computer) and kb_auto_product puts what was found on a product
// record, which goes into Compare products at once, tagged "Auto-read, not yet reviewed".
// Only what the reader actually found is sent; anything it did not find stays blank (never guessed).
import { supabase } from './supabase'
import { readFile, readRates, readSummary, readableName, type RatesResult, type SummaryResult } from './kbExtract'
import { fmtNum, plain } from './num'
import { missingText } from './kbAdmin'

export const READ_TYPES = ['Product Summary', 'Rate sheet']
export const readsInto = (docType: string, fileName: string | null | undefined) => READ_TYPES.includes(docType) && readableName(fileName)

export interface Reading { kind: 'summary' | 'rates'; summary?: SummaryResult; rates?: RatesResult; error?: string }

/** Reads a file the person picked (or downloaded). Never throws: a file it can't read comes back with an error. */
export async function readUpload(data: ArrayBuffer, name: string, docType: string, onProgress?: (t: string) => void): Promise<Reading> {
  const kind = docType === 'Rate sheet' ? 'rates' : 'summary'
  try {
    const doc = await readFile(data, name, (done, total, ocr) => onProgress?.(`Reading ${name}: page ${plain(Math.min(total, Math.floor(done) + 1))} of ${plain(total)}${ocr ? ' (scanned, reading the picture)' : ''}…`))
    if (kind === 'summary') return { kind, summary: readSummary(doc) }
    const r = readRates(doc)
    return { kind, rates: r, error: r.error || undefined }
  } catch (e) {
    return { kind, error: `Couldn't read ${name}: ${e instanceof Error ? e.message : String(e)}` }
  }
}

/** What the reading sends to kb_auto_product (only the values found). */
export function autoPayload(r: Reading, target: { product_id?: string | null; insurer: string; name: string }) {
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
  const rates = r.rates && !r.rates.error ? r.rates.rates : []
  if (rates.length) found.push('_rates')
  const notes = [...(r.summary?.notes ?? []), ...(r.rates?.notes ?? []), ...(r.error ? [r.error] : [])].join(' ')
  return { product_id: target.product_id || null, insurer: target.insurer.trim(), name: target.name.trim(), record, facts, rates, found: [...new Set(found)], notes }
}

/** Products are term plans only for now (Kumar): a Product Summary for another kind of plan (universal life,
 *  investment-linked, whole life ...) is kept as a document but makes no product record, so it never shows up in
 *  Compare products as a term plan. Empty when the reading can go on a record. */
export function notTermLine(r: Reading): string {
  const k = r.summary?.kind
  return k ? `This Product Summary is for ${k}, not a term plan. Only term plans go into Compare products for now, so no product record was made from it. The document is kept in the Knowledge Bank.` : ''
}

/** Puts the reading on a product record. Returns the record's id, and whether it can be found in search; or,
 *  for a plan that is not a term plan, `skipped` with the reason (nothing is saved). */
export async function saveReading(docId: string, r: Reading, target: { product_id?: string | null; insurer: string; name: string }) {
  const skip = notTermLine(r)
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
export function afterRead(r: { missing: string[]; searchable: boolean }) {
  if (r.searchable) return 'The product is in search now (Compare products and the Product Comparison Matrix), marked "Auto-read, not yet reviewed".'
  if (r.missing.length) return `The product record is made but is not searchable yet: the ${missingText(r.missing)} ${r.missing.length > 1 ? 'were' : 'was'} not found in the document.`
  return 'The product record is not searchable (withdrawn, or a source document is out of date).'
}
