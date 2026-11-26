// Runs the free AI helper for the Knowledge Bank (web/src/lib/kbAi.ts) the way the browser does, after the reader's
// rules: it is asked only about what the rules left blank, and its answers go through the same checks.
// Scores each value it fills against expected-kb-ai.json: right, WRONG (must be 0), or "?" (not scored yet).
// A key listed as "" must stay blank (the document does not state it; e.g. real SG summaries give no entry ages).
// It is asked two ways (askKbAi): picking one of the document's own lines by number, then an exact quote.
// Documents: the 5 real Product Summaries (FWD, Singlife, Genesis, HSBC, Manulife; project files product-matrix/kb-real-summaries/), the
// made-up Orchard summary with everything treated as blank (--all), and short made-up summaries with unusual wording.
// Usage: node tests/kb-extract/check-kb-ai.mjs [folder with the real PDFs] [--model id] [--dtype q4] [--max-wrong N]
// Needs `npm ci` in web/; the model downloads once from Hugging Face (like tests/pi-extract/check-ai.mjs).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
const here = path.dirname(fileURLToPath(import.meta.url))
const web = path.join(here, '../../web')
const args = process.argv.slice(2)
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d)
const dir = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--')) ?? '/mnt/project-files/product-matrix/kb-real-summaries'
const pdfjs = await import(path.join(web, 'node_modules/pdfjs-dist/legacy/build/pdf.mjs'))
const { readWith } = await import(path.join(web, 'src/lib/piExtract.ts'))
const kb = await import(path.join(web, 'src/lib/kbExtract.ts'))
const ai = await import(path.join(web, 'src/lib/kbAi.ts'))
const cfg = await import(path.join(web, 'src/lib/aiConfig.ts'))
const { pipeline } = await import(path.join(web, 'node_modules/@huggingface/transformers/dist/transformers.node.mjs'))
const model = opt('--model', cfg.AI_MODEL), dtype = opt('--dtype', cfg.AI_DTYPE_CPU)
const maxWrong = args.includes('--max-wrong') ? +opt('--max-wrong') : null
const expected = JSON.parse(fs.readFileSync(path.join(here, 'expected-kb-ai.json'), 'utf8'))
const { VARIANTS } = await import('./kb-ai-variants.mjs')

const pdf = async (file) => { const d = fs.readFileSync(file); return { pages: await readWith(pdfjs, d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength)), rows: [], kind: 'pdf' } }
const textDoc = (text) => ({ pages: [{ page: 1, items: [], lines: text.trim().split('\n').map((t) => ({ page: 1, text: t.trim() })) }], rows: [], kind: 'excel' })
const docs = []
for (const f of ['FWD_Future_First_Term_Product_Summary.pdf', 'Singlife_Elite_Term_II_Product_Summary.pdf', 'Genesis_III_IUL_Product_Summary.pdf', 'HSBC_Indexed_Flexi_Income_Product_Summary.pdf', 'Manulife_Signature_IUL_Select_III_Product_Summary.pdf']) {
  if (fs.existsSync(path.join(dir, f))) docs.push({ name: f, doc: await pdf(path.join(dir, f)) }); else console.log(`(skipped ${f}: not in ${dir})`)
}
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-samples-'))
  execFileSync(process.execPath, [path.join(here, 'make-samples.mjs'), tmp], { stdio: 'ignore' })
  docs.push({ name: 'Orchard_TermShield_Product_Summary.pdf (all blank)', doc: await pdf(path.join(tmp, 'Orchard_TermShield_Product_Summary.pdf')), all: true })
}
for (const [name, text] of Object.entries(VARIANTS)) docs.push({ name, doc: textDoc(text) })

const same = (got, want) => (want.startsWith('~') ? String(got).toLowerCase().includes(want.slice(1).toLowerCase()) : JSON.stringify(got) === want || String(got) === want)
const gen = await pipeline('text-generation', model, { dtype })
let right = 0, wrong = 0, unscored = 0, blankOk = 0, asked = 0, secs = 0
for (const { name, doc, all } of docs) {
  const s = kb.readSummary(doc)
  const known = all ? { ...s, record: { name: s.record.name }, facts: {} } : s
  const blank = all ? { record: [...ai.KB_AI_RECORD], facts: ai.KB_AI_FACTS.map((f) => f.key) } : ai.blankOf(s)
  const t = Date.now()
  let questions = 0
  const fill = await ai.askKbAi(doc, blank, known, async (messages, maxTokens) => {
    questions++
    const out = await gen(messages, { max_new_tokens: maxTokens, do_sample: false })
    return out[0].generated_text.at(-1).content
  }, args.includes('--verbose') ? (l) => console.log('  ' + l) : undefined)
  secs += (Date.now() - t) / 1000
  const want = expected[name] ?? {}
  const got = { ...Object.fromEntries(Object.entries(fill.facts).map(([k, f]) => [k, f.v])) }
  if (fill.record.entry_age_min != null) got.entry_age = `${fill.record.entry_age_min}-${fill.record.entry_age_max}`
  if (fill.record.sa_min != null || fill.record.sa_max != null) got.sum_assured = `${fill.record.sa_min ?? ''}-${fill.record.sa_max ?? ''}`
  if (fill.record.currencies) got.currencies = fill.record.currencies.join(',')
  if (fill.record.residency) got.residency = fill.record.residency.join(',')
  const n = fill.asked.length
  if (args.includes('--verbose')) console.log(`  reader left blank: ${[...blank.record, ...blank.facts].join(',')}; asked: ${fill.asked.join(',')}`)
  asked += n
  console.log(`${name}: asked about ${n} in ${questions} questions, filled ${Object.keys(got).length}, dropped by checks ${fill.dropped.length} [${fill.dropped.join(',')}] (${((Date.now() - t) / 1000).toFixed(0)} s)`)
  for (const [k, v] of Object.entries(got)) {
    const w = want[k]
    if (w === undefined) { unscored++; console.log(`    ? ${k} = ${String(v).slice(0, 150)}`) }
    else if (w !== '' && [].concat(w).some((x) => same(v, x))) { right++; console.log(`    ✓ ${k} = ${String(v).slice(0, 110)}`) }
    else { wrong++; console.log(`    ✗ ${k} = "${String(v).slice(0, 150)}" but want ${JSON.stringify(w)}`) }
  }
  for (const [k, w] of Object.entries(want)) if (w === '' && !(k in got)) blankOk++
}
console.log(`\nKnowledge Bank AI helper (${model}, ${dtype}): asked ${asked}, ${right} right, ${wrong} wrong, ${unscored} not scored, ${blankOk} correctly left blank; ${secs.toFixed(0)} s on this CPU`)
if (maxWrong !== null && wrong > maxWrong) { console.log(`More than ${maxWrong} wrong`); process.exit(1) }
