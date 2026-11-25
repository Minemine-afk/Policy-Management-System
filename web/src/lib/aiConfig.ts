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
  gpu: { id: ID, dtype: { embed_tokens: 'fp16', decoder_model_merged: 'q4f16', vision_encoder: 'q4f16' }, mb: 1010, label: 'Qwen3.5 0.8B' },
  /** Otherwise the processor. The 4-bit word table needs an operation the processor engine lacks, so 16-bit there. */
  small: { id: ID, dtype: { embed_tokens: 'fp16', decoder_model_merged: 'q4', vision_encoder: 'q4' }, mb: 1060, label: 'Qwen3.5 0.8B' },
}
/** The Node tests' default (Node's engine has every operation, so plain 4-bit). */
export const AI_MODEL = ID
export const AI_DTYPE_CPU = 'q4'
export const MAX_NEW_TOKENS = 300
