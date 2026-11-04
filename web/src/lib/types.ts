export type Role = 'submitter' | 'approver' | 'content_editor' | 'admin'

export interface Profile {
  id: string
  full_name: string
  email: string
  roles: Role[]
  active: boolean
  created_at: string
}

export type RequestStatus =
  | 'draft' | 'submitted' | 'referred_back' | 'approved' | 'rejected' | 'withdrawn' | 'expired'

export interface PriceRange {
  insurer: string
  product_name: string
  version: number
  rates_as_at: string
  premium_low: number
  premium_high: number
}

export interface PolicyRequest {
  id: string
  ref: string
  submitter_id: string
  status: RequestStatus
  plan_category: string
  product: string
  age_band: string
  gender: string
  smoker: boolean
  coverage_term: string
  sum_assured_band: string
  premium_type: string
  ci_benefit: boolean
  introducer_id: string | null
  attested: boolean
  submitted_at: string | null
  decided_by: string | null
  decided_at: string | null
  decision: string | null
  decision_reason: string | null
  price_snapshot: PriceRange[] | null
  created_at: string
  updated_at: string
}

export interface RequestDocument {
  id: string
  request_id: string
  storage_path: string
  file_name: string
  scan: 'clean' | 'blocked' | 'reported'
  scan_notes: string | null
  hidden: boolean
  uploaded_by: string
  uploaded_at: string
}

export interface Introducer {
  id: string
  name: string
  entity_type: string
  uen_or_ref: string | null
  specialities: string[]
  status: 'active' | 'suspended' | 'terminated'
  date_added: string
  last_active: string | null
  agreement_expiry: string | null
  disclosure_on_file: boolean
  contact_person: string | null
  notes: string | null
}

export interface KbDocument {
  id: string
  title: string
  doc_type: string
  insurer: string | null
  tags: string[]
  description: string | null
  storage_path: string | null
  file_name: string | null
  version: number
  archived: boolean
  updated_at: string
}

export interface RateTable {
  id: string
  insurer: string
  product_name: string
  version: number
  rates_as_at: string
  status: 'pending' | 'approved' | 'retired'
  uploaded_by: string | null
  approved_by: string | null
  uploaded_at: string
}
