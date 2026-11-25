# End-to-end check without Docker

Used when the full Supabase stack can't run (for example in a locked-down cloud container).
It runs the real Supabase Auth (GoTrue) and PostgREST binaries against local PostgreSQL, plus
`gateway.mjs`, a small test-only stand-in for the Supabase gateway and Storage API.
On a normal machine, use `supabase start` instead and you don't need any of this.

1. Download `auth` (github.com/supabase/auth releases, v2.170.0 x86; also keep its `migrations` folder) and
   `postgrest` (github.com/PostgREST/postgrest releases, v12.2.3 linux-static-x64) into this folder.
2. Create PostgreSQL roles `supabase_auth_admin` (superuser, password `pw`) and `authenticator`
   (login, noinherit, password `pw`, granted anon/authenticated/service_role); set the postgres password to `pw`.
3. `./reset.sh` (rebuilds the `e2e` database and starts Auth + PostgREST), then `node gateway.mjs`.
4. Start the web app against `http://127.0.0.1:54321` with the anon key the gateway prints.
5. `npm i pg playwright` here, then `node run.cjs`. It walks through: submit, pick up, upload PIs, internal
   vs shared comments, complete, drag on the board, send back and resubmit, introducer isolation, bsd assign and
   remove, admin users (add, CSV import and export), settings and the audit log, and Compare PIs on made-up Singapore-style PIs (`sample-pis.cjs`).
   Screenshots go to `shots/`. Add `PI_SAMPLES=/path/to/pi-samples` to also check the two real Singapore sample PIs
   (expected values in `../pi-extract/expected-sg-samples.json`). Without a browser: `node tests/pi-extract/check.mjs <folder> [expected.json]`.
   Add `PI_SCANS=/path/to/scans` (made by `./make-scans.sh <pi-samples> <scans> [tilt]`) to also check OCR on scanned copies.
6. OCR only: `node tests/pi-extract/check-ocr.mjs <scans> ../pi-extract/expected-sg-samples.json` (Node, same models and
   rules; needs `npm i onnxruntime-node pngjs` in `tests/pi-extract` and pdftoppm), or `node tests/pi-extract/check-browser.cjs
   <folder> <expected.json>` (real Chromium through the Vite dev server, with timings and download size).
7. Teach a new insurer: `node tests/pi-extract/check-teach.mjs <pi-samples> --max-wrong 0`. The walkthrough also teaches Empire Life when `PI_SAMPLES` is set.
   On a scanned PI: `node tests/pi-extract/check-teach-scan.mjs <pi-samples>/SG_Manulife_ManuProtectTermII_500k.pdf tests/pi-extract/teach-scan-manulife.json`.
8. PI pack and issue dates: `node tests/pi-extract/check-issue-date.mjs <pi-samples>` (issue date rules),
   `node tests/pi-extract/check-form-fill.mjs` (particulars from the request form), and
   `node tests/pi-extract/check-pdf.mjs out.pdf PI1.pdf [PI2.pdf] [PI3.pdf]` (builds the pack; check it with `pdfinfo`).
9. Excel only: `node tests/pi-extract/check-excel.mjs <folder with up to 3 PIs> out.xlsx` fills the comparison template
   (built by `node web/scripts/make-template.mjs`) and prints the sheet.

10. Free AI helper (fills blank cells, in the browser): `node tests/pi-extract/check-ai-checks.mjs` (its safety checks, no model,
   seconds), `node tests/pi-extract/check-ai.mjs <pi-samples> ../pi-extract/expected-unknown-formats.json --extra
   ../pi-extract/expected-ai-extra.json --max-wrong 0` (the real model on the CPU in Node, ~10 minutes, downloads it once; add `--cache <dir>` to keep the raw answers and re-score
   changes to the checks in seconds, `--model <id>` to try another model;
   add `--all` to ask about every field, a harder test of the checks), and `node tests/pi-extract/check-ai-browser.cjs <pi-samples>
   CA_iA_TermQuote_2024.pdf` (the website's own worker in Chromium; also checks that nothing is sent out of the page).

Knowledge Bank reader (fills product records from a Product Summary or rate sheet, PDF/Excel/CSV): `node tests/kb-extract/check.mjs`
(made-up documents from `tests/kb-extract/make-samples.mjs`). The walkthrough also uploads them and checks what is filled in.
Premium financing documents (CIMB factsheet, iFAST cost-of-funds sheet): `node tests/kb-extract/check-financing.mjs [folder] [--ai]`.
Real Singapore documents: `node tests/kb-extract/check-real.mjs [folder]` (5 real Product Summaries and the Great Eastern Cares rate
sheet, kept in the project files under product-matrix/kb-real-summaries/; expected rates in `tests/kb-extract/expected-ge-cares-rates.json`).
Free AI helper for Product Summaries (the same model as the PI helper; fills only what the rules left blank, every answer must
quote the document): `node tests/kb-extract/check-kb-ai-checks.mjs [folder]` (its safety checks, no model, seconds) and
`node tests/kb-extract/check-kb-ai.mjs [folder] --max-wrong 0` (the real model on the CPU, ~5 minutes; expected values in
`expected-kb-ai.json`, unusual wordings in `kb-ai-variants.mjs`). Rate sheets have no AI step (see `web/src/lib/kbAi.ts`).

Thousands commas (every number on screen, e.g. 1,000,000): `node tests/format/check.mjs` tests the shared formatter
(`web/src/lib/num.ts`) and runs `web/scripts/check-number-format.mjs`, which also runs in `npm run build` and fails it
when a number is shown without `fmtNum` / `fmtMoney` (or `plain()` for years, ids, page numbers).

Top bar layout (one row for every role, Menu button on narrow screens, sign-in page centred): `node tests/topbar/check.cjs [outDir]`.
It needs no database (Supabase is faked in the browser) and checks every role and module mix on every page at 390, 1024,
1280, 1366 and 1920 wide, saving screenshots to `tests/topbar/shots/`.
