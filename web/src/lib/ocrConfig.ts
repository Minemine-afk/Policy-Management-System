// Settings shared by the website's OCR (ocr.ts) and the Node test script (tests/pi-extract/check-ocr.mjs).

/** Pages are drawn at this many pixels per PDF point before OCR (about 216 dpi). */
export const SCALE = 3
/** Longest side of the picture the text-finding model sees (a multiple of 32). */
export const DET_MAX_SIDE = 1920
/** Model files, served by the site itself from public/ocr/ (copied from web/ocr-models/ by scripts/copy-ocr.mjs). */
export const MODEL_FILES = {
  det: 'ch_PP-OCRv5_det_mobile.onnx',
  rec: 'en_PP-OCRv5_rec_mobile.onnx',
  chars: 'en_PP-OCRv5_rec_mobile.chars.txt',
}
/** A second recognition model for a second opinion on lines the first is unsure of (downloaded only when a
 *  scanned page has such lines); null for none. The Latin-script model reads clean scans better (it gets "Term (II)"
 *  right where the English one reads "Term (Il)"), the English one blurred or tilted scans: together they beat both
 *  (22 Nov 2026 tests, see web/ocr-models/README.md). */
export const SECOND_REC: { rec: string; chars: string } | null = { rec: 'latin_PP-OCRv5_rec_mobile.onnx', chars: 'latin_PP-OCRv5_rec_mobile.chars.txt' }
/** Lines read with less confidence than this get the second opinion. */
export const REREAD_BELOW = 0.9

/** The recognition model's character list: one per line, plus the space PaddleOCR adds at the end. */
export function charsFrom(text: string): string[] {
  return [...text.replace(/\r/g, '').replace(/\n$/, '').split('\n'), ' ']
}
