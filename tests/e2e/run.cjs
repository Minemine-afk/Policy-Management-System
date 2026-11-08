// Browser walkthrough of the PI request tracker. Needs the stack from README.md running.
const { chromium } = require('playwright')
const fs = require('fs')
const BASE = 'http://127.0.0.1:5173'
const SHOTS = __dirname + '/shots'
fs.mkdirSync(SHOTS, { recursive: true })
let pass = 0, failed = 0
const ok = (m) => { pass++; console.log('PASS', m) }
const bad = (m) => { failed++; console.log('FAIL', m) }
const check = async (cond, m) => ((await cond) ? ok(m) : bad(m))
const file = (name) => ({ name, mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 sample ' + name) })

// Minimal one-page PDF with text placed at [x, y] (points). Sample PIs below are made up.
function pdf(items) {
  const esc = (t) => t.replace(/([()\\])/g, '\\$1')
  const stream = items.map(([x, y, t]) => `BT /F1 11 Tf ${x} ${y} Td (${esc(t)}) Tj ET`).join('\n')
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let out = '%PDF-1.4\n'; const offs = []
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n` })
  const x = out.length
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('')
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}
const rows = (start, pairs, valueX) => pairs.flatMap(([a, b], i) => valueX ? [[72, start - i * 20, a], [valueX, start - i * 20, b]] : [[72, start - i * 20, a]])
const PI_A = pdf([[72, 760, '[SAMPLE] Great Eastern Life - Policy Illustration'], ...rows(700, [
  ['Plan Name: GREAT Term Protector'], ['Life Assured: XXXXX'], ['Age Next Birthday: 35   Gender: Female'], ['Smoker Status: Non-Smoker'],
  ['Basic Sum Assured: S$500,000'], ['Critical Illness Sum Assured: S$200,000'], ['Policy Term: To Age 65'], ['Premium Payment Term: 30 years'],
  ['Annual Premium: S$1,234.50'], ['Monthly Premium: S$105.20'], ['Total Premiums Payable: S$37,035.00'], ['Riders: Early CI Rider']])])
const PI_B = pdf([[72, 760, '[SAMPLE] AIA Singapore - Benefit Illustration'], ...rows(700, [
  ['Product Name', 'AIA Secure Term'], ['Sex', 'F'], ['ALB', '35'], ['Smoker', 'No'], ['Sum Assured', 'SGD 500,000'],
  ['Coverage Term', '30 yrs'], ['Premium Term', '30 yrs'], ['Yearly Premium', '1,180.00'], ['Critical Illness Benefit', 'Not included']], 320)])
const PI_C = pdf([[72, 760, '[SAMPLE] Income Insurance Limited'], ...rows(700, [
  ['Plan name'], ['Star Term Cover'], ['Death Benefit'], ['$500,000'], ['Benefit term'], ['25 years'], ['Premium (Annual)'], ['$990.40']])])
const piFile = (name, buffer) => ({ name, mimeType: 'application/pdf', buffer })

;(async () => {
  const browser = await chromium.launch()
  const errors = []
  async function session(email) {
    const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 }, deviceScaleFactor: 1 })
    const p = await ctx.newPage()
    p.on('pageerror', (e) => errors.push(e.message))
    await p.goto(BASE)
    await p.getByLabel('Email').fill(email)
    await p.getByLabel('Password').fill('password123')
    await p.getByRole('button', { name: 'Sign in', exact: true }).click()
    await p.getByRole('button', { name: 'Sign out' }).waitFor()
    return p
  }
  const col = (p, name) => p.getByRole('region', { name, exact: true })

  // 1. Introducer Sam: board, new request
  let sam = await session('introducer1@example.com')
  await sam.getByRole('heading', { name: 'Board' }).waitFor()
  await check(sam.locator('.cardlet').count().then((n) => n === 3), 'introducer sees only their own 3 cards on the board')
  await check(col(sam, 'Completed').getByText('PI-00005').isVisible(), 'completed request is in the Completed column')
  await check(sam.locator('.cardlet[draggable=true]').count().then((n) => n === 0), 'introducer cards are not draggable')
  await sam.screenshot({ path: SHOTS + '/1-board-introducer.png' })
  await sam.getByRole('link', { name: 'New request' }).first().click()
  await sam.getByLabel('Client name').fill('[Sample] Client Golf')
  await sam.getByLabel('NRIC / FIN (optional)').fill('S0000007G')
  await sam.getByLabel('Client age band').selectOption('35 to 39')
  await sam.getByRole('group', { name: 'Gender' }).getByRole('button', { name: 'Female' }).click()
  await sam.getByLabel('Remarks for ops (optional)').fill('Wants quotes from three insurers')
  await sam.getByRole('button', { name: 'Submit request' }).click()
  await sam.getByRole('heading', { name: /PI-00007/ }).waitFor()
  await check(sam.getByText('[Sample] Client Golf').isVisible(), 'introducer sees the client name on their own request')
  await sam.getByLabel('Upload attachments').setInputFiles(file('fact-find.pdf'))
  await sam.getByRole('button', { name: 'fact-find.pdf' }).waitFor()
  ok('introducer attached a file')
  await sam.screenshot({ path: SHOTS + '/2-request-introducer.png', fullPage: true })

  // 2. Ops Olivia: pool, pick up, complete
  let olivia = await session('ops1@example.com')
  await olivia.locator('.cardlet').first().waitFor()
  await check(olivia.locator('.cardlet.late[data-ref="PI-00002"]').getByText(/Overdue by 1d/).isVisible(), 'ops sees a 3-day-old request highlighted red (1 day past the 2-day limit) as overdue')
  await check(sam.locator('.cardlet.late, .cardlet.soon').count().then((n) => n === 0), 'introducers do not see overdue flags')
  await check(olivia.locator('.cardlet.soon[data-ref="PI-00001"]').getByText('Due in 1d').isVisible(), 'a request with one day left is orange')
  await olivia.locator('.cardlet[data-ref="PI-00001"]').getByRole('button', { name: 'Assign to me' }).waitFor()
  ok('pool cards show an Assign to me button for ops')
  await check(olivia.locator('.cardlet').count().then((n) => n === 4), 'ops sees the unassigned pool plus own work (4 cards)')
  await check(olivia.locator('.cardlet[draggable=true]').count().then((n) => n === 4), 'ops cards are draggable')
  await olivia.locator('.cardlet[data-ref="PI-00007"]').click()
  await check(olivia.getByText('[Sample] Client Golf').count().then((n) => n === 0), 'ops cannot see the client name')
  await olivia.getByText('Wants quotes from three insurers').waitFor()
  ok('ops sees the remarks')
  await olivia.getByRole('button', { name: 'Assign to me' }).click()
  await olivia.getByRole('button', { name: 'Start work' }).click()
  await olivia.getByRole('button', { name: 'Mark completed' }).waitFor()
  await check(olivia.getByRole('button', { name: 'Mark completed' }).isDisabled(), 'cannot complete without a PI')
  await olivia.getByLabel('Upload policy illustrations (pis)').setInputFiles([piFile('insurer-a.pdf', PI_A), piFile('insurer-b.pdf', PI_B), piFile('insurer-c.pdf', PI_C)])
  await olivia.getByRole('button', { name: 'insurer-c.pdf' }).waitFor()

  // PI comparison: read the three uploaded PIs, check, correct one value, export to Excel
  await olivia.getByRole('link', { name: 'Compare these PIs' }).click()
  await olivia.getByLabel('Annual premium for PI 3').waitFor()
  const val = (f, i) => olivia.getByLabel(`${f} for PI ${i}`).inputValue()
  await check(olivia.getByLabel('Insurer for PI 1').inputValue().then((v) => v === 'Great Eastern'), 'comparison detects the insurer of PI 1')
  await check(val('Sum assured (death / TPD)', 1).then((v) => v === '500000.00'), 'reads sum assured from a "Label: value" layout')
  await check(val('Annual premium', 2).then((v) => v === '1180.00'), 'reads annual premium from a two-column table layout')
  await check(val('Annual premium', 3).then((v) => v === '990.40'), 'reads annual premium when the value is on the next line')
  await check(val('Critical illness cover', 2).then((v) => v === 'No'), 'reads "Not included" as No')
  await check(val('Policy term', 1).then((v) => v === 'To age 65'), 'reads "To Age 65" as a policy term')
  await check(olivia.getByRole('button', { name: 'Export to Excel' }).isDisabled(), 'export needs the values-checked box')
  await olivia.getByLabel('Life assured age for PI 3').fill('35')
  await olivia.screenshot({ path: SHOTS + '/8-compare-pis.png', fullPage: true })
  await olivia.getByText('I have checked these values against the PDFs').click()
  const [dl] = await Promise.all([olivia.waitForEvent('download'), olivia.getByRole('button', { name: 'Export to Excel' }).click()])
  const xlsxPath = SHOTS + '/comparison.xlsx'
  await dl.saveAs(xlsxPath)
  const ExcelJS = require(__dirname + '/../../web/node_modules/exceljs')
  const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(xlsxPath)
  const ws = wb.getWorksheet('Comparison')
  const rowOf = (label) => { let r = null; ws.eachRow((row) => { if (row.getCell(1).value === label) r = row }); return r }
  await check(Promise.resolve(ws.getRow(3).getCell(2).value === 'Great Eastern' && rowOf('Annual premium').getCell(3).value === 1180), 'Excel file has insurers as columns and premiums as numbers')
  await check(Promise.resolve(rowOf('Life assured age').getCell(4).value === '35' && wb.getWorksheet('Sources').rowCount === 37), 'Excel keeps hand corrections and a Sources sheet')
  await olivia.goBack()
  await olivia.getByRole('button', { name: 'insurer-c.pdf' }).waitFor()
  await olivia.getByLabel('Write a comment').fill('Internal: insurer B needs a loading')
  await olivia.getByText('Internal note (hidden from the introducer)').click()
  await olivia.getByRole('button', { name: 'Post comment' }).click()
  await olivia.getByText('Internal: insurer B needs a loading').waitFor()
  await olivia.getByLabel('Write a comment').fill('Your PIs are nearly ready')
  await olivia.getByRole('button', { name: 'Post comment' }).click()
  await olivia.getByText('Your PIs are nearly ready').waitFor()
  await olivia.screenshot({ path: SHOTS + '/3-request-ops.png', fullPage: true })
  await check(olivia.getByRole('button', { name: 'Mark completed' }).isEnabled(), 'Mark completed enabled after uploading PIs')
  await olivia.getByRole('button', { name: 'Mark completed' }).click()
  await olivia.locator('h1 .pill', { hasText: 'Completed' }).waitFor()
  ok('ops completed the request')

  // 3. Sam sees the PIs but not the internal note
  await sam.reload()
  await sam.getByRole('link', { name: 'My requests' }).click()
  await sam.getByRole('link', { name: 'PI-00007' }).click()
  await sam.getByRole('button', { name: 'insurer-b.pdf' }).waitFor()
  await check(sam.getByText('Internal: insurer B needs a loading').count().then((n) => n === 0), 'introducer cannot see internal notes')
  await sam.getByText('Your PIs are nearly ready').waitFor()
  ok('introducer sees the shared comment')
  await check(sam.getByText('Completed', { exact: true }).first().isVisible(), 'timeline/status shows completed to the introducer')
  await sam.screenshot({ path: SHOTS + '/4-request-completed-introducer.png', fullPage: true })

  // 4. Drag on the board: Olivia moves PI-00003 to Sent back
  await olivia.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Board' }).click()
  await olivia.locator('.cardlet[data-ref="PI-00003"]').dragTo(col(olivia, 'Sent back'))
  await olivia.getByRole('dialog').getByLabel('Reason').fill('Need the client occupation')
  await olivia.getByRole('button', { name: 'Send back', exact: true }).click()
  await check(col(olivia, 'Sent back').getByText('PI-00003').waitFor().then(() => true), 'dragging a card to Sent back asks for a reason and moves it')
  await olivia.locator('.cardlet[data-ref="PI-00002"]').dragTo(col(olivia, 'Completed'))
  await olivia.getByRole('region', { name: 'Assigned', exact: true }).getByText('PI-00002').waitFor()
  await olivia.getByRole('alert').first().waitFor()
  ok('an illegal move is refused with a message')
  await olivia.screenshot({ path: SHOTS + '/5-board-ops.png' })

  // 5. Dana: isolated from Sam, resubmits her sent-back request
  let dana = await session('introducer2@example.com')
  await dana.locator('.cardlet').first().waitFor()
  await check(dana.locator('.cardlet').count().then((n) => n === 2), 'second introducer sees only their own 2 open cards')
  const samReq = await sam.evaluate(() => location.pathname)
  await dana.goto(BASE + samReq)
  await dana.getByText('Request not found, or you do not have access.').waitFor()
  ok('second introducer cannot open the first introducer’s request')
  await dana.goto(BASE + '/board')
  await dana.locator('.cardlet[data-ref="PI-00003"]').click()
  await dana.getByText('Need the client occupation').first().waitFor()
  await dana.getByLabel('Reply note').fill('Occupation: engineer')
  await dana.getByRole('button', { name: 'Resubmit' }).click()
  await dana.locator('h1 .pill', { hasText: 'In progress' }).waitFor()
  ok('introducer replied to a sent-back request and resubmitted')

  // 6. Bsd Pat: sees all, assigns, removes, manages users
  let pat = await session('bsd@example.com')
  await pat.getByRole('link', { name: 'Backlog' }).click()
  await pat.getByLabel('Status').selectOption('all')
  await check(pat.locator('tbody tr').count().then((n) => n === 7), 'bsd sees all 7 requests in the backlog')
  await pat.screenshot({ path: SHOTS + '/6-backlog-bsd.png' })
  await pat.getByLabel('Status').selectOption('open')
  await pat.getByLabel('Assign PI-00001').selectOption({ label: 'Omar Ops' })
  await pat.waitForTimeout(600)
  await pat.getByLabel('Handled by').selectOption({ label: 'Omar Ops' })
  await check(pat.getByRole('link', { name: 'PI-00001' }).isVisible(), 'bsd assigned a request to another ops user')
  await pat.getByRole('link', { name: 'PI-00001' }).click()
  await check(pat.getByText('[Sample] Client Alpha').count().then((n) => n === 0), 'bsd cannot see client names')
  await pat.getByRole('button', { name: 'Remove' }).click()
  await pat.getByRole('dialog').getByLabel('Reason').fill('Duplicate')
  await pat.getByRole('button', { name: 'Remove request' }).click()
  await pat.locator('h1 .pill', { hasText: 'Removed' }).waitFor()
  ok('bsd removed a request with a reason')
  await pat.getByRole('link', { name: 'Admin' }).click()
  await pat.getByLabel('Role for ops2@example.com').waitFor()
  await pat.screenshot({ path: SHOTS + '/7-admin-users.png' })
  await pat.getByRole('link', { name: 'Audit log' }).click()
  await pat.getByText('request.removed').first().waitFor()
  ok('audit log shows the removal')

  // 7. Non-bsd cannot open admin
  await olivia.goto(BASE + '/admin')
  await olivia.getByRole('heading', { name: 'Board' }).waitFor()
  ok('ops is redirected away from admin')

  await check(Promise.resolve(errors.length === 0), 'no uncaught page errors' + (errors.length ? ': ' + errors[0] : ''))
  console.log(`\n${pass} passed, ${failed} failed`)
  await browser.close()
  process.exit(failed ? 1 : 0)
})().catch((e) => { console.error(e); process.exit(2) })
