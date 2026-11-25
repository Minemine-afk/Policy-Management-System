// Pictures of a PI's pages, for the AI helper to look at when the reader got no text (or too little) from them
// (see piAi.ts, pictureMessages). Drawn in this browser with pdf.js: nothing is uploaded.

/** About 110 dots per inch: enough for the model to read a PI's tables, small enough to read quickly. */
const SCALE = 1.5

/** How much the two halves of a page overlap, so a line cut by the split is whole in one of them. */
const OVERLAP = 0.06

/** JPEG pictures of the given pages (1-based) that the PDF has, each as its top and bottom half: a whole page is too
 *  big for the AI engine on a processor (it fails with "Integer overflow"), and half a page reads as well. */
export async function pagePictures(data: ArrayBuffer, pageNos: number[]): Promise<{ page: number; images: Blob[] }[]> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const workerUrl = (await import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url')).default
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl
  const task = pdfjs.getDocument({ data: new Uint8Array(data.slice(0)) })
  const doc = await task.promise
  const out: { page: number; images: Blob[] }[] = []
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
      const half = Math.ceil(canvas.height * (0.5 + OVERLAP / 2))
      const images: Blob[] = []
      for (const top of [0, canvas.height - half]) {
        const c = document.createElement('canvas')
        c.width = canvas.width; c.height = half
        c.getContext('2d')!.drawImage(canvas, 0, top, canvas.width, half, 0, 0, canvas.width, half)
        images.push(await new Promise<Blob>((ok, no) => c.toBlob((b) => (b ? ok(b) : no(new Error('could not draw the page'))), 'image/jpeg', 0.9)))
      }
      out.push({ page: p, images })
      page.cleanup()
    }
  } finally {
    await task.destroy()
  }
  return out
}

/** Which pages to show the AI: the first ones the reader got no text from (a PI's summary is near the front), at most
 *  4 with no text at all, else 3 (each takes a while on a processor). `done`: pages with text. */
export const picturePages = (numPages: number, hasText: boolean, done: Set<number> = new Set(), max = hasText ? 3 : 4) =>
  Array.from({ length: numPages }, (_, i) => i + 1).filter((p) => !done.has(p)).slice(0, max)
