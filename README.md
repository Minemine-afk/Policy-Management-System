# PI Request Tracker (prototype)

Internal web app for a Singapore insurance distribution agency. It tracks **policy illustration (PI) requests**
from submission to delivery, in the style of a simple Jira or Taiga board.

- **Introducers** submit a request through a form (client details plus the banded profile fields) and follow
  its progress. When ops finish, the PIs appear on the request. Each introducer sees only their own clients and requests.
- **Ops** pick requests from an unassigned pool or get them assigned, prepare the PIs outside the portal,
  upload them back, and mark the request completed. They can send a request back to the introducer with a reason.
- **BSD** (temporary name; the admin role) sees every request, assigns or reassigns it to an ops user,
  removes requests, manages users and reads the audit log.

Ops can assign a pooled request to themselves (**Assign to me**). Requests are due two days after submission. Ops and BSD see them in orange when one day or less is left and in red
once past two days (with the time overdue), until they are completed or removed.

Board columns: staff see Unassigned, Assigned, In progress, Sent back, Completed (cards have a drag grip); ops can drag a
request freely between Unassigned, Assigned and In progress. Introducers see only In progress (anything not yet sent back
or completed), Sent back and Completed, and never see who is handling a request. Sent-back requests are closed to comments;
the introducer edits any field and resubmits. Notifications (bell): introducers on sent back / completed; ops on
assignments, deadlines and resubmissions of their requests; BSD on all deadlines. Deadline notices are generated when
ops/BSD have the app open (every minute); there is no email yet.

Statuses: Submitted, Assigned, In progress, Sent back, Completed, Removed. Views: Board (drag cards between
columns), Backlog (filterable table), and a request page with comments (shared or internal), files and an activity timeline.

> **Prototype.** All names and clients are made-up sample data. Real client details are personal data under
> PDPA: do not enter any until the go-live checklist below is done.

**Compare PIs (ops only):** add up to three PI PDFs, or open it from a request to load that request's PIs.
The text is read in the browser with pdf.js (nothing is sent anywhere), key fields are matched by label rules in
`web/src/lib/piExtract.ts`, ops check and correct every value side by side, then export an Excel comparison with
ExcelJS (a Comparison sheet plus a Sources sheet showing where each value came from and what was changed by hand).
The rules were tested only on made-up sample PIs. Real insurer PIs will need per-insurer rules (`INSURER_RULES`).
Scanned PDFs (images) can't be read yet; they would need OCR. There is no AI fallback yet.

## Stack

| Part | Choice |
|---|---|
| Front end | React + TypeScript (Vite) in `web/` |
| Database, login, files | Supabase (PostgreSQL with row-level security, Auth, Storage) in `supabase/` |
| Sign-in | Email and password. Accounts are created by BSD in the Supabase dashboard; public sign-up is off |
| Hosting | Cloudflare Pages for `web/`, Supabase project in Singapore (ap-southeast-1) |

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

| Email | Role | Try this |
|---|---|---|
| introducer1@example.com | Introducer (Sam) | Submit a request, attach a file, see your clients |
| introducer2@example.com | Introducer (Dana) | Reply to a request that ops sent back |
| ops1@example.com | Ops (Olivia) | Pick up a request, upload PIs, complete it, drag cards |
| ops2@example.com | Ops (Omar) | See only your own work and the unassigned pool |
| bsd@example.com | BSD (Pat) | Backlog of everything, assign, remove, users, audit log |

## What the database enforces

These rules live in `supabase/migrations/` and hold even if someone bypasses the screens:

- Requests change only through database functions (`create_request`, `claim_request`, `assign_request`,
  `change_status`, `resubmit_request`, `remove_request`, ...). Nobody can edit the status directly.
- Client name, NRIC and contact are readable only by the introducer who submitted the request. Ops and BSD never see them.
- An introducer sees only their own requests. Ops see the unassigned pool and their own assignments. BSD sees all.
- Internal comments and internal events never reach introducers. PIs reach the introducer only once the request is completed.
- Sending back or removing needs a reason. Completing needs at least one uploaded PI. Only BSD assigns, reassigns and removes.
- Deactivated users see nothing. Removal keeps the record. Every status change, assignment, removal, document view
  and user change is written to an append-only audit log.

## Tests

```bash
PGURL=postgres://user:password@127.0.0.1:5432/postgres npm run test:db   # access-rule tests on plain PostgreSQL
```

`tests/e2e/` holds the browser walkthrough (27 checks) that was used to verify the full flow; see its README.

## Put it online (sample data only)

1. Supabase: follow `supabase/cloud/README.md` (about 15 minutes, Singapore region).
2. Cloudflare Pages: connect the GitHub repo, leave **Root directory** empty, set **Build command** `npm run build`,
   **Output directory** `dist` (the root build installs and builds `web/` itself), and add the variables `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`.
   Then add the Pages URL in Supabase under Authentication, URL Configuration.
3. Search engines are told to stay away (`robots.txt`, a `noindex` tag and an `X-Robots-Tag` header), but this is
   not access control: the app itself requires login.

## Not done yet (before real client data)

- Phase 2: invite and password-reset emails sent from the app, deactivation review. (MFA skipped for now by decision.)
- PDF comparison: tune the rules on real PIs from each insurer, fill your own Excel template instead of the default layout, optional AI fallback (switchable off), OCR for scanned PDFs.
- Daily reminders for stale requests, email notifications.
- Supabase Pro (backups, no pausing), sample users removed, MAS outsourcing assessment, PDPA review, compliance
  sign-off, and a professional security test. Make this GitHub repository private.
