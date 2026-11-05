# Set up the hosted Supabase project (about 15 minutes)

No Docker or command line needed except for step 8. Use made-up data only until the go-live checklist in the main README is done.

## Reusing an existing project instead (e.g. Finassistant)
1. Open the paused project and click **Restore**. Wait until it is running.
2. **Project Settings → General**: note the **Region**. Fine for the prototype if it isn't Singapore,
   but real client data must live in a Singapore project, and a project's region can't be changed.
3. SQL Editor → run `0-check-existing-project.sql` (read-only) and send Claude a screenshot.
   If it lists only the two "(info)" rows, nothing clashes: skip to step 2 below.
4. Existing users of that project get a DMS profile with no roles, so they see nothing until you assign one.
5. Turn off public sign-up (step 4) only if the old app no longer needs it.

## 1. Create the project
1. Sign in at supabase.com and click **New project**.
2. Name: `dms-prototype`. Region: **Southeast Asia (Singapore)**. Plan: **Free**.
3. Set a strong database password and keep it in a password manager. You won't need it day to day.
4. Wait about 2 minutes for the project to start.

## 2. Create the tables and access rules
1. Left menu: **SQL Editor** → **New query**.
2. Paste the whole of `1-setup.sql` and click **Run**. You should see "Success. No rows returned".
3. Run it once only. If it fails part-way, nothing is saved (it runs as one transaction); send me the error.

## 3. (Optional) Load sample data
New query → paste `2-sample-data.sql` → **Run**. This adds 6 sample introducers, 3 sample insurers' term rate
tables and 6 knowledge-bank entries, so the screens have something to show. `4-remove-sample-data.sql` removes them later.

## 4. Lock down sign-up
1. **Authentication** → **Sign In / Providers** (or **Providers** → **Email**): keep Email enabled.
2. Turn **off** "Allow new users to sign up". Only people you add can get in.
3. **Authentication** → **URL Configuration**: Site URL `http://localhost:5173`. Add your Cloudflare Pages URL here later.

## 5. Add yourself (and testers)
**Authentication** → **Users** → **Add user** → **Create new user**. Enter the email and a password and tick
**Auto Confirm User**. Repeat for each tester. A second admin is needed to approve rate tables.

## 6. Give people roles
New query → paste `3-assign-roles.sql`, change the emails and names, **Run**. The result lists everyone and their roles.
Until this step, a new user sees "Waiting for access".

## 7. Copy the connection details
**Project Settings** → **API** (or the **Connect** button at the top): copy the **Project URL** and the
**anon / publishable** key. Never put the `service_role` / secret key in the web app.

## 8. Run the web app against it
```bash
cd web
cp .env.example .env.local     # paste the Project URL and anon key
npm install
npm run dev                    # open http://localhost:5173 and sign in
```

## Notes
- Free projects pause after about a week without use. Restore from the dashboard; data is kept. Move to Pro before real data.
- Future database changes come as new files in `supabase/migrations/`. To apply them from the command line later:
  `npx supabase link --project-ref <your ref>`, then once only
  `npx supabase migration repair --status applied 20261104000001 20261104000002` (because steps 2 ran by hand),
  then `npx supabase db push` for each new change.
