// "Download summary (PDF)" from the product comparison pop-up: the wireframe 5 table, with each value's source,
// and the disclaimer. Made in the browser; nothing is uploaded. No client name on it (only the profile used).
import { AUTO_NOTE, DISCLAIMER, blankText, compareNotes, comparisonRows, type Kb, type KbProduct, type Needs } from './kb'
import { fmtNum, plain } from './num.ts'
import { planLabel } from './families.ts'

const NAVY = [0.06, 0.16, 0.3] as const
const GREY = [0.42, 0.45, 0.5] as const
const BAND = [0.92, 0.94, 0.97] as const

export async function buildComparisonPdf(kb: Kb, products: KbProduct[], n: Needs, now = new Date()): Promise<Blob> {
  const { PDFDocument, StandardFonts, rgb } = await import('@cantoo/pdf-lib')
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const bold = await doc.embedFont(StandardFonts.HelveticaBold)
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
  const W = 842, H = 595, M = 36
  let page = doc.addPage([W, H])
  let y = H - M
  const text = (s: string, x: number, yy: number, size = 9, f = font, c: readonly number[] = [0, 0, 0]) =>
    page.drawText(safe(s), { x, y: yy, size, font: f, color: rgb(c[0], c[1], c[2]) })
  const rect = (x: number, yy: number, w: number, h: number, c: readonly number[]) =>
    page.drawRectangle({ x, y: yy, width: w, height: h, color: rgb(c[0], c[1], c[2]) })

  const labelW = 150
  const colW = (W - 2 * M - labelW) / products.length
  const header = () => {
    rect(M, y - 30, W - 2 * M, 30, NAVY)
    text('Product', M + 6, y - 19, 9, bold, [1, 1, 1])
    products.forEach((p, i) => {
      const x = M + labelW + i * colW + 6
      text(wrap(`${p.insurer} · ${planLabel(p.product_type)}${p.auto_read ? ' · AUTO-READ, NOT REVIEWED' : ''}`, 8, colW - 12)[0], x, y - 12, 8, font, [1, 1, 1])
      text(wrap(p.name, 9.5, colW - 12, bold)[0], x, y - 24, 9.5, bold, [1, 1, 1])
    })
    y -= 34
  }

  text('Product comparison', M, y - 14, 16, bold, NAVY)
  const date = now.toLocaleDateString('en-SG', { day: 'numeric', month: 'short', year: 'numeric' })
  text(`Made ${date}`, W - M - width(`Made ${date}`, 9), y - 12, 9, font, GREY)
  y -= 30
  const who = [n.age != null ? `age ${plain(n.age)} next birthday` : '', n.gender.toLowerCase(), n.smoker ? 'smoker' : 'non-smoker',
    n.residency === 'All' ? '' : n.residency.toLowerCase(), n.currency === 'All' ? '' : n.currency,
    !n.amount ? '' : n.mode === 'coverage' ? `cover ${n.currency === 'All' ? '' : n.currency + ' '}${fmtNum(n.amount)}` : `budget ${n.currency === 'All' ? '' : n.currency + ' '}${fmtNum(n.amount)} a year`,
    n.ci ? 'with critical illness' : ''].filter(Boolean).join(', ')
  for (const l of wrap(`Client profile used: ${who}.`, 9, W - 2 * M)) { text(l, M, y, 9, font, GREY); y -= 12 }
  y -= 6
  header()

  let cat = ''
  for (const row of comparisonRows(kb, products, n)) {
    const cells = row.cells.map((c, i) => ({
      lines: wrap(c.text || blankText(products[i]), 8.5, colW - 12, c.text ? font : font),
      src: c.source ? wrap(`Source: ${c.source}`, 6.5, colW - 12) : [],
      na: !c.text,
    }))
    const labelLines = wrap(row.label, 8.5, labelW - 12, bold)
    const h = Math.max(labelLines.length * 11, ...cells.map((c) => c.lines.length * 11 + c.src.length * 8.5)) + 8
    const needBand = row.cat !== cat
    if (y - h - (needBand ? 18 : 0) < M + 20) { page = doc.addPage([W, H]); y = H - M; header(); cat = '' }
    if (row.cat !== cat) {
      cat = row.cat
      rect(M, y - 15, W - 2 * M, 15, BAND)
      text(cat.toUpperCase(), M + 6, y - 11, 8, bold, NAVY)
      y -= 18
    }
    labelLines.forEach((l, i) => text(l, M + 6, y - 9 - i * 11, 8.5, bold))
    cells.forEach((c, i) => {
      const x = M + labelW + i * colW + 6
      c.lines.forEach((l, j) => text(l, x, y - 9 - j * 11, 8.5, font, c.na ? GREY : [0, 0, 0]))
      c.src.forEach((l, j) => text(l, x, y - 9 - c.lines.length * 11 - j * 8.5, 6.5, font, GREY))
    })
    y -= h
    page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 0.4, color: rgb(0.85, 0.87, 0.9) })
  }

  const dis = wrap([...compareNotes(products), DISCLAIMER, ...(products.some((p) => p.auto_read) ? [AUTO_NOTE] : [])].join(' '), 8.5, W - 2 * M - 12)
  if (y - dis.length * 11 - 20 < M) { page = doc.addPage([W, H]); y = H - M }
  y -= 14
  rect(M, y - dis.length * 11 - 8, W - 2 * M, dis.length * 11 + 8, BAND)
  dis.forEach((l, i) => text(l, M + 6, y - 10 - i * 11, 8.5, i === 0 ? font : font))

  const pages = doc.getPages()
  pages.forEach((p, i) => p.drawText(`Page ${plain(i + 1)} of ${plain(pages.length)} · Factual comparison from the Knowledge Bank, not advice`,
    { x: M, y: M - 18, size: 7.5, font, color: rgb(GREY[0], GREY[1], GREY[2]) }))
  return new Blob([await doc.save()], { type: 'application/pdf' })
}
