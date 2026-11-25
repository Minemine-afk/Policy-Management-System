// Runs the free AI helper (lib/piAi.ts) on sample PIs the way the browser does, after the reader's rules: it is
// asked only about the cells the rules left blank, and its answers go through the same checks against the PI text.
// Scores what it fills: right, WRONG (must be 0), or not scored (the expected file lists no value).
// Usage: node tests/pi-extract/check-ai.mjs <folder with PDFs> <expected.json> [--extra more.json] [--model id] [--dtype q4] [--all] [--max-wrong N]
//   --extra  merges more truths (expected-ai-extra.json scores what the AI fills beyond the rules' file). "" = must stay blank.
//   --all   asks about every AI field, not only the blank ones (a harder test of the checks).
// Needs `npm ci` in web/ (it uses web's @huggingface/transformers, on the CPU in Node). The model downloads once
// (about 1.8 GB) from Hugging Face into node_modules/@huggingface/transformers/.cache.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const web = path.join(here, '../../web')
const pdfjs = await import(path.join(web, 'node_modules/pdfjs-dist/legacy/build/pdf.mjs'))
const { extract, readWith } = await import(path.join(web, 'src/lib/piExtract.ts'))
const ai = await import(path.join(web, 'src/lib/piAi.ts'))
const cfg = await import(path.join(web, 'src/lib/aiConfig.ts'))
const { pipeline } = await import(path.join(web, 'node_modules/@huggingface/transformers/dist/transformers.node.mjs'))

const args = process.argv.slice(2)
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d)
const [dir, expectedPath] = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'))
if (!dir || !expectedPath) { console.error('Usage: node tests/pi-extract/check-ai.mjs <folder> <expected.json> [--model id] [--dtype q4] [--all] [--max-wrong N]'); process.exit(2) }
const model = opt('--model', cfg.AI_MODEL), dtype = opt('--dtype', cfg.AI_DTYPE_CPU), all = args.includes('--all')
const maxWrong = args.includes('--max-wrong') ? +opt('--max-wrong') : null
const expected = JSON.parse(fs.readFileSync(expectedPath, 'utf8'))
if (args.includes('--extra')) for (const [f, v] of Object.entries(JSON.parse(fs.readFileSync(opt('--extra'), 'utf8')))) if (!f.startsWith('_')) expected[f] = { ...expected[f], ...v }
const same = (got, want) => want.startsWith('NOT:') ? got !== want.slice(4) : want.startsWith('~') ? !!got && got.toLowerCase().includes(want.slice(1).toLowerCase()) : got === want

const gen = await pipeline('text-generation', model, { dtype })
let right = 0, wrong = 0, unscored = 0, asked = 0, secs = 0
for (const f of Object.keys(expected).filter((k) => !k.startsWith('_')).sort()) {
  const file = path.join(dir, f)
  if (!fs.existsSync(file)) { console.log(`- ${f}: not in ${dir}, skipped`); continue }
  const d = fs.readFileSync(file)
  const pages = await readWith(pdfjs, d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength))
  if (!pages.some((p) => p.lines.length)) { console.log(`- ${f}: no text (scanned; needs OCR first), skipped`); continue }
  const read = extract(pages, f).found
  const known = all ? {} : Object.fromEntries(Object.entries(read).map(([k, v]) => [k, v.value]).filter(([, v]) => v))
  const keys = all ? ai.AI_FIELDS.map((x) => x.key) : ai.blankKeys(read)
  if (!keys.length) { console.log(`${f}: nothing blank for the AI`); continue }
  asked += keys.length
  const t = Date.now()
  const out = await gen(ai.buildMessages(pages, keys), { max_new_tokens: cfg.MAX_NEW_TOKENS, do_sample: false })
  secs += (Date.now() - t) / 1000
  const res = ai.checkAnswer(ai.parseAnswer(out[0].generated_text.at(-1).content), pages, keys, known)
  const lines = []
  for (const [k, v] of Object.entries(res.found)) {
    const want = expected[f][k]
    if (want === undefined) { unscored++; lines.push(`    ? ${k} = ${v.value} (not scored)`) }
    else if (want === '' ? false : same(v.value, want)) { right++; lines.push(`    ✓ ${k} = ${v.value}`) }
    else { wrong++; lines.push(`    ✗ ${k} = "${v.value}" but PI says ${want}`) }
  }
  console.log(`${f}: asked ${keys.length}, filled ${Object.keys(res.found).length}, dropped by checks ${res.dropped.length} (${((Date.now() - t) / 1000).toFixed(0)} s)`)
  for (const l of lines) console.log(l)
}
console.log(`\nAI helper (${model}, ${dtype}): asked ${asked} cells, ${right} right, ${wrong} wrong, ${unscored} not scored; ${secs.toFixed(0)} s on this CPU`)
if (maxWrong !== null && wrong > maxWrong) { console.log(`More than ${maxWrong} wrong`); process.exit(1) }
