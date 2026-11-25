// Runs the AI helper's model off the main thread (started by aiModel.ts). One model for every reader that uses
// the AI helper (PI comparison, Knowledge Bank documents): a model change in aiConfig.ts applies to all of them. Uses the graphics card through WebGPU
// when the browser has it, else the CPU. The PI text stays in this browser: only the model and engine files are
// downloaded (Hugging Face and jsDelivr), never uploaded to.
import { AI_MODELS, MAX_NEW_TOKENS } from './aiConfig'

type Ask = { id: number; messages: { role: string; content: string }[]; maxTokens?: number; force?: { device?: string; dtype?: string; model?: string } }
type Gen = (messages: Ask['messages'], opts: Record<string, unknown>) => Promise<{ generated_text: { content: string }[] }[]>

let gen: Promise<Gen> | null = null
let device = ''
let label = ''

async function load(onProgress: (pct: number) => void, force: Ask['force'] = {}, noGpu = false): Promise<Gen> {
  const t = await import('@huggingface/transformers')
  // ONNX Runtime's engine file (27 MB, over Cloudflare Pages' 25 MB file limit, so this site can't serve it) comes
  // from the jsDelivr CDN, at the exact version transformers.js was built with. It is code only: nothing is sent.
  t.env.allowLocalModels = false
  // Office laptops' built-in graphics (e.g. Intel Iris Xe) have WebGPU with 16-bit maths in Chrome and Edge: fast.
  // Otherwise the processor (see aiConfig.ts).
  const adapter = (navigator as any).gpu ? await (navigator as any).gpu.requestAdapter().catch(() => null) : null
  const f16 = !!adapter?.features?.has?.('shader-f16')
  const gpu = force.device ? force.device === 'webgpu' : !!adapter && f16 && !noGpu
  device = gpu ? 'webgpu' : 'wasm'
  const m = gpu ? AI_MODELS.gpu : AI_MODELS.small
  label = m.label
  const files = new Map<string, { loaded: number; total: number }>()
  const p = await t.pipeline('text-generation', force.model ?? m.id, {
    device: gpu ? 'webgpu' : 'wasm', dtype: force.dtype ? (force.dtype.startsWith('{') ? JSON.parse(force.dtype) : force.dtype) : m.dtype,
    progress_callback: (e: any) => {
      if (e.status !== 'progress' || !e.total) return
      files.set(e.file, { loaded: e.loaded, total: e.total })
      let a = 0, b = 0
      for (const f of files.values()) { a += f.loaded; b += f.total }
      onProgress(b ? a / b : 0)
    },
  } as any)
  return p as unknown as Gen
}

self.onmessage = async (e: MessageEvent<Ask>) => {
  const { id, messages, force, maxTokens } = e.data
  try {
    gen ??= load((pct) => self.postMessage({ id, loading: pct }), force).catch((err) => {
      if (force?.device) throw err
      // The graphics chip could not load it: the processor instead.
      return load((pct) => self.postMessage({ id, loading: pct }), force, true)
    })
    const g = await gen
    self.postMessage({ id, thinking: true, device, model: label })
    let out
    try {
      out = await g(messages, { max_new_tokens: maxTokens ?? MAX_NEW_TOKENS, do_sample: false })
    } catch (err) {
      // A graphics chip that loads the model but can't run it: once more on the processor.
      if (device !== 'webgpu' || force?.device) throw err
      gen = load((pct) => self.postMessage({ id, loading: pct }), force, true)
      const g2 = await gen
      self.postMessage({ id, thinking: true, device, model: label })
      out = await g2(messages, { max_new_tokens: maxTokens ?? MAX_NEW_TOKENS, do_sample: false })
    }
    self.postMessage({ id, text: out[0].generated_text.at(-1)?.content ?? '' })
  } catch (err) {
    gen = null
    self.postMessage({ id, error: (err as Error).message || String(err) })
  }
}
