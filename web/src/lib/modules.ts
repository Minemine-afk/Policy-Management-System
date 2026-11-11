import { useEffect, useState } from 'react'
import { supabase } from './supabase'
import type { Role } from './types'

/** Module keys. PI Requests is live; the rest are planned and show as "coming soon". */
export type ModuleKey = 'pi_requests' | 'product_matrix' | 'introducer_intelligence' | 'knowledge_hub' | 'content_studio' | 'linkedin_outreach'

export interface AppModule {
  key: ModuleKey
  name: string
  description: string
  live: boolean
  /** Roles the module can ever be given to. */
  roles: Role[]
  sort: number
}

/** Where each live module opens. */
export const MODULE_HOME: Partial<Record<ModuleKey, string>> = { pi_requests: '/board' }

export async function loadModules(): Promise<AppModule[]> {
  const { data } = await supabase.from('app_modules').select('*').order('sort')
  return (data as AppModule[]) ?? []
}

export function useModules() {
  const [mods, setMods] = useState<AppModule[]>([])
  useEffect(() => { loadModules().then(setMods) }, [])
  return mods
}

/** Ids of the people whose PI Requests module is on (only they can be given requests). */
export function usePiMembers() {
  const [ids, setIds] = useState<Set<string> | null>(null)
  useEffect(() => {
    supabase.rpc('module_members', { p_module: 'pi_requests' }).then(({ data, error }) =>
      setIds(error ? null : new Set(((data as string[] | null) ?? []))))
  }, [])
  return ids
}
