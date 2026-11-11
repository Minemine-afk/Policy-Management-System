import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from './supabase'
import type { Profile, Role } from './types'

interface AuthState {
  session: Session | null
  profile: Profile | null
  loading: boolean
  has: (r: Role) => boolean
  /** Modules the user can open (role default or the admin's per-user switch). */
  modules: string[]
  can: (module: string) => boolean
  /** True after the user opened a password-reset link, until they set a new password. */
  recovering: boolean
  clearRecovering: () => void
}

const Ctx = createContext<AuthState>({ session: null, profile: null, loading: true, has: () => false, modules: [], can: () => false, recovering: false, clearRecovering: () => {} })

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [modules, setModules] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [recovering, setRecovering] = useState(false)

  async function loadProfile(s: Session | null) {
    if (!s) { setProfile(null); setModules([]); return }
    const [{ data }, mods] = await Promise.all([
      supabase.from('profiles').select('*').eq('id', s.user.id).maybeSingle(),
      supabase.rpc('my_modules'),
    ])
    setModules((mods.data as string[] | null) ?? [])
    setProfile((data as Profile) ?? null)
  }

  useEffect(() => {
    supabase.auth.getSession().then(async ({ data }) => {
      setSession(data.session)
      await loadProfile(data.session)
      setLoading(false)
    })
    const { data: sub } = supabase.auth.onAuthStateChange((e, s) => {
      if (e === 'PASSWORD_RECOVERY') setRecovering(true)
      setSession(s); loadProfile(s)
    })
    return () => sub.subscription.unsubscribe()
  }, [])

  const has = (r: Role) => !!profile?.active && profile.role === r
  const can = (m: string) => modules.includes(m)
  return <Ctx.Provider value={{ session, profile, loading, has, modules, can, recovering, clearRecovering: () => setRecovering(false) }}>{children}</Ctx.Provider>
}

export const useAuth = () => useContext(Ctx)
