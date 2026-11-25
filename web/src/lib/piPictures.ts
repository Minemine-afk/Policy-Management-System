// Pictures of a PI's pages, for the AI helper to look at when the reader got no text (or too little) from them
// (see piAi.ts, pictureMessages). Drawn in this browser with pdf.js: nothing is uploaded.

/** About 110 dots per inch: enough for the model to read a PI's tables, small enough to read quickly. */
const SCALE = 1.5

/** JPEG pictures of the given pages (1-based) that the PDF has. */
export async function pagePictures(data: ArrayBuffer, pageNos: number[]): Promise<{ page: number; image: Blob }[]> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const workerUrl = (await import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url')).default
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl
  const task = pdfjs.getDocument({ data: new Uint8Array(data.slice(0)) })
  const doc = await task.promise
  const out: { page: number; image: Blob }[] = []
  try {
    for (const p of pageNos) {
      if (p < 1 || p > doc.numPages) continue
      const page = await doc.getPage(p)
      const vp = page.getViewport({ scale: SCALE })
      const canvas = document.createElement('canvas')
      canvas.width = Math.ceil(vp.width); canvas.height = Math.ceil(vp.height)
      const ctx = canvas.getContext('2d')!
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height)
      await page.render({ canvasContext: ctx, viewport: vp, canvas } as any).promise
      const image = await new Promise<Blob>((ok, no) => canvas.toBlob((b) => (b ? ok(b) : no(new Error('could not draw the page'))), 'image/jpeg', 0.9))
      out.push({ page: p, image })
      page.cleanup()
    }
  } finally {
    await task.destroy()
  }
  return out
}

/** Which pages to show the AI: the first ones the reader got no text from (a PI's summary is near the front), at most
 *  4 with no text at all, else 3 (each takes a while on a processor). `done`: pages with text. */
export const picturePages = (numPages: number, hasText: boolean, done: Set<number> = new Set()) =>
  Array.from({ length: numPages }, (_, i) => i + 1).filter((p) => !done.has(p)).slice(0, hasText ? 3 : 4)
