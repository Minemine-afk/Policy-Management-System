# Set up the hosted Supabase project (about 15 minutes)

No Docker or command line needed except for step 7. Use made-up data only until the go-live checklist in the main README is done.

## 1. Create the project
1. Sign in at supabase.com and click **New project**.
2. Name: `pi-tracker`. Region: **Southeast Asia (Singapore)**. Plan: **Free** for now.
3. Set a strong database password and keep it in a password manager.
4. Wait about 2 minutes for the project to start.

(Reusing an existing project? Run `0-check-existing-project.sql` first and send Claude a screenshot. If you already ran
the old approval-flow setup on it, run `0-clear-old-prototype.sql` once, which deletes that prototype's data.)

## 2. Create the tables and access rules
1. Left menu: **SQL Editor** → **New query**.
2. Paste the whole of `1-setup.sql` and click **Run**. You should see "Success. No rows returned".
3. **Already ran an earlier `1-setup.sql`?** Don't run it again. Run the upgrade files you haven't run yet, in order:
   - `1b-upgrade.sql` (9 Nov: notifications, new workflow rules, tighter privacy)
   - `1c-upgrade.sql` (10 Nov: urgent flag, deadline settings, reopen, bulk assign, saved filters)
   - `1d-upgrade.sql` (11 Nov: urgent and due times hidden from introducers, overdue requests marked urgent automatically)
   - `1e-upgrade.sql` (12 Nov: separate Admin role). **Edit it first:** put the email of the login that should become
     Admin on the line marked `CHANGE THIS`. It stops without changing anything until you do.
   - `1f-upgrade.sql` (12 Nov: NRIC/FIN no longer collected). **Warning:** it permanently deletes every NRIC stored so far;
     client name and contact are kept. Export the request_clients table first if the firm must keep them.
   - `1g-upgrade.sql` (13 Nov: fixes "Direct deletion from storage tables is not allowed" when removing a file)
   - `1i-upgrade.sql` (14 Nov: module access, so an admin can switch modules on or off per role and per person).
     Nobody's access changes when you run it.
   - `1j-upgrade.sql` (15 Nov: PI pack). Introducers get one restricted PDF (the comparison, then the PIs) and never the
     Excel; "Mark completed" needs an up-to-date PI pack. Requests completed earlier keep their PI PDFs (Excel hidden).
   - `1k-upgrade.sql` (19 Nov: automatic deletion of requests overdue for more than 30 days). Running it deletes nothing;
     see step 6c to switch the daily run on.
   - `1l-upgrade.sql` (19 Nov: the request form asks for the client's date of birth, compulsory, instead of an age band).
     Existing requests keep their age band.
   - `1m-upgrade.sql` (20 Nov: teach a new insurer). Keeps the places the PI reader learns from saved comparisons
     (label words and positions only, never client values). Until you run it, comparisons save as before but nothing
     is learned.
   - `1n-upgrade.sql` (22 Nov: the PI reader learns more). It also learns values in year-by-year tables (e.g. the total
     premium on the policy term's row) and remembers when ops CORRECT one of its values, so the next PI of that insurer
     uses the taught place instead. Until you run it, the rest of the learning works as before.
   - `1o-upgrade.sql` (22 Nov: the PI reader remembers the NAs ops set per plan: no rider, no cash value, no campaign).
     Until you run it, everything else is learned as before.
   - `1p-upgrade.sql` (23 Nov: the new PI request form from the deck's wireframe 2, with the optional term product
     comparison, and the Knowledge Bank tables it reads products from). Deletes nothing: old requests keep their
     details. The compare pop-up lists only checked Knowledge Bank products; to try it before real products are added,
     run `3c-sample-products.sql` (6 made-up plans marked "(sample)"), and remove them later with
     `4c-remove-sample-products.sql`.
   - `1q-upgrade.sql` (23 Nov: the Knowledge Hub module with the Knowledge Bank screens: upload documents with versions
     and expiry dates, product records, and checking by a second person). Ops and BSD get the module the first time you
     run it; introducers only if an admin switches it on for them (they then see checked documents only). Files go to
     a new private storage bucket `kb-docs`, created by the script.
   - `1h-undo-new-form.sql`: **only if you ran the withdrawn `1h-upgrade.sql`** (11-12 Nov). Never needed otherwise:
     it now stops without changing anything when 1h never ran.

   Each is safe to run again if you are not sure whether you ran it.
4. Run it once only. If it fails part-way nothing is saved (it runs as one transaction); send me the error.

## 3. Lock down sign-up
1. **Authentication** → **Sign In / Providers**: keep Email enabled, turn **off** "Allow new users to sign up".
2. **Authentication** → **URL Configuration**: Site URL `http://localhost:5173`. Add your Cloudflare Pages URL later.

## 4. Add yourself and testers
**Authentication** → **Users** → **Add user** → **Create new user**. Enter the email and a password and tick
**Auto Confirm User**. You only need to do this for yourself (the first admin); once step 4b is done, an admin can add
everyone else from the website.

## Roles
- **Introducer** submits PI requests and sees only their own.
- **Ops** picks up requests, uploads PIs, compares them.
- **BSD** sees every request, assigns, reassigns, bulk assigns, removes and reopens requests.
- **Admin** manages the system: adds users (one by one or from a CSV file), changes roles, deactivates people,
  sets the deadline and reads the audit log. Admin does not see requests or client details.
One role per login.

## 5. Give people roles
New query → paste `2-assign-roles.sql`, change the emails, names and roles, **Run**. The result lists everyone.
Until this step a new user sees "Waiting for access". Afterwards, an admin can change roles from the Admin page.

## 4b. Let admins create users from the website (about 5 minutes, once)
Creating a login needs Supabase's secret key, which must never be in the web app. So the website asks a small
server function, `admin-create-user`, which runs on Supabase, checks the caller is an active admin user, creates the
login and sets the role. No command line needed:
1. Left menu: **Edge Functions** → **Deploy a new function** → **Via Editor**.
2. Name it exactly `admin-create-user`.
3. Delete the example code, paste the whole of `supabase/functions/admin-create-user/index.ts`, click **Deploy**.
4. Sign in as an admin → **Admin** → **Users and roles** → **Add a user**. Pick the role, keep or change the suggested
   temporary password, **Create user**, and pass the email and password to the person privately. They can change
   the password under **Account** (top right) after signing in.

If **Create user** says "Invalid JWT" or "Unauthorized", open the function's **Details** and turn off
**Verify JWT** (the function checks the caller's sign-in itself), then try again.
Command-line alternative: `npx supabase functions deploy admin-create-user --project-ref <ref>`.

## 6. (Optional) Load sample requests
Run `3-sample-data.sql` after step 5. `4-remove-sample-data.sql` removes them again.

## 6a. (Optional) 20 fake sample users with 3 requests each per introducer
`3b-sample-users.sql` adds 5 introducers, 5 ops, 5 bsd and 5 admin users (`sample.introducer1@example.com` …
`sample.bsd5@example.com`, `sample.admin1@example.com` … `sample.admin5@example.com`, all named "[Sample] …") and
3 requests for each sample introducer (one waiting, one in progress with a sample ops user, one completed).
**First change `sample_password` near the top**; the script refuses to run until you do. All 20 share that password
and five are admins, so pick a strong one. Already ran it before 12 Nov? Run it again to add the 5 admins
(users that exist are skipped).
`4b-remove-sample-users.sql` removes all of them (admins included) and their requests again (real users and requests are kept).
Remove them before any real client data goes in.

## 6b. (Optional) Deadline checks on a schedule
Run `5-schedule-deadline-checks.sql` once. It checks deadlines every 15 minutes, so "due soon" and "overdue" notices
arrive even when nobody has the app open.

## 6c. Automatic deletion of long-overdue requests (about 10 minutes, once)
An open request (submitted, assigned, in progress, or sent back with the clock running) whose due time passed more than
30 days ago is **deleted for good** once a day at 3 AM Singapore time: the request, its client details, comments, history,
files, PI comparison and PI pack. Completed and removed requests are never deleted, nor are sent-back requests while
their clock is paused. The audit log keeps one line per deleted request (its reference, status and how late it was;
no client details), shown as done by "System". An admin changes the number of days, or switches it off, under
**Admin → Deadline settings**, which also lists exactly which requests would be deleted now.

1. Run `1k-upgrade.sql` (step 2) if you haven't. Nothing is deleted yet.
2. Deploy the file clean-up function (Supabase does not let SQL delete stored files, so this function removes them with
   the Storage API): **Edge Functions** → **Deploy a new function** → **Via Editor**, name it exactly `cleanup-deleted-files`,
   paste the whole of `supabase/functions/cleanup-deleted-files/index.ts`, **Deploy**. Then open its **Details** and turn
   **off** "Verify JWT" (the schedule calls it without a key; it takes no input and can only remove files of requests
   that are already deleted).
3. Sign in as an admin → **Admin → Deadline settings** and check the **Preview** list. These are the requests the first
   run will delete. Untick "Delete long-overdue requests automatically" and **Save** if you are not ready.
4. Open `5b-schedule-auto-delete.sql`, replace `YOUR-PROJECT-REF` everywhere (Find and replace, "Replace all") with your
   project reference (the part before `.supabase.co` in the Project URL), paste it into SQL Editor and **Run**. The result
   lists two jobs. If "create extension" fails: **Database → Extensions**, switch on `pg_cron` and `pg_net`, run it again.

Admins can also press **Delete these now** on that page instead of waiting for the night. A note there shows if files
of deleted requests are still waiting to be removed (nobody can open them; **Remove now** retries).
Command-line alternative for step 2: `npx supabase functions deploy cleanup-deleted-files --no-verify-jwt --project-ref <ref>`.

## 7. Connect the web app
**Project Settings** → **API** (or the **Connect** button): copy the **Project URL** and the **anon / publishable** key.
Never put the `service_role` / secret key in the web app.
```bash
cd web
cp .env.example .env.local     # paste the Project URL and anon key
npm install
npm run dev                    # open http://localhost:5173 and sign in
```

## Notes
- Free projects pause after about a week without use and have no backups. Move to Pro before real data.
- Password reset emails use Supabase's built-in sender, which is rate-limited. Set up your own email (SMTP) before
  giving accounts to introducers.
- Future database changes come as new files in `supabase/migrations/`. Apply them by pasting into the SQL Editor,
  or from the command line with `npx supabase link --project-ref <ref>` and `npx supabase db push`.
