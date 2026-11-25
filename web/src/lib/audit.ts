import { ROLE_LABEL, STATUS_LABEL, fmtHours } from './options'
import type { AuditRow, Profile } from './types'
import { fmtNum } from './num.ts'

/** Short plain-English names for the audit log's Action filter. */
export const AUDIT_ACTION_LABEL: Record<string, string> = {
  'request.submitted': 'Request submitted (or returned to the pool)',
  'request.edited': 'Request details edited',
  'request.products_added': 'Products added to a request',
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
  'document.pack_saved': 'PI pack saved',
  'insurer.taught': 'PI reader learned places',
  'insurer.forgotten': 'Learned places deleted',
  'settings.updated': 'Deadline settings changed',
  'settings.auto_delete': 'Automatic deletion setting changed',
  'request.auto_deleted': 'Overdue request deleted',
  'user.updated': 'User added or changed',
  'access.user_module': 'Module access changed for a person',
  'access.role_module': 'Module default changed for a role',
  'kb.document_uploaded': 'Knowledge Bank document uploaded',
  'kb.document_changed': 'Knowledge Bank document details changed',
  'kb.document_checked': 'Knowledge Bank document checked',
  'kb.document_removed': 'Knowledge Bank document removed',
  'kb.product_saved': 'Product record draft saved',
  'kb.product_sent_for_check': 'Product record sent for check',
  'kb.product_checked': 'Product record checked',
  'kb.product_sent_back': 'Product record sent back',
  'kb.product_discarded': 'Product record draft discarded',
  'kb.product_withdrawn': 'Product withdrawn from Compare products',
}

export const auditActionLabel = (action: string) => AUDIT_ACTION_LABEL[action] ?? action.replace(/[._]/g, ' ')

const yesNo = (v: unknown) => (v ? 'yes' : 'no')
const withReason = (s: string, reason: unknown) => (reason ? `${s}. Reason: “${reason}”` : s)

/** One audit entry as a plain-English sentence, e.g. "Assigned request PI-00001 to Omar Ops". */
export function describeAudit(r: AuditRow, people: Record<string, Profile>): string {
  const s = describe(r, people)
  // When a long-overdue request is deleted, free text (reasons, file names) is taken out of its earlier entries.
  return r.entity === 'pi_request' && (r.details as Record<string, unknown> | null)?.details_removed
    ? `${s} (reason removed when the request was deleted)` : s
}

function describe(r: AuditRow, people: Record<string, Profile>): string {
  const d = (r.details ?? {}) as Record<string, unknown>
  const req = r.entity_id ? `request ${r.entity_id}` : 'a request'
  const person = (id: unknown) => {
    const p = typeof id === 'string' ? people[id] : undefined
    return p ? p.full_name || p.email : 'someone'
  }
  const kbName = String(d.product ?? d.title ?? 'a Knowledge Bank item')
  switch (r.action) {
    case 'kb.document_uploaded': return d.replaces ? `Uploaded a new version of “${d.title}” (${d.insurer})` : `Uploaded “${d.title}” (${d.insurer}) to the Knowledge Bank`
    case 'kb.document_changed': return `Changed the details of “${kbName}”`
    case 'kb.document_checked': return `Checked the document “${kbName}”`
    case 'kb.document_removed': return `Removed the document “${kbName}”`
    case 'kb.product_saved': return `Saved a draft of the product record ${kbName}`
    case 'kb.product_sent_for_check': return `Sent the product record ${kbName} for check`
    case 'kb.product_checked': return `Checked the product record ${kbName}${d.version ? ` (version ${d.version})` : ''}`
    case 'kb.product_sent_back': return withReason(`Sent the product record ${kbName} back`, d.reason)
    case 'kb.product_discarded': return d.deleted ? `Deleted the draft product record ${kbName}` : `Discarded the draft changes to ${kbName}`
    case 'kb.product_withdrawn': return withReason(`Withdrew ${kbName} from Compare products`, d.reason)
    case 'request.submitted':
      // The same action is logged when ops hand a request back to the unassigned pool (that one carries a reason key).
      return 'reason' in d ? withReason(`Returned ${req} to the unassigned pool`, d.reason) : `Submitted a new ${req}`
    case 'request.edited': return `Edited the details of ${req}`
    case 'request.products_added': return `Added ${Array.isArray(d.products) ? (d.products as string[]).join(', ') : 'products'} to ${req} from the Product Comparison Matrix`
    case 'request.resubmitted': return `Resubmitted ${req} after correcting it`
    case 'request.claimed': return `Picked up ${req} from the unassigned pool`
    case 'request.assigned': return d.to ? `Assigned ${req} to ${person(d.to)}` : `Assigned ${req}`
    case 'request.in_progress': return `Started work on ${req}`
    case 'request.sent_back': return withReason(`Sent ${req} back to the introducer`, d.reason)
    case 'request.completed': return `Marked ${req} as completed`
    case 'request.removed': return withReason(`Removed ${req}`, d.reason)
    case 'request.reopened': return withReason(`Reopened ${req}`, d.reason)
    case 'request.priority': return d.priority === 'urgent' ? `Marked ${req} as urgent` : `Removed the urgent flag from ${req}`
    case 'document.viewed':
      return d.request ? `Opened a document of request ${d.request} (file name removed when the request was deleted)` : `Opened the document “${d.file ?? 'a file'}”`
    case 'document.pack_saved': return `Saved the PI pack ${d.request ? `of request ${d.request}` : `“${d.file ?? 'a file'}”`} (${d.pis == null ? '?' : fmtNum(Number(d.pis))} PIs, fingerprint ${String(d.sha256 ?? '').slice(0, 12)}…)`
    case 'insurer.taught': return `Taught the PI reader ${d.places == null ? '?' : fmtNum(Number(d.places))} new ${Number(d.places) === 1 ? 'place' : 'places'} for ${r.entity_id ?? 'an insurer'} (label words only)`
    case 'insurer.forgotten': return `Deleted ${d.places == null ? '?' : fmtNum(Number(d.places))} learned ${Number(d.places) === 1 ? 'place' : 'places'} for ${r.entity_id ?? 'an insurer'}`
    case 'settings.updated':
      return `Changed the deadline settings: due ${fmtHours(Number(d.deadline_hours))} after submission, ` +
        `“due soon” ${fmtHours(Number(d.due_soon_hours))} before, pause the clock while sent back: ${yesNo(d.pause_when_sent_back)}`
    case 'settings.auto_delete':
      return d.auto_delete_on
        ? `Switched automatic deletion on: open requests overdue for more than ${fmtNum(Number(d.auto_delete_days))} days are deleted`
        : `Switched automatic deletion off (setting kept: ${fmtNum(Number(d.auto_delete_days))} days)`
    case 'request.auto_deleted': {
      const status = STATUS_LABEL[String(d.status)] ?? String(d.status ?? '')
      const files = Number(d.files ?? 0)
      return `Deleted ${req} for good${r.actor_id ? ' (Delete now)' : ' automatically'}: open (“${status}”) and ` +
        `${fmtNum(Number(d.days_overdue))} days overdue, more than the ${fmtNum(Number(d.after_days))} days allowed. Its client details, comments, history and ` +
        `${files === 1 ? '1 file' : `${fmtNum(files)} files`} were deleted`
    }
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
