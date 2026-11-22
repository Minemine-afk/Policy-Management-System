# OCR models (served by the site itself from /ocr/)

These files let the PI comparison read scanned PIs in the browser. They are copied into `public/ocr/` by
`scripts/copy-ocr.mjs` before `dev` and `build`. Nothing is downloaded from anywhere else at run time.

| File | What it is | Size | SHA-256 |
|---|---|---|---|
| `ch_PP-OCRv5_det_mobile.onnx` | PaddleOCR PP-OCRv5 mobile text detection | 4.6M | `4d97c44a20d30a81aad087d6a396b08f786c4635742afc391f6621f5c6ae78ae` |
| `en_PP-OCRv5_rec_mobile.onnx` | PaddleOCR PP-OCRv5 mobile English text recognition | 7.6M | `c3461add59bb4323ecba96a492ab75e06dda42467c9e3d0c18db5d1d21924be8` |
| `en_PP-OCRv5_rec_mobile.chars.txt` | The recognition model's character list (taken from the model file's own metadata) | 2 KB | |
| `latin_PP-OCRv5_rec_mobile.onnx` | PaddleOCR PP-OCRv5 mobile Latin-script text recognition (second opinion since 22 Nov 2026) | 7.6M | `b20bd37c168a570f583afbc8cd7925603890efbcdc000a59e22c269d160b5f5a` |
| `latin_PP-OCRv5_rec_mobile.chars.txt` | Its character list (from the model file's metadata) | 2 KB | |

Since 22 Nov 2026 the English model reads every line and the Latin model gives a second opinion on lines the English
model is less than 90% sure of (the surer reading wins); the Latin model is only downloaded when a page has such
lines. Test on 6 scanned PIs (every word checked against the PDF's own text): numbers read right 97.6% (English
only), 99.5% (Latin only), 98.6% (English + Latin second opinion). Latin as the main reader did best on clean scans
but lost 6 of 96 values on blurred, tilted scans, where English + Latin got 96 of 96, so English stays the main one.
The larger PP-OCRv5 server model (84 MB) was
also tried: over the 25 MB Cloudflare limit per file, and about 90 seconds a page in the browser, so not used.

**Licences.** The models are PaddleOCR by Baidu / PaddlePaddle, licensed under the Apache License 2.0
(https://github.com/PaddlePaddle/PaddleOCR). These ONNX conversions come from the RapidOCR project, also Apache 2.0
(https://www.modelscope.cn/models/RapidAI/RapidOCR, folder `onnx/PP-OCRv5`). They run with ONNX Runtime Web
(npm `onnxruntime-web`, MIT licence, by Microsoft). All three allow commercial use; keep this notice with the files.

To swap a model: put the new file here, change `MODEL_FILES` in `src/lib/ocrConfig.ts`, then run
`node tests/pi-extract/check-ocr.mjs <scanned PDFs> tests/pi-extract/expected-sg-samples.json`.
Keep every file under 25 MB (the Cloudflare Pages limit per file).
