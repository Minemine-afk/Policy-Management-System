-- DMS setup for a hosted Supabase project. Paste the whole file into SQL Editor and click Run. Run it once.
-- Generated from supabase/migrations/. Do not edit here; edit the migrations instead.
begin;
-- Distribution Management System: core schema (prototype)
-- Clients are never identified in this database. Documents arrive already redacted.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Users and roles
-- ---------------------------------------------------------------------------
create type app_role as enum ('submitter', 'approver', 'content_editor', 'admin');

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  full_name text not null default '',
  email text not null default '',
  roles app_role[] not null default '{}',
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- New sign-ins (Microsoft Entra in production) get a profile with no roles.
-- An admin assigns roles before the person can do anything.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, coalesce(new.email, ''),
          coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name', ''));
  return new;
end $$;

create trigger on_auth_user_created
after insert on auth.users for each row execute function public.handle_new_user();

-- Accounts that existed before this setup (e.g. a reused project) get a profile too.
insert into public.profiles (id, email, full_name)
select u.id, coalesce(u.email, ''), coalesce(u.raw_user_meta_data ->> 'full_name', u.raw_user_meta_data ->> 'name', '')
from auth.users u
on conflict (id) do nothing;

create or replace function public.has_role(r app_role)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.active and r = any (p.roles)
  );
$$;

create or replace function public.is_active_user()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles p where p.id = auth.uid() and p.active);
$$;

-- ---------------------------------------------------------------------------
-- Audit log (append only)
-- ---------------------------------------------------------------------------
create table public.audit_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  actor_id uuid,
  action text not null,
  entity text not null,
  entity_id text,
  details jsonb not null default '{}'
);

create or replace function public.log_event(p_action text, p_entity text, p_entity_id text, p_details jsonb default '{}')
returns void language sql security definer set search_path = public as $$
  insert into public.audit_log (actor_id, action, entity, entity_id, details)
  values (auth.uid(), p_action, p_entity, p_entity_id, coalesce(p_details, '{}'));
$$;

-- ---------------------------------------------------------------------------
-- Introducers
-- ---------------------------------------------------------------------------
create type introducer_status as enum ('active', 'suspended', 'terminated');

create table public.introducers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  entity_type text not null default 'Company',       -- Company or Individual
  uen_or_ref text,
  specialities text[] not null default '{}',
  status introducer_status not null default 'active',
  date_added date not null default current_date,
  last_active date,
  agreement_expiry date,
  disclosure_on_file boolean not null default false,  -- FAA-N02 disclosure document
  contact_person text,
  notes text,
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Rate tables (indicative premium ranges, uploaded per insurer)
-- ---------------------------------------------------------------------------
create type rate_table_status as enum ('pending', 'approved', 'retired');

create table public.rate_tables (
  id uuid primary key default gen_random_uuid(),
  insurer text not null,
  product_name text not null,
  version int not null,
  rates_as_at date not null,
  status rate_table_status not null default 'pending',
  uploaded_by uuid references public.profiles (id),
  approved_by uuid references public.profiles (id),
  uploaded_at timestamptz not null default now(),
  approved_at timestamptz,
  unique (insurer, version)
);

create table public.rate_rows (
  id bigint generated always as identity primary key,
  rate_table_id uuid not null references public.rate_tables (id) on delete cascade,
  age_band text not null,
  gender text not null,            -- Male / Female
  smoker boolean not null,
  coverage_term text not null,
  sum_assured_band text not null,
  ci_benefit boolean not null,
  premium_low numeric(12, 2) not null,
  premium_high numeric(12, 2) not null,
  check (premium_low <= premium_high)
);
create index on public.rate_rows (rate_table_id, age_band, gender, smoker, coverage_term, sum_assured_band, ci_benefit);

-- ---------------------------------------------------------------------------
-- Policy requests
-- ---------------------------------------------------------------------------
create type request_status as enum
  ('draft', 'submitted', 'referred_back', 'approved', 'rejected', 'withdrawn', 'expired');

create sequence public.request_ref_seq;

create table public.policy_requests (
  id uuid primary key default gen_random_uuid(),
  ref text not null unique default
    ('PR-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('public.request_ref_seq')::text, 6, '0')),
  submitter_id uuid not null default auth.uid() references public.profiles (id),
  status request_status not null default 'draft',
  -- banded risk profile (no identity)
  plan_category text not null default 'All',
  product text not null default 'Term life',
  age_band text not null,
  gender text not null,
  smoker boolean not null,
  coverage_term text not null,
  sum_assured_band text not null,
  premium_type text not null default 'Annual',
  ci_benefit boolean not null default false,
  introducer_id uuid references public.introducers (id),
  -- workflow
  attested boolean not null default false,  -- submitter confirms documents are redacted
  submitted_at timestamptz,
  decided_by uuid references public.profiles (id),
  decided_at timestamptz,
  decision text,
  decision_reason text,
  price_snapshot jsonb,                     -- ranges frozen at submit time
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Optional private case reference, visible to the submitter only.
create table public.request_private_refs (
  request_id uuid primary key references public.policy_requests (id) on delete cascade,
  owner_id uuid not null default auth.uid() references public.profiles (id),
  case_ref text not null
);

create type scan_result as enum ('clean', 'blocked', 'reported');

create table public.request_documents (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.policy_requests (id) on delete cascade,
  storage_path text not null,
  file_name text not null,
  scan scan_result not null default 'clean',
  scan_notes text,
  hidden boolean not null default false,
  uploaded_by uuid not null default auth.uid() references public.profiles (id),
  uploaded_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Knowledge bank (store and look up documents)
-- ---------------------------------------------------------------------------
create table public.kb_documents (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  doc_type text not null,            -- Product, Onboarding, Compliance, Process
  insurer text,
  tags text[] not null default '{}', -- matched against form categories, e.g. 'term', 'ci'
  description text,
  body_text text,                    -- extracted text, used for search
  storage_path text,
  file_name text,
  version int not null default 1,
  archived boolean not null default false,
  uploaded_by uuid references public.profiles (id),
  updated_at timestamptz not null default now(),
  search tsvector generated always as (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(description, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(body_text, '')), 'C')
  ) stored
);
create index kb_search_idx on public.kb_documents using gin (search);
create index kb_tags_idx on public.kb_documents using gin (tags);
-- Access rules. Status changes only happen through the functions below, so the
-- rules (no self-approval, reason required, second admin for rate tables) are
-- enforced by the database, not just the screens.

alter table public.profiles enable row level security;
alter table public.audit_log enable row level security;
alter table public.introducers enable row level security;
alter table public.rate_tables enable row level security;
alter table public.rate_rows enable row level security;
alter table public.policy_requests enable row level security;
alter table public.request_private_refs enable row level security;
alter table public.request_documents enable row level security;
alter table public.kb_documents enable row level security;

-- Profiles: everyone signed in can see names (approvers need "submitted by").
create policy profiles_read on public.profiles for select to authenticated
  using (public.is_active_user() or id = auth.uid());
revoke insert, update, delete on public.profiles from authenticated, anon;

-- Audit log: admins read; nobody writes directly.
create policy audit_read on public.audit_log for select to authenticated using (public.has_role('admin'));
revoke insert, update, delete on public.audit_log from authenticated, anon;

-- Introducers: all active users read; admins maintain.
create policy introducers_read on public.introducers for select to authenticated using (public.is_active_user());
create policy introducers_write on public.introducers for all to authenticated
  using (public.has_role('admin')) with check (public.has_role('admin'));

-- Rate tables: everyone reads approved ones, admins read all and upload.
create policy rate_tables_read on public.rate_tables for select to authenticated
  using (public.is_active_user() and (status = 'approved' or public.has_role('admin')));
create policy rate_tables_insert on public.rate_tables for insert to authenticated
  with check (public.has_role('admin') and status = 'pending' and uploaded_by = auth.uid());
create policy rate_rows_read on public.rate_rows for select to authenticated
  using (exists (select 1 from public.rate_tables t where t.id = rate_table_id
                 and (t.status = 'approved' or public.has_role('admin'))));
create policy rate_rows_insert on public.rate_rows for insert to authenticated
  with check (public.has_role('admin') and exists (
    select 1 from public.rate_tables t where t.id = rate_table_id and t.status = 'pending' and t.uploaded_by = auth.uid()));
revoke update, delete on public.rate_tables, public.rate_rows from authenticated, anon;

-- Policy requests -----------------------------------------------------------
create or replace function public.can_view_request(p_request uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.policy_requests r
    where r.id = p_request and public.is_active_user() and (
      r.submitter_id = auth.uid()
      or public.has_role('admin')
      or (public.has_role('approver') and r.submitter_id <> auth.uid() and r.status <> 'draft')
    )
  );
$$;

-- The submitter check is inline (not only in the function) so a new row can be
-- returned straight after insert.
create policy requests_read on public.policy_requests for select to authenticated
  using ((submitter_id = auth.uid() and public.is_active_user()) or public.can_view_request(id));
create policy requests_insert on public.policy_requests for insert to authenticated
  with check (public.has_role('submitter') and submitter_id = auth.uid() and status = 'draft');
create policy requests_update on public.policy_requests for update to authenticated
  using (submitter_id = auth.uid() and status in ('draft', 'referred_back'))
  with check (submitter_id = auth.uid() and status in ('draft', 'referred_back'));

-- Only the profile fields can be written directly; workflow fields go through functions.
revoke insert, update, delete on public.policy_requests from authenticated, anon;
grant insert (plan_category, product, age_band, gender, smoker, coverage_term, sum_assured_band,
              premium_type, ci_benefit, introducer_id, attested)
  on public.policy_requests to authenticated;
grant update (plan_category, product, age_band, gender, smoker, coverage_term, sum_assured_band,
              premium_type, ci_benefit, introducer_id, attested, updated_at)
  on public.policy_requests to authenticated;
grant usage on sequence public.request_ref_seq to authenticated;

-- Private case reference: owner only.
create policy private_refs_owner on public.request_private_refs for all to authenticated
  using (owner_id = auth.uid()) with check (owner_id = auth.uid() and exists (
    select 1 from public.policy_requests r where r.id = request_id and r.submitter_id = auth.uid()));

-- Documents: visible with the request; hidden (reported) files only to submitter and admin.
create policy docs_read on public.request_documents for select to authenticated
  using (public.can_view_request(request_id) and (
    not hidden or uploaded_by = auth.uid() or public.has_role('admin')));
create policy docs_insert on public.request_documents for insert to authenticated
  with check (uploaded_by = auth.uid() and scan = 'clean' and exists (
    select 1 from public.policy_requests r where r.id = request_id
    and r.submitter_id = auth.uid() and r.status in ('draft', 'referred_back')));
create policy docs_delete on public.request_documents for delete to authenticated
  using (uploaded_by = auth.uid() and exists (
    select 1 from public.policy_requests r where r.id = request_id
    and r.submitter_id = auth.uid() and r.status in ('draft', 'referred_back')));
revoke update on public.request_documents from authenticated, anon;

-- Knowledge bank: everyone reads; content editors and admins write.
create policy kb_read on public.kb_documents for select to authenticated
  using (public.is_active_user() and (not archived or public.has_role('content_editor') or public.has_role('admin')));
create policy kb_write on public.kb_documents for all to authenticated
  using (public.has_role('content_editor') or public.has_role('admin'))
  with check (public.has_role('content_editor') or public.has_role('admin'));

-- ---------------------------------------------------------------------------
-- Indicative prices: latest approved table per insurer, matched on the bands.
-- ---------------------------------------------------------------------------
create or replace function public.indicative_prices(
  p_age_band text, p_gender text, p_smoker boolean, p_coverage_term text,
  p_sum_assured_band text, p_ci boolean)
returns table (insurer text, product_name text, version int, rates_as_at date,
               premium_low numeric, premium_high numeric)
language sql stable security definer set search_path = public as $$
  select t.insurer, t.product_name, t.version, t.rates_as_at, rr.premium_low, rr.premium_high
  from public.rate_tables t
  join public.rate_rows rr on rr.rate_table_id = t.id
  where t.status = 'approved'
    and public.is_active_user()
    and rr.age_band = p_age_band and rr.gender = p_gender and rr.smoker = p_smoker
    and rr.coverage_term = p_coverage_term and rr.sum_assured_band = p_sum_assured_band
    and rr.ci_benefit = p_ci
  order by rr.premium_low;
$$;

-- ---------------------------------------------------------------------------
-- Workflow functions
-- ---------------------------------------------------------------------------
create or replace function public.submit_request(p_request uuid)
returns void language plpgsql security definer set search_path = public as $$
declare r public.policy_requests;
begin
  select * into r from public.policy_requests where id = p_request for update;
  if r.id is null or r.submitter_id <> auth.uid() then raise exception 'Not your request'; end if;
  if not public.has_role('submitter') then raise exception 'You need the Submitter role'; end if;
  if r.status not in ('draft', 'referred_back') then raise exception 'Only drafts or referred-back requests can be submitted'; end if;
  if not r.attested then raise exception 'Confirm that the documents are redacted before submitting'; end if;
  if exists (select 1 from public.request_documents d where d.request_id = r.id and d.scan <> 'clean') then
    raise exception 'Remove the blocked or reported documents first';
  end if;

  update public.policy_requests set
    status = 'submitted', submitted_at = now(), updated_at = now(),
    decided_by = null, decided_at = null, decision = null, decision_reason = null,
    price_snapshot = (select coalesce(jsonb_agg(to_jsonb(p)), '[]') from public.indicative_prices(
      r.age_band, r.gender, r.smoker, r.coverage_term, r.sum_assured_band, r.ci_benefit) p)
  where id = r.id;
  perform public.log_event('request.submitted', 'policy_request', r.ref);
end $$;

create or replace function public.decide_request(p_request uuid, p_decision text, p_reason text default null)
returns void language plpgsql security definer set search_path = public as $$
declare r public.policy_requests; new_status request_status;
begin
  select * into r from public.policy_requests where id = p_request for update;
  if r.id is null then raise exception 'Request not found'; end if;
  if not public.has_role('approver') then raise exception 'You need the Approver role'; end if;
  if r.submitter_id = auth.uid() then raise exception 'You cannot decide on your own request'; end if;
  if r.status <> 'submitted' then raise exception 'This request is not awaiting a decision'; end if;

  new_status := case p_decision
    when 'approve' then 'approved'::request_status
    when 'reject' then 'rejected'::request_status
    when 'refer_back' then 'referred_back'::request_status
    else null end;
  if new_status is null then raise exception 'Unknown decision %', p_decision; end if;
  if p_decision in ('reject', 'refer_back') and coalesce(btrim(p_reason), '') = '' then
    raise exception 'A reason is required to reject or refer back';
  end if;

  update public.policy_requests set
    status = new_status, decided_by = auth.uid(), decided_at = now(), updated_at = now(),
    decision = p_decision, decision_reason = nullif(btrim(p_reason), '')
  where id = r.id;
  perform public.log_event('request.' || p_decision, 'policy_request', r.ref,
                           jsonb_build_object('reason', p_reason));
end $$;

create or replace function public.withdraw_request(p_request uuid)
returns void language plpgsql security definer set search_path = public as $$
declare r public.policy_requests;
begin
  select * into r from public.policy_requests where id = p_request for update;
  if r.id is null or r.submitter_id <> auth.uid() then raise exception 'Not your request'; end if;
  if r.status not in ('draft', 'submitted', 'referred_back') then raise exception 'This request can no longer be withdrawn'; end if;
  update public.policy_requests set status = 'withdrawn', updated_at = now() where id = r.id;
  perform public.log_event('request.withdrawn', 'policy_request', r.ref);
end $$;

-- Requests waiting more than 30 days expire. Run daily (pg_cron in production).
create or replace function public.expire_stale_requests()
returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  update public.policy_requests set status = 'expired', updated_at = now()
  where status in ('submitted', 'referred_back') and coalesce(submitted_at, created_at) < now() - interval '30 days';
  get diagnostics n = row_count;
  return n;
end $$;

-- Approver flags a file that still shows identity: hidden at once, admin sees it in the log.
create or replace function public.report_unredacted(p_document uuid, p_note text default null)
returns void language plpgsql security definer set search_path = public as $$
declare d public.request_documents;
begin
  select * into d from public.request_documents where id = p_document for update;
  if d.id is null or not public.can_view_request(d.request_id) then raise exception 'Document not found'; end if;
  update public.request_documents set hidden = true, scan = 'reported', scan_notes = p_note where id = d.id;
  perform public.log_event('document.reported_unredacted', 'request_document', d.id::text,
                           jsonb_build_object('file', d.file_name, 'note', p_note));
end $$;

create or replace function public.log_document_view(p_document uuid)
returns void language plpgsql security definer set search_path = public as $$
declare d public.request_documents;
begin
  select * into d from public.request_documents where id = p_document;
  if d.id is null or not public.can_view_request(d.request_id) then raise exception 'Document not found'; end if;
  perform public.log_event('document.viewed', 'request_document', d.id::text, jsonb_build_object('file', d.file_name));
end $$;

-- Rate tables need a second admin.
create or replace function public.approve_rate_table(p_table uuid)
returns void language plpgsql security definer set search_path = public as $$
declare t public.rate_tables;
begin
  if not public.has_role('admin') then raise exception 'Admins only'; end if;
  select * into t from public.rate_tables where id = p_table for update;
  if t.id is null or t.status <> 'pending' then raise exception 'Nothing to approve'; end if;
  if t.uploaded_by = auth.uid() then raise exception 'A second admin must approve rate tables you uploaded'; end if;
  update public.rate_tables set status = 'retired' where insurer = t.insurer and status = 'approved';
  update public.rate_tables set status = 'approved', approved_by = auth.uid(), approved_at = now() where id = t.id;
  perform public.log_event('rate_table.approved', 'rate_table', t.id::text,
                           jsonb_build_object('insurer', t.insurer, 'version', t.version));
end $$;

create or replace function public.admin_update_user(p_user uuid, p_roles app_role[], p_active boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.has_role('admin') then raise exception 'Admins only'; end if;
  if p_user = auth.uid() and (not p_active or not ('admin' = any (p_roles))) then
    raise exception 'You cannot remove your own admin access';
  end if;
  update public.profiles set roles = p_roles, active = p_active where id = p_user;
  perform public.log_event('user.updated', 'profile', p_user::text,
                           jsonb_build_object('roles', p_roles, 'active', p_active));
end $$;

revoke execute on function public.expire_stale_requests() from authenticated, anon, public;

-- Audit triggers for direct edits
create or replace function public.audit_row()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public.log_event(lower(tg_op), tg_table_name,
    coalesce((case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end) ->> 'id', ''));
  return null;
end $$;

create trigger audit_introducers after insert or update or delete on public.introducers
  for each row execute function public.audit_row();
create trigger audit_kb after insert or update or delete on public.kb_documents
  for each row execute function public.audit_row();
create trigger audit_rate_tables after insert on public.rate_tables
  for each row execute function public.audit_row();

-- ---------------------------------------------------------------------------
-- File storage (private buckets)
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public) values
  ('request-docs', 'request-docs', false),
  ('kb', 'kb', false)
on conflict (id) do nothing;

-- request-docs path: <request id>/<file name>
create policy "request docs upload" on storage.objects for insert to authenticated
  with check (bucket_id = 'request-docs' and exists (
    select 1 from public.policy_requests r
    where r.id::text = (storage.foldername(name))[1]
      and r.submitter_id = auth.uid() and r.status in ('draft', 'referred_back')));
create policy "request docs read" on storage.objects for select to authenticated
  using (bucket_id = 'request-docs' and exists (
    select 1 from public.request_documents d
    where d.storage_path = name and public.can_view_request(d.request_id)
      and (not d.hidden or d.uploaded_by = auth.uid() or public.has_role('admin'))));
create policy "request docs delete" on storage.objects for delete to authenticated
  using (bucket_id = 'request-docs' and owner = auth.uid());

create policy "kb read" on storage.objects for select to authenticated
  using (bucket_id = 'kb' and public.is_active_user());
create policy "kb write" on storage.objects for insert to authenticated
  with check (bucket_id = 'kb' and (public.has_role('content_editor') or public.has_role('admin')));
commit;
