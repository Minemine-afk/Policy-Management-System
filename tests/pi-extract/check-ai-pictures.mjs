// The AI helper on PAGE PICTURES, the way the browser does when the reader got no text from a PI (pdf.js and OCR
// both failed): the model reads out each page picture's words (lib/piAi.ts readOutPage), then is asked about the
// cells still blank from that text, with the same checks as for any PI text (askAi / checkAnswer).
// Scores what it fills: right, WRONG (must be 0), or not scored.
// Usage: node tests/pi-extract/check-ai-pictures.mjs <folder with PDFs> [--files a.pdf,b.pdf] [--pages 4] [--cache dir] [--max-wrong N]
// Needs pdftoppm (poppler) for the pictures, and `npm ci` in web/ (the model downloads once into
// node_modules/@huggingface/transformers/.cache). Client particulars the request form gives are not asked (as in the app).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const web = path.join(here, '../../web')
const ai = await import(path.join(web, 'src/lib/piAi.ts'))
const cfg = await import(path.join(web, 'src/lib/aiConfig.ts'))
const run = await import(path.join(web, 'src/lib/aiRun.ts'))
const t = await import(path.join(web, 'node_modules/@huggingface/transformers/dist/transformers.node.mjs'))

const args = process.argv.slice(2)
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d)
const [dir] = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'))
if (!dir) { console.error('Usage: node tests/pi-extract/check-ai-pictures.mjs <folder> [--files a.pdf] [--pages 4] [--show] [--cache dir]'); process.exit(2) }
const maxPages = +opt('--pages', 4)
const maxWrong = args.includes('--max-wrong') ? +opt('--max-wrong') : null
const expected = { ...JSON.parse(fs.readFileSync(path.join(here, 'expected-sg-samples.json'), 'utf8')), ...JSON.parse(fs.readFileSync(path.join(here, 'expected-pictures.json'), 'utf8')) }
const files = opt('--files', '') ? opt('--files').split(',') : Object.keys(expected).filter((k) => !k.startsWith('_')).sort()
const same = (got, want) => want.startsWith('~') ? !!got && got.toLowerCase().includes(want.slice(1).toLowerCase()) : got === want
// The request form fills these (see formFill.ts), so the app never asks the AI about them on a current request.
const FROM_FORM = new Set(['gender', 'underwriting_class', 'date_of_birth', 'residency', 'insured_name'])
const cacheDir = opt('--cache', null)
if (cacheDir) fs.mkdirSync(cacheDir, { recursive: true })

let m = null
const model = async () => (m ??= await run.loadModel(t, cfg.AI_MODEL, { dtype: { embed_tokens: 'q4', decoder_model_merged: 'q4', vision_encoder: 'q4' } }))
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-pics-'))
let right = 0, wrong = 0, unscored = 0, secs = 0
for (const f of files) {
  const file = path.join(dir, f)
  if (!fs.existsSync(file)) { console.log(`- ${f}: not in ${dir}, skipped`); continue }
  const base = path.join(tmp, f.replace(/\W+/g, '_'))
  execFileSync('pdftoppm', ['-r', '110', '-f', '1', '-l', String(maxPages), '-png', file, base])
  const pics = fs.readdirSync(tmp).filter((x) => x.startsWith(path.basename(base) + '-')).sort()
  const keys = ai.pictureKeys(ai.AI_FIELDS.map((x) => x.key).filter((k) => !FROM_FORM.has(k)))
  const tStart = Date.now()
  // 1. Read out each page picture (cached by file and page).
  const pages = []
  for (const [i, pic] of pics.entries()) {
    const cacheFile = cacheDir && path.join(cacheDir, `readout-${createHash('sha1').update(f + (i + 1) + JSON.stringify(ai.readOutMessages()) + ai.READ_OUT_TOKENS).digest('hex').slice(0, 16)}.txt`)
    let raw = cacheFile && fs.existsSync(cacheFile) ? fs.readFileSync(cacheFile, 'utf8') : null
    if (raw === null) {
      const t1 = Date.now()
      raw = await run.generate(await model(), ai.readOutMessages(), [await t.RawImage.read(path.join(tmp, pic))], ai.READ_OUT_TOKENS)
      console.log(`  page ${i + 1} read out in ${((Date.now() - t1) / 1000).toFixed(0)} s`)
      if (cacheFile) fs.writeFileSync(cacheFile, raw)
    }
    pages.push(ai.readOutPage(raw, i + 1))
  }
  if (args.includes('--show')) for (const p of pages) console.log(`--- page ${p.page}\n` + p.lines.map((l) => '  ' + l.text).join('\n'))
  // 2. The AI is asked about that text, one group at a time, as in the browser (aiModel.askAi).
  const found = {}
  for (const group of ai.aiGroups(keys)) {
    const msgs = ai.buildMessages(pages, group)
    const cacheFile = cacheDir && path.join(cacheDir, `pic-ask-${createHash('sha1').update(JSON.stringify(msgs)).digest('hex').slice(0, 16)}.txt`)
    let raw = cacheFile && fs.existsSync(cacheFile) ? fs.readFileSync(cacheFile, 'utf8') : null
    if (raw === null) {
      raw = await run.generate(await model(), msgs, [], cfg.MAX_NEW_TOKENS)
      if (cacheFile) fs.writeFileSync(cacheFile, raw)
    }
    const res = ai.checkAnswer(ai.parseAnswer(raw), pages, group, Object.fromEntries(Object.entries(found).map(([k, v]) => [k, v.value])))
    Object.assign(found, res.found)
  }
  ai.pictureCrossChecks(found, [], {})
  secs += (Date.now() - tStart) / 1000
  const lines = []
  for (const [k, v] of Object.entries(found)) {
    const want = expected[f]?.[k]
    if (want === undefined) { unscored++; lines.push(`    ? ${k} = ${v.value} (not scored)`) }
    else if (want !== '' && same(v.value, want)) { right++; lines.push(`    ✓ ${k} = ${v.value} (page ${v.page})`) }
    else { wrong++; lines.push(`    ✗ ${k} = "${v.value}" (page ${v.page}) but PI says ${want || 'nothing (blank)'}`) }
  }
  console.log(`${f}: filled ${Object.keys(found).length} (${((Date.now() - tStart) / 1000).toFixed(0)} s)`)
  for (const l of lines) console.log(l)
}
fs.rmSync(tmp, { recursive: true, force: true })
console.log(`\nAI from page pictures (read out, then checked against the read-out): ${right} right, ${wrong} wrong, ${unscored} not scored; ${secs.toFixed(0)} s on this CPU`)
if (maxWrong !== null && wrong > maxWrong) { console.log(`More than ${maxWrong} wrong`); process.exit(1) }
