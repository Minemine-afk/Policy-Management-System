// OCR for scanned PIs (pages that are pictures, with no text inside the PDF).
// PaddleOCR (PP-OCRv5 mobile models, Apache 2.0) runs in the browser with ONNX Runtime Web (MIT), from files
// this site serves itself (public/ocr/ from scripts/copy-ocr.mjs, and the runtime's .wasm in assets/):
// no CDN, no server, no AI service. The PDF and its text never leave the computer.
// The engine (about 28 MB) is only downloaded the first time a scanned page is met; the browser caches it.
// Pages are straightened first (see paddleOcr.ts), so slightly tilted scans read like digital PDFs.
import { SCALE } from './ocrConfig'
import { toGray } from './paddleOcr'
import type { TextItem } from './piExtract'

type Reply = { id: number; step?: number; items?: TextItem[]; error?: string }
let worker: Worker | null = null
let idle: ReturnType<typeof setTimeout> | undefined
let nextId = 0
const waiting = new Map<number, { alive?: (done: number) => void; done: (r: Reply) => void }>()

function getWorker(): Worker {
  clearTimeout(idle)
  if (!worker) {
    worker = new Worker(new URL('./ocrWorker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (e: MessageEvent<Reply>) => {
      const w = waiting.get(e.data.id)
      if (!w) return
      if (e.data.step !== undefined) { w.alive?.(e.data.step); return }
      waiting.delete(e.data.id)
      w.done(e.data)
    }
    worker.onerror = (e) => {
      for (const w of waiting.values()) w.done({ id: -1, error: e.message || 'the OCR engine stopped' })
      waiting.clear()
      worker?.terminate(); worker = null
    }
  }
  return worker
}

/** Frees the OCR engine's memory a minute after the last page. */
function releaseLater() {
  clearTimeout(idle)
  idle = setTimeout(() => { if (!waiting.size) { worker?.terminate(); worker = null } }, 60_000)
}

/** Draws a pdf.js page and reads it with OCR. Returns text positioned in PDF points, like pdf.js text.
 *  `alive` is called after each step, so the "nothing happened for 60 seconds" limit only stops a real stall. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function ocrPage(page: any, alive?: (done: number) => void): Promise<TextItem[]> {
  clearTimeout(idle)
  const viewport = page.getViewport({ scale: SCALE })
  const canvas = document.createElement('canvas')
  canvas.width = Math.ceil(viewport.width)
  canvas.height = Math.ceil(viewport.height)
  try {
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    await page.render({ canvas, canvasContext: ctx, viewport }).promise
    const gray = toGray(ctx.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height)
    canvas.width = canvas.height = 0
    alive?.(0)
    const reply = await new Promise<Reply>((done) => {
      const id = nextId++
      waiting.set(id, { alive, done })
      getWorker().postMessage({ id, ...gray }, [gray.data.buffer])
    })
    if (reply.error) throw new Error(`OCR failed: ${reply.error}`)
    return reply.items ?? []
  } finally {
    canvas.width = canvas.height = 0
    releaseLater()
  }
}
