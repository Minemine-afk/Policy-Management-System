# OCR models (served by the site itself from /ocr/)

These files let the PI comparison read scanned PIs in the browser. They are copied into `public/ocr/` by
`scripts/copy-ocr.mjs` before `dev` and `build`. Nothing is downloaded from anywhere else at run time.

| File | What it is | Size | SHA-256 |
|---|---|---|---|
| `ch_PP-OCRv5_det_mobile.onnx` | PaddleOCR PP-OCRv5 mobile text detection | 4.6M | `4d97c44a20d30a81aad087d6a396b08f786c4635742afc391f6621f5c6ae78ae` |
| `en_PP-OCRv5_rec_mobile.onnx` | PaddleOCR PP-OCRv5 mobile English text recognition | 7.6M | `c3461add59bb4323ecba96a492ab75e06dda42467c9e3d0c18db5d1d21924be8` |
| `en_PP-OCRv5_rec_mobile.chars.txt` | The recognition model's character list (taken from the model file's own metadata) | 2 KB | |

**Licences.** The models are PaddleOCR by Baidu / PaddlePaddle, licensed under the Apache License 2.0
(https://github.com/PaddlePaddle/PaddleOCR). These ONNX conversions come from the RapidOCR project, also Apache 2.0
(https://www.modelscope.cn/models/RapidAI/RapidOCR, folder `onnx/PP-OCRv5`). They run with ONNX Runtime Web
(npm `onnxruntime-web`, MIT licence, by Microsoft). All three allow commercial use; keep this notice with the files.

To swap a model: put the new file here, change `MODEL_FILES` in `src/lib/ocrConfig.ts`, then run
`node tests/pi-extract/check-ocr.mjs <scanned PDFs> tests/pi-extract/expected-sg-samples.json`.
Keep every file under 25 MB (the Cloudflare Pages limit per file).
