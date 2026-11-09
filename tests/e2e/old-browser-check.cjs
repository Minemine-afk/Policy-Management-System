// Usage (stack from README.md running, after ./reset.sh): node old-browser-check.cjs http://127.0.0.1:5173
// Simulates a browser without Map.getOrInsertComputed / Math.sumPrecise (Chrome before ~2026) in the page and the pdf.js worker.
const { chromium } = require('playwright')
const { PI_A, PI_B } = require(__dirname + '/sample-pis.cjs')
const STRIP = 'delete Map.prototype.getOrInsertComputed; delete Map.prototype.getOrInsert; delete WeakMap.prototype.getOrInsertComputed; delete WeakMap.prototype.getOrInsert; delete Math.sumPrecise; delete Promise.try; delete Uint8Array.fromBase64; delete Uint8Array.fromHex; delete Uint8Array.prototype.toHex; delete Uint8Array.prototype.toBase64; delete Uint8Array.prototype.setFromBase64; try { for (const k of ["map","filter","take","drop","flatMap","reduce","toArray","forEach","some","every","find"]) delete Iterator.prototype[k] } catch (e) {}\n'
;(async () => {
  const b = await chromium.launch(); const p = await b.newPage()
  await p.addInitScript(STRIP)
  p.on('worker', (w) => w.evaluate(() => typeof new Map().getOrInsertComputed).then((v) => console.log('worker getOrInsertComputed:', v)).catch(() => {}))
  await p.route(/pdf\.worker.*\.(m?js)(\?.*)?$/, async (route) => { const r = await route.fetch(); route.fulfill({ response: r, body: STRIP + await r.text() }) })
  const B = process.argv[2]
  await p.goto(B)
  await p.getByLabel('Email').fill('ops1@example.com'); await p.getByLabel('Password').fill('password123')
  await p.getByRole('button', { name: 'Sign in', exact: true }).click()
  await p.getByRole('button', { name: 'Sign out' }).waitFor()
  await p.goto(B + '/requests/20000000-0000-0000-0000-000000000003')
  await p.getByLabel('Upload policy illustrations (pis)').setInputFiles(process.env.PI_SAMPLES
    ? ['SG_Singlife_EliteTermII_2024.pdf', 'SG_TokioMarine-CIMB_TermProtectPlus_2022.pdf'].map((n) => process.env.PI_SAMPLES + '/' + n)
    : [{ name: 'a.pdf', mimeType: 'application/pdf', buffer: PI_A }, { name: 'b.pdf', mimeType: 'application/pdf', buffer: PI_B }])
  await p.waitForTimeout(8000)
  const t = await p.getByRole('region', { name: 'PI comparison' }).innerText()
  console.log(t.includes('Could not read') ? 'FAILED: ' + t.match(/Could not read[^\n]*/)[0] : t.includes('Insurer / plan') && t.includes('Page 1') ? 'READ OK' : t.slice(0, 400))
  await b.close()
})()
