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
  plan_category: string
  product: string
  age_band: string
  date_of_birth?: string | null   // YYYY-MM-DD; requests before 19 Nov 2026 have only the age band
  gender: string
  smoker: boolean
  coverage_term: string
  sum_assured_band: string
  premium_type: string
  ci_benefit: boolean
  remarks: string | null
  // PI request form from 23 Nov 2026 (deck wireframe 2). Older requests have these empty.
  client_type?: string | null
  residency?: string | null
  nationality?: string | null
  insurer?: string | null
  plan_name?: string | null
  plan_kb_id?: string | null      // set when the product was picked from the Knowledge Bank
  currency?: string | null
  amount_basis?: 'sum_assured' | 'premium' | null
  amount?: number | string | null
  compare_term?: boolean | null
  compare_product_1?: string | null
  compare_kb_1?: string | null
  compare_product_2?: string | null
  compare_kb_2?: string | null
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
  // PI pack (1j-upgrade.sql): the one PDF the introducer gets, with the comparison and the PIs it was made from.
  is_pack?: boolean
  sha256?: string | null
  pack_of?: string[] | null
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
