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
   remove, user admin and the audit log. Screenshots go to `shots/`.
