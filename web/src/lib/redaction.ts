// Upload check: looks for identity patterns in a file's text before it is stored.
// Prototype runs in the browser. In production this must also run on the server,
// and flatten PDFs / strip metadata, because a browser check can be bypassed.
import * as pdfjs from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

const PATTERNS: { label: string; re: RegExp }[] = [
  { label: 'NRIC/FIN', re: /\b[STFGM]\d{7}[A-Z]\b/i },
  { label: 'Singapore phone number', re: /(?:\+65[\s-]?)?\b[689]\d{3}[\s-]?\d{4}\b/ },
  { label: 'email address', re: /[\w.+-]+@[\w-]+\.[\w.-]+/ },
  { label: 'date of birth', re: /\b(?:DOB|date of birth)\b/i },
]

export interface ScanResult {
  ok: boolean
  checked: boolean // false when no text could be read (e.g. a scanned image)
  message: string
}

async function textOf(file: File): Promise<{ pages: string[] }> {
  if (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) {
    const doc = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise
    const pages: string[] = []
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i)
      const content = await page.getTextContent()
      pages.push(content.items.map((it) => ('str' in it ? it.str : '')).join(' '))
    }
    const meta = await doc.getMetadata().catch(() => null)
    const info = (meta?.info ?? {}) as Record<string, unknown>
    pages.push([info.Title, info.Author, info.Subject, info.Keywords].filter(Boolean).join(' '))
    return { pages }
  }
  if (file.type.startsWith('text/')) return { pages: [await file.text()] }
  return { pages: [] }
}

export async function scanFile(file: File): Promise<ScanResult> {
  let pages: string[]
  try {
    pages = (await textOf(file)).pages
  } catch {
    return { ok: false, checked: false, message: 'Could not read this file. Upload a PDF.' }
  }
  const all = pages.join(' ').trim()
  if (!all) {
    return {
      ok: true,
      checked: false,
      message: 'No readable text (scanned image?). Check it by eye before submitting.',
    }
  }
  for (let i = 0; i < pages.length; i++) {
    for (const p of PATTERNS) {
      if (p.re.test(pages[i])) {
        const where = i === pages.length - 1 && pages.length > 1 ? 'in the file details' : `on page ${i + 1}`
        return { ok: false, checked: true, message: `Blocked · possible ${p.label} ${where}. Redact and upload again.` }
      }
    }
  }
  return { ok: true, checked: true, message: 'Checked · nothing identifying found' }
}
