// Supabase side of "teach a new insurer" (piTeach.ts does the reading and learning, in the browser).
import { supabase } from './supabase'
import type { LearnedRule } from './piTeach'

export interface SavedRule extends LearnedRule { id: string; created_at: string }

const COLUMNS = 'id, insurer, field, how, label, label_offset, factor, cut, plan, created_at'
const COLUMNS_2 = COLUMNS + ', row_at, corrects'
const NEEDS_UPGRADE = /insurer_label_rules|teach_insurer|forget_insurer_rules|schema cache|does not exist/i
export const UPGRADE_NOTE = 'The database needs an update first: run supabase/cloud/1m-upgrade.sql in Supabase.'

type Row = Omit<SavedRule, 'offset' | 'row'> & { label_offset: number; row_at?: string }
const fromRow = ({ label_offset, row_at, ...r }: Row): SavedRule => ({ ...r, offset: label_offset, factor: Number(r.factor), row: (row_at ?? '') as SavedRule['row'], corrects: !!r.corrects })

/** False until supabase/cloud/1n-upgrade.sql is run: table rows and corrections are then not saved (everything else is). */
let tableRows = true

/** Every learned place. `ready` is false when the table is not there yet (1m-upgrade.sql not run). */
export async function loadRules(): Promise<{ rules: SavedRule[]; ready: boolean; error: string }> {
  const read = (cols: string) => supabase.from('insurer_label_rules').select(cols).order('insurer').order('field').limit(5000)
  let { data, error } = await read(COLUMNS_2)
  tableRows = !error
  // Before 1n-upgrade.sql: the two newer columns are missing, so read without them.
  if (error && /row_at|corrects/i.test(error.message)) ({ data, error } = await read(COLUMNS))
  if (error) return { rules: [], ready: !NEEDS_UPGRADE.test(error.message), error: NEEDS_UPGRADE.test(error.message) ? UPGRADE_NOTE : error.message }
  return { rules: (data as unknown as Row[]).map(fromRow), ready: true, error: '' }
}

/** Saves learned places; returns how many were new. */
export async function saveRules(all: LearnedRule[]): Promise<{ added: number; error: string }> {
  // Before 1n-upgrade.sql the database refuses table-row places and does not keep corrections: send the rest.
  const rules = tableRows ? all : all.filter((r) => r.how !== 'row').map(({ corrects: _c, row: _r, ...r }) => r)
  if (!rules.length) return { added: 0, error: '' }
  let { data, error } = await supabase.rpc('teach_insurer', { p_rules: rules })
  // Before 1o-upgrade.sql the database refuses remembered NAs: save the rest.
  if (error && /how_check|field_check/i.test(error.message) && rules.some((r) => r.how === 'na')) {
    const rest = rules.filter((r) => r.how !== 'na')
    ;({ data, error } = rest.length ? await supabase.rpc('teach_insurer', { p_rules: rest }) : { data: 0, error: null })
  }
  if (error) return { added: 0, error: NEEDS_UPGRADE.test(error.message) ? UPGRADE_NOTE : error.message }
  return { added: Number(data ?? 0), error: '' }
}

export async function forgetRules(ids: string[]): Promise<{ removed: number; error: string }> {
  const { data, error } = await supabase.rpc('forget_insurer_rules', { p_ids: ids })
  if (error) return { removed: 0, error: NEEDS_UPGRADE.test(error.message) ? UPGRADE_NOTE : error.message }
  return { removed: Number(data ?? 0), error: '' }
}
