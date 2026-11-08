import { useEffect, useState } from 'react'
import { supabase } from './supabase'
import type { Profile } from './types'

/** Profiles the signed-in user is allowed to see, keyed by id. */
export function usePeople() {
  const [people, setPeople] = useState<Record<string, Profile>>({})
  useEffect(() => {
    supabase.from('profiles').select('*').order('full_name').then(({ data }) =>
      setPeople(Object.fromEntries(((data as Profile[]) ?? []).map((p) => [p.id, p]))))
  }, [])
  return people
}

export const nameOf = (people: Record<string, Profile>, id: string | null) =>
  id ? people[id]?.full_name || people[id]?.email || 'Someone' : '—'
