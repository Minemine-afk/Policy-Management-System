// Supabase side of "teach a new insurer" (piTeach.ts does the reading and learning, in the browser).
import { supabase } from './supabase'
import type { LearnedRule } from './piTeach'

export interface SavedRule extends LearnedRule { id: string; created_at: string }

const COLUMNS = 'id, insurer, field, how, label, label_offset, factor, cut, plan, created_at'
const NEEDS_UPGRADE = /insurer_label_rules|teach_insurer|forget_insurer_rules|schema cache|does not exist/i
export const UPGRADE_NOTE = 'The database needs an update first: run supabase/cloud/1l-upgrade.sql in Supabase.'

type Row = Omit<SavedRule, 'offset'> & { label_offset: number }
const fromRow = ({ label_offset, ...r }: Row): SavedRule => ({ ...r, offset: label_offset, factor: Number(r.factor) })

/** Every learned place. `ready` is false when the table is not there yet (1l-upgrade.sql not run). */
export async function loadRules(): Promise<{ rules: SavedRule[]; ready: boolean; error: string }> {
  const { data, error } = await supabase.from('insurer_label_rules').select(COLUMNS).order('insurer').order('field').limit(5000)
  if (error) return { rules: [], ready: !NEEDS_UPGRADE.test(error.message), error: NEEDS_UPGRADE.test(error.message) ? UPGRADE_NOTE : error.message }
  return { rules: (data as Row[]).map(fromRow), ready: true, error: '' }
}

/** Saves learned places; returns how many were new. */
export async function saveRules(rules: LearnedRule[]): Promise<{ added: number; error: string }> {
  if (!rules.length) return { added: 0, error: '' }
  const { data, error } = await supabase.rpc('teach_insurer', { p_rules: rules })
  if (error) return { added: 0, error: NEEDS_UPGRADE.test(error.message) ? UPGRADE_NOTE : error.message }
  return { added: Number(data ?? 0), error: '' }
}

export async function forgetRules(ids: string[]): Promise<{ removed: number; error: string }> {
  const { data, error } = await supabase.rpc('forget_insurer_rules', { p_ids: ids })
  if (error) return { removed: 0, error: NEEDS_UPGRADE.test(error.message) ? UPGRADE_NOTE : error.message }
  return { removed: Number(data ?? 0), error: '' }
}
