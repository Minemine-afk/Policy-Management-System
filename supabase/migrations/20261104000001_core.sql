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
