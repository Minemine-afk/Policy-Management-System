import { supabase } from './supabase'
import { says } from './options'
import type { Role } from './types'

/** A readable temporary password, e.g. "Kite-7342-Moss". */
export function tempPassword() {
  const words = ['Kite', 'Moss', 'Reef', 'Pine', 'Lark', 'Opal', 'Fern', 'Dune', 'Cove', 'Teal', 'Wren', 'Jade']
  const n = new Uint32Array(3); crypto.getRandomValues(n)
  return `${words[n[0] % words.length]}-${1000 + (n[1] % 9000)}-${words[n[2] % words.length]}`
}

export interface NewUser { full_name: string; email: string; role: Role; company: string; password: string }

/** Creates a login with a role straight away (runs the admin-create-user server function). Returns an error message or ''. */
export async function createUser(u: NewUser): Promise<string> {
  const { error } = await supabase.functions.invoke('admin-create-user', {
    body: { ...u, company: u.role === 'introducer' ? u.company : '' },
  })
  if (!error) return ''
  let msg = says(error.message)
  const ctx = (error as { context?: Response }).context
  if (ctx && typeof ctx.json === 'function') {
    try { msg = says((await ctx.json()).error ?? msg) } catch { /* not JSON */ }
  } else if (/fetch|send a request|not found/i.test(msg)) {
    msg = 'Could not reach the user-creation function. It may not be deployed yet (see supabase/cloud/README.md, "Let admins create users").'
  }
  return msg
}
