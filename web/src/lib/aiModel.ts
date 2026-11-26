// The browser side of the AI helper, shared by every file reader that uses it: the PI comparison (piAi.ts) and the
// Knowledge Bank's Product Summary reader (kbAi.ts). One worker and one model (aiConfig.ts) for all of them, so a
// model change applies everywhere. Each reader writes its own prompt and checks its own answers against the
// document's text; only answers that pass are used.
import { READ_OUT_TOKENS, aiGroups, buildMessages, checkAnswer, parseAnswer, readOutMessages, readOutPage, type AiFill } from './piAi'
import type { ChatMsg } from './aiRun'
import { AI_STOPPED } from './aiConfig'
import type { Page } from './piExtract'

type Reply = { id: number; loading?: number; starting?: string; thinking?: boolean; tokens?: number; device?: string; model?: string; text?: string; error?: string }
/** `tokens`: pieces of the answer written so far. 'switch': the graphics chip did not answer, the processor takes over. */
export type AiProgress = (p: { stage: 'download' | 'read' | 'switch'; pct?: number; device?: string; model?: string; tokens?: number }) => void
type Force = { device?: string; dtype?: string; model?: string; hangGpu?: boolean; stallMs?: number; pictures?: boolean; picturePages?: number }
/** Tests (check-ai-browser.cjs, the e2e) can pick the device and model file through globalThis.__AI_FORCE. */
const testForce = (): Force => (globalThis as { __AI_FORCE?: Force }).__AI_FORCE ?? {}

// A graphics chip that never answers (Kumar's laptops, 26 Nov 2026: "AI helper working…" for 10 minutes with nothing).
// The browser offers the chip, the model loads on it, and then no piece of the answer ever comes. So the first run on
// a graphics chip is watched: when it gives no sign of life for a while, its worker is stopped, the same question goes
// to the processor (slower, but it finishes), and this browser remembers not to try the chip again for 30 days.
/** No sign of life for this long while the graphics chip starts the model or writes the first piece of the answer. */
const GPU_START_MS = 120_000
/** ...or between two pieces of the answer. */
const GPU_PIECE_MS = 45_000
const NO_GPU_KEY = 'pws-ai-no-gpu'
const NO_GPU_DAYS = 30
let noGpu: boolean | null = null
function gpuGivenUp(): boolean {
  if (noGpu === null) {
    try { noGpu = Date.now() - Number(localStorage.getItem(NO_GPU_KEY) ?? 0) < NO_GPU_DAYS * 86_400_000 } catch { noGpu = false }
  }
  return noGpu
}
function giveUpGpu() {
  noGpu = true
  try { localStorage.setItem(NO_GPU_KEY, String(Date.now())) } catch { /* private window: remembered for this page only */ }
}
/** What the worker is told: the tests' choices, and the processor once the graphics chip was given up on. */
const forceNow = (): Force => { const f = testForce(); return gpuGivenUp() && !f.device ? { ...f, device: 'wasm' } : f }

interface Waiting {
  progress?: AiProgress; done: (r: Reply) => void
  /** What was asked, to ask again on the processor. */
  ask: { messages: ChatMsg[]; images: Blob[]; maxTokens?: number }
  device?: string; beat: number; tokens: number; watched: boolean
}
let worker: Worker | null = null
let nextId = 0
const waiting = new Map<number, Waiting>()
let watchdog: ReturnType<typeof setInterval> | undefined

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('./aiWorker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (e: MessageEvent<Reply>) => {
      const w = waiting.get(e.data.id)
      if (!w) return
      w.beat = Date.now()
      if (e.data.starting) { w.device = e.data.starting; w.watched = false; return }
      // While files download, a slow network is not the chip's fault: watched once they are all here.
      if (e.data.loading !== undefined) { w.watched = e.data.loading >= 0.999; w.progress?.({ stage: 'download', pct: e.data.loading }); return }
      if (e.data.thinking) { w.device = e.data.device; w.watched = true; w.progress?.({ stage: 'read', device: e.data.device, model: e.data.model }); return }
      if (e.data.tokens !== undefined) { w.tokens = e.data.tokens; w.progress?.({ stage: 'read', device: w.device, tokens: e.data.tokens }); return }
      waiting.delete(e.data.id)
      w.done(e.data)
    }
    worker.onerror = (e) => {
      for (const w of waiting.values()) w.done({ id: -1, error: e.message || 'the AI helper stopped' })
      waiting.clear()
      worker?.terminate(); worker = null
    }
    watchdog ??= setInterval(watch, 1000)
  }
  return worker
}

/** Stops a graphics chip run that gives no sign of life, and asks the processor instead. */
function watch() {
  if (!waiting.size) return
  const f = testForce()
  if (f.device) return   // a test chose the device: no switching
  const now = Date.now()
  const stuck = [...waiting.values()].some((w) => w.device === 'webgpu' && w.watched && now - w.beat > (f.stallMs ?? (w.tokens ? GPU_PIECE_MS : GPU_START_MS)))
  if (!stuck) return
  giveUpGpu()
  worker?.terminate(); worker = null
  for (const [id, w] of waiting) {
    w.device = 'wasm'; w.beat = now; w.tokens = 0; w.watched = false
    w.progress?.({ stage: 'switch' })
    getWorker().postMessage({ id, ...w.ask, force: forceNow() })
  }
}

/** Sends chat messages to the shared model and resolves with its raw answer text (check it before use!). */
export function runAi(messages: ChatMsg[], progress?: AiProgress, maxTokens?: number, images: Blob[] = []): Promise<string> {
  const id = ++nextId
  return new Promise((resolve, reject) => {
    waiting.set(id, { progress, done: (r) => (r.error ? reject(new Error(r.error)) : resolve(r.text ?? '')), ask: { messages, images, maxTokens }, beat: Date.now(), tokens: 0, watched: false })
    getWorker().postMessage({ id, messages, images, maxTokens, force: forceNow() })
  })
}

/** Asks the AI about `keys` (blank cells) of one PI; `known` holds the cells already filled, for cross-checks. Resolves with the values that passed the checks. */
export async function askAi(pages: Page[], keys: string[], known: Record<string, string>, progress?: AiProgress): Promise<AiFill> {
  const out: AiFill = { found: {}, dropped: [] }
  // One question per group (the plan's numbers, then the rest), each checked with what is known so far.
  for (const group of aiGroups(keys)) {
    const res = checkAnswer(parseAnswer(await runAi(buildMessages(pages, group), progress)), pages, group,
      { ...known, ...Object.fromEntries(Object.entries(out.found).map(([k, v]) => [k, v.value])) })
    Object.assign(out.found, res.found)
    out.dropped.push(...res.dropped)
  }
  return out
}

/** The model's read-out of one page from its pictures (its top and bottom halves), as PI text (see piAi.ts
 *  readOutPage). Lines read twice where the halves overlap are kept once. */
export async function readOutPicture(images: Blob[], page: number, progress?: AiProgress): Promise<Page> {
  const lines: string[] = []
  for (const image of images) {
    const part = readOutPage(await runAi(readOutMessages(), progress, READ_OUT_TOKENS, [image]), page).lines.map((l) => l.text)
    // The overlap: the first lines of this half that repeat the last lines of the one before.
    let skip = 0
    while (skip < part.length && skip < 6 && lines.slice(-8).includes(part[skip])) skip++
    lines.push(...part.slice(skip))
  }
  return { page, items: [], lines: lines.map((text) => ({ page, text })) }
}

/** True when the AI will run on the graphics chip (WebGPU with 16-bit maths, as the worker checks). Page pictures
 *  are read only then: on a processor one page takes over 10 minutes (measured 26 Nov 2026), which nobody would wait
 *  for. Tests can allow the processor through globalThis.__AI_FORCE.pictures. */
export async function aiOnGraphics(): Promise<boolean> {
  if (testForce().pictures) return true
  if (gpuGivenUp()) return false
  const gpu = (navigator as any).gpu
  const adapter = gpu ? await gpu.requestAdapter().catch(() => null) : null
  return !!adapter?.features?.has?.('shader-f16')
}


/** Frees the model's memory (it is large) when the comparison is left, or stops a run (the Stop button). */
export function releaseAi() {
  worker?.terminate(); worker = null
  // Anything still waiting gets an answer (an error), so no button stays "busy" for ever.
  for (const w of waiting.values()) w.done({ id: -1, error: AI_STOPPED })
  waiting.clear()
}
