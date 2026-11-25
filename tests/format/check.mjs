// Thousands commas (Kumar, 25 Nov 2026): node tests/format/check.mjs
// Checks the shared formatter, then runs the build-time check that every number on screen uses it.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fmtNum, fmtMoney, plain, ungroup, groupDigits, groupMoneyInText } from '../../web/src/lib/num.ts'

let n = 0
const eq = (a, b) => { assert.equal(a, b); n++ }

eq(fmtNum(1000000), '1,000,000')
eq(fmtNum(12345.67), '12,345.67')
eq(fmtNum(999), '999')
eq(fmtNum(1000), '1,000')
eq(fmtNum(-2500), '-2,500')
eq(fmtNum(2478.5, 2), '2,478.50')
eq(fmtNum(0.125), '0.13')
eq(fmtNum('1,234,567'), '1,234,567')
eq(fmtNum('500000'), '500,000')
eq(fmtNum(null), '')
eq(fmtNum('abc'), '')
eq(fmtMoney(1000000, 'SGD'), 'SGD 1,000,000')
eq(fmtMoney('2653.1', 'USD', 2), 'USD 2,653.10')
eq(fmtMoney(null, 'SGD'), '—')
eq(plain(2026), '2026')
eq(plain(12345), '12345')
eq(ungroup('1,000,000.50'), '1000000.50')
eq(ungroup('Included, see page 3'), 'Included, see page 3')
eq(groupDigits('2478.51'), '2,478.51')
eq(groupDigits('500000'), '500,000')
eq(groupDigits('SGD 1500000'), 'SGD 1,500,000')
eq(groupDigits('1,000,000'), '1,000,000')
eq(groupDigits('1234.5678'), '1,234.5678')
eq(groupDigits('999'), '999')
eq(groupDigits('NA'), 'NA')
eq(groupDigits('12345.'), '12,345.')
eq(groupMoneyInText('Annual premium S$2478.51, total SGD 49570.20 over 20 years'), 'Annual premium S$2,478.51, total SGD 49,570.20 over 20 years')
eq(groupMoneyInText('Issued 2026, call 63333333, request PI-2026-00123'), 'Issued 2026, call 63333333, request PI-2026-00123')
eq(groupMoneyInText('Minimum sum assured $50000'), 'Minimum sum assured $50,000')
eq(groupMoneyInText('RM 1,000,000 already'), 'RM 1,000,000 already')
console.log(`Formatter: ${n}/${n} ok`)

execFileSync(process.execPath, ['web/scripts/check-number-format.mjs'], { stdio: 'inherit' })
