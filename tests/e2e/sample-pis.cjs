// Made-up Singapore-style PIs (LIA layout: cover page rows + a summary table), used by run.cjs.
// Writes them to a folder when run directly: node sample-pis.cjs <folder>
function pdf(items) {
  const esc = (t) => t.replace(/([()\\])/g, '\\$1')
  const stream = items.map(([x, y, t, size = 10]) => `BT /F1 ${size} Tf ${x} ${y} Td (${esc(t)}) Tj ET`).join('\n')
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

// Cover page block, then a summary table: heads = [[x, y, text]], row = [[x, text]].
function lia({ plan, insurer, premiumTerm, policyTerm, tdc, pct, mode, heads, row, extra = [] }) {
  return pdf([
    [72, 770, '[SAMPLE] Made-up policy illustration for testing'],
    [200, 730, plan, 12],
    [72, 710, 'Product Type'], [250, 710, 'Non-Participating Term Plan'],
    [72, 695, 'Premium Term'], [250, 695, premiumTerm],
    [72, 680, 'Policy Term'], [250, 680, policyTerm],
    [72, 665, 'Name of Insurer'], [250, 665, insurer],
    [72, 640, `The Total Distribution Cost for this plan is ${tdc} as shown in the Policy Illustration. This makes up ${pct}% of`],
    [72, 628, 'the total premiums payable. The minimum sum assured is $50,000.', 7],
    [72, 560, 'Life Assured : XXXXX'], [300, 560, 'Gender / Smoker Status : Female/Non-Smoker'],
    [72, 545, `Payment Mode : ${mode}`],
    ...heads,
    ...row.map(([x, t]) => [x, 470, t]),
    ...extra,
  ])
}

const PI_A = lia({
  plan: 'GREAT Term Protector', insurer: 'The Great Eastern Life Assurance Company Limited',
  premiumTerm: '20 Years', policyTerm: 'To Age 65', tdc: '$2,345.60', pct: '20.10', mode: 'Monthly',
  heads: [[72, 500, 'Plan Name'], [220, 500, 'Policy Term'], [300, 500, 'Premium Term'], [380, 500, 'Sum Assured (S$)'], [480, 505, 'Monthly Premium'], [500, 494, '(S$)']],
  row: [[72, 'GREAT Term Protector'], [225, 'To Age 65'], [305, '20 Years'], [385, '500,000'], [485, '105.20']],
})
const PI_B = lia({
  plan: 'AIA Secure Term', insurer: 'AIA Singapore Private Limited',
  premiumTerm: '30 Years', policyTerm: '30 Years', tdc: '$3,010', pct: '9.50', mode: 'Annual',
  heads: [[72, 500, 'Your Plan'], [220, 500, 'Policy Term'], [300, 500, 'Premium Term'], [380, 500, 'Sum Assured'], [480, 500, 'Premium Payable']],
  row: [[72, 'AIA Secure Term'], [230, '30'], [310, '30'], [385, '400,000.00'], [490, '1,180.00']],
})
const PI_C = lia({
  plan: 'Star Term Cover', insurer: 'Income Insurance Limited',
  premiumTerm: '25 Years', policyTerm: '25 Years', tdc: '$ 9 9 0 . 4 0', pct: '12.00', mode: 'Monthly',
  heads: [[72, 510, 'Your Plan'], [170, 510, 'Policy Term'], [240, 510, 'Premium Term'], [310, 510, 'Sum Assured /'], [318, 500, 'Benefit'],
    [390, 510, 'Premium'], [392, 500, 'Before'], [390, 490, 'Discount'], [450, 510, 'Discount (%)'], [510, 510, 'Premium Payable']],
  row: [[72, 'Star Term Cover'], [180, '25'], [250, '25'], [312, '600,000.00'], [395, '80.00'], [460, '15%'], [520, '68.00']],
  extra: [[72, 440, 'Supplementary Benefits'], [72, 425, 'Early CI Rider 25 25 200,000.00 20.00 15% 17.00'], [72, 410, 'Total: 100.00 85.00']],
})

module.exports = { pdf, PI_A, PI_B, PI_C }
if (require.main === module) {
  const fs = require('fs'); const dir = process.argv[2]; fs.mkdirSync(dir, { recursive: true })
  for (const [n, b] of Object.entries({ 'insurer-a.pdf': PI_A, 'insurer-b.pdf': PI_B, 'insurer-c.pdf': PI_C })) fs.writeFileSync(`${dir}/${n}`, b)
}
