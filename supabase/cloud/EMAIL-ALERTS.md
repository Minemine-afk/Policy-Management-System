# Email alerts (about 20 minutes)

Every in-app notification (assigned to you, due soon, overdue, sent back, completed, resubmitted, urgent, reopened,
new comment) can also go out by email. Each user can switch emails off on their Notifications page.

The email carries only the request reference and the notice text (for example "PI-00012 is overdue" or the
send-back reason), plus a link. It never contains client names, NRIC or contact details.

It works like this: a new row in `notifications` → a Supabase **Database Webhook** → the **notify-email** Edge Function
→ **Resend** sends the email. (Supabase Edge Functions can't use ordinary SMTP on port 587, so an email API is used.)

> **Before real users:** Resend is a US service that will see staff email addresses and notice texts. Include it in the
> MAS outsourcing / PDPA review, or ask Claude to switch the function to a provider you already use.

## 1. Resend
1. Sign up at resend.com.
2. **Domains → Add domain**: add a domain or subdomain you control (for example `alerts.yourfirm.sg`) and add the DNS
   records it shows. Wait until it says Verified.
3. **API Keys → Create API key** with "Sending access". Copy it.

## 2. Deploy the function
1. Supabase dashboard → **Edge Functions → Deploy a new function → Via Editor**.
2. Name it `notify-email`. Replace the sample code with the whole of `supabase/functions/notify-email/index.ts` from the repo. **Deploy**.
3. **Edge Functions → Secrets** (or Manage secrets), add:
   - `RESEND_API_KEY` = the key from step 1
   - `EMAIL_FROM` = `PI Tracker <alerts@alerts.yourfirm.sg>` (an address on the verified domain)
   - `APP_URL` = your Cloudflare Pages address, e.g. `https://pi-tracker.pages.dev`
   - `WEBHOOK_SECRET` = a long random text (make one with a password manager)

## 3. Connect the webhook
1. **Database → Webhooks → Create a new hook** (enable webhooks first if asked).
2. Name `notify-email`, table `notifications`, events **Insert** only.
3. Type **Supabase Edge Functions**, function `notify-email`, method POST, timeout 5000 ms.
4. Headers: keep the Authorization header it adds, and **add** `x-webhook-secret` with the same value as `WEBHOOK_SECRET`.
5. **Create webhook**.

## 4. Turn on scheduled deadline checks
Run `5-schedule-deadline-checks.sql` in the SQL Editor, so overdue emails go out even when nobody has the app open.

## 5. Test
Assign a request to an ops user whose email you can read. An email should arrive within a minute. If not:
**Edge Functions → notify-email → Logs** shows the reason (wrong secret = 401, missing secret = "not configured",
Resend errors show their message).

## Also set up (separate): Supabase's own login emails
Password resets use Supabase Auth's built-in sender, which is heavily rate-limited. Resend can serve that too:
**Authentication → Emails → SMTP Settings**, enable custom SMTP with host `smtp.resend.com`, port `465`,
user `resend`, password = your Resend API key, sender = the same address as `EMAIL_FROM`.
