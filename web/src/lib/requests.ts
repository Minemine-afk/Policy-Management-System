import { useCallback, useEffect, useState } from 'react'
import { supabase } from './supabase'
import type { PiRequest } from './types'

export function useRequests() {
  const [rows, setRows] = useState<PiRequest[]>([])
  const [loading, setLoading] = useState(true)
  const reload = useCallback(async () => {
    const { data } = await supabase.from('request_list').select('*').order('submitted_at', { ascending: false })
    setRows((data as PiRequest[]) ?? [])
    setLoading(false)
  }, [])
  useEffect(() => { reload() }, [reload])
  return { rows, loading, reload }
}
