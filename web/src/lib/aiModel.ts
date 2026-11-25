// The browser side of the AI helper, shared by every file reader that uses it: the PI comparison (piAi.ts) and the
// Knowledge Bank's Product Summary reader (kbAi.ts). One worker and one model (aiConfig.ts) for all of them, so a
// model change applies everywhere. Each reader writes its own prompt and checks its own answers against the
// document's text; only answers that pass are used.
import { READ_OUT_TOKENS, aiGroups, buildMessages, checkAnswer, parseAnswer, readOutMessages, readOutPage, type AiFill } from './piAi'
import type { ChatMsg } from './aiRun'
import type { Page } from './piExtract'

type Reply = { id: number; loading?: number; thinking?: boolean; device?: string; model?: string; text?: string; error?: string }
export type AiProgress = (p: { stage: 'download' | 'read'; pct?: number; device?: string; model?: string }) => void

let worker: Worker | null = null
let nextId = 0
const waiting = new Map<number, { progress?: AiProgress; done: (r: Reply) => void }>()

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('./aiWorker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (e: MessageEvent<Reply>) => {
      const w = waiting.get(e.data.id)
      if (!w) return
      if (e.data.loading !== undefined) { w.progress?.({ stage: 'download', pct: e.data.loading }); return }
      if (e.data.thinking) { w.progress?.({ stage: 'read', device: e.data.device, model: e.data.model }); return }
      waiting.delete(e.data.id)
      w.done(e.data)
    }
    worker.onerror = (e) => {
      for (const w of waiting.values()) w.done({ id: -1, error: e.message || 'the AI helper stopped' })
      waiting.clear()
      worker?.terminate(); worker = null
    }
  }
  return worker
}

/** Sends chat messages to the shared model and resolves with its raw answer text (check it before use!). */
export function runAi(messages: ChatMsg[], progress?: AiProgress, maxTokens?: number, images: Blob[] = []): Promise<string> {
  const id = ++nextId
  return new Promise((resolve, reject) => {
    waiting.set(id, { progress, done: (r) => (r.error ? reject(new Error(r.error)) : resolve(r.text ?? '')) })
    // Tests (check-ai-browser.cjs) can pick the device and model file through globalThis.__AI_FORCE.
    getWorker().postMessage({ id, messages, images, maxTokens, force: (globalThis as { __AI_FORCE?: object }).__AI_FORCE })
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

/** True when the AI will run on the graphics chip (WebGPU with 16-bit maths, as the worker checks): page pictures are
 *  then quick; on the processor each takes minutes. */
export async function aiOnGraphics(): Promise<boolean> {
  const gpu = (navigator as any).gpu
  const adapter = gpu ? await gpu.requestAdapter().catch(() => null) : null
  return !!adapter?.features?.has?.('shader-f16')
}

/** Frees the model's memory (it is large) when the comparison is left. */
export function releaseAi() {
  worker?.terminate(); worker = null
  // Anything still waiting gets an answer (an error), so no button stays "busy" for ever.
  for (const w of waiting.values()) w.done({ id: -1, error: 'the AI helper was stopped' })
  waiting.clear()
}
