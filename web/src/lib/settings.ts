import { useEffect, useState } from 'react'
import { supabase } from './supabase'
import type { AppSettings } from './types'

export const DEFAULT_SETTINGS: AppSettings = { deadline_hours: 48, due_soon_hours: 24, pause_when_sent_back: true }

let cached: AppSettings | null = null

/** The deadline settings an admin chose (Admin > Deadline settings). Loaded once per page load. */
export function useSettings() {
  const [s, setS] = useState<AppSettings>(cached ?? DEFAULT_SETTINGS)
  useEffect(() => {
    if (cached) return
    supabase.from('app_settings').select('deadline_hours, due_soon_hours, pause_when_sent_back').maybeSingle()
      .then(({ data }) => { if (data) { cached = data as AppSettings; setS(cached) } })
  }, [])
  return s
}

export function forgetSettings(next?: AppSettings) { cached = next ?? null }
