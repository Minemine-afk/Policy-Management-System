import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

// The AI helper's ONNX Runtime (inside @huggingface/transformers) is fetched from the jsDelivr CDN at run time
// (see src/lib/aiWorker.ts): its 27 MB engine file is over Cloudflare Pages' 25 MB file limit, so the copy Vite
// would emit is left out of the build. The OCR's own (smaller) engine file stays.
const dropOversizedAiEngine = (): Plugin => ({
  name: 'drop-oversized-ai-engine',
  generateBundle(_, bundle) {
    for (const [name, file] of Object.entries(bundle)) {
      if (file.type === 'asset' && /ort-wasm-simd-threaded\.asyncify.*\.wasm$/.test(name)) delete bundle[name]
    }
  },
})

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), dropOversizedAiEngine()],
  worker: { format: 'es', plugins: () => [dropOversizedAiEngine()] },
})
