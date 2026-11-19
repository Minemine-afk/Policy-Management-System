// Builds the PI pack: one PDF with the comparison page first (in the layout of the comparison Excel template)
// and then every PI PDF of the request, unchanged. Made in the browser of the ops or bsd user, so the PIs never
// leave it except for the upload to the request.
// The pack is restricted (AES-256, owner password thrown away): it opens without a password and can be printed
// and copied from, but PDF readers won't let anyone edit it, annotate it, fill it in or move its pages.
// Readers respect these flags; a determined person can still remove them with other tools. The portal's own copy
// can't be changed, and its SHA-256 fingerprint is kept, so a changed copy can always be told apart.
import { FIELDS, labelWith, type FieldDef } from './piExtract.ts'
import { commonCurrency, headerValue, type ExportColumn } from './piExcel.ts'
import { issueDateHeading, showDate, todayDmy } from './piIssueDate.ts'
import type { RequestDocument } from './types.ts'

type PdfLib = typeof import('@cantoo/pdf-lib')
let pdfLoad: Promise<PdfLib> | null = null
/** Loads the PDF tool in the background when the comparison shows (see preloadExcel for why). */
export function preloadPdf() {
  pdfLoad ??= import('@cantoo/pdf-lib').catch((e) => { pdfLoad = null; throw e })
  return pdfLoad
}

export const packFileName = (ref: string) => `${ref}-pi-pack.pdf`
export const isPackFile = (name: string) => /-pi-pack\.pdf$/i.test(name)

export interface PiFile { name: string; data: ArrayBuffer }

const isPack = (d: RequestDocument) => d.is_pack ?? isPackFile(d.file_name)
/** The PI PDFs on a request (not packs, not Excel), the newest pack, and whether that pack was made from exactly them. */
export function packState(docs: RequestDocument[]) {
  const pdfs = docs.filter((d) => d.kind === 'pi_output' && !isPack(d) && d.file_name.toLowerCase().endsWith('.pdf'))
  const pack = docs.filter((d) => d.kind === 'pi_output' && isPack(d)).sort((a, b) => b.uploaded_at.localeCompare(a.uploaded_at))[0]
  const ids = pdfs.map((d) => d.id).sort().join(',')
  const current = !!pack && [...(pack.pack_of ?? [])].sort().join(',') === ids
  return { pdfs, pack, current, isPack }
}

const NAVY = [11 / 255, 31 / 255, 77 / 255] as const
const CREAM = [1, 242 / 255, 204 / 255] as const
const GREY = [0.5, 0.5, 0.5] as const
const DOLLAR = new Set(['SGD', 'USD', 'AUD', 'CAD', 'HKD', 'BND', 'NZD'])
const HEADER_KEYS = ['insured_name', 'date_of_birth', 'gender', 'residency', 'underwriting_class']
const NOT_IN_TABLE = new Set([...HEADER_KEYS, 'currency', 'cover_age'])
const toNumber = (v: string): number | null => {
  const s = v.replace(/,/g, '').trim()
  return s !== '' && !isNaN(Number(s)) ? Number(s) : null
}
const commas = (n: number, dp: number) => n.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp })

/** A value as the Excel shows it: "$2,478.51" under "Annual Premium (SGD)", "SGD 500,000" for a sum assured. */
export function cellText(f: FieldDef, raw: string, cur: string, common: string): string {
  const v = raw.trim()
  if (!v) return ''
  const n = f.kind === 'text' || f.kind === 'cover' ? null : toNumber(v)
  if (n === null) return v
  if (f.kind === 'years' || f.kind === 'age') return String(n)
  const dp = f.kind === 'money' || !Number.isInteger(n) ? 2 : 0
  const prefix = f.kind === 'money' && common && DOLLAR.has(cur) ? '$' : cur ? `${cur} ` : ''
  return prefix + commas(n, dp)
}

const SECTION_ROWS: { band?: string; keys: string[] }[] = [
  { keys: ['insurer', 'policy_name', 'policy_term', 'premium_term', 'annual_premium', 'total_premium'] },
  { band: '', keys: ['death_sa', 'terminal_illness', 'accidental_death', 'base_premium'] },
  { band: 'Riders', keys: ['tpd_sa', 'tpd_premium', 'ci_sa', 'ci_premium'] },
  { band: '', keys: ['cash_value', 'campaigns'] },
]

export async function buildPack(cols: ExportColumn[], pis: PiFile[], ref: string, now = new Date()): Promise<Blob> {
  let lib: PdfLib
  try { lib = await preloadPdf() }
  catch { throw new Error('The site was updated after this page was opened, so the PDF tool could not load. Note any values you changed, refresh the page, then try again.') }
  const { PDFDocument, StandardFonts, rgb } = lib
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const bold = await doc.embedFont(StandardFonts.HelveticaBold)
  // The standard fonts cover Western European text only; anything else shows as "?".
  const safe = (s: string) => [...s.replace(/\s+/g, ' ')].map((ch) => { try { font.encodeText(ch); return ch } catch { return '?' } }).join('')
  const width = (s: string, size: number, f = font) => f.widthOfTextAtSize(safe(s), size)
  const wrap = (s: string, size: number, max: number, f = font): string[] => {
    const out: string[] = []
    let line = ''
    for (const word of safe(s).split(' ')) {
      const next = line ? `${line} ${word}` : word
      if (width(next, size, f) <= max || !line) line = next
      else { out.push(line); line = word }
    }
    if (line) out.push(line)
    return out.length ? out : ['']
  }

  const W = 842, H = 595, M = 36           // A4 landscape, half-inch margins
  const common = commonCurrency(cols)
  const generated = todayDmy(now)
  const heading = issueDateHeading(cols.map((c) => c.issueDate ?? ''), generated)
  const notes: string[] = []
  if (heading.note) notes.push(heading.note)
  const pages: import('@cantoo/pdf-lib').PDFPage[] = []
  let page = doc.addPage([W, H]); pages.push(page)
  let y = H - M
  const text = (s: string, x: number, yy: number, size = 9, f = font, color: readonly number[] = [0, 0, 0]) =>
    page.drawText(safe(s), { x, y: yy, size, font: f, color: rgb(color[0], color[1], color[2]) })
  const newPage = () => { page = doc.addPage([W, H]); pages.push(page); y = H - M }

  // Title, request and the PI issue date at the top right.
  text('Term Quotation Comparison', M, y - 14, 16, bold, NAVY)
  for (const [i, l] of wrap(heading.text, 10, 360, bold).entries()) text(l, W - M - width(l, 10, bold), y - 12 - i * 13, 10, bold, NAVY)
  text(`Request ${ref}`, M, y - 30, 9, font, GREY)
  y -= 50

  // The insured person: the PI's value, else the request form's (marked with a dagger).
  let fromForm = false
  for (const k of HEADER_KEYS) {
    const f = FIELDS.find((x) => x.key === k)!
    const h = headerValue(cols, k)
    text(`${f.label}:`, M, y, 9.5, bold)
    text(h.value + (h.fromForm ? ' †' : ''), M + 120, y, 9.5)
    if (h.fromForm) fromForm = true
    for (const [i, x] of h.differs) notes.push(`PI${i + 1}: ${f.label} is "${x}" in this PI (the header shows "${h.value}").`)
    y -= 14
  }
  y -= 6

  // Table geometry: a label column and one column per PI.
  const labelW = 190
  const colW = (W - 2 * M - labelW) / Math.max(cols.length, 1)
  const bar = (color: readonly number[], h: number) => page.drawRectangle({ x: M, y: y - h, width: W - 2 * M, height: h, color: rgb(color[0], color[1], color[2]) })

  bar(NAVY, 16); text('PLAN TYPE: TERM PLAN', M + 6, y - 11.5, 9.5, bold, [1, 1, 1]); y -= 22
  const sa = headerValue(cols, 'death_sa').value
  const saCur = cols.find((c) => (c.values.death_sa ?? '').trim())?.values.currency ?? common
  const saN = toNumber(sa)
  const age = headerValue(cols, 'cover_age').value
  const term = headerValue(cols, 'policy_term').value
  for (const l of [
    `Sum Assured: ${saN !== null ? `${saCur ? saCur.toUpperCase() + ' ' : ''}${commas(saN, Number.isInteger(saN) ? 0 : 2)}` : sa}`,
    `Policy Term: ${age ? `Up till age ${age}` : term ? `${term} years` : ''}`,
  ]) { bar(CREAM, 15); text(l, M + 6, y - 11, 9.5, bold, NAVY); y -= 15 }
  y -= 8

  const grid = rgb(0.5, 0.5, 0.5)
  const row = (label: string, cells: string[], opts: { head?: boolean } = {}) => {
    const size = 8.5
    const lab = wrap(label, size, labelW - 8, bold)
    const vals = cells.map((c) => wrap(c, size, colW - 8, opts.head ? bold : font))
    const lines = Math.max(lab.length, ...vals.map((v) => v.length))
    const h = 5 + lines * 9.5
    if (y - h < M + 30) newPage()
    page.drawRectangle({ x: M, y: y - h, width: labelW, height: h, borderColor: grid, borderWidth: 0.5 })
    lab.forEach((l, i) => text(l, M + 4, y - 10.5 - i * 9.5, size, bold))
    vals.forEach((v, c) => {
      const x = M + labelW + c * colW
      page.drawRectangle({ x, y: y - h, width: colW, height: h, borderColor: grid, borderWidth: 0.5 })
      v.forEach((l, i) => text(l, x + (colW - width(l, size, opts.head ? bold : font)) / 2, y - 10.5 - i * 9.5, size, opts.head ? bold : font))
    })
    y -= h
  }
  const band = (label: string) => {
    if (y - 14 < M + 30) newPage()
    bar(NAVY, 14)
    if (label) text(label, M + labelW + (W - 2 * M - labelW - width(label, 9, bold)) / 2, y - 10.5, 9, bold, [1, 1, 1])
    y -= 14
  }

  for (const sec of SECTION_ROWS) {
    if (sec.band !== undefined) band(sec.band)
    for (const k of sec.keys) {
      const f = FIELDS.find((x) => x.key === k)!
      if (NOT_IN_TABLE.has(k)) continue
      const cells = cols.map((c) => {
        const cur = (c.values.currency ?? '').trim().toUpperCase()
        const t = cellText(f, c.values[k] ?? '', cur, common)
        return k === 'insurer' && cur && !common ? `${t} (${cur})` : t
      })
      row(k === 'insurer' ? 'Insurer' : labelWith(f, common), cells, { head: k === 'insurer' })
    }
  }

  // Notes and the key.
  const all = [...cols.flatMap((c, i) => c.notes.map((n) => `PI${i + 1}: ${n}`)), ...notes]
  if (fromForm) all.unshift('† Not shown in the PI, so taken from the request form.')
  y -= 10
  for (const n of all) {
    for (const l of wrap(n, 8, W - 2 * M)) {
      if (y < M + 30) newPage()
      text(l, M, y, 8, font, [0.4, 0.4, 0.4]); y -= 10
    }
  }
  if (y < M + 44) newPage()
  y -= 8
  for (const l of wrap('This comparison summarises the policy illustrations (PIs) that follow it. It is not advice. The PIs are the insurers\' documents: where this page and a PI differ, the PI prevails.', 8, W - 2 * M)) {
    text(l, M, y, 8, font, [0.4, 0.4, 0.4]); y -= 10
  }

  // The PIs, unchanged. Insurer PIs locked only against changes still open: read them with the empty password.
  for (const [i, pi] of pis.entries()) {
    let src: import('@cantoo/pdf-lib').PDFDocument
    try { src = await PDFDocument.load(pi.data, { password: '' }) }
    catch {
      try { src = await PDFDocument.load(pi.data) }
      catch { throw new Error(`PI ${i + 1} (${pi.name}) is password-protected or damaged, so it can't go into the PI pack. Ask the insurer for a copy without a password and upload that instead.`) }
    }
    for (const p of await doc.copyPages(src, src.getPageIndices())) doc.addPage(p)
  }

  // Footer on the comparison pages.
  const total = doc.getPageCount()
  pages.forEach((p, i) => {
    const s = safe(`Prepared by PWS Service Hub on ${showDate(generated)} · Request ${ref} · Comparison page ${i + 1} of ${pages.length} · ${total} pages in this pack with the PIs`)
    p.drawText(s, { x: M, y: M - 18, size: 7.5, font, color: rgb(GREY[0], GREY[1], GREY[2]) })
  })

  doc.setTitle(`${ref} PI comparison and policy illustrations`)
  doc.setSubject('Term quotation comparison with the policy illustrations')
  doc.setProducer('PWS Service Hub')
  doc.setCreator('PWS Service Hub')
  const owner = Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) => b.toString(16).padStart(2, '0')).join('')
  doc.encrypt({
    userPassword: '', ownerPassword: owner,
    permissions: { printing: 'highResolution', copying: true, contentAccessibility: true, modifying: false, annotating: false, fillingForms: false, documentAssembly: false },
  })
  const bytes = await doc.save()
  return new Blob([bytes as BlobPart], { type: 'application/pdf' })
}

/** The SHA-256 fingerprint of a file, as 64 hex characters. */
export async function sha256(blob: Blob): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('')
}
