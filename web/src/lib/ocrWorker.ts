// Runs PaddleOCR off the main thread, so the page (and its progress bar) stays responsive while a scan is read.
// Started by ocr.ts. Loads ONNX Runtime Web and the models from this site only.
import { DET_MAX_SIDE, MODEL_FILES, SCALE, charsFrom } from './ocrConfig'
import { ocrImage, type OcrModels, type Runner } from './paddleOcr'

const BASE = `${import.meta.env.BASE_URL}ocr/`
let models: Promise<OcrModels> | null = null

async function load(): Promise<OcrModels> {
  const ort = await import('onnxruntime-web/wasm')
  // Several threads need a cross-origin isolated page; otherwise one thread (slower, but works everywhere).
  ort.env.wasm.numThreads = globalThis.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1
  const get = async (file: string) => {
    const res = await fetch(BASE + file)
    if (!res.ok) throw new Error(`could not load the OCR files (${file}: ${res.status})`)
    return res
  }
  const session = async (file: string): Promise<Runner> => {
    const s = await ort.InferenceSession.create(new Uint8Array(await (await get(file)).arrayBuffer()), { executionProviders: ['wasm'], graphOptimizationLevel: 'all' })
    return async (data, dims) => {
      const out = await s.run({ [s.inputNames[0]]: new ort.Tensor('float32', data, dims) })
      const t = out[s.outputNames[0]]
      return { data: t.data as Float32Array, dims: t.dims }
    }
  }
  const [det, rec, chars] = await Promise.all([session(MODEL_FILES.det), session(MODEL_FILES.rec), get(MODEL_FILES.chars).then((r) => r.text())])
  return { det, rec, chars: charsFrom(chars) }
}

self.onmessage = async (e: MessageEvent<{ id: number; data: Uint8Array; width: number; height: number }>) => {
  const { id, data, width, height } = e.data
  const step = (done: number) => self.postMessage({ id, step: done })
  try {
    if (!models) { models = load(); models.catch(() => { models = null }) }
    const m = await models
    step(0.02)
    const { items, skew } = await ocrImage({ data, width, height }, m, { scale: SCALE, detMaxSide: DET_MAX_SIDE, onStep: step })
    self.postMessage({ id, items, skew })
  } catch (err) {
    self.postMessage({ id, error: err instanceof Error ? err.message : String(err) })
  }
}
