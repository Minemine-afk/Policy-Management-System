// Which free models the AI helper uses (see piAi.ts). Chosen on the sample PIs (tests/pi-extract/check-ai.mjs: both
// give 0 wrong values after the checks; the larger one fills about twice as many blank cells).
// Apache 2.0 licences, so free for business use. Their files come from Hugging Face's public model hub the first
// time (only the model is downloaded: nothing is uploaded), then the browser keeps them.
export interface AiModel { id: string; dtype: string; mb: number; label: string }
export const AI_MODELS: { gpu: AiModel; small: AiModel } = {
  /** With a graphics chip that does 16-bit maths through WebGPU (e.g. Intel Iris Xe in Chrome or Edge). */
  gpu: { id: 'onnx-community/Qwen2.5-1.5B-Instruct', dtype: 'q4f16', mb: 1220, label: 'Qwen2.5 1.5B' },
  /** Otherwise: the larger model can't load in the browser's processor engine (4 GB memory limit), so a smaller one. */
  small: { id: 'onnx-community/Qwen2.5-0.5B-Instruct', dtype: 'q4', mb: 790, label: 'Qwen2.5 0.5B' },
}
/** Kept for the Node tests: the model they check by default. */
export const AI_MODEL = AI_MODELS.gpu.id
export const AI_DTYPE_CPU = 'q4'
export const MAX_NEW_TOKENS = 300
