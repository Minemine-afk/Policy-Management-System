// notify-email: emails each new in-app notification to its user.
//
// Runs as a Supabase Edge Function, called by a Database Webhook on INSERT into public.notifications.
// Emails are sent through Resend's HTTP API (resend.com). Parked (not deployed). Switch-on steps: docs/email-alerts/README.md.
//
// Secrets (Edge Functions > Secrets):
//   RESEND_API_KEY   the API key from Resend
//   EMAIL_FROM       e.g. "PI Tracker <alerts@yourdomain.sg>" (the domain must be verified in Resend)
//   APP_URL          the web app address, e.g. https://pi-tracker.pages.dev
//   WEBHOOK_SECRET   any long random text; the webhook sends it in the x-webhook-secret header
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by Supabase automatically.
//
// The email carries only the request reference and the notice text (never client names or contact).

type Env = (name: string) => string | undefined

interface NotificationRow { id: string; user_id: string; request_id: string; kind: string; message: string }

const SUBJECT: Record<string, string> = {
  assigned: 'Request assigned to you', due_soon: 'Request due soon', overdue: 'Request overdue',
  sent_back: 'Request sent back to you', completed: 'Your PIs are ready', resubmitted: 'Request resubmitted',
  comment: 'New comment', urgent: 'Urgent request', reopened: 'Request reopened',
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))

export async function handle(req: Request, env: Env, fetchFn: typeof fetch = fetch): Promise<Response> {
  const secret = env('WEBHOOK_SECRET')
  if (!secret || req.headers.get('x-webhook-secret') !== secret) return new Response('Forbidden', { status: 401 })
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })

  const body = await req.json().catch(() => null)
  const n = body?.record as NotificationRow | undefined
  if (body?.type !== 'INSERT' || body?.table !== 'notifications' || !n?.user_id) return Response.json({ skipped: 'not a new notification' })

  const url = env('SUPABASE_URL'), key = env('SUPABASE_SERVICE_ROLE_KEY')
  const apiKey = env('RESEND_API_KEY'), from = env('EMAIL_FROM'), app = (env('APP_URL') ?? '').replace(/\/$/, '')
  if (!url || !key || !apiKey || !from) return new Response('Email alerts are not configured', { status: 500 })

  const res = await fetchFn(`${url}/rest/v1/profiles?id=eq.${encodeURIComponent(n.user_id)}&select=email,full_name,active,role,email_alerts`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  })
  if (!res.ok) return new Response('Could not read the profile', { status: 502 })
  const [p] = (await res.json()) as { email: string; full_name: string; active: boolean; role: string | null; email_alerts: boolean }[]
  if (!p?.email || !p.active || !p.role || !p.email_alerts) return Response.json({ skipped: 'user has email alerts off or no access' })

  const link = app ? `${app}/requests/${n.request_id}` : ''
  const subject = `PI Tracker: ${SUBJECT[n.kind] ?? 'Update'}`
  const text = `Hi ${p.full_name || ''},\n\n${n.message}\n\n${link ? `Open it: ${link}\n\n` : ''}` +
    `You get this because email alerts are on. Turn them off on the Notifications page of the PI Tracker.`
  const html = `<p>Hi ${esc(p.full_name || '')},</p><p><strong>${esc(n.message)}</strong></p>` +
    (link ? `<p><a href="${esc(link)}">Open the request</a></p>` : '') +
    `<p style="color:#666;font-size:12px">You get this because email alerts are on. Turn them off on the Notifications page of the PI Tracker.</p>`

  const sent = await fetchFn('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to: [p.email], subject, text, html }),
  })
  if (!sent.ok) return new Response(`Email provider error: ${sent.status} ${await sent.text()}`, { status: 502 })
  return Response.json({ sent: true })
}

// deno-lint-ignore no-explicit-any
const D = (globalThis as any).Deno
if (D?.serve) D.serve((req: Request) => handle(req, (k) => D.env.get(k)))
