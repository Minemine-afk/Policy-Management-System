import { ROLE_LABEL, STATUS_LABEL, fmtHours } from './options'
import type { AuditRow, Profile } from './types'

/** Short plain-English names for the audit log's Action filter. */
export const AUDIT_ACTION_LABEL: Record<string, string> = {
  'request.submitted': 'Request submitted (or returned to the pool)',
  'request.edited': 'Request details edited',
  'request.resubmitted': 'Request resubmitted',
  'request.claimed': 'Request picked up by ops',
  'request.assigned': 'Request assigned',
  'request.in_progress': 'Work started',
  'request.sent_back': 'Request sent back',
  'request.completed': 'Request completed',
  'request.removed': 'Request removed',
  'request.reopened': 'Request reopened',
  'request.priority': 'Priority changed',
  'document.viewed': 'Document opened',
  'settings.updated': 'Deadline settings changed',
  'user.updated': 'User added or changed',
  'access.user_module': 'Module access changed for a person',
  'access.role_module': 'Module default changed for a role',
}

export const auditActionLabel = (action: string) => AUDIT_ACTION_LABEL[action] ?? action.replace(/[._]/g, ' ')

const yesNo = (v: unknown) => (v ? 'yes' : 'no')
const withReason = (s: string, reason: unknown) => (reason ? `${s}. Reason: “${reason}”` : s)

/** One audit entry as a plain-English sentence, e.g. "Assigned request PI-00001 to Omar Ops". */
export function describeAudit(r: AuditRow, people: Record<string, Profile>): string {
  const d = (r.details ?? {}) as Record<string, unknown>
  const req = r.entity_id ? `request ${r.entity_id}` : 'a request'
  const person = (id: unknown) => {
    const p = typeof id === 'string' ? people[id] : undefined
    return p ? p.full_name || p.email : 'someone'
  }
  switch (r.action) {
    case 'request.submitted':
      // The same action is logged when ops hand a request back to the unassigned pool (that one carries a reason key).
      return 'reason' in d ? withReason(`Returned ${req} to the unassigned pool`, d.reason) : `Submitted a new ${req}`
    case 'request.edited': return `Edited the details of ${req}`
    case 'request.resubmitted': return `Resubmitted ${req} after correcting it`
    case 'request.claimed': return `Picked up ${req} from the unassigned pool`
    case 'request.assigned': return d.to ? `Assigned ${req} to ${person(d.to)}` : `Assigned ${req}`
    case 'request.in_progress': return `Started work on ${req}`
    case 'request.sent_back': return withReason(`Sent ${req} back to the introducer`, d.reason)
    case 'request.completed': return `Marked ${req} as completed`
    case 'request.removed': return withReason(`Removed ${req}`, d.reason)
    case 'request.reopened': return withReason(`Reopened ${req}`, d.reason)
    case 'request.priority': return d.priority === 'urgent' ? `Marked ${req} as urgent` : `Removed the urgent flag from ${req}`
    case 'document.viewed': return `Opened the document “${d.file ?? 'a file'}”`
    case 'settings.updated':
      return `Changed the deadline settings: due ${fmtHours(Number(d.deadline_hours))} after submission, ` +
        `“due soon” ${fmtHours(Number(d.due_soon_hours))} before, pause the clock while sent back: ${yesNo(d.pause_when_sent_back)}`
    case 'user.updated': {
      const role = d.role ? ROLE_LABEL[String(d.role)] ?? String(d.role) : 'no role'
      return `Saved the account of ${person(r.entity_id)}: role ${role}, ${d.active === false ? 'deactivated' : 'active'}`
    }
  }
  if (r.action === 'access.user_module') {
    const what = d.setting === 'default' ? 'set back to the role default' : `switched ${d.setting}`
    return `${d.module_name ?? d.module} ${what} for ${person(r.entity_id)}`
  }
  if (r.action === 'access.role_module') {
    const role = ROLE_LABEL[String(d.role)] ?? String(d.role)
    return `${d.module_name ?? d.module} switched ${d.setting} by default for the ${role} role`
  }
  if (r.action.startsWith('request.')) {
    const status = STATUS_LABEL[r.action.slice(8)] ?? r.action.slice(8).replace(/_/g, ' ')
    return withReason(`Changed ${req} to “${status}”`, d.reason)
  }
  const extra = Object.entries(d).filter(([, v]) => v !== null && v !== '').map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v}`).join(', ')
  return auditActionLabel(r.action) + (r.entity_id ? ` (${r.entity_id})` : '') + (extra ? `: ${extra}` : '')
}
