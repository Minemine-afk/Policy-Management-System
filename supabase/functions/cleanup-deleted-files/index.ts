// Supabase Edge Function: removes the files of requests that were deleted automatically (long overdue).
//
// Why a server function: Supabase does not let SQL delete stored files ("Direct deletion from storage tables is not
// allowed"), and a browser may only delete its own unlisted uploads. So when the database deletes a long-overdue
// request (public.delete_overdue_requests), it only puts the request's file paths in the table storage_cleanup_queue.
// This function takes those paths, removes the files with the Storage API (using the service_role key, which Supabase
// provides here automatically and which never reaches the web app) and empties the queue.
//
// Who may call it: anyone who can reach it. It takes no input and can only remove files that are in the queue,
// i.e. files whose request is already gone and which nobody can open any more; calling it early only does the
// clean-up sooner. The schedule (supabase/cloud/5b-schedule-auto-delete.sql) calls it every hour, and the
// Admin > Deadline settings page calls it after "Delete now".
//
// Deploy: see supabase/cloud/README.md ("Automatic deletion of long-overdue requests"). It uses only fetch, no imports,
// so it can be pasted into the dashboard editor as one file. Turn OFF "Verify JWT" for this function.

export interface Env { url: string; serviceKey: string }

const BATCH = 100
const ROUNDS = 10   // up to 1,000 files per call; the rest wait for the next call

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
  if (!env.url || !env.serviceKey) return reply(500, { error: 'Function is missing its Supabase settings' })

  const asServer = { apikey: env.serviceKey, authorization: `Bearer ${env.serviceKey}`, 'content-type': 'application/json' }
  const rpc = (fn: string, args: unknown) =>
    fetch(`${env.url}/rest/v1/rpc/${fn}`, { method: 'POST', headers: asServer, body: JSON.stringify(args) })

  let removed = 0
  const failed: string[] = []
  for (let round = 0; round < ROUNDS; round++) {
    const next = await rpc('files_to_clean', { p_limit: BATCH })
    if (!next.ok) return reply(500, { error: `Could not read the list of files: ${await readError(next)}`, removed })
    const rows = (await next.json()) as { bucket: string; path: string }[]
    if (!rows.length) break
    const byBucket = new Map<string, string[]>()
    for (const r of rows) byBucket.set(r.bucket, [...(byBucket.get(r.bucket) ?? []), r.path])
    let progress = false
    for (const [bucket, paths] of byBucket) {
      // The Storage API removes the files that exist and ignores paths that are already gone; both count as done.
      const del = await fetch(`${env.url}/storage/v1/object/${encodeURIComponent(bucket)}`,
        { method: 'DELETE', headers: asServer, body: JSON.stringify({ prefixes: paths }) })
      const error = del.ok ? null : `Storage API ${del.status}: ${await readError(del)}`
      const done = await rpc('files_cleaned', { p_bucket: bucket, p_paths: paths, p_error: error })
      if (!done.ok) return reply(500, { error: `Could not update the list of files: ${await readError(done)}`, removed })
      if (error) failed.push(error)
      else { removed += paths.length; progress = true }
    }
    if (!progress) break   // the Storage API refused everything this round; try again on the next call
  }
  const left = await rpc('files_to_clean', { p_limit: 500 })
  const remaining = left.ok ? ((await left.json()) as unknown[]).length : null
  return reply(failed.length ? 502 : 200, { removed, remaining, errors: failed.slice(0, 3) })
}

// Runs on Supabase (Deno). Not used when the test gateway imports handle() directly.
declare const Deno: { env: { get(k: string): string | undefined }; serve(h: (r: Request) => Promise<Response>): void } | undefined
if (typeof Deno !== 'undefined') {
  Deno.serve((req) => handle(req, {
    url: Deno!.env.get('SUPABASE_URL') ?? '',
    serviceKey: Deno!.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  }))
}
