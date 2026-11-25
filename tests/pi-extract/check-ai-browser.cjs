// Runs the AI helper in a real browser (Chromium) through the website's own worker (lib/aiModel.ts, aiWorker.ts):
// the model and ONNX Runtime download from Hugging Face / jsDelivr, the PI text stays in the page. Headless Chromium
// has no graphics card, so this takes the slower processor path.
// Usage: node tests/pi-extract/check-ai-browser.cjs <folder with PDFs> <PI file name> [more names...]
// Needs `npm ci` in web/ and Playwright. Starts the Vite dev server itself. First run downloads ~1.8 GB.
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { chromium } = require('playwright')

const [dir, ...names] = process.argv.slice(2)
if (!dir || !names.length) { console.error('Usage: node tests/pi-extract/check-ai-browser.cjs <folder> <PI.pdf> [...]'); process.exit(2) }
const web = path.join(__dirname, '../../web')
const PORT = 5181

;(async () => {
  const vite = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], { cwd: web, stdio: ['ignore', 'pipe', 'inherit'], detached: true, env: { VITE_SUPABASE_URL: 'http://127.0.0.1:9', VITE_SUPABASE_ANON_KEY: 'test-only', ...process.env } })
  await new Promise((ok) => vite.stdout.on('data', (d) => { if (String(d).includes('Local')) ok() }))
  // AI_DEVICE=webgpu tries the graphics path on a software adapter (SwiftShader); AI_DTYPE picks the model file.
  const browser = await chromium.launch(process.env.AI_DEVICE === 'webgpu' ? { args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=swiftshader', '--use-webgpu-adapter=swiftshader'] } : {})
  let ok = true
  try {
    const page = await browser.newPage()
    page.on('pageerror', (e) => console.log('page error:', e.message))
    page.on('console', (m) => { if (/^AI /.test(m.text())) console.log(m.text()) })
    const sent = []
    page.on('request', (r) => { if (r.method() !== 'GET' && !r.url().includes(`localhost:${PORT}`)) sent.push(`${r.method()} ${r.url()}`) })
    await page.route('**/__pdf/**', (route) => route.fulfill({ body: fs.readFileSync(path.join(dir, decodeURIComponent(route.request().url().split('/__pdf/')[1]))), contentType: 'application/pdf' }))
    await page.goto(`http://localhost:${PORT}/`)
    for (const f of names) {
      const r = await page.evaluate(async ([name, force]) => {
        if (force.device || force.dtype || force.model) globalThis.__AI_FORCE = force
        const { readPdf, extract } = await import('/src/lib/piExtract.ts')
        const { blankKeys } = await import('/src/lib/piAi.ts')
        const { askAi } = await import('/src/lib/aiModel.ts')
        const pages = await readPdf(await (await fetch(`/__pdf/${encodeURIComponent(name)}`)).arrayBuffer())
        const keys = blankKeys(extract(pages, name).found)
        const t0 = performance.now()
        let last = -10
        const res = await askAi(pages, keys, (p) => {
          const pct = Math.round((p.pct ?? 0) * 100)
          if (p.stage === 'read') console.log(`AI reading on ${p.device}`)
          else if (pct >= last + 10) { last = pct; console.log(`AI download ${pct}%`) }
        })
        return { keys, found: Object.fromEntries(Object.entries(res.found).map(([k, v]) => [k, v.value])), dropped: res.dropped, s: (performance.now() - t0) / 1000 }
      }, [f, { device: process.env.AI_DEVICE, dtype: process.env.AI_DTYPE, model: process.env.AI_MODEL }])
      console.log(`${f}: asked ${r.keys.join(', ')}\n  filled ${JSON.stringify(r.found)}\n  dropped ${r.dropped.join(', ') || 'none'} (${r.s.toFixed(0)} s)`)
    }
    console.log(sent.length ? `Requests that sent data out: ${sent.join('; ')}` : 'No request sent data out of the page (GET downloads only).')
    if (sent.length) ok = false
  } catch (e) { console.log('failed:', e.message); ok = false } finally {
    await browser.close()
    try { process.kill(-vite.pid) } catch { vite.kill() }
  }
  process.exit(ok ? 0 : 1)
})()
