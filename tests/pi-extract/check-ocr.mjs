// Checks the scanned-PI path (PaddleOCR + straightening + reading rules) outside the browser, with the same
// model files and code the website uses. Pages are drawn with pdftoppm at the website's OCR scale.
// Usage: node tests/pi-extract/check-ocr.mjs <folder with scanned PDFs> [expected.json]
// Needs `npm ci` in web/, `npm i onnxruntime-node pngjs` in this folder, and pdftoppm (poppler-utils).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(path.join(here, 'package.json'))
const ort = require('onnxruntime-node')
const { PNG } = require('pngjs')
const pdfjs = await import(path.join(here, '../../web/node_modules/pdfjs-dist/legacy/build/pdf.mjs'))
const { extract, readWith, allFound, FIELDS } = await import(path.join(here, '../../web/src/lib/piExtract.ts'))
const { ocrImage, toGray } = await import(path.join(here, '../../web/src/lib/paddleOcr.ts'))
const { SCALE, DET_MAX_SIDE, MODEL_FILES, charsFrom } = await import(path.join(here, '../../web/src/lib/ocrConfig.ts'))

const [dir, expectedPath] = process.argv.slice(2)
if (!dir) { console.error('Usage: node tests/pi-extract/check-ocr.mjs <folder> [expected.json]'); process.exit(2) }
const expected = expectedPath ? JSON.parse(fs.readFileSync(expectedPath, 'utf8')) : {}
const models = path.join(here, '../../web/ocr-models')
const session = async (f) => {
  const s = await ort.InferenceSession.create(path.join(models, f))
  return async (data, dims) => { const r = await s.run({ [s.inputNames[0]]: new ort.Tensor('float32', data, dims) }); const o = r[s.outputNames[0]]; return { data: o.data, dims: o.dims } }
}
const ocrModels = { det: await session(MODEL_FILES.det), rec: await session(MODEL_FILES.rec), chars: charsFrom(fs.readFileSync(path.join(models, MODEL_FILES.chars), 'utf8')) }

const files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.pdf')).sort()
let pass = 0, fail = 0
for (const f of files) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-'))
  const t0 = Date.now()
  const skews = []
  const data = fs.readFileSync(path.join(dir, f))
  const pages = await readWith(pdfjs, data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength), undefined, undefined, async (page) => {
    const n = String(page.pageNumber)
    execFileSync('pdftoppm', ['-r', String(72 * SCALE), '-png', '-singlefile', '-f', n, '-l', n, path.join(dir, f), path.join(tmp, 'p' + n)])
    const png = PNG.sync.read(fs.readFileSync(path.join(tmp, `p${n}.png`)))
    const r = await ocrImage(toGray(png.data, png.width, png.height), ocrModels, { scale: SCALE, detMaxSide: DET_MAX_SIDE })
    skews.push(r.skew)
    return r.items
  }, process.env.ALL_PAGES ? undefined : allFound)
  fs.rmSync(tmp, { recursive: true, force: true })
  if (process.env.DUMP) for (const p of pages) for (const l of p.lines) console.log(`  p${p.page}| ${l.text}`)
  if (process.env.DUMP_PAGE) for (const it of pages[+process.env.DUMP_PAGE - 1]?.items ?? []) console.log(`  ${it.y.toFixed(1)} ${it.x.toFixed(1)} ${it.w.toFixed(1)} ${JSON.stringify(it.str)}`)
  const r = extract(pages, f)
  const skipped = pages.filter((p) => p.skipped).length
  console.log(`\n${f}  (${((Date.now() - t0) / 1000).toFixed(1)} s, ${pages.length} pages, ${skews.length} read with OCR${skipped ? `, ${skipped} skipped` : ''}, tilt found ${skews.join(', ')} deg)`)
  for (const fd of FIELDS) {
    const got = r.found[fd.key].value
    const want = expected[f]?.[fd.key]
    let mark = ' '
    if (want !== undefined) { if (want === got) { mark = '✓'; pass++ } else { mark = '✗'; fail++ } }
    console.log(`  ${mark} ${fd.label.padEnd(30)} ${got || '(blank)'}${mark === '✗' ? `   expected ${want || '(blank)'}` : ''}${got ? `   [p${r.found[fd.key].page}]` : ''}`)
  }
  for (const n of r.notes) console.log(`    note: ${n}`)
  if (expected[f]?.discounted !== undefined) {
    if (expected[f].discounted === r.discounted) pass++; else { fail++; console.log(`  ✗ discounted flag ${r.discounted}, expected ${expected[f].discounted}`) }
  }
}
if (expectedPath) { console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0) }
