// PaddleOCR (PP-OCRv5 mobile) for scanned PIs, without any browser or Node specifics, so the same code runs
// in the browser (ocr.ts, with onnxruntime-web) and in the Node test script (with onnxruntime-node).
// Steps for one page picture: straighten it (deskew), find the text lines (detection model), read each line
// (recognition model), then split lines into words placed in PDF points, like pdf.js text.
// Models: PaddleOCR PP-OCRv5 by Baidu (Apache 2.0), as ONNX files from the RapidOCR project (Apache 2.0).
import type { TextItem } from './piExtract'

/** A greyscale picture, one byte per pixel, 0 = black. */
export interface Gray { data: Uint8Array | Uint8ClampedArray; width: number; height: number }
/** Runs one model on one input tensor (shape [n, 3, h, w]) and returns its output. */
export type Runner = (input: Float32Array, dims: number[]) => Promise<{ data: Float32Array; dims: readonly number[] }>

export interface OcrModels {
  det: Runner
  rec: Runner
  /** The recognition model's characters, in order (index 0 of the model output is "no character"). */
  chars: string[]
}

export interface OcrOptions {
  /** Pixels per PDF point of the picture (the page was drawn at this scale). */
  scale: number
  /** The longest side the detection model sees. Larger finds smaller print, but is slower. */
  detMaxSide?: number
  /** Called after each step with how much of the page is done (0 to 1), so a long page never looks stuck. */
  onStep?: (done: number) => void
}

export interface OcrResult { items: TextItem[]; skew: number }

/** Greyscale from canvas RGBA pixels. */
export function toGray(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number): Gray {
  const out = new Uint8Array(width * height)
  for (let i = 0, j = 0; i < out.length; i++, j += 4) {
    // Transparent pixels count as white paper.
    const a = rgba[j + 3] / 255
    out[i] = Math.round((0.299 * rgba[j] + 0.587 * rgba[j + 1] + 0.114 * rgba[j + 2]) * a + 255 * (1 - a))
  }
  return { data: out, width, height }
}

// ---------- Straightening (deskew) ----------

/**
 * How far the text lines are tilted, in degrees (positive = the page needs turning clockwise to be straight,
 * in picture coordinates with y going down). Uses projection profiles: when the page is straight, ink piles
 * up in sharp rows, so the row totals vary the most. Checks -maxDeg to +maxDeg.
 */
export function estimateSkew(img: Gray, maxDeg = 6): number {
  // Work on a smaller copy (about 1000 px wide): enough for 0.05 degree precision, and quick.
  const f = Math.max(1, Math.floor(img.width / 1000))
  const w = Math.floor(img.width / f), h = Math.floor(img.height / f)
  const xs: number[] = [], ys: number[] = []
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0
      for (let dy = 0; dy < f; dy++) { const row = (y * f + dy) * img.width + x * f; for (let dx = 0; dx < f; dx++) s += img.data[row + dx] }
      if (s / (f * f) < 140) { xs.push(x - w / 2); ys.push(y - h / 2) }
    }
  }
  if (xs.length < 200) return 0
  const n = h * 2 + 1
  const bins = new Float64Array(n)
  const score = (deg: number) => {
    const a = (deg * Math.PI) / 180, s = Math.sin(a), c = Math.cos(a)
    bins.fill(0)
    for (let i = 0; i < xs.length; i++) {
      const r = Math.round(ys[i] * c + xs[i] * s) + h
      if (r >= 0 && r < n) bins[r]++
    }
    let v = 0
    for (let i = 1; i < n; i++) { const d = bins[i] - bins[i - 1]; v += d * d }
    return v
  }
  let best = 0, bestScore = -1
  for (let d = -maxDeg; d <= maxDeg + 1e-9; d += 0.2) { const s = score(d); if (s > bestScore) { bestScore = s; best = d } }
  const coarse = best
  for (let d = coarse - 0.2; d <= coarse + 0.2 + 1e-9; d += 0.02) { const s = score(d); if (s > bestScore) { bestScore = s; best = d } }
  // Under a twentieth of a degree is not worth turning the picture for.
  return Math.abs(best) < 0.05 ? 0 : Math.round(best * 100) / 100
}

/** Turns the picture about its centre (same size, white corners) so that a skew of `deg`, as estimateSkew
 *  measures it, becomes straight. */
export function rotate(img: Gray, deg: number): Gray {
  if (!deg) return img
  const { width: w, height: h, data } = img
  const a = (deg * Math.PI) / 180, s = Math.sin(a), c = Math.cos(a)
  const cx = w / 2, cy = h / 2
  const out = new Uint8Array(w * h).fill(255)
  for (let y = 0; y < h; y++) {
    const dy = y - cy
    for (let x = 0; x < w; x++) {
      const dx = x - cx
      // Where this output pixel comes from in the tilted picture.
      const sx = c * dx + s * dy + cx, sy = -s * dx + c * dy + cy
      const x0 = Math.floor(sx), y0 = Math.floor(sy)
      if (x0 < 0 || y0 < 0 || x0 >= w - 1 || y0 >= h - 1) continue
      const fx = sx - x0, fy = sy - y0, i = y0 * w + x0
      const top = data[i] + (data[i + 1] - data[i]) * fx
      const bot = data[i + w] + (data[i + w + 1] - data[i + w]) * fx
      out[y * w + x] = top + (bot - top) * fy
    }
  }
  return { data: out, width: w, height: h }
}

// ---------- Text line detection (DB model) ----------

interface Box { x0: number; y0: number; x1: number; y1: number }

/** Resizes a greyscale picture with bilinear sampling. */
function resize(img: Gray, sx: number, sy: number, sw: number, sh: number, w: number, h: number): Float32Array {
  const out = new Float32Array(w * h)
  const fx = sw / w, fy = sh / h
  for (let y = 0; y < h; y++) {
    const yy = Math.min(Math.max(sy + (y + 0.5) * fy - 0.5, 0), img.height - 1)
    const y0 = Math.floor(yy), y1 = Math.min(y0 + 1, img.height - 1), ty = yy - y0
    for (let x = 0; x < w; x++) {
      const xx = Math.min(Math.max(sx + (x + 0.5) * fx - 0.5, 0), img.width - 1)
      const x0 = Math.floor(xx), x1 = Math.min(x0 + 1, img.width - 1), tx = xx - x0
      const a = img.data[y0 * img.width + x0], b = img.data[y0 * img.width + x1]
      const c = img.data[y1 * img.width + x0], d = img.data[y1 * img.width + x1]
      out[y * w + x] = (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty
    }
  }
  return out
}

export async function detect(img: Gray, run: Runner, maxSide = 1920): Promise<Box[]> {
  const r = Math.min(1, maxSide / Math.max(img.width, img.height))
  const w = Math.max(32, Math.round((img.width * r) / 32) * 32), h = Math.max(32, Math.round((img.height * r) / 32) * 32)
  const px = resize(img, 0, 0, img.width, img.height, w, h)
  // ImageNet normalisation, the same value on all three channels (the picture is grey).
  const mean = [0.485, 0.456, 0.406], std = [0.229, 0.224, 0.225]
  const input = new Float32Array(3 * w * h)
  for (let ch = 0; ch < 3; ch++) for (let i = 0; i < w * h; i++) input[ch * w * h + i] = (px[i] / 255 - mean[ch]) / std[ch]
  const { data: prob } = await run(input, [1, 3, h, w])
  return boxesFromMap(prob, w, h).map((b) => ({ x0: (b.x0 * img.width) / w, y0: (b.y0 * img.height) / h, x1: (b.x1 * img.width) / w, y1: (b.y1 * img.height) / h }))
}

/** Text regions in the probability map: connected areas over 0.3, kept when their average is over 0.6,
 *  then grown back to the full text size (the model marks a shrunk core of each line). */
export function boxesFromMap(prob: Float32Array, w: number, h: number, thresh = 0.3, boxThresh = 0.6, unclip = 1.5): Box[] {
  const seen = new Uint8Array(w * h)
  const stack = new Int32Array(w * h)
  const boxes: Box[] = []
  for (let start = 0; start < w * h; start++) {
    if (seen[start] || prob[start] <= thresh) continue
    let top = 0, n = 0, sum = 0
    let x0 = w, y0 = h, x1 = 0, y1 = 0
    stack[top++] = start; seen[start] = 1
    while (top) {
      const i = stack[--top]
      const x = i % w, y = (i - x) / w
      n++; sum += prob[i]
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y
      if (x > 0 && !seen[i - 1] && prob[i - 1] > thresh) { seen[i - 1] = 1; stack[top++] = i - 1 }
      if (x < w - 1 && !seen[i + 1] && prob[i + 1] > thresh) { seen[i + 1] = 1; stack[top++] = i + 1 }
      if (y > 0 && !seen[i - w] && prob[i - w] > thresh) { seen[i - w] = 1; stack[top++] = i - w }
      if (y < h - 1 && !seen[i + w] && prob[i + w] > thresh) { seen[i + w] = 1; stack[top++] = i + w }
    }
    const bw = x1 - x0 + 1, bh = y1 - y0 + 1
    if (Math.min(bw, bh) < 3 || sum / n < boxThresh) continue
    const d = (bw * bh * unclip) / (2 * (bw + bh))
    boxes.push({ x0: Math.max(0, x0 - d), y0: Math.max(0, y0 - d), x1: Math.min(w, x1 + 1 + d), y1: Math.min(h, y1 + 1 + d) })
  }
  return boxes
}

// ---------- Text line recognition (CTC model) ----------

const REC_H = 48

export interface Read { box: Box; text: string; conf: number; chars: { ch: string; x0: number; x1: number }[] }

export async function recognize(img: Gray, boxes: Box[], run: Runner, chars: string[], onBatch?: (done: number) => void): Promise<Read[]> {
  const order = boxes.map((b, i) => ({ b, i, ratio: (b.x1 - b.x0) / Math.max(1, b.y1 - b.y0) })).filter((x) => x.ratio >= 0.5).sort((a, b) => a.ratio - b.ratio)
  const out: Read[] = []
  const BATCH = 8
  for (let k = 0; k < order.length; k += BATCH) {
    const group = order.slice(k, k + BATCH)
    const W = Math.max(320, Math.ceil(REC_H * group[group.length - 1].ratio))
    const input = new Float32Array(group.length * 3 * REC_H * W)    // 0 = mid grey after normalisation (padding)
    const widths: number[] = []
    group.forEach(({ b }, g) => {
      const rw = Math.min(W, Math.max(1, Math.ceil(REC_H * ((b.x1 - b.x0) / (b.y1 - b.y0)))))
      widths.push(rw)
      const px = resize(img, b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0, rw, REC_H)
      const base = g * 3 * REC_H * W
      for (let y = 0; y < REC_H; y++) for (let x = 0; x < rw; x++) {
        const v = px[y * rw + x] / 127.5 - 1
        for (let ch = 0; ch < 3; ch++) input[base + ch * REC_H * W + y * W + x] = v
      }
    })
    const { data, dims } = await run(input, [group.length, 3, REC_H, W])
    const T = dims[1], C = dims[2]
    const step = W / T
    group.forEach(({ b }, g) => {
      const toX = (px: number) => b.x0 + (px / widths[g]) * (b.x1 - b.x0)
      const got: Read['chars'] = []
      let prev = 0, confSum = 0
      for (let t = 0; t < T; t++) {
        const o = (g * T + t) * C
        let best = 0, bp = data[o]
        for (let c = 1; c < C; c++) if (data[o + c] > bp) { bp = data[o + c]; best = c }
        if (best && best !== prev) {
          got.push({ ch: chars[best - 1] ?? ' ', x0: toX(t * step), x1: toX((t + 1) * step) })
          confSum += bp
        } else if (best && best === prev && got.length) got[got.length - 1].x1 = toX((t + 1) * step)
        prev = best
      }
      const text = got.map((c) => c.ch).join('')
      if (text.trim()) out.push({ box: b, text, conf: confSum / got.length, chars: got })
    })
    onBatch?.(Math.min(1, (k + BATCH) / order.length))
  }
  return out
}

// ---------- Page ----------

/** Reads a page picture. Text comes back as words in PDF points (y up from the bottom, on the baseline),
 *  in the straightened page, so rows and columns line up as on a digital PDF. */
export async function ocrImage(page: Gray, models: OcrModels, opt: OcrOptions): Promise<OcrResult> {
  const skew = estimateSkew(page)
  opt.onStep?.(0.05)
  const img = rotate(page, skew)
  opt.onStep?.(0.1)
  const boxes = await detect(img, models.det, opt.detMaxSide)
  opt.onStep?.(0.3)
  const reads = await recognize(img, boxes, models.rec, models.chars, (f) => opt.onStep?.(0.3 + 0.7 * f))
  const S = opt.scale
  const words: TextItem[] = []
  for (const r of reads) {
    if (r.conf < 0.5) continue
    // The baseline sits about a quarter of the line height above the bottom of the grown box.
    const base = r.box.y1 - (r.box.y1 - r.box.y0) * 0.25
    const y = (img.height - base) / S
    for (const p of phrases(r)) words.push({ str: p.str, x: p.x0 / S, y, w: (p.x1 - p.x0) / S })
  }
  return { items: joinWords(words), skew }
}

/**
 * Splits a read line into phrases at column gaps, the way pdf.js gives text ("Premium Term", "Policy Term").
 * The model can join table cells into one line; a gap of several characters' width between words means
 * a new cell. Each phrase spans from half a character before its first letter to half after its last.
 */
export function phrases(r: Read): { str: string; x0: number; x1: number }[] {
  const cs = r.chars.map((c) => ({ ch: c.ch, x: (c.x0 + c.x1) / 2 }))
  const letters = cs.filter((c) => c.ch !== ' ')
  if (!letters.length) return []
  const steps: number[] = []
  for (let i = 1; i < cs.length; i++) if (cs[i].ch !== ' ' && cs[i - 1].ch !== ' ') steps.push(cs[i].x - cs[i - 1].x)
  steps.sort((a, b) => a - b)
  const pitch = steps.length ? steps[Math.floor(steps.length / 2)] : (r.box.y1 - r.box.y0) * 0.45
  const out: { str: string; first: number; last: number }[] = []
  let cur: { str: string; first: number; last: number } | null = null
  for (const c of cs) {
    if (c.ch === ' ') { if (cur && !cur.str.endsWith(' ')) cur.str += ' '; continue }
    if (cur && c.x - cur.last > 3.5 * pitch) { out.push(cur); cur = null }
    if (!cur) cur = { str: c.ch, first: c.x, last: c.x }
    else { cur.str += c.ch; cur.last = c.x }
  }
  if (cur) out.push(cur)
  return out.map((p, i) => ({
    str: p.str.trim(),
    x0: i === 0 ? Math.max(r.box.x0, p.first - pitch) : p.first - pitch / 2,
    x1: i === out.length - 1 ? Math.min(r.box.x1, p.last + pitch) : p.last + pitch / 2,
  }))
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
