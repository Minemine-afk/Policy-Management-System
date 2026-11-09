// Copies the OCR engine (Tesseract) and its English model into public/ocr/, so the app serves them itself.
// Nothing is fetched from a CDN at run time and no PI ever leaves the browser. Runs before `dev` and `build`.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const web = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const nm = path.join(web, 'node_modules')
const out = path.join(web, 'public', 'ocr')
fs.mkdirSync(out, { recursive: true })
const copy = (from, to = path.basename(from)) => fs.copyFileSync(path.join(nm, from), path.join(out, to))

copy('tesseract.js/dist/worker.min.js')
// The engine picks the fastest build the browser supports (LSTM-only builds: smaller, used with the LSTM model).
for (const v of ['tesseract-core-lstm', 'tesseract-core-simd-lstm', 'tesseract-core-relaxedsimd-lstm']) copy(`tesseract.js-core/${v}.wasm.js`)
// "best_int": the more accurate English model (numbers and small print matter on PIs).
copy('@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz')
console.log('OCR files copied to public/ocr/')
