// Checks the reading rules in a real browser (Chromium), with the real OCR engine, model files and worker the
// website uses: digital PIs go through pdf.js, scanned PIs through PaddleOCR. Also reports timings and how much
// the OCR engine downloads the first time.
// Usage: node tests/pi-extract/check-browser.cjs <folder with PDFs> [expected.json]
// Needs `npm ci` in web/ and `npm i playwright` (or a global Playwright). Starts the Vite dev server itself.
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { chromium } = require('playwright')

const [dir, expectedPath] = process.argv.slice(2)
if (!dir) { console.error('Usage: node tests/pi-extract/check-browser.cjs <folder> [expected.json]'); process.exit(2) }
const expected = expectedPath ? JSON.parse(fs.readFileSync(expectedPath, 'utf8')) : {}
const web = path.join(__dirname, '../../web')
const PORT = 5179

;(async () => {
  const vite = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], { cwd: web, stdio: ['ignore', 'pipe', 'inherit'] })
  await new Promise((ok) => vite.stdout.on('data', (d) => { if (String(d).includes('Local')) ok() }))
  const browser = await chromium.launch()
  let pass = 0, fail = 0
  try {
    const page = await browser.newPage()
    page.on('pageerror', (e) => console.log('page error:', e.message))
    if (process.env.DEBUG) page.on('console', (m) => console.log('console:', m.text()))
    let ocrBytes = 0
    page.on('response', async (r) => { if (/\/ocr\/|ort-wasm/.test(r.url())) { try { ocrBytes += (await r.body()).length } catch { /* ignore */ } } })
    await page.route('**/__pdf/**', (route) => route.fulfill({ body: fs.readFileSync(path.join(dir, decodeURIComponent(route.request().url().split('/__pdf/')[1]))), contentType: 'application/pdf' }))
    await page.goto(`http://localhost:${PORT}/`)
    const files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.pdf')).sort()
    for (const f of files) {
      const r = await page.evaluate(async (name) => {
        const { readPdf, extract } = await import('/src/lib/piExtract.ts')
        const t0 = performance.now()
        const data = await (await fetch(`/__pdf/${encodeURIComponent(name)}`)).arrayBuffer()
        const ocrPages = new Set()
        const pages = await readPdf(data, (p, _t, ocr) => { if (ocr) ocrPages.add(Math.floor(p) + 1) })
        const x = extract(pages, name)
        return { found: Object.fromEntries(Object.entries(x.found).map(([k, v]) => [k, v.value])), discounted: x.discounted, notes: x.notes, ms: performance.now() - t0, ocrPages: ocrPages.size, pages: pages.length }
      }, f)
      console.log(`\n${f}  (${(r.ms / 1000).toFixed(1)} s, ${r.pages} pages, ${r.ocrPages} read with OCR)`)
      for (const [k, got] of Object.entries(r.found)) {
        const want = expected[f]?.[k]
        let mark = ' '
        if (want !== undefined) { if (want === got) { mark = '✓'; pass++ } else { mark = '✗'; fail++ } }
        console.log(`  ${mark} ${k.padEnd(20)} ${got || '(blank)'}${mark === '✗' ? `   expected ${want || '(blank)'}` : ''}`)
      }
      if (expected[f]?.discounted !== undefined) { if (expected[f].discounted === r.discounted) pass++; else { fail++; console.log(`  ✗ discounted flag ${r.discounted}`) } }
      for (const n of r.notes) console.log(`    note: ${n}`)
    }
    console.log(`\nOCR engine downloaded: ${(ocrBytes / 1e6).toFixed(1)} MB`)
  } finally {
    await browser.close()
    vite.kill()
  }
  if (expectedPath) { console.log(`${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0) }
})()
