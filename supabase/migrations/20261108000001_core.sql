-- PI request tracker: core schema (prototype)
-- Introducers submit policy illustration (PI) requests, ops prepare PIs outside the
-- portal and upload them back, bsd (admin) oversees and reassigns.
-- Client identity is stored in request_clients, readable by the submitting introducer only.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Users and roles (one role per account; "bsd" is a temporary name)
-- ---------------------------------------------------------------------------
create type app_role as enum ('introducer', 'ops', 'bsd');

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  full_name text not null default '',
  email text not null default '',
  company text not null default '',           -- introducer's firm, shown to ops and bsd
  role app_role,                              -- null until bsd assigns one
  active boolean not null default true,
  created_at timestamptz not null default now()
);

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

insert into public.profiles (id, email, full_name)
select u.id, coalesce(u.email, ''), coalesce(u.raw_user_meta_data ->> 'full_name', u.raw_user_meta_data ->> 'name', '')
from auth.users u
on conflict (id) do nothing;

create or replace function public.has_role(r app_role)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles p where p.id = auth.uid() and p.active and p.role = r);
$$;

create or replace function public.is_active_user()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles p where p.id = auth.uid() and p.active and p.role is not null);
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
-- PI requests
-- ---------------------------------------------------------------------------
create type request_status as enum
  ('submitted', 'assigned', 'in_progress', 'sent_back', 'completed', 'removed');

create sequence public.request_ref_seq;

create table public.pi_requests (
  id uuid primary key default gen_random_uuid(),
  ref text not null unique default ('PI-' || lpad(nextval('public.request_ref_seq')::text, 5, '0')),
  introducer_id uuid not null default auth.uid() references public.profiles (id),
  status request_status not null default 'submitted',
  assignee_id uuid references public.profiles (id),
  -- the same form fields as the first design (no identity)
  plan_category text not null default 'All',
  product text not null default 'Term life',
  age_band text not null,
  gender text not null,
  smoker boolean not null,
  coverage_term text not null,
  sum_assured_band text not null,
  premium_type text not null default 'Annual',
  ci_benefit boolean not null default false,
  remarks text,
  -- workflow
  status_reason text,                         -- why it was sent back or removed
  submitted_at timestamptz not null default now(),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on public.pi_requests (status);
create index on public.pi_requests (assignee_id);
create index on public.pi_requests (introducer_id);

-- Real client details: only the introducer who submitted the request can read them.
create table public.request_clients (
  request_id uuid primary key references public.pi_requests (id) on delete cascade,
  owner_id uuid not null default auth.uid() references public.profiles (id),
  client_name text not null,
  nric text,
  contact text
);

create table public.request_comments (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.pi_requests (id) on delete cascade,
  author_id uuid not null default auth.uid() references public.profiles (id),
  body text not null check (length(btrim(body)) > 0),
  internal boolean not null default false,    -- internal = ops and bsd only
  created_at timestamptz not null default now()
);
create index on public.request_comments (request_id, created_at);

create table public.request_events (
  id bigint generated always as identity primary key,
  request_id uuid not null references public.pi_requests (id) on delete cascade,
  actor_id uuid default auth.uid() references public.profiles (id),
  kind text not null,                         -- submitted, assigned, started, sent_back, resubmitted, completed, removed ...
  from_status request_status,
  to_status request_status,
  detail text,
  introducer_visible boolean not null default true,
  at timestamptz not null default now()
);
create index on public.request_events (request_id, at);

create type document_kind as enum ('attachment', 'pi_output');

create table public.request_documents (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.pi_requests (id) on delete cascade,
  kind document_kind not null,
  storage_path text not null,
  file_name text not null,
  uploaded_by uuid not null default auth.uid() references public.profiles (id),
  uploaded_at timestamptz not null default now()
);
create index on public.request_documents (request_id);
