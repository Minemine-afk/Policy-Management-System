import { useCallback, useEffect, useState } from 'react'
import { supabase } from './supabase'
import { useAuth } from './auth'

export interface Notice {
  id: string
  request_id: string
  kind: string
  message: string
  created_at: string
  read_at: string | null
}

/** Unread count for the bell. Ops and bsd also refresh deadline notices when they open the app. */
export function useUnreadCount() {
  const { has, profile } = useAuth()
  const [count, setCount] = useState(0)
  const staff = has('ops') || has('bsd')
  const uid = profile?.id

  const load = useCallback(async () => {
    if (staff) await supabase.rpc('refresh_deadline_notifications')
    const { count } = await supabase.from('notifications').select('id', { count: 'exact', head: true }).is('read_at', null)
    setCount(count ?? 0)
  }, [staff])

  useEffect(() => {
    if (!uid) return
    // load now and every minute, and whenever the notifications page marks things read
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load()
    const t = setInterval(load, 60_000)
    window.addEventListener('notifications-changed', load)
    return () => { clearInterval(t); window.removeEventListener('notifications-changed', load) }
  }, [uid, load])
  return count
}
