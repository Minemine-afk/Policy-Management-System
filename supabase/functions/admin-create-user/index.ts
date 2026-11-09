// Supabase Edge Function: lets a bsd user create a new login from the Admin page.
//
// Why a server function: creating a user needs the service_role (secret) key, which must never be in the
// web app. This function runs on Supabase's servers, where that key is provided automatically.
//
// What it does, in order:
//   1. Checks the caller is signed in and is an active bsd user (the database rule has_role('bsd')).
//   2. Creates the login (email + temporary password, already confirmed).
//   3. Gives it the chosen role, name and firm by calling admin_update_user AS THE CALLER, so the database
//      checks bsd again and the audit log records who did it. If that fails, the new login is deleted again.
//
// Deploy: see supabase/cloud/README.md ("Let bsd create users"). It uses only fetch, no imports, so it can
// be pasted into the dashboard editor as one file.

const ROLES = ['introducer', 'ops', 'bsd'] as const
const MIN_PASSWORD = 8

export interface Env { url: string; anonKey: string; serviceKey: string }

const cors = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, x-client-info, apikey, content-type',
  'access-control-allow-methods': 'POST, OPTIONS',
}
const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'content-type': 'application/json' } })

async function readError(r: Response) {
  const t = await r.text()
  try { const j = JSON.parse(t); return String(j.msg || j.message || j.error_description || j.error || t) } catch { return t }
}

export async function handle(req: Request, env: Env): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return reply(405, { error: 'Use POST' })
  if (!env.url || !env.anonKey || !env.serviceKey) return reply(500, { error: 'Function is missing its Supabase settings' })

  const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '')
  if (!token) return reply(401, { error: 'Sign in first' })

  // 1. Who is calling, and are they bsd? Both answered by Supabase with the caller's own token.
  const me = await fetch(`${env.url}/auth/v1/user`, { headers: { apikey: env.anonKey, authorization: `Bearer ${token}` } })
  if (!me.ok) return reply(401, { error: 'Your session has expired. Sign in again.' })
  const asCaller = { apikey: env.anonKey, authorization: `Bearer ${token}`, 'content-type': 'application/json' }
  const isBsd = await fetch(`${env.url}/rest/v1/rpc/has_role`, { method: 'POST', headers: asCaller, body: JSON.stringify({ r: 'bsd' }) })
  if (!isBsd.ok || (await isBsd.json()) !== true) return reply(403, { error: 'Only bsd can create users' })

  // Check the form.
  let body: Record<string, unknown>
  try { body = await req.json() } catch { return reply(400, { error: 'Send the details as JSON' }) }
  const email = String(body.email ?? '').trim().toLowerCase()
  const password = String(body.password ?? '')
  const fullName = String(body.full_name ?? '').trim()
  const company = String(body.company ?? '').trim()
  const role = String(body.role ?? '')
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return reply(400, { error: 'Enter a valid email address' })
  if (password.length < MIN_PASSWORD) return reply(400, { error: `The temporary password needs at least ${MIN_PASSWORD} characters` })
  if (!fullName) return reply(400, { error: 'Enter the person’s name' })
  if (!(ROLES as readonly string[]).includes(role)) return reply(400, { error: 'Choose a role: introducer, ops or bsd' })

  // 2. Create the login. Only this call uses the secret key.
  const admin = { apikey: env.serviceKey, authorization: `Bearer ${env.serviceKey}`, 'content-type': 'application/json' }
  const created = await fetch(`${env.url}/auth/v1/admin/users`, {
    method: 'POST', headers: admin,
    body: JSON.stringify({ email, password, email_confirm: true, user_metadata: { full_name: fullName } }),
  })
  if (!created.ok) {
    const msg = await readError(created)
    if (created.status === 422 && /already|exists|registered/i.test(msg)) return reply(409, { error: `${email} already has an account` })
    return reply(400, { error: msg })
  }
  const user = await created.json()
  const id: string = user.id ?? user.user?.id

  // 3. Role, name and firm, as the caller (database re-checks bsd and writes the audit log).
  const assign = await fetch(`${env.url}/rest/v1/rpc/admin_update_user`, {
    method: 'POST', headers: asCaller,
    body: JSON.stringify({ p_user: id, p_role: role, p_active: true, p_full_name: fullName, p_company: company }),
  })
  if (!assign.ok) {
    const msg = await readError(assign)
    await fetch(`${env.url}/auth/v1/admin/users/${id}`, { method: 'DELETE', headers: admin })
    return reply(400, { error: `Could not set the role, so the account was not created: ${msg}` })
  }
  return reply(200, { id, email, role, full_name: fullName })
}

// Runs on Supabase (Deno). Not used when the test gateway imports handle() directly.
declare const Deno: { env: { get(k: string): string | undefined }; serve(h: (r: Request) => Promise<Response>): void } | undefined
if (typeof Deno !== 'undefined') {
  Deno.serve((req) => handle(req, {
    url: Deno!.env.get('SUPABASE_URL') ?? '',
    anonKey: Deno!.env.get('SUPABASE_ANON_KEY') ?? '',
    serviceKey: Deno!.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  }))
}
