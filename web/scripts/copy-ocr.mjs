// Copies the OCR models (PaddleOCR PP-OCRv5 mobile, kept in web/ocr-models/) into public/ocr/, so the app
// serves them itself. Nothing is fetched from a CDN at run time and no PI ever leaves the browser.
// (ONNX Runtime's .wasm file is bundled by Vite into assets/.) Runs before `dev` and `build`.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const web = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const src = path.join(web, 'ocr-models')
const out = path.join(web, 'public', 'ocr')
fs.rmSync(out, { recursive: true, force: true })   // drops the old Tesseract files
fs.mkdirSync(out, { recursive: true })
for (const f of fs.readdirSync(src)) if (/\.(onnx|txt)$/.test(f)) fs.copyFileSync(path.join(src, f), path.join(out, f))
console.log('OCR files copied to public/ocr/')
