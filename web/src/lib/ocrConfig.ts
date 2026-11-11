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

/** The recognition model's character list: one per line, plus the space PaddleOCR adds at the end. */
export function charsFrom(text: string): string[] {
  return [...text.replace(/\r/g, '').replace(/\n$/, '').split('\n'), ' ']
}
