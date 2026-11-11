import type { Profile, Role } from './types'
import { ROLE_LABEL } from './options'

/** Columns of the users CSV (export and import). The password column is only read on import, never exported. */
export const USER_CSV_HEADER = ['Name', 'Email', 'Role', 'Firm', 'Active', 'Temporary password']
export const MAX_IMPORT_ROWS = 500
const MIN_PASSWORD = 8

const ROLES = Object.keys(ROLE_LABEL) as Role[]

/** Rows for "Export users": everyone, without passwords (the app never knows them). */
export function usersToCsvRows(people: Profile[]): unknown[][] {
  return [
    ['Name', 'Email', 'Role', 'Firm', 'Active', 'Added on'],
    ...[...people].sort((a, b) => a.email.localeCompare(b.email)).map((p) => [
      p.full_name, p.email, p.role ? ROLE_LABEL[p.role] : '', p.company, p.active ? 'Yes' : 'No', p.created_at.slice(0, 10),
    ]),
  ]
}

/** A blank file to fill in, with one made-up example row. */
export function templateCsvRows(): unknown[][] {
  return [USER_CSV_HEADER, ['Example Person', 'example.person@example.com', 'Introducer', 'Example Firm Pte Ltd', 'Yes', '']]
}

export type ImportAction = 'create' | 'update' | 'same' | 'error'

export interface ImportRow {
  line: number            // line in the file (the header is line 1)
  email: string
  full_name: string
  role: Role | null       // null = keep (existing users only)
  company: string | null  // null = keep
  active: boolean | null  // null = keep (new users default to active)
  password: string        // new users only; '' = make one up
  action: ImportAction
  problems: string[]
  existing?: Profile
  changes: string[]       // what an update changes, in words
}

const HEADER_NAMES: Record<string, keyof typeof COL> = {
  name: 'name', 'full name': 'name', full_name: 'name',
  email: 'email', 'email address': 'email',
  role: 'role',
  firm: 'company', company: 'company', 'firm (introducers)': 'company',
  active: 'active',
  'temporary password': 'password', password: 'password', temporary_password: 'password',
}
const COL = { name: -1, email: -1, role: -1, company: -1, active: -1, password: -1 }

function roleFrom(v: string): Role | undefined {
  const t = v.trim().toLowerCase()
  return ROLES.find((r) => r === t || ROLE_LABEL[r].toLowerCase() === t)
}
function yesNo(v: string): boolean | undefined {
  const t = v.trim().toLowerCase()
  if (['yes', 'y', 'true', '1', 'active'].includes(t)) return true
  if (['no', 'n', 'false', '0', 'inactive'].includes(t)) return false
  return undefined
}
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/**
 * Checks an uploaded users CSV against the current users and works out what each row would do.
 * New email: create a login (name and role needed). Existing email: update name, role, firm and active where the
 * cell is filled in (blank cells keep what is there). Nothing is changed until the admin confirms.
 */
export function planImport(cells: string[][], people: Profile[], myId: string): { rows: ImportRow[]; error?: string } {
  if (!cells.length) return { rows: [], error: 'The file is empty.' }
  const col = { ...COL }
  cells[0].forEach((h, i) => {
    const k = HEADER_NAMES[h.trim().toLowerCase()]
    if (k && col[k] < 0) col[k] = i
  })
  if (col.email < 0) return { rows: [], error: 'The first line must be the column names, with at least an "Email" column. Download the template to see the layout.' }
  const body = cells.slice(1)
  if (!body.length) return { rows: [], error: 'The file has column names but no users.' }
  if (body.length > MAX_IMPORT_ROWS) return { rows: [], error: `At most ${MAX_IMPORT_ROWS} users per file; this one has ${body.length}. Split it into smaller files.` }

  const byEmail = new Map(people.map((p) => [p.email.toLowerCase(), p]))
  const seen = new Map<string, number>()
  const get = (r: string[], i: number) => (i >= 0 ? (r[i] ?? '').trim() : '')

  const rows = body.map((r, n): ImportRow => {
    const line = n + 2
    const email = get(r, col.email).toLowerCase()
    const roleText = get(r, col.role)
    const activeText = get(r, col.active)
    const companyText = get(r, col.company)
    const row: ImportRow = {
      line, email, full_name: get(r, col.name), role: null, company: col.company >= 0 && companyText ? companyText : null,
      active: null, password: col.password >= 0 ? (r[col.password] ?? '') : '', action: 'error', problems: [], changes: [],
    }
    if (!email) row.problems.push('Email is missing')
    else if (!EMAIL.test(email)) row.problems.push('Email is not valid')
    else if (seen.has(email)) row.problems.push(`Same email as line ${seen.get(email)}`)
    if (email) seen.set(email, seen.get(email) ?? line)
    if (roleText) {
      const role = roleFrom(roleText)
      if (role) row.role = role
      else row.problems.push(`Role "${roleText}" is not one of: ${ROLES.map((x) => ROLE_LABEL[x]).join(', ')}`)
    }
    if (activeText) {
      const a = yesNo(activeText)
      if (a === undefined) row.problems.push(`Active should be Yes or No, not "${activeText}"`)
      else row.active = a
    }

    const existing = email ? byEmail.get(email) : undefined
    if (existing) {
      row.existing = existing
      if (row.password.trim()) row.problems.push('Already has an account: leave the password blank (people change their own password under Account)')
      if (existing.id === myId && ((row.role && row.role !== 'admin') || row.active === false)) row.problems.push('You cannot remove your own admin access')
      if (row.full_name && row.full_name !== existing.full_name) row.changes.push(`name to "${row.full_name}"`)
      if (row.role && row.role !== existing.role) row.changes.push(`role to ${ROLE_LABEL[row.role]}`)
      if (row.company !== null && row.company !== existing.company) row.changes.push(`firm to "${row.company}"`)
      if (row.active !== null && row.active !== existing.active) row.changes.push(row.active ? 'reactivate' : 'deactivate')
      if (!row.problems.length) row.action = row.changes.length ? 'update' : 'same'
    } else {
      if (!row.full_name) row.problems.push('Name is missing (needed for a new user)')
      if (!roleText) row.problems.push('Role is missing (needed for a new user)')
      if (row.password && row.password.length < MIN_PASSWORD) row.problems.push(`Temporary password needs at least ${MIN_PASSWORD} characters`)
      if (row.active === false) row.problems.push('A new user cannot start inactive; leave Active blank or Yes')
      if (!row.problems.length) row.action = 'create'
    }
    return row
  })
  return { rows }
}

export function actionLabel(r: ImportRow) {
  if (r.action === 'create') return 'Add new user'
  if (r.action === 'update') return `Update: ${r.changes.join(', ')}`
  if (r.action === 'same') return 'No change'
  return r.problems.join('; ')
}
