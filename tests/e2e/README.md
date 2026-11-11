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
