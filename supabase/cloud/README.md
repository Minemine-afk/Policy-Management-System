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

   Each is safe to run again if you are not sure whether you ran it.
4. Run it once only. If it fails part-way nothing is saved (it runs as one transaction); send me the error.

## 3. Lock down sign-up
1. **Authentication** → **Sign In / Providers**: keep Email enabled, turn **off** "Allow new users to sign up".
2. **Authentication** → **URL Configuration**: Site URL `http://localhost:5173`. Add your Cloudflare Pages URL later.

## 4. Add yourself and testers
**Authentication** → **Users** → **Add user** → **Create new user**. Enter the email and a password and tick
**Auto Confirm User**. Make at least one user for each role you want to test (introducer, ops, bsd).

## 5. Give people roles
New query → paste `2-assign-roles.sql`, change the emails, names and roles, **Run**. The result lists everyone.
Until this step a new user sees "Waiting for access". Afterwards, BSD can change roles from the Admin page.

## 6. (Optional) Load sample requests
Run `3-sample-data.sql` after step 5. `4-remove-sample-data.sql` removes them again.

## 6b. (Optional) Deadline checks on a schedule
Run `5-schedule-deadline-checks.sql` once. It checks deadlines every 15 minutes, so "due soon" and "overdue" notices
arrive even when nobody has the app open.

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
