// Tests "teach a new insurer" (web/src/lib/piTeach.ts) on PIs whose layout the reader has no rules for.
// Ops' values for each PI are the expected values (expected-unknown-formats.json), with full words from
// teach-values.json where the expected value is only part of the words.
//
// A. Same insurer, new client: learn from each PI, then read a copy of it where every taught amount is changed
//    (x 1.37, in the PI's own number format) and the insured name is replaced. A learned place that points at the
//    wrong number reads the unchanged number, so it shows as wrong.
// B. Same insurer, another product: learn from one real PI, read a different real PI of that insurer.
// C. Other insurers: with every PI's places learned, read each PI using only other PIs' places. Nothing may change.
// Usage: node tests/pi-extract/check-teach.mjs <folder with PDFs> [--max-wrong N]
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pdfjs = await import(path.join(here, '../../web/node_modules/pdfjs-dist/legacy/build/pdf.mjs'))
const { extract, readWith, FIELDS } = await import(path.join(here, '../../web/src/lib/piExtract.ts'))
const { learn, applyLearned } = await import(path.join(here, '../../web/src/lib/piTeach.ts'))

const args = process.argv.slice(2)
const dir = args.find((a) => !a.startsWith('--') && !/^\d+$/.test(a))
const maxWrong = args.includes('--max-wrong') ? +args[args.indexOf('--max-wrong') + 1] : null
const verbose = args.includes('--verbose')
if (!dir) { console.error('Usage: node tests/pi-extract/check-teach.mjs <folder> [--max-wrong N]'); process.exit(2) }
const expected = JSON.parse(fs.readFileSync(path.join(here, 'expected-unknown-formats.json'), 'utf8'))
const words = JSON.parse(fs.readFileSync(path.join(here, 'teach-values.json'), 'utf8'))
const files = Object.keys(expected).filter((k) => !k.startsWith('_') && fs.existsSync(path.join(dir, k))).sort()

const origLog = console.log
const quiet = (fn) => async (...a) => { const w = console.warn; console.warn = () => {}; try { return await fn(...a) } finally { console.warn = w } }
const read = quiet(async (f) => { const d = fs.readFileSync(path.join(dir, f)); return readWith(pdfjs, d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength)) })

const same = (got, want) => {
  if (want.startsWith('NOT:')) return got !== want.slice(4)
  if (want.startsWith('~')) return !!got && got.toLowerCase().includes(want.slice(1).toLowerCase())
  return got === want
}
const kindOf = (k) => FIELDS.find((f) => f.key === k)?.kind

/** What ops would type for each field of a PI. */
function opsValues(f, found) {
  const v = {}
  for (const [k, want] of Object.entries(expected[f])) {
    if (!want || want.startsWith('NOT:')) continue
    if (!want.startsWith('~')) { v[k] = want; continue }
    if (words[f]?.[k]) v[k] = words[f][k]
    else if (same(found[k]?.value ?? '', want)) v[k] = found[k].value
  }
  for (const [k, w] of Object.entries(words[f] ?? {})) if (!(k in v)) v[k] = w
  return v
}

function score(found, want, label, out, scoreOnly) {
  let r = 0, b = 0, w = 0
  for (const [k, x] of Object.entries(want)) {
    if (x === undefined || (scoreOnly && !(k in scoreOnly))) continue
    const got = found[k]?.value ?? ''
    if (same(got, x)) r++
    else if (!got) { b++; out.push(`    · ${label} ${k}: blank (PI says ${x})`) }
    else { w++; out.push(`    ✗ ${label} ${k}: "${got}" but PI says ${x}${found[k].learned ? ' (learned place)' : ''}`) }
  }
  return { r, b, w }
}

// ---------- the changed copy ----------
const SCALE = 1.37
function fmtLike(src, n) {
  const dec = (src.match(/\.(\d+)$/) ?? [, ''])[1].length
  let s = n.toFixed(dec)
  if (src.includes(',')) { const [i, d] = s.split('.'); s = i.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (d ? '.' + d : '') }
  return s
}
function changedCopy(pages, values) {
  const targets = []
  for (const [k, v] of Object.entries(values)) {
    if (!['money', 'sum'].includes(kindOf(k))) continue
    const n = Number(v); if (!(n > 0)) continue
    for (const d of [1, 2, 4, 12]) targets.push(n / d)
  }
  const near = (n) => targets.some((t) => Math.abs(n - t) <= Math.max(0.006, t * 0.0001))
  const name = values.insured_name
  const fix = (s) => {
    let t = s.replace(/\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?/g, (m) => (near(Number(m.replace(/,/g, ''))) && Number(m.replace(/,/g, '')) >= 1 ? fmtLike(m, Number(m.replace(/,/g, '')) * SCALE) : m))
    if (name) t = t.split(name).join('Alex Tan')
    if (name && name.includes('Client Quote')) t = t.split('Client Quote').join('Alex Tan')
    return t
  }
  return pages.map((p) => ({ ...p, items: p.items.map((i) => ({ ...i, str: fix(i.str) })), lines: p.lines.map((l) => ({ ...l, text: fix(l.text) })) }))
}
function changedValues(values) {
  const out = {}
  for (const [k, v] of Object.entries(values)) {
    if (['money', 'sum'].includes(kindOf(k)) && Number(v) > 0) {
      const n = Number(v) * SCALE
      out[k] = kindOf(k) === 'money' ? n.toFixed(2) : String(Math.round(n))
    } else out[k] = k === 'insured_name' ? v.replace(values.insured_name, 'Alex Tan').replace('Client Quote', 'Alex Tan') : v
  }
  return out
}
// Monthly x 12 after scaling the monthly figure can differ from yearly x 1.37 by a cent: compare to the cent.
const centSame = (a, b) => a === b || (/^\d+\.\d\d$/.test(a) && /^\d+\.\d\d$/.test(b) && Math.abs(a - b) <= 0.12)

// ---------- run ----------
const data = {}
for (const f of files) {
  const pages = await read(f)
  const found = extract(pages, f).found
  const values = opsValues(f, found)
  const insurer = values.insurer || found.insurer?.value || ''
  const rules = learn(pages, values, found, insurer)
  data[f] = { pages, found, values, insurer, rules }
}

origLog('A. Same insurer, new client (changed copy of each PI)')
let A0 = { r: 0, b: 0, w: 0 }, A1 = { r: 0, b: 0, w: 0 }, learnedCount = 0
for (const f of files) {
  const { pages, values, rules } = data[f]
  const copy = changedCopy(pages, values)
  const want = changedValues(values)
  const before = extract(copy, f).found
  const after = applyLearned(before, copy, rules).found
  for (const k of Object.keys(want)) if (centSame(after[k]?.value ?? '', want[k])) after[k] = { ...after[k], value: want[k] }
  for (const k of Object.keys(want)) if (centSame(before[k]?.value ?? '', want[k])) before[k] = { ...before[k], value: want[k] }
  const out0 = [], out1 = []
  const s0 = score(before, want, 'before', out0, expected[f]), s1 = score(after, want, 'after', out1, expected[f])
  const n = Object.values(after).filter((x) => x.learned).length
  learnedCount += n
  for (const k of ['r', 'b', 'w']) { A0[k] += s0[k]; A1[k] += s1[k] }
  origLog(`${f}: ${rules.length} places learned. Before ${s0.r} right ${s0.b} blank ${s0.w} wrong; after ${s1.r} right ${s1.b} blank ${s1.w} wrong (${n} learned values)`)
  for (const o of out1) origLog(o)
  if (verbose) for (const r of rules) origLog(`      ${r.field}: ${r.how} "${r.label}" +${r.offset} x${r.factor}${r.cut ? ' cut ' + r.cut : ''}`)
}
const pct = (s) => `${s.r}/${s.r + s.b + s.w} right, ${s.b} blank, ${s.w} wrong`
origLog(`A total. Before teaching: ${pct(A0)}. After: ${pct(A1)}.\n`)

origLog('B. Same insurer, another product (real PIs)')
const PAIRS = [
  ['MY_Zurich_TermLife_PDS_2026.pdf', 'MY_Zurich_DirectTerm_PDS.pdf'],
  ['MY_Zurich_DirectTerm_PDS.pdf', 'MY_Zurich_TermLife_PDS_2026.pdf'],
  ['MY_HLA_LifeEssential_PDS_2025.pdf', 'MY_HLA_MDTA-DreadDisease_PDS_2025.pdf'],
  ['MY_HLA_MDTA-DreadDisease_PDS_2025.pdf', 'MY_HLA_LifeEssential_PDS_2025.pdf'],
  ['CA_Manulife_FamilyTerm20_2024.pdf', 'MY_Manulife_EasyProtect_PDS_2021.pdf'],
  ['MY_Manulife_EasyProtect_PDS_2021.pdf', 'CA_Manulife_FamilyTerm20_2024.pdf'],
]
let B0 = { r: 0, b: 0, w: 0 }, B1 = { r: 0, b: 0, w: 0 }
for (const [from, to] of PAIRS) {
  if (!data[from] || !data[to]) continue
  const { pages, found } = data[to]
  const after = applyLearned(found, pages, data[from].rules)
  const out0 = [], out1 = []
  const s0 = score(found, expected[to], 'before', out0), s1 = score(after.found, expected[to], 'after', out1)
  for (const k of ['r', 'b', 'w']) { B0[k] += s0[k]; B1[k] += s1[k] }
  const n = Object.values(after.found).filter((x) => x.learned).length
  origLog(`${from} -> ${to}: ${n} learned values used${after.insurer ? '' : ' (insurer not matched)'}. Before ${pct(s0)}; after ${pct(s1)}`)
  for (const o of out1) if (o.includes('✗')) origLog(o)
}
origLog(`B total. Before: ${pct(B0)}. After: ${pct(B1)}.\n`)

origLog('C. Places of other insurers must not be used')
let changed = 0
for (const f of files) {
  const others = files.filter((g) => g !== f && data[g].insurer.toLowerCase().split(/\s+/)[0] !== data[f].insurer.toLowerCase().split(/\s+/)[0]).flatMap((g) => data[g].rules)
  const after = applyLearned(data[f].found, data[f].pages, others)
  const diff = Object.keys(after.found).filter((k) => (after.found[k]?.value ?? '') !== (data[f].found[k]?.value ?? ''))
  if (diff.length) { changed += diff.length; origLog(`  ✗ ${f}: ${diff.join(', ')} changed using ${after.insurer}'s places`) }
}
origLog(`C total: ${changed} values changed by other insurers' places.`)

origLog('\nD. No client value is kept in a learned place')
let leaks = 0
for (const f of files) {
  const { values, rules } = data[f]
  const secret = [values.insured_name, values.date_of_birth, ...Object.entries(values).filter(([k, v]) => ['money', 'sum'].includes(kindOf(k)) && Number(v) >= 100).flatMap(([, v]) => [v, Number(v).toLocaleString('en-US'), Number(v).toLocaleString('en-US', { minimumFractionDigits: 2 })])].filter(Boolean)
  for (const r of rules) {
    const kept = JSON.stringify([r.label, r.cut, r.plan]).toLowerCase()
    const hit = secret.find((x) => kept.includes(String(x).toLowerCase()))
    if (hit) { leaks++; origLog(`  ✗ ${f}: a ${r.field} place keeps "${hit}" (${r.label})`) }
  }
}
origLog(`D total: ${leaks} places keeping a client value.`)

const wrongAdded = leaks + Math.max(0, A1.w - A0.w) + Math.max(0, B1.w - B0.w) + changed
if (maxWrong !== null && wrongAdded > maxWrong) { origLog(`Teaching added ${wrongAdded} wrong values (allowed ${maxWrong})`); process.exit(1) }
