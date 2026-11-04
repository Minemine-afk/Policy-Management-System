# Distribution Management System (prototype)

Internal web app for a Singapore insurance distribution agency:

1. **Introducers**: directory sortable by date added and last active, filterable by speciality and status.
2. **Policy requests**: a term-life form built from fixed categories generates an anonymised request
   with indicative premium ranges from approved rate tables. Submitters, approvers and admins have separate access.
3. **Knowledge bank**: store and look up product, onboarding and process documents (search reads inside PDFs).

The system never stores client identity. Documents are uploaded already redacted, and each upload is
checked for NRIC, phone and email patterns before it is stored.

> **Prototype.** All names, introducers and premiums are made-up sample data. Do not put real client
> documents in it until the go-live checklist below is done.

## Stack

| Part | Choice |
|---|---|
| Front end | React + TypeScript (Vite) in `web/` |
| Database, login, files | Supabase (PostgreSQL with row-level security, Auth, Storage) in `supabase/` |
| Sign-in | Email + password for the prototype; Microsoft (Entra ID) ready in `supabase/config.toml` |
| Hosting (later) | Cloudflare Pages for `web/`, Supabase project in Singapore (ap-southeast-1) |

## Run it on your computer

You need Node.js 20+ and Docker Desktop running.

```bash
npm install                 # installs the Supabase CLI
npx supabase start          # first run downloads the containers (a few minutes)
npx supabase status         # copy "API URL" and "anon key"

cd web
cp .env.example .env.local  # paste the API URL and anon key in
npm install
npm run dev                 # open http://127.0.0.1:5173
```

`npx supabase db reset` wipes the local database and reloads the sample data.

### Sample logins (password `password123`)

| Email | Roles | Try this |
|---|---|---|
| submitter@example.com | Submitter | Fill the form, upload a PDF, submit |
| approver@example.com | Submitter + Approver | See that your own request is greyed out in the queue |
| approver2@example.com | Approver | Approve, refer back, reject, report an unredacted file |
| admin@example.com | Admin | All requests, users and roles, rate tables, audit log |
| admin2@example.com | Admin + Approver | Approve a rate table uploaded by the other admin |
| editor@example.com | Content editor | Upload and archive knowledge-bank documents |

## What the database enforces

These rules live in `supabase/migrations/` and hold even if someone bypasses the screens:

- A request's status only changes through `submit_request`, `decide_request` and `withdraw_request`.
- Nobody can approve their own request; Reject and Refer back need a reason.
- Submitting needs the redaction confirmation and no blocked or reported files.
- Approvers see submitted requests only (never drafts) and never the submitter's private case reference.
- A file reported as unredacted is hidden from approvers at once and logged for admins.
- A rate table only goes live when a different admin approves it; the old version is retired.
- Deactivated users see nothing; new Microsoft sign-ins get no access until an admin assigns a role.
- Every decision, document view, role change and rate-table change is written to the audit log.
- Price ranges are frozen onto the request when it is submitted.

## Tests

```bash
npm run test:db     # access-rule tests on plain PostgreSQL (set PGURL); no Docker needed
```

`tests/e2e/` holds the browser walkthrough used to check the full flow (see its README).

## Rate tables

Admins upload one CSV per insurer when the insurer changes its rates (not per request).
Columns: `age_band, gender, smoker, coverage_term, sum_assured_band, ci_benefit, premium_low, premium_high`
(annual S$). Band labels must match the form exactly; see `docs/rate-table-template.csv`.

## Turning on Microsoft sign-in

1. A Microsoft 365 admin creates an app registration (single tenant) with redirect URI
   `http://127.0.0.1:54321/auth/v1/callback` (local) and later your Supabase project's callback URL.
2. Set `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_TENANT_URL` (`https://login.microsoftonline.com/<tenant-id>`),
   set `enabled = true` under `[auth.external.azure]` in `supabase/config.toml`, and restart Supabase.
3. Set `VITE_ENABLE_MICROSOFT_LOGIN=true` in `web/.env.local`. Remove the sample users before go-live.

## Not done yet (before real client data)

- Server-side redaction check, PDF flattening and metadata removal (today's check runs in the browser and can be bypassed).
- Daily job for `expire_stale_requests()` (pg_cron) and email notifications to approvers.
- Supabase Pro (backups, no pausing), Microsoft sign-in only, MFA through Entra, sample users removed.
- MAS outsourcing assessment, PDPA review, compliance sign-off on the approval step, and a professional security test.
- Real rate tables from each insurer, and confirmed term variants and riders.
- Make this repository private.
