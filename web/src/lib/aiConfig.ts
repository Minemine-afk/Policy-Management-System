// Which free model the AI helper uses (see piAi.ts). Chosen on the sample PIs (tests/pi-extract/check-ai.mjs,
// 25 Nov 2026 benchmark of five models; after the checks every one gave 0 wrong values):
//   Qwen2.5 0.5B 14 cells right, Qwen2.5 1.5B 22, Qwen3.5 2B 22, Qwen3.5 0.8B 26, Qwen3 4B 30 (but ~3 GB, 2x slower).
// Qwen3.5 0.8B fills the most for its size and runs in the browser's processor engine (Qwen2.5 1.5B does not:
// 4 GB memory limit). Apache 2.0 licence, so free for business use. Its files come from Hugging Face's public model
// hub the first time (only the model is downloaded: nothing is uploaded), then the browser keeps them.
export interface AiModel { id: string; dtype: string | Record<string, string>; mb: number; label: string }
const ID = 'onnx-community/Qwen3.5-0.8B-ONNX'
export const AI_MODELS: { gpu: AiModel; small: AiModel } = {
  /** With a graphics chip that does 16-bit maths through WebGPU (e.g. Intel Iris Xe in Chrome or Edge): fast. */
  gpu: { id: ID, dtype: { embed_tokens: 'fp16', decoder_model_merged: 'q4f16', vision_encoder: 'fp16' }, mb: 1210, label: 'Qwen3.5 0.8B' },
  /** Otherwise the processor. The 4-bit word table and picture reader need an operation the processor engine lacks
   *  (GatherBlockQuantized), so 16-bit for those. The picture reader (vision_encoder) is used only for page pictures. */
  small: { id: ID, dtype: { embed_tokens: 'fp16', decoder_model_merged: 'q4', vision_encoder: 'fp16' }, mb: 1260, label: 'Qwen3.5 0.8B' },
}
/** The Node tests' default (Node's engine has every operation, so plain 4-bit). */
export const AI_MODEL = ID
export const AI_DTYPE_CPU = 'q4'
export const MAX_NEW_TOKENS = 300

/** The error text a stopped run ends with (aiModel.ts releaseAi, the Stop buttons). */
export const AI_STOPPED = 'the AI helper was stopped'
/** Shown when the graphics chip gave no sign of life and the processor takes over (aiModel.ts, the watchdog). */
export const AI_SWITCH_TEXT = "This computer's graphics chip did not answer, so the AI helper is starting again on the processor (slower, but it finishes). This browser will go straight to the processor from now on…"
/** ...and put in front of the lines after it (the processor's model is a separate download). */
export const AI_SWITCHED = "This computer's graphics chip did not answer, so the AI helper moved to the processor. "
