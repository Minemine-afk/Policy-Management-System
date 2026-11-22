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

Knowledge Bank reader (fills product records from a Product Summary or rate sheet, PDF/Excel/CSV): `node tests/kb-extract/check.mjs`
(made-up documents from `tests/kb-extract/make-samples.mjs`). The walkthrough also uploads them and checks what is filled in.
