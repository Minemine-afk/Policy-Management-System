// Runs the AI helper's model off the main thread (started by aiModel.ts). One model for every reader that uses
// the AI helper (PI comparison, Knowledge Bank documents): a model change in aiConfig.ts applies to all of them. Uses the graphics card through WebGPU
// when the browser has it, else the CPU. The PI text (and any page picture) stays in this browser: only the model and
// engine files are downloaded (Hugging Face and jsDelivr), never uploaded to.
import { AI_MODELS, MAX_NEW_TOKENS } from './aiConfig'
import { generate, loadModel, type ChatMsg, type Loaded } from './aiRun'

type Ask = { id: number; messages: ChatMsg[]; images?: Blob[]; maxTokens?: number; force?: { device?: string; dtype?: string; model?: string; hangGpu?: boolean } }

// The processor engine has 4 GB at most (32-bit WebAssembly). Its memory arena grabs ever larger blocks and keeps them,
// which ran a long PI (about 2,000 tokens) out of memory: "std::bad_alloc" (Kumar, 26 Nov 2026). Without the arena
// each piece of memory is given back when done with.
const WASM_SESSION = { enableCpuMemArena: false, enableMemPattern: false }

let gen: Promise<Loaded> | null = null
let device = ''
let label = ''
let RawImage: any = null

let onDevice: (d: string) => void = () => {}

async function load(onProgress: (pct: number) => void, force: Ask['force'] = {}, noGpu = false, vision = false): Promise<Loaded> {
  const t = await import('@huggingface/transformers')
  RawImage = t.RawImage
  // ONNX Runtime's engine file (27 MB, over Cloudflare Pages' 25 MB file limit, so this site can't serve it) comes
  // from the jsDelivr CDN, at the exact version transformers.js was built with. It is code only: nothing is sent.
  t.env.allowLocalModels = false
  // Office laptops' built-in graphics (e.g. Intel Iris Xe) have WebGPU with 16-bit maths in Chrome and Edge: fast.
  // Otherwise the processor (see aiConfig.ts).
  const adapter = (navigator as any).gpu ? await (navigator as any).gpu.requestAdapter().catch(() => null) : null
  const f16 = !!adapter?.features?.has?.('shader-f16')
  const gpu = force.device ? force.device === 'webgpu' : !!adapter && f16 && !noGpu
  device = gpu ? 'webgpu' : 'wasm'
  onDevice(device)
  const m = gpu ? AI_MODELS.gpu : AI_MODELS.small
  label = m.label
  const files = new Map<string, { loaded: number; total: number }>()
  return loadModel(t, force.model ?? m.id, {
    device: gpu ? 'webgpu' : 'wasm', ...(gpu ? {} : { session_options: WASM_SESSION }), dtype: force.dtype ? (force.dtype.startsWith('{') ? JSON.parse(force.dtype) : force.dtype) : m.dtype,
    progress_callback: (e: any) => {
      if (e.status !== 'progress' || !e.total) return
      files.set(e.file, { loaded: e.loaded, total: e.total })
      let a = 0, b = 0
      for (const f of files.values()) { a += f.loaded; b += f.total }
      onProgress(b ? a / b : 0)
    },
  }, vision)
}

self.onmessage = async (e: MessageEvent<Ask>) => {
  const { id, messages, images = [], force, maxTokens } = e.data
  onDevice = (d) => self.postMessage({ id, starting: d })
  try {
    // Page pictures need the model's picture reader too: the text-only model is swapped for the whole one (one model
    // in memory at a time; the browser keeps the files, so this is quick after the first time).
    const vision = images.length > 0
    if (gen && vision && !(await gen.catch(() => null))?.vision) {
      const old = await gen.catch(() => null)
      gen = null
      await old?.model?.dispose?.()
    }
    // A test's stand-in for a graphics chip that never answers (see aiModel.ts, the watchdog).
    if (force?.hangGpu && force.device !== 'wasm') {
      self.postMessage({ id, starting: 'webgpu' })
      self.postMessage({ id, thinking: true, device: 'webgpu', model: 'test' })
      await new Promise(() => {})
    }
    gen ??= load((pct) => self.postMessage({ id, loading: pct }), force, false, vision).catch((err) => {
      // Page pictures are not read on the processor: far too slow there (over 10 minutes a page).
      if (force?.device || vision) throw err
      // The graphics chip could not load it: the processor instead.
      return load((pct) => self.postMessage({ id, loading: pct }), force, true, vision)
    })
    const g = await gen
    self.postMessage({ id, thinking: true, device, model: label })
    const pics = await Promise.all(images.map((b) => RawImage.fromBlob(b)))
    let out: string
    try {
      out = await generate(g, messages, pics, maxTokens ?? MAX_NEW_TOKENS, (n) => self.postMessage({ id, tokens: n }))
    } catch (err) {
      // A graphics chip that loads the model but can't run it: once more on the processor.
      if (device !== 'webgpu' || force?.device || vision) throw err
      gen = load((pct) => self.postMessage({ id, loading: pct }), force, true, vision)
      const g2 = await gen
      self.postMessage({ id, thinking: true, device, model: label })
      out = await generate(g2, messages, pics, maxTokens ?? MAX_NEW_TOKENS, (n) => self.postMessage({ id, tokens: n }))
    }
    self.postMessage({ id, text: out })
  } catch (err) {
    gen = null
    self.postMessage({ id, error: (err as Error).message || String(err) })
  }
}
