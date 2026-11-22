// Teach a new insurer on a SCANNED PI: reads it the way the app does (PaddleOCR), learns from what ops would type
// (a JSON of field -> value), then reads a "new client" copy of the same PI (every taught amount x 1.37) with and
// without the learned places, and shows what teaching fixed and what is still blank or wrong.
// Usage: node tests/pi-extract/check-teach-scan.mjs <scanned PI.pdf> <ops-values.json>
// e.g. pi-samples/SG_Manulife_ManuProtectTermII_500k.pdf with tests/pi-extract/teach-scan-manulife.json
// Needs what check-ocr.mjs needs (npm i onnxruntime-node pngjs in this folder, and pdftoppm).
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { execFileSync } from 'node:child_process'; import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
const here = path.dirname(fileURLToPath(import.meta.url)); const root = path.join(here, '../..')
const [pdf, vj] = process.argv.slice(2)
if (!pdf || !vj) { console.error('Usage: node tests/pi-extract/check-teach-scan.mjs <scanned PI.pdf> <ops-values.json>'); process.exit(2) }
const require = createRequire(path.join(here, 'package.json'))
const ort = require('onnxruntime-node'); const { PNG } = require('pngjs')
const pdfjs = await import(path.join(root, 'web/node_modules/pdfjs-dist/legacy/build/pdf.mjs'))
const { readWith, extract, FIELDS } = await import(path.join(root, 'web/src/lib/piExtract.ts'))
const { learn, applyLearned } = await import(path.join(root, 'web/src/lib/piTeach.ts'))
const { ocrImage, toGray } = await import(path.join(root, 'web/src/lib/paddleOcr.ts'))
const { SCALE, DET_MAX_SIDE, MODEL_FILES, SECOND_REC, REREAD_BELOW, charsFrom } = await import(path.join(root, 'web/src/lib/ocrConfig.ts'))
const models = path.join(root, 'web/ocr-models')
const session = async (f) => { const s = await ort.InferenceSession.create(path.join(models, f)); return async (data, dims) => { const r = await s.run({ [s.inputNames[0]]: new ort.Tensor('float32', data, dims) }); const o = r[s.outputNames[0]]; return { data: o.data, dims: o.dims } } }
const m = { det: await session(MODEL_FILES.det), rec: await session(MODEL_FILES.rec), chars: charsFrom(fs.readFileSync(path.join(models, MODEL_FILES.chars), 'utf8')),
  ...(SECOND_REC ? { second: async () => ({ rec: await session(SECOND_REC.rec), chars: charsFrom(fs.readFileSync(path.join(models, SECOND_REC.chars), 'utf8')) }), rereadBelow: REREAD_BELOW } : {}) }
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-')); const data = fs.readFileSync(pdf)
const w = console.warn; console.warn = () => {}
const pages = await readWith(pdfjs, data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength), undefined, undefined, async (page) => {
  const n = String(page.pageNumber); execFileSync('pdftoppm', ['-r', String(72 * SCALE), '-png', '-singlefile', '-f', n, '-l', n, pdf, path.join(tmp, 'p' + n)])
  const png = PNG.sync.read(fs.readFileSync(path.join(tmp, `p${n}.png`))); return (await ocrImage(toGray(png.data, png.width, png.height), m, { scale: SCALE, detMaxSide: DET_MAX_SIDE })).items
})
console.warn = w; fs.rmSync(tmp, { recursive: true, force: true })
const values = JSON.parse(fs.readFileSync(vj, 'utf8'))
const kindOf = (k) => FIELDS.find((f) => f.key === k)?.kind
const ex = (p) => { const r = extract(p, ''); if (!r.found.insurer.value) r.found.insurer = { value: values.insurer, page: 1, line: 'test: insurer named in PI' }; return r.found }
const found = ex(pages)
const rules = learn(pages, values, found, values.insurer)
console.log(`${rules.length} places learned`); for (const r of rules) console.log(`   ${r.field}: ${r.how} "${r.label}" +${r.offset} x${r.factor}`)
const S = 1.37, tg = []
for (const [k, v] of Object.entries(values)) if (['money', 'sum'].includes(kindOf(k)) && +v > 0) for (const d of [1, 2, 4, 12]) tg.push(+v / d)
const near = (n) => n >= 1 && tg.some((t) => Math.abs(n - t) <= Math.max(0.006, t * 0.0001))
const fl = (src, n) => { const dec = (src.match(/\.(\d+)$/) ?? [, ''])[1].length; let s = n.toFixed(dec); if (src.includes(',')) { const [i, d] = s.split('.'); s = i.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (d ? '.' + d : '') } return s }
const fix = (s) => s.replace(/\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?/g, (m) => near(+m.replace(/,/g, '')) ? fl(m, +m.replace(/,/g, '') * S) : m)
const copy = pages.map((p) => ({ ...p, items: p.items.map((i) => ({ ...i, str: fix(i.str) })), lines: p.lines.map((l) => ({ ...l, text: fix(l.text) })) }))
const want = {}; for (const [k, v] of Object.entries(values)) want[k] = ['money', 'sum'].includes(kindOf(k)) && +v > 0 ? (kindOf(k) === 'money' ? (+v * S).toFixed(2) : String(Math.round(+v * S))) : v
const before = ex(copy); const after = applyLearned(before, copy, rules)
const tally = (f) => { let r = 0, b = 0, w = 0; for (const [k, x] of Object.entries(want)) { const g = f[k]?.value ?? ''; const ok = g === x || (/^\d+\.\d\d$/.test(g) && Math.abs(g - x) <= 1) /* PIs round totals to the dollar */; if (ok) r++; else if (!g) b++; else w++ } return `${r} right, ${b} blank, ${w} wrong` }
console.log('new-client copy before teaching:', tally(before)); console.log('after teaching:', tally(after.found))
for (const [k, x] of Object.entries(want)) { const g0 = before[k]?.value ?? '', g = after.found[k]?.value ?? ''; if (g0 !== x || g !== x) console.log(`   ${k.padEnd(20)} want ${String(x).padEnd(12)} before ${(g0 || '-').padEnd(12)} after ${g || '-'}${after.found[k]?.learned ? ' (learned)' : ''}`) }
for (const n of after.notes) console.log('   note:', n)
