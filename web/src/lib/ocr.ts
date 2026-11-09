// OCR for scanned PIs (pages that are pictures, with no text inside the PDF).
// Tesseract runs in the browser, from files this site serves itself (public/ocr/, see scripts/copy-ocr.mjs):
// no CDN, no server, no AI service. The PDF and its text never leave the computer. Free and open source (Apache 2.0).
import type { TextItem } from './piExtract'

const BASE = `${import.meta.env.BASE_URL}ocr`
/** Pages are drawn at this many pixels per PDF point before OCR (about 216 dpi). */
const SCALE = 3

type OcrWorker = Awaited<ReturnType<typeof import('tesseract.js')['createWorker']>>
let worker: Promise<OcrWorker> | null = null
let idle: ReturnType<typeof setTimeout> | undefined

async function getWorker(): Promise<OcrWorker> {
  clearTimeout(idle)
  if (!worker) {
    worker = import('tesseract.js').then(({ createWorker, OEM, PSM }) =>
      createWorker('eng', OEM.LSTM_ONLY, {
        workerPath: `${BASE}/worker.min.js`,
        corePath: BASE,
        langPath: BASE,
        workerBlobURL: false,
      }).then(async (w) => {
        // "Sparse text" finds the words inside boxed tables (cover page, summary table),
        // which the default page layout analysis often skips.
        await w.setParameters({ tessedit_pageseg_mode: PSM.SPARSE_TEXT })
        return w
      }))
    worker.catch(() => { worker = null })
  }
  return worker
}

/** Frees the OCR engine's memory a minute after the last page. */
function releaseLater() {
  clearTimeout(idle)
  idle = setTimeout(() => { const w = worker; worker = null; w?.then((x) => x.terminate()).catch(() => {}) }, 60_000)
}

/** Draws a pdf.js page and reads it with OCR. Returns text positioned in PDF points, like pdf.js text. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function ocrPage(page: any): Promise<TextItem[]> {
  const viewport = page.getViewport({ scale: SCALE })
  const canvas = document.createElement('canvas')
  canvas.width = Math.ceil(viewport.width)
  canvas.height = Math.ceil(viewport.height)
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  await page.render({ canvas, canvasContext: ctx, viewport }).promise
  try {
    const w = await getWorker()
    const { data } = await w.recognize(canvas, {}, { blocks: true, text: false })
    const words: TextItem[] = []
    for (const block of data.blocks ?? []) {
      for (const para of block.paragraphs) {
        for (const line of para.lines) {
          for (const word of line.words) {
            if (!word.text.trim() || word.confidence < 30) continue
            const bl = (word as { baseline?: { y0: number; y1: number } }).baseline   // not in the type, but returned
            const base = bl ? (bl.y0 + bl.y1) / 2 : word.bbox.y1
            words.push({ str: word.text, x: word.bbox.x0 / SCALE, y: (canvas.height - base) / SCALE, w: (word.bbox.x1 - word.bbox.x0) / SCALE })
          }
        }
      }
    }
    return joinWords(words)
  } finally {
    canvas.width = canvas.height = 0
    releaseLater()
  }
}

/** pdf.js gives phrases ("Sum Assured (S$)", "1 Year"); OCR gives single words. Words on one row that are
 *  closer than a column gap (in PDF points) are joined back into phrases, so the table rules see the same cells. */
export function joinWords(words: TextItem[], gap = 4): TextItem[] {
  const rows: { y: number; items: TextItem[] }[] = []
  for (const w of words) {
    const row = rows.find((r) => Math.abs(r.y - w.y) <= 2)
    if (row) row.items.push(w); else rows.push({ y: w.y, items: [w] })
  }
  const out: TextItem[] = []
  for (const r of rows) {
    r.items.sort((a, b) => a.x - b.x)
    let cur: TextItem | null = null
    for (const it of r.items) {
      if (cur && it.x - (cur.x + cur.w) < gap) { cur.str += ' ' + it.str; cur.w = it.x + it.w - cur.x }
      else { if (cur) out.push(cur); cur = { ...it } }
    }
    if (cur) out.push(cur)
  }
  return out
}
