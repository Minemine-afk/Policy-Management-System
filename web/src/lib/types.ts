export type Role = 'introducer' | 'ops' | 'bsd' | 'admin'

export interface Profile {
  id: string
  full_name: string
  email: string
  company: string
  role: Role | null
  active: boolean
  email_alerts: boolean
  created_at: string
}

export type RequestStatus = 'submitted' | 'assigned' | 'in_progress' | 'sent_back' | 'completed' | 'removed'

export interface PiRequest {
  id: string
  ref: string
  introducer_id: string
  status: RequestStatus
  assignee_id: string | null
  gender: string
  client_type: string | null
  residency: string | null
  nationality: string | null
  date_of_birth: string | null      // YYYY-MM-DD; empty on requests made with the earlier form
  insurer: string | null
  product: string                   // the plan, e.g. "Singlife Elite Term II"
  currency: string
  amount_basis: 'sum_assured' | 'premium'
  amount: number | null
  smoker: boolean
  policy_term: string | null
  premium_term: string | null
  premium_type: string              // payment frequency
  riders: string[]
  compare_term: boolean
  compare_product_1: string | null
  compare_product_2: string | null
  remarks: string | null
  status_reason: string | null
  // Ops and bsd only: the database returns null for introducers (they never see priority or deadlines).
  priority: 'normal' | 'urgent' | null
  urgent_auto: boolean | null   // true = urgent because it is overdue (set automatically)
  due_at: string | null
  paused_at: string | null
  submitted_at: string
  completed_at: string | null
  created_at: string
  updated_at: string
}

export interface RequestClient {
  request_id: string
  client_name: string
  contact: string | null
}

export interface RequestComment {
  id: string
  request_id: string
  author_id: string
  body: string
  internal: boolean
  created_at: string
}

export interface RequestEvent {
  id: number
  request_id: string
  actor_id: string | null
  kind: string
  from_status: RequestStatus | null
  to_status: RequestStatus | null
  detail: string | null
  at: string
}

export interface RequestDocument {
  id: string
  request_id: string
  kind: 'attachment' | 'pi_output'
  storage_path: string
  file_name: string
  uploaded_by: string
  uploaded_at: string
}

export interface AuditRow {
  id: number
  at: string
  actor_id: string | null
  action: string
  entity: string
  entity_id: string | null
  details: Record<string, unknown>
}

export interface AppSettings {
  deadline_hours: number
  due_soon_hours: number
  pause_when_sent_back: boolean
}

export interface SavedFilter {
  id: string
  name: string
  filters: Record<string, string>
}
