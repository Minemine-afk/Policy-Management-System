// Loads the AI helper's model and asks it one question, shared by the browser worker (aiWorker.ts) and the Node tests,
// so both run it the same way. The model reads text, and page pictures too (Qwen3.5 sees images): a picture is used
// when the reader got no text from a page (see piAi.ts, pictureMessages).
export type ChatPart = { type: 'image' } | { type: 'text'; text: string }
export type ChatMsg = { role: string; content: string | ChatPart[] }
type T = typeof import('@huggingface/transformers')
export interface Loaded { processor: any; model: any }

export async function loadModel(t: T, id: string, opts: { device?: string; dtype?: unknown; progress_callback?: (e: any) => void }): Promise<Loaded> {
  const processor = await (t as any).AutoProcessor.from_pretrained(id, { progress_callback: opts.progress_callback })
  const model = await (t as any).AutoModelForImageTextToText.from_pretrained(id, opts)
  return { processor, model }
}

/** The model's answer to `messages`; `images` (one per {type: 'image'} part, in order) are RawImages. */
export async function generate(m: Loaded, messages: ChatMsg[], images: unknown[], maxTokens: number): Promise<string> {
  const text = m.processor.apply_chat_template(messages, { add_generation_prompt: true })
  const inputs = images.length ? await m.processor(text, images.length === 1 ? images[0] : images) : await m.processor(text)
  // A page picture's read-out: a light penalty on repeats keeps a small model from looping on empty table rows.
  const out = await m.model.generate({ ...inputs, max_new_tokens: maxTokens, do_sample: false, ...(images.length ? { repetition_penalty: 1.05 } : {}) })
  return m.processor.batch_decode(out.slice(null, [inputs.input_ids.dims.at(-1), null]), { skip_special_tokens: true })[0] ?? ''
}
