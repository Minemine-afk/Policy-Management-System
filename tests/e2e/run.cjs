const { chromium } = require('playwright')
const fs = require('fs')

function pdf(text) {
  const lines = text.split('\n')
  const stream = 'BT /F1 14 Tf 72 720 Td 18 TL ' + lines.map((l) => `(${l.replace(/[()\\]/g, '')}) '`).join(' ') + ' ET'
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
fs.writeFileSync(__dirname + '/advisory-form-redacted.pdf', pdf('Life Insurance Advisory Form\nClient name: XXXXXXXX\nNRIC: XXXXXXXX\nNeeds: income protection 10 years'))
fs.writeFileSync(__dirname + '/needs-analysis-NOT-redacted.pdf', pdf('Needs analysis\nClient NRIC S1234567D\nPhone 9123 4567'))
fs.writeFileSync(__dirname + '/rates-v2.csv', 'age_band,gender,smoker,coverage_term,sum_assured_band,ci_benefit,premium_low,premium_high\n"30 to 34",Female,Yes,"6 to 10 years","Up to S$100,000",Yes,400,560\n')

const BASE = 'http://127.0.0.1:5173'
const results = []
const ok = (m) => { results.push('PASS ' + m); console.log('PASS', m) }
const fail = (m) => { results.push('FAIL ' + m); console.log('FAIL', m) }
async function check(cond, m) { (await cond) ? ok(m) : fail(m) }

;(async () => {
  const browser = await chromium.launch()
  const ctx = async () => browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 })
  async function login(page, email) {
    await page.goto(BASE)
    await page.getByLabel('Email').fill(email)
    await page.getByLabel('Password').fill('password123')
    await page.getByRole('button', { name: 'Sign in' }).click()
    await page.getByRole('button', { name: 'Sign out' }).waitFor()
  }
  const errors = []

  // 1. Submitter creates a request
  let c = await ctx(); let p = await c.newPage()
  p.on('pageerror', (e) => errors.push(e.message))
  await login(p, 'submitter@example.com')
  await p.getByRole('heading', { name: 'Term life request' }).waitFor()
  await p.getByLabel('Client age band').selectOption('30 to 34')
  await p.getByRole('group', { name: 'Gender' }).getByRole('button', { name: 'Female' }).click()
  await p.getByRole('group', { name: 'Smoker' }).getByRole('button', { name: 'Yes' }).click()
  await p.getByLabel('Sum assured').selectOption('Up to S$100,000')
  await p.waitForTimeout(800)
  await check(p.locator('table tbody tr').count().then((n) => n === 3), 'live preview shows 3 insurer price ranges')
  await check(p.getByText('[Sample] Critical illness rider guide').isVisible(), 'relevant documents panel shows CI-tagged documents')
  await p.getByLabel('Introducer').selectOption({ label: '[Sample] Orchard Legal Chambers' })
  await p.getByLabel(/private case reference/).fill('FILE-0423')
  await p.getByLabel('Upload redacted PDFs').setInputFiles([__dirname + '/advisory-form-redacted.pdf', __dirname + '/needs-analysis-NOT-redacted.pdf'])
  await p.getByText('Checked · nothing identifying found').first().waitFor({ timeout: 15000 })
  await check(p.getByText(/Blocked · possible NRIC\/FIN on page 1/).isVisible(), 'unredacted PDF is blocked and not stored')
  await check(p.locator('.filelist li', { hasText: 'needs-analysis-NOT-redacted.pdf' }).getByRole('button', { name: 'Remove' }).count().then((n) => n === 0), 'blocked file has no stored row')
  await p.getByRole('button', { name: 'Preview request' }).click()
  await p.getByRole('heading', { level: 1, name: /PR-2026-/ }).waitFor()
  const ref = await p.getByRole('heading', { level: 1 }).innerText()
  await p.getByRole('button', { name: 'Submit for approval' }).click()
  await check(p.getByText('Confirm that the documents are redacted').waitFor({ timeout: 5000 }).then(() => true, () => false), 'submit without attestation is refused by the database')
  await p.getByRole('link', { name: 'Back to edit' }).click()
  await p.getByRole('checkbox').check()
  await p.getByRole('button', { name: 'Preview request' }).click()
  await p.getByRole('button', { name: 'Submit for approval' }).click()
  await p.getByText('Submitted · awaiting review').first().waitFor()
  ok(`submitter submitted ${ref}`)
  await p.getByText('Your case reference: FILE-0423').waitFor()
  await p.screenshot({ path: __dirname + '/shots/1-generated-request.png', fullPage: true })
  await c.close()

  // 2. Alex (submitter + approver) refers it back
  c = await ctx(); p = await c.newPage(); p.on('pageerror', (e) => errors.push(e.message))
  await login(p, 'approver@example.com')
  await p.getByRole('link', { name: 'Approval queue' }).click()
  await p.getByText('Submitted by you').waitFor()
  ok('approver sees own request greyed out as "Submitted by you"')
  await p.getByRole('link', { name: new RegExp(ref) }).click()
  await p.getByRole('heading', { name: ref }).waitFor()
  await check(p.getByText('FILE-0423').count().then((n) => n === 0), 'approver cannot see the private case reference')
  const [popup] = await Promise.all([p.waitForEvent('popup'), p.getByRole('button', { name: 'Open' }).first().click()])
  await popup.waitForLoadState().catch(() => {})
  ok('approver opened redacted document via signed link')
  await popup.close()
  await p.getByRole('button', { name: 'Reject' }).click()
  await check(p.getByText('A reason is required').waitFor({ timeout: 5000 }).then(() => true, () => false), 'reject without reason is refused')
  await p.getByLabel(/Reason/).fill('Please add the needs analysis (redacted).')
  await p.screenshot({ path: __dirname + '/shots/2-approval-queue.png', fullPage: true })
  await p.getByRole('button', { name: 'Refer back' }).click()
  await p.getByText('Referred back').first().waitFor()
  ok('approver referred the request back with a reason')
  await c.close()

  // 3. Submitter resubmits
  c = await ctx(); p = await c.newPage(); p.on('pageerror', (e) => errors.push(e.message))
  await login(p, 'submitter@example.com')
  await p.getByRole('link', { name: 'My requests' }).click()
  await p.getByRole('link', { name: ref }).click()
  await p.getByText('Please add the needs analysis (redacted).').waitFor()
  ok('submitter sees the approver\'s reason on the edit screen')
  await p.getByRole('button', { name: 'Preview request' }).click()
  await p.getByRole('button', { name: 'Resubmit for approval' }).click()
  await p.getByText('Submitted · awaiting review').first().waitFor()
  ok('submitter resubmitted')
  await c.close()

  // 4. Jordan reports a file, then approves
  c = await ctx(); p = await c.newPage(); p.on('pageerror', (e) => errors.push(e.message))
  await login(p, 'approver2@example.com')
  await p.goto(BASE + '/queue')
  await p.getByRole('link', { name: new RegExp(ref) }).click()
  await p.getByRole('heading', { name: ref }).waitFor()
  p.once('dialog', (d) => d.accept('Name visible in header, page 1'))
  await p.getByRole('button', { name: 'Report unredacted data' }).click()
  await p.waitForTimeout(800)
  await check(p.getByText('advisory-form-redacted.pdf').count().then((n) => n === 0), 'reported file disappears for the approver')
  await p.getByRole('button', { name: 'Approve' }).click()
  await p.waitForTimeout(800)
  await p.goto(BASE + '/requests/' + p.url().split('/').pop())
  await check(p.getByText('Approved', { exact: true }).first().waitFor({ timeout: 5000 }).then(() => true, () => false), 'second approver approved the request')
  await c.close()

  // 5. Admin: all requests, audit, rate table, users
  c = await ctx(); p = await c.newPage(); p.on('pageerror', (e) => errors.push(e.message))
  await login(p, 'admin@example.com')
  await p.goto(BASE + '/admin/requests')
  await p.getByRole('link', { name: ref }).waitFor()
  ok('admin sees the request in All requests')
  await p.screenshot({ path: __dirname + '/shots/3-admin-requests.png', fullPage: true })
  await p.getByRole('link', { name: 'Audit log' }).click()
  await check(p.getByText(/1 file reported as unredacted/).waitFor({ timeout: 5000 }).then(() => true, () => false), 'audit log flags the reported file for the admin')
  await check(p.getByRole('cell', { name: 'document.viewed' }).first().isVisible(), 'document view was logged')
  await p.getByRole('link', { name: 'Rate tables' }).click()
  await p.getByLabel('Insurer').fill('[Sample Insurer A]')
  await p.getByLabel('Rates as at').fill('2026-11-01')
  await p.getByLabel('CSV file').setInputFiles(__dirname + '/rates-v2.csv')
  await p.getByRole('button', { name: 'Upload for approval' }).click()
  await p.getByText(/Uploaded 1 rows as \[Sample Insurer A\] v2/).waitFor()
  await check(p.getByText('Needs another admin').isVisible(), 'uploader cannot approve their own rate table')
  await p.getByRole('link', { name: 'Users and roles' }).click()
  await p.getByRole('checkbox', { name: 'Admin for Pat Admin' }).click()
  await check(p.getByText('You cannot remove your own admin access').waitFor({ timeout: 5000 }).then(() => true, () => false), 'admin cannot remove own admin access')
  await c.close()

  c = await ctx(); p = await c.newPage(); p.on('pageerror', (e) => errors.push(e.message))
  await login(p, 'admin2@example.com')
  await p.goto(BASE + '/admin/rates')
  await p.getByRole('button', { name: 'Approve' }).click()
  await p.getByText('[Sample Insurer A] v2 is now live.').waitFor()
  ok('second admin approved the rate table')
  await c.close()

  // 6. Introducers and knowledge bank
  c = await ctx(); p = await c.newPage(); p.on('pageerror', (e) => errors.push(e.message))
  await login(p, 'editor@example.com')
  await p.goto(BASE + '/introducers')
  await p.getByLabel('Speciality').selectOption('Legal')
  await check(p.locator('tbody tr').count().then((n) => n === 1), 'introducers filter by speciality')
  await p.getByLabel('Speciality').selectOption('')
  await p.getByLabel('Status').selectOption('')
  await p.getByRole('button', { name: /Date added/ }).click()
  await p.screenshot({ path: __dirname + '/shots/4-introducers.png', fullPage: true })
  await p.goto(BASE + '/knowledge')
  await p.getByLabel('Search').fill('money')
  await p.waitForTimeout(800)
  await check(p.locator('.filelist li').count().then((n) => n === 1), 'knowledge bank full-text search finds text inside a document')
  await p.getByLabel('Search').fill('')
  await p.getByRole('button', { name: 'Upload document' }).click()
  await p.getByLabel('Title').fill('Sample redaction form')
  await p.getByLabel(/Tags/).fill('term, onboarding')
  await p.getByLabel('File').setInputFiles(__dirname + '/advisory-form-redacted.pdf')
  await p.getByRole('button', { name: 'Save' }).click()
  await p.getByText('Sample redaction form').waitFor()
  await p.getByLabel('Search').fill('income protection')
  await p.waitForTimeout(800)
  await check(p.getByText('Sample redaction form').isVisible(), 'uploaded PDF is searchable by its contents')
  await p.screenshot({ path: __dirname + '/shots/5-knowledge-bank.png', fullPage: true })
  await c.close()

  // 7. Mobile width check of the form
  c = await browser.newContext({ viewport: { width: 390, height: 844 } }); p = await c.newPage()
  await login(p, 'submitter@example.com')
  const sw = await p.evaluate(() => document.documentElement.scrollWidth)
  sw <= 390 ? ok('request form fits a phone screen') : fail('horizontal scroll on phone: ' + sw)
  await c.close()

  if (errors.length) fail('page errors: ' + errors.join(' | ')); else ok('no JavaScript errors')
  await browser.close()
  fs.writeFileSync(__dirname + '/results.txt', results.join('\n'))
})().catch((e) => { console.log('CRASH', e.message); process.exit(1) })
