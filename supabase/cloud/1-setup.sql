-- PI tracker setup for a hosted Supabase project. Paste the whole file into SQL Editor and click Run. Run it once.
-- Generated from supabase/migrations/. Do not edit here; edit the migrations instead.
begin;
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

-- Access rules. Requests change only through the functions below, so the rules
-- (who may move a request, reasons required, client details private) are enforced
-- by the database, not just the screens.

alter table public.profiles enable row level security;
alter table public.audit_log enable row level security;
alter table public.pi_requests enable row level security;
alter table public.request_clients enable row level security;
alter table public.request_comments enable row level security;
alter table public.request_events enable row level security;
alter table public.request_documents enable row level security;

-- Profiles: you see yourself; ops and bsd see everyone; introducers see only ops and bsd names.
create policy profiles_read on public.profiles for select to authenticated
  using (id = auth.uid() or public.has_role('bsd') or public.has_role('ops')
         or (public.is_active_user() and role in ('ops', 'bsd')));
revoke insert, update, delete on public.profiles from authenticated, anon;

create policy audit_read on public.audit_log for select to authenticated using (public.has_role('bsd'));
revoke insert, update, delete on public.audit_log from authenticated, anon;

-- Who can open a request.
create or replace function public.can_view_request(p_request uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.pi_requests r
    where r.id = p_request and public.is_active_user() and (
      (r.introducer_id = auth.uid() and public.has_role('introducer'))
      or public.has_role('bsd')
      or (public.has_role('ops') and (r.assignee_id = auth.uid() or (r.assignee_id is null and r.status = 'submitted')))
    )
  );
$$;

create policy requests_read on public.pi_requests for select to authenticated
  using (public.can_view_request(id));
revoke insert, update, delete on public.pi_requests from authenticated, anon;

-- Client details: the submitting introducer only (not even bsd).
create policy clients_owner on public.request_clients for select to authenticated
  using (owner_id = auth.uid() and public.has_role('introducer'));
revoke insert, update, delete on public.request_clients from authenticated, anon;

-- Comments: internal ones never reach introducers.
create policy comments_read on public.request_comments for select to authenticated
  using (public.can_view_request(request_id) and (not internal or not public.has_role('introducer')));
revoke insert, update, delete on public.request_comments from authenticated, anon;

create policy events_read on public.request_events for select to authenticated
  using (public.can_view_request(request_id) and (introducer_visible or not public.has_role('introducer')));
revoke insert, update, delete on public.request_events from authenticated, anon;

-- Documents: introducers see their own attachments, and finished PIs once the request is completed.
create policy docs_read on public.request_documents for select to authenticated
  using (public.can_view_request(request_id) and (
    not public.has_role('introducer') or kind = 'attachment'
    or exists (select 1 from public.pi_requests r where r.id = request_id and r.status = 'completed')));
revoke insert, update, delete on public.request_documents from authenticated, anon;

-- ---------------------------------------------------------------------------
-- Helpers (not callable from the browser)
-- ---------------------------------------------------------------------------
create or replace function public.add_event(p_request uuid, p_kind text, p_from request_status,
                                            p_to request_status, p_detail text default null, p_visible boolean default true)
returns void language sql security definer set search_path = public as $$
  insert into public.request_events (request_id, actor_id, kind, from_status, to_status, detail, introducer_visible)
  values (p_request, auth.uid(), p_kind, p_from, p_to, nullif(btrim(p_detail), ''), p_visible);
$$;
revoke execute on function public.add_event(uuid, text, request_status, request_status, text, boolean) from public, anon, authenticated;

create or replace function public.check_fields(p jsonb)
returns void language plpgsql immutable as $$
begin
  if coalesce(p ->> 'age_band', '') = '' or coalesce(p ->> 'gender', '') = ''
     or coalesce(p ->> 'coverage_term', '') = '' or coalesce(p ->> 'sum_assured_band', '') = ''
     or (p -> 'smoker') is null then
    raise exception 'Fill in age band, gender, smoker status, coverage term and sum assured';
  end if;
end $$;
revoke execute on function public.check_fields(jsonb) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Introducer actions
-- ---------------------------------------------------------------------------
create or replace function public.create_request(p jsonb, p_client jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare rid uuid; rref text;
begin
  if not public.has_role('introducer') then raise exception 'Only introducers can submit requests'; end if;
  perform public.check_fields(p);
  if coalesce(btrim(p_client ->> 'client_name'), '') = '' then raise exception 'Enter the client name'; end if;
  insert into public.pi_requests (introducer_id, plan_category, product, age_band, gender, smoker,
      coverage_term, sum_assured_band, premium_type, ci_benefit, remarks)
  values (auth.uid(), coalesce(p ->> 'plan_category', 'All'), coalesce(p ->> 'product', 'Term life'),
      p ->> 'age_band', p ->> 'gender', (p ->> 'smoker')::boolean, p ->> 'coverage_term', p ->> 'sum_assured_band',
      coalesce(p ->> 'premium_type', 'Annual'), coalesce((p ->> 'ci_benefit')::boolean, false), nullif(btrim(p ->> 'remarks'), ''))
  returning id, ref into rid, rref;
  insert into public.request_clients (request_id, owner_id, client_name, nric, contact)
  values (rid, auth.uid(), btrim(p_client ->> 'client_name'), nullif(btrim(p_client ->> 'nric'), ''), nullif(btrim(p_client ->> 'contact'), ''));
  perform public.add_event(rid, 'submitted', null, 'submitted');
  perform public.log_event('request.submitted', 'pi_request', rref);
  return rid;
end $$;

create or replace function public.update_request(p_request uuid, p jsonb, p_client jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare r public.pi_requests;
begin
  select * into r from public.pi_requests where id = p_request for update;
  if r.id is null or r.introducer_id <> auth.uid() or not public.has_role('introducer') then raise exception 'Not your request'; end if;
  if r.status not in ('submitted', 'sent_back') then raise exception 'This request can no longer be edited'; end if;
  perform public.check_fields(p);
  update public.pi_requests set
    plan_category = coalesce(p ->> 'plan_category', plan_category), age_band = p ->> 'age_band', gender = p ->> 'gender',
    smoker = (p ->> 'smoker')::boolean, coverage_term = p ->> 'coverage_term', sum_assured_band = p ->> 'sum_assured_band',
    premium_type = coalesce(p ->> 'premium_type', premium_type), ci_benefit = coalesce((p ->> 'ci_benefit')::boolean, false),
    remarks = nullif(btrim(p ->> 'remarks'), ''), updated_at = now()
  where id = r.id;
  if p_client is not null then
    if coalesce(btrim(p_client ->> 'client_name'), '') = '' then raise exception 'Enter the client name'; end if;
    update public.request_clients set client_name = btrim(p_client ->> 'client_name'),
      nric = nullif(btrim(p_client ->> 'nric'), ''), contact = nullif(btrim(p_client ->> 'contact'), '')
    where request_id = r.id;
  end if;
  perform public.add_event(r.id, 'edited', r.status, r.status);
  perform public.log_event('request.edited', 'pi_request', r.ref);
end $$;

create or replace function public.resubmit_request(p_request uuid, p_note text default null)
returns void language plpgsql security definer set search_path = public as $$
declare r public.pi_requests; nxt request_status;
begin
  select * into r from public.pi_requests where id = p_request for update;
  if r.id is null or r.introducer_id <> auth.uid() or not public.has_role('introducer') then raise exception 'Not your request'; end if;
  if r.status <> 'sent_back' then raise exception 'Only a request that was sent back can be resubmitted'; end if;
  nxt := case when r.assignee_id is null then 'submitted' else 'in_progress' end;
  update public.pi_requests set status = nxt, status_reason = null, updated_at = now() where id = r.id;
  if coalesce(btrim(p_note), '') <> '' then
    insert into public.request_comments (request_id, author_id, body, internal) values (r.id, auth.uid(), btrim(p_note), false);
  end if;
  perform public.add_event(r.id, 'resubmitted', r.status, nxt, p_note);
  perform public.log_event('request.resubmitted', 'pi_request', r.ref);
end $$;

-- ---------------------------------------------------------------------------
-- Ops and bsd actions
-- ---------------------------------------------------------------------------
create or replace function public.claim_request(p_request uuid)
returns void language plpgsql security definer set search_path = public as $$
declare r public.pi_requests;
begin
  select * into r from public.pi_requests where id = p_request for update;
  if not public.has_role('ops') then raise exception 'Ops only'; end if;
  if r.id is null or r.status <> 'submitted' or r.assignee_id is not null then raise exception 'This request is not in the unassigned pool'; end if;
  update public.pi_requests set status = 'assigned', assignee_id = auth.uid(), updated_at = now() where id = r.id;
  perform public.add_event(r.id, 'assigned', r.status, 'assigned', 'Picked up');
  perform public.log_event('request.claimed', 'pi_request', r.ref);
end $$;

create or replace function public.assign_request(p_request uuid, p_user uuid)
returns void language plpgsql security definer set search_path = public as $$
declare r public.pi_requests; nxt request_status; who text;
begin
  select * into r from public.pi_requests where id = p_request for update;
  if not public.has_role('bsd') then raise exception 'Only bsd can assign requests'; end if;
  if r.id is null then raise exception 'Request not found'; end if;
  if r.status in ('completed', 'removed') then raise exception 'A % request cannot be reassigned', r.status; end if;
  select full_name into who from public.profiles where id = p_user and role = 'ops' and active;
  if not found then raise exception 'Choose an active ops user'; end if;
  nxt := case when r.status = 'submitted' then 'assigned' else r.status end;
  update public.pi_requests set assignee_id = p_user, status = nxt, updated_at = now() where id = r.id;
  perform public.add_event(r.id, case when r.assignee_id is null then 'assigned' else 'reassigned' end,
                           r.status, nxt, 'To ' || who, r.assignee_id is null);
  perform public.log_event('request.assigned', 'pi_request', r.ref, jsonb_build_object('to', p_user));
end $$;

create or replace function public.change_status(p_request uuid, p_to request_status, p_reason text default null)
returns void language plpgsql security definer set search_path = public as $$
declare r public.pi_requests; ok boolean := false; is_bsd boolean := public.has_role('bsd');
begin
  select * into r from public.pi_requests where id = p_request for update;
  if r.id is null then raise exception 'Request not found'; end if;
  if not (is_bsd or (public.has_role('ops') and r.assignee_id = auth.uid())) then
    raise exception 'Only the assigned ops user or bsd can change the status';
  end if;
  if r.status = 'removed' then raise exception 'A removed request cannot be changed'; end if;
  if p_to in ('assigned', 'removed') then raise exception 'Use assign or remove for that'; end if;

  if is_bsd then
    ok := p_to <> r.status and (p_to = 'submitted' or r.assignee_id is not null);
  else
    ok := (r.status = 'assigned' and p_to in ('in_progress', 'sent_back'))
       or (r.status = 'in_progress' and p_to in ('sent_back', 'completed'));
  end if;
  if not ok then raise exception 'You cannot move this request from % to %', r.status, p_to; end if;
  if p_to = 'sent_back' and coalesce(btrim(p_reason), '') = '' then raise exception 'A reason is required to send a request back'; end if;
  if p_to = 'completed' and not exists (select 1 from public.request_documents d where d.request_id = r.id and d.kind = 'pi_output') then
    raise exception 'Upload at least one PI document before completing';
  end if;

  update public.pi_requests set
    status = p_to, updated_at = now(),
    assignee_id = case when p_to = 'submitted' then null else assignee_id end,
    status_reason = case when p_to = 'sent_back' then btrim(p_reason) else null end,
    completed_at = case when p_to = 'completed' then now() else null end
  where id = r.id;
  perform public.add_event(r.id, case p_to when 'in_progress' then 'started' when 'sent_back' then 'sent_back'
                           when 'completed' then 'completed' else 'status_changed' end, r.status, p_to, p_reason);
  perform public.log_event('request.' || p_to, 'pi_request', r.ref, jsonb_build_object('reason', p_reason));
end $$;

create or replace function public.remove_request(p_request uuid, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare r public.pi_requests;
begin
  select * into r from public.pi_requests where id = p_request for update;
  if not public.has_role('bsd') then raise exception 'Only bsd can remove requests'; end if;
  if r.id is null or r.status = 'removed' then raise exception 'Request not found'; end if;
  if coalesce(btrim(p_reason), '') = '' then raise exception 'A reason is required to remove a request'; end if;
  update public.pi_requests set status = 'removed', status_reason = btrim(p_reason), updated_at = now() where id = r.id;
  perform public.add_event(r.id, 'removed', r.status, 'removed', p_reason);
  perform public.log_event('request.removed', 'pi_request', r.ref, jsonb_build_object('reason', p_reason));
end $$;

-- ---------------------------------------------------------------------------
-- Comments and documents
-- ---------------------------------------------------------------------------
create or replace function public.add_comment(p_request uuid, p_body text, p_internal boolean default false)
returns void language plpgsql security definer set search_path = public as $$
declare r public.pi_requests;
begin
  select * into r from public.pi_requests where id = p_request;
  if r.id is null or not public.can_view_request(p_request) then raise exception 'Request not found'; end if;
  if r.status = 'removed' then raise exception 'This request was removed'; end if;
  if p_internal and public.has_role('introducer') then raise exception 'Introducers cannot write internal notes'; end if;
  if coalesce(btrim(p_body), '') = '' then raise exception 'Write a comment first'; end if;
  insert into public.request_comments (request_id, author_id, body, internal) values (p_request, auth.uid(), btrim(p_body), p_internal);
end $$;

create or replace function public.can_upload(p_request uuid, p_kind document_kind)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.pi_requests r
    where r.id = p_request and public.is_active_user() and (
      (p_kind = 'attachment' and r.introducer_id = auth.uid() and public.has_role('introducer')
        and r.status in ('submitted', 'assigned', 'in_progress', 'sent_back'))
      or (p_kind = 'pi_output' and r.status in ('assigned', 'in_progress')
        and (public.has_role('bsd') or (public.has_role('ops') and r.assignee_id = auth.uid())))
    )
  );
$$;

create or replace function public.add_document(p_request uuid, p_kind document_kind, p_path text, p_name text)
returns uuid language plpgsql security definer set search_path = public as $$
declare did uuid;
begin
  if not public.can_upload(p_request, p_kind) then raise exception 'You cannot upload this kind of file to this request now'; end if;
  if split_part(p_path, '/', 1) <> p_request::text then raise exception 'Bad storage path'; end if;
  insert into public.request_documents (request_id, kind, storage_path, file_name)
  values (p_request, p_kind, p_path, p_name) returning id into did;
  perform public.add_event(p_request, case p_kind when 'pi_output' then 'pi_uploaded' else 'attachment_added' end,
                           null, null, p_name, p_kind = 'attachment' or false);
  return did;
end $$;

create or replace function public.remove_document(p_document uuid)
returns void language plpgsql security definer set search_path = public as $$
declare d public.request_documents;
begin
  select * into d from public.request_documents where id = p_document;
  if d.id is null or d.uploaded_by <> auth.uid() or not public.can_upload(d.request_id, d.kind) then
    raise exception 'You cannot remove this file';
  end if;
  delete from public.request_documents where id = d.id;
  delete from storage.objects where bucket_id = 'request-docs' and name = d.storage_path;
end $$;

create or replace function public.log_document_view(p_document uuid)
returns void language plpgsql security definer set search_path = public as $$
declare d public.request_documents;
begin
  select * into d from public.request_documents where id = p_document;
  if d.id is null or not public.can_view_request(d.request_id) then raise exception 'Document not found'; end if;
  perform public.log_event('document.viewed', 'request_document', d.id::text, jsonb_build_object('file', d.file_name));
end $$;

-- ---------------------------------------------------------------------------
-- Users (bsd). Accounts are created in the Supabase dashboard; sign-up is off.
-- ---------------------------------------------------------------------------
create or replace function public.admin_update_user(p_user uuid, p_role app_role, p_active boolean,
                                                    p_full_name text default null, p_company text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.has_role('bsd') then raise exception 'Only bsd can manage users'; end if;
  if p_user = auth.uid() and (not p_active or p_role is distinct from 'bsd') then
    raise exception 'You cannot remove your own bsd access';
  end if;
  update public.profiles set role = p_role, active = p_active,
    full_name = coalesce(p_full_name, full_name), company = coalesce(p_company, company) where id = p_user;
  perform public.log_event('user.updated', 'profile', p_user::text,
                           jsonb_build_object('role', p_role, 'active', p_active));
end $$;

-- ---------------------------------------------------------------------------
-- File storage (private bucket). Path: <request id>/<file name>
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public) values ('request-docs', 'request-docs', false)
on conflict (id) do nothing;

create policy "request docs upload" on storage.objects for insert to authenticated
  with check (bucket_id = 'request-docs' and (
    public.can_upload(((storage.foldername(name))[1])::uuid, 'attachment')
    or public.can_upload(((storage.foldername(name))[1])::uuid, 'pi_output')));
create policy "request docs read" on storage.objects for select to authenticated
  using (bucket_id = 'request-docs' and exists (
    select 1 from public.request_documents d where d.storage_path = name and public.can_view_request(d.request_id)
      and (not public.has_role('introducer') or d.kind = 'attachment'
           or exists (select 1 from public.pi_requests r where r.id = d.request_id and r.status = 'completed'))));
create policy "request docs delete" on storage.objects for delete to authenticated
  using (bucket_id = 'request-docs' and owner = auth.uid());

-- log_event writes to the audit log with the definer's rights. Only the database's own
-- functions may call it; signed-in users must not be able to add audit entries directly.
revoke execute on function public.log_event(text, text, text, jsonb) from public, anon, authenticated;

-- Workflow update (9 Nov 2026):
--  * notifications for introducers (sent back, completed), ops (deadline soon, corrections, assignments) and bsd (deadline soon)
--  * ops can move their requests freely between Unassigned, Assigned and In progress
--  * introducers no longer see who handles their request
--  * no comments on a request that is sent back
-- Safe to run on a project that already has the earlier setup.

-- ---------------------------------------------------------------------------
-- Introducers can read only their own profile (they no longer see ops or bsd names)
-- ---------------------------------------------------------------------------
drop policy if exists profiles_read on public.profiles;
create policy profiles_read on public.profiles for select to authenticated
  using (id = auth.uid() or public.has_role('bsd') or public.has_role('ops'));

-- Assignment and status shuffling is internal: hide those events from introducers.
update public.request_events set introducer_visible = false
 where kind in ('assigned', 'reassigned', 'started', 'status_changed', 'released');

-- ---------------------------------------------------------------------------
-- Notifications
-- ---------------------------------------------------------------------------
create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  request_id uuid not null references public.pi_requests (id) on delete cascade,
  kind text not null,      -- sent_back, completed, due_soon, overdue, assigned, resubmitted, comment
  message text not null,
  created_at timestamptz not null default now(),
  read_at timestamptz
);
create index if not exists notifications_user_idx on public.notifications (user_id, created_at desc);
-- A deadline notice is sent once per person per request.
create unique index if not exists notifications_deadline_once on public.notifications (user_id, request_id, kind)
  where kind in ('due_soon', 'overdue');

alter table public.notifications enable row level security;
drop policy if exists notifications_own on public.notifications;
create policy notifications_own on public.notifications for select to authenticated
  using (user_id = auth.uid() and public.is_active_user());
revoke insert, update, delete on public.notifications from authenticated, anon;

create or replace function public.notify(p_user uuid, p_request uuid, p_kind text, p_message text)
returns void language sql security definer set search_path = public as $$
  insert into public.notifications (user_id, request_id, kind, message)
  values (p_user, p_request, p_kind, p_message)
  on conflict (user_id, request_id, kind) where kind in ('due_soon', 'overdue') do nothing;
$$;
revoke execute on function public.notify(uuid, uuid, text, text) from public, anon, authenticated;

create or replace function public.mark_notifications_read(p_ids uuid[] default null)
returns void language sql security definer set search_path = public as $$
  update public.notifications set read_at = now()
   where user_id = auth.uid() and read_at is null and (p_ids is null or id = any (p_ids));
$$;

-- Deadline notices. Requests are due two days after submission: "due soon" once a day or less is left,
-- "overdue" after two days. Called by the app for ops and bsd when they open it; safe to call repeatedly.
create or replace function public.refresh_deadline_notifications()
returns void language plpgsql security definer set search_path = public as $$
declare r record; hours numeric; k text; msg text; u uuid;
begin
  if not (public.has_role('ops') or public.has_role('bsd')) then return; end if;
  for r in select id, ref, assignee_id, submitted_at from public.pi_requests where status not in ('completed', 'removed') loop
    hours := extract(epoch from now() - r.submitted_at) / 3600;
    continue when hours < 24;
    k := case when hours > 48 then 'overdue' else 'due_soon' end;
    msg := r.ref || case when k = 'overdue' then ' is overdue' else ' is due in 1 day' end;
    for u in select id from public.profiles where active and role = 'bsd'
             union select id from public.profiles where active and role = 'ops' and id = r.assignee_id loop
      perform public.notify(u, r.id, k, msg);
    end loop;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Workflow functions
-- ---------------------------------------------------------------------------
drop function if exists public.claim_request(uuid);
create or replace function public.claim_request(p_request uuid, p_start boolean default false)
returns void language plpgsql security definer set search_path = public as $$
declare r public.pi_requests; nxt request_status := case when p_start then 'in_progress' else 'assigned' end;
begin
  select * into r from public.pi_requests where id = p_request for update;
  if not public.has_role('ops') then raise exception 'Ops only'; end if;
  if r.id is null or r.status <> 'submitted' or r.assignee_id is not null then raise exception 'This request is not in the unassigned pool'; end if;
  update public.pi_requests set status = nxt, assignee_id = auth.uid(), updated_at = now() where id = r.id;
  perform public.add_event(r.id, 'assigned', r.status, nxt, 'Picked up', false);
  perform public.log_event('request.claimed', 'pi_request', r.ref);
end $$;

create or replace function public.assign_request(p_request uuid, p_user uuid)
returns void language plpgsql security definer set search_path = public as $$
declare r public.pi_requests; nxt request_status; who text;
begin
  select * into r from public.pi_requests where id = p_request for update;
  if not public.has_role('bsd') then raise exception 'Only bsd can assign requests'; end if;
  if r.id is null then raise exception 'Request not found'; end if;
  if r.status in ('completed', 'removed') then raise exception 'A % request cannot be reassigned', r.status; end if;
  select full_name into who from public.profiles where id = p_user and role = 'ops' and active;
  if not found then raise exception 'Choose an active ops user'; end if;
  nxt := case when r.status = 'submitted' then 'assigned' else r.status end;
  update public.pi_requests set assignee_id = p_user, status = nxt, updated_at = now() where id = r.id;
  perform public.add_event(r.id, case when r.assignee_id is null then 'assigned' else 'reassigned' end,
                           r.status, nxt, 'To ' || who, false);
  perform public.notify(p_user, r.id, 'assigned', r.ref || ' was assigned to you');
  perform public.log_event('request.assigned', 'pi_request', r.ref, jsonb_build_object('to', p_user));
end $$;

create or replace function public.change_status(p_request uuid, p_to request_status, p_reason text default null)
returns void language plpgsql security definer set search_path = public as $$
declare r public.pi_requests; ok boolean := false; is_bsd boolean := public.has_role('bsd');
begin
  select * into r from public.pi_requests where id = p_request for update;
  if r.id is null then raise exception 'Request not found'; end if;
  if not (is_bsd or (public.has_role('ops') and r.assignee_id = auth.uid())) then
    raise exception 'Only the assigned ops user or bsd can change the status';
  end if;
  if r.status = 'removed' then raise exception 'A removed request cannot be changed'; end if;
  if p_to = 'removed' then raise exception 'Use remove for that'; end if;

  if is_bsd then
    ok := p_to <> r.status and (p_to = 'submitted' or r.assignee_id is not null);
  else
    -- ops move their own work freely between Unassigned (released to the pool), Assigned and In progress
    ok := (r.status in ('assigned', 'in_progress') and p_to in ('assigned', 'in_progress', 'submitted', 'sent_back') and p_to <> r.status)
       or (r.status = 'in_progress' and p_to = 'completed');
  end if;
  if not ok then raise exception 'You cannot move this request from % to %', r.status, p_to; end if;
  if p_to = 'sent_back' and coalesce(btrim(p_reason), '') = '' then raise exception 'A reason is required to send a request back'; end if;
  if p_to = 'completed' and not exists (select 1 from public.request_documents d where d.request_id = r.id and d.kind = 'pi_output') then
    raise exception 'Upload at least one PI document before completing';
  end if;

  update public.pi_requests set
    status = p_to, updated_at = now(),
    assignee_id = case when p_to = 'submitted' then null else assignee_id end,
    status_reason = case when p_to = 'sent_back' then btrim(p_reason) else null end,
    completed_at = case when p_to = 'completed' then now() else null end
  where id = r.id;
  perform public.add_event(r.id,
    case p_to when 'in_progress' then 'started' when 'sent_back' then 'sent_back' when 'completed' then 'completed'
              when 'submitted' then 'released' else 'status_changed' end,
    r.status, p_to, p_reason, p_to in ('sent_back', 'completed'));
  if p_to = 'sent_back' then
    perform public.notify(r.introducer_id, r.id, 'sent_back', r.ref || ' was sent back: ' || btrim(p_reason));
  elsif p_to = 'completed' then
    perform public.notify(r.introducer_id, r.id, 'completed', r.ref || ' is completed. Your policy illustrations are ready.');
  end if;
  perform public.log_event('request.' || p_to, 'pi_request', r.ref, jsonb_build_object('reason', p_reason));
end $$;

create or replace function public.resubmit_request(p_request uuid, p_note text default null)
returns void language plpgsql security definer set search_path = public as $$
declare r public.pi_requests; nxt request_status;
begin
  select * into r from public.pi_requests where id = p_request for update;
  if r.id is null or r.introducer_id <> auth.uid() or not public.has_role('introducer') then raise exception 'Not your request'; end if;
  if r.status <> 'sent_back' then raise exception 'Only a request that was sent back can be resubmitted'; end if;
  nxt := case when r.assignee_id is null then 'submitted' else 'in_progress' end;
  update public.pi_requests set status = nxt, status_reason = null, updated_at = now() where id = r.id;
  if coalesce(btrim(p_note), '') <> '' then
    insert into public.request_comments (request_id, author_id, body, internal) values (r.id, auth.uid(), btrim(p_note), false);
  end if;
  perform public.add_event(r.id, 'resubmitted', r.status, nxt, p_note);
  if r.assignee_id is not null then
    perform public.notify(r.assignee_id, r.id, 'resubmitted', r.ref || ' was corrected and resubmitted by the introducer');
  end if;
  perform public.log_event('request.resubmitted', 'pi_request', r.ref);
end $$;

create or replace function public.add_comment(p_request uuid, p_body text, p_internal boolean default false)
returns void language plpgsql security definer set search_path = public as $$
declare r public.pi_requests;
begin
  select * into r from public.pi_requests where id = p_request;
  if r.id is null or not public.can_view_request(p_request) then raise exception 'Request not found'; end if;
  if r.status = 'removed' then raise exception 'This request was removed'; end if;
  if r.status = 'sent_back' then raise exception 'Comments are closed while a request is sent back'; end if;
  if p_internal and public.has_role('introducer') then raise exception 'Introducers cannot write internal notes'; end if;
  if coalesce(btrim(p_body), '') = '' then raise exception 'Write a comment first'; end if;
  insert into public.request_comments (request_id, author_id, body, internal) values (p_request, auth.uid(), btrim(p_body), p_internal);
  if public.has_role('introducer') and r.assignee_id is not null then
    perform public.notify(r.assignee_id, r.id, 'comment', 'New comment from the introducer on ' || r.ref);
  end if;
end $$;

-- Workflow improvements (10 Nov 2026):
--  * priority (urgent) flag on requests
--  * configurable deadline (bsd), optionally paused while a request is sent back
--  * reopen a completed request
--  * bulk assign for bsd
--  * saved backlog filters per user
--  * a deadline check that a schedule (pg_cron) can run
--  * email alerts are OFF for now; profiles.email_alerts and set_email_alerts() are kept so they can be switched on
--    later without a database change (see docs/email-alerts/README.md)
-- Safe to run on a project that already has the earlier setup (1-setup.sql + 1b-upgrade.sql).

-- ---------------------------------------------------------------------------
-- Settings (one row, edited by bsd)
-- ---------------------------------------------------------------------------
create table if not exists public.app_settings (
  id boolean primary key default true check (id),
  deadline_hours int not null default 48 check (deadline_hours between 1 and 720),
  due_soon_hours int not null default 24 check (due_soon_hours between 0 and 720),
  pause_when_sent_back boolean not null default true,
  updated_at timestamptz not null default now(),
  check (due_soon_hours < deadline_hours)
);
insert into public.app_settings (id) values (true) on conflict (id) do nothing;

alter table public.app_settings enable row level security;
drop policy if exists settings_read on public.app_settings;
create policy settings_read on public.app_settings for select to authenticated using (public.is_active_user());
revoke insert, update, delete on public.app_settings from authenticated, anon;

-- ---------------------------------------------------------------------------
-- New request columns
-- ---------------------------------------------------------------------------
alter table public.pi_requests add column if not exists priority text not null default 'normal';
alter table public.pi_requests drop constraint if exists pi_requests_priority_check;
alter table public.pi_requests add constraint pi_requests_priority_check check (priority in ('normal', 'urgent'));
alter table public.pi_requests add column if not exists due_at timestamptz;
alter table public.pi_requests add column if not exists paused_at timestamptz;   -- set while sent back, if the clock is paused
update public.pi_requests set due_at = submitted_at + interval '48 hours' where due_at is null;
update public.pi_requests set paused_at = updated_at where status = 'sent_back' and paused_at is null;
alter table public.pi_requests alter column due_at set not null;
create index if not exists pi_requests_due_idx on public.pi_requests (due_at);

-- New requests get their due time from the settings.
create or replace function public.set_due_at()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.due_at is null then
    new.due_at := new.submitted_at + make_interval(hours => (select deadline_hours from public.app_settings));
  end if;
  return new;
end $$;
revoke execute on function public.set_due_at() from public, anon, authenticated;
drop trigger if exists pi_requests_due_at on public.pi_requests;
create trigger pi_requests_due_at before insert on public.pi_requests for each row execute function public.set_due_at();

alter table public.profiles add column if not exists email_alerts boolean not null default true;

-- ---------------------------------------------------------------------------
-- Deadline notices
-- ---------------------------------------------------------------------------
-- Drop deadline notices that no longer apply after a due time moved later, so they can fire again.
create or replace function public.clear_stale_deadline_notices(p_request uuid default null)
returns void language sql security definer set search_path = public as $$
  delete from public.notifications n
   using public.pi_requests r, public.app_settings s
   where n.request_id = r.id and n.kind in ('due_soon', 'overdue')
     and (p_request is null or r.id = p_request)
     and r.status not in ('completed', 'removed')
     and ((n.kind = 'overdue' and now() <= r.due_at)
       or (n.kind = 'due_soon' and now() < r.due_at - make_interval(hours => s.due_soon_hours)));
$$;
revoke execute on function public.clear_stale_deadline_notices(uuid) from public, anon, authenticated;

-- Creates "due soon" and "overdue" notices for the assigned ops user and every bsd user.
-- Not callable from the browser; a schedule (5-schedule-deadline-checks.sql) or the wrapper below runs it.
create or replace function public.generate_deadline_notifications()
returns void language plpgsql security definer set search_path = public as $$
declare r record; k text; msg text; u uuid; s public.app_settings; left_h numeric;
begin
  select * into s from public.app_settings;
  for r in select id, ref, assignee_id, due_at, priority from public.pi_requests
           where status not in ('completed', 'removed') and paused_at is null loop
    left_h := extract(epoch from r.due_at - now()) / 3600;
    continue when left_h > s.due_soon_hours;
    k := case when left_h < 0 then 'overdue' else 'due_soon' end;
    msg := case when r.priority = 'urgent' then 'URGENT ' else '' end || r.ref ||
           case when k = 'overdue' then ' is overdue' else ' is due in ' || greatest(ceil(left_h), 1) || 'h' end;
    for u in select id from public.profiles where active and role = 'bsd'
             union select id from public.profiles where active and role = 'ops' and id = r.assignee_id loop
      perform public.notify(u, r.id, k, msg);
    end loop;
  end loop;
end $$;
revoke execute on function public.generate_deadline_notifications() from public, anon, authenticated;

create or replace function public.refresh_deadline_notifications()
returns void language plpgsql security definer set search_path = public as $$
begin
  if not (public.has_role('ops') or public.has_role('bsd')) then return; end if;
  perform public.generate_deadline_notifications();
end $$;

create or replace function public.update_settings(p_deadline_hours int, p_due_soon_hours int, p_pause boolean)
returns void language plpgsql security definer set search_path = public as $$
declare old public.app_settings;
begin
  if not public.has_role('bsd') then raise exception 'Only bsd can change settings'; end if;
  if p_deadline_hours is null or p_deadline_hours < 1 or p_deadline_hours > 720 then raise exception 'The deadline must be between 1 and 720 hours'; end if;
  if p_due_soon_hours is null or p_due_soon_hours < 0 or p_due_soon_hours >= p_deadline_hours then
    raise exception 'The "due soon" warning must be shorter than the deadline';
  end if;
  select * into old from public.app_settings for update;
  update public.app_settings set deadline_hours = p_deadline_hours, due_soon_hours = p_due_soon_hours,
    pause_when_sent_back = coalesce(p_pause, true), updated_at = now() where id;
  -- Open requests move by the same amount, so the new deadline applies to them too.
  if p_deadline_hours <> old.deadline_hours then
    update public.pi_requests set due_at = due_at + make_interval(hours => p_deadline_hours - old.deadline_hours)
     where status not in ('completed', 'removed');
  end if;
  -- Turning the pause off restarts the clock on requests that are sent back now.
  if not coalesce(p_pause, true) then
    update public.pi_requests set due_at = due_at + (now() - paused_at), paused_at = null where paused_at is not null;
  end if;
  perform public.clear_stale_deadline_notices(null);
  perform public.log_event('settings.updated', 'app_settings', null,
    jsonb_build_object('deadline_hours', p_deadline_hours, 'due_soon_hours', p_due_soon_hours, 'pause_when_sent_back', p_pause));
end $$;

-- ---------------------------------------------------------------------------
-- Introducer actions (priority, reopen)
-- ---------------------------------------------------------------------------
create or replace function public.create_request(p jsonb, p_client jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare rid uuid; rref text; pr text := coalesce(nullif(p ->> 'priority', ''), 'normal'); u uuid;
begin
  if not public.has_role('introducer') then raise exception 'Only introducers can submit requests'; end if;
  perform public.check_fields(p);
  if pr not in ('normal', 'urgent') then raise exception 'Priority must be normal or urgent'; end if;
  if coalesce(btrim(p_client ->> 'client_name'), '') = '' then raise exception 'Enter the client name'; end if;
  insert into public.pi_requests (introducer_id, plan_category, product, age_band, gender, smoker,
      coverage_term, sum_assured_band, premium_type, ci_benefit, remarks, priority)
  values (auth.uid(), coalesce(p ->> 'plan_category', 'All'), coalesce(p ->> 'product', 'Term life'),
      p ->> 'age_band', p ->> 'gender', (p ->> 'smoker')::boolean, p ->> 'coverage_term', p ->> 'sum_assured_band',
      coalesce(p ->> 'premium_type', 'Annual'), coalesce((p ->> 'ci_benefit')::boolean, false), nullif(btrim(p ->> 'remarks'), ''), pr)
  returning id, ref into rid, rref;
  insert into public.request_clients (request_id, owner_id, client_name, nric, contact)
  values (rid, auth.uid(), btrim(p_client ->> 'client_name'), nullif(btrim(p_client ->> 'nric'), ''), nullif(btrim(p_client ->> 'contact'), ''));
  perform public.add_event(rid, 'submitted', null, 'submitted', case when pr = 'urgent' then 'Marked urgent' end);
  if pr = 'urgent' then
    for u in select id from public.profiles where active and role = 'bsd' loop
      perform public.notify(u, rid, 'urgent', 'URGENT ' || rref || ' was submitted and is unassigned');
    end loop;
  end if;
  perform public.log_event('request.submitted', 'pi_request', rref);
  return rid;
end $$;

create or replace function public.update_request(p_request uuid, p jsonb, p_client jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare r public.pi_requests; pr text;
begin
  select * into r from public.pi_requests where id = p_request for update;
  if r.id is null or r.introducer_id <> auth.uid() or not public.has_role('introducer') then raise exception 'Not your request'; end if;
  if r.status not in ('submitted', 'sent_back') then raise exception 'This request can no longer be edited'; end if;
  perform public.check_fields(p);
  pr := coalesce(nullif(p ->> 'priority', ''), r.priority);
  if pr not in ('normal', 'urgent') then raise exception 'Priority must be normal or urgent'; end if;
  update public.pi_requests set
    plan_category = coalesce(p ->> 'plan_category', plan_category), age_band = p ->> 'age_band', gender = p ->> 'gender',
    smoker = (p ->> 'smoker')::boolean, coverage_term = p ->> 'coverage_term', sum_assured_band = p ->> 'sum_assured_band',
    premium_type = coalesce(p ->> 'premium_type', premium_type), ci_benefit = coalesce((p ->> 'ci_benefit')::boolean, false),
    remarks = nullif(btrim(p ->> 'remarks'), ''), priority = pr, updated_at = now()
  where id = r.id;
  if p_client is not null then
    if coalesce(btrim(p_client ->> 'client_name'), '') = '' then raise exception 'Enter the client name'; end if;
    update public.request_clients set client_name = btrim(p_client ->> 'client_name'),
      nric = nullif(btrim(p_client ->> 'nric'), ''), contact = nullif(btrim(p_client ->> 'contact'), '')
    where request_id = r.id;
  end if;
  perform public.add_event(r.id, 'edited', r.status, r.status);
  if pr <> r.priority then
    perform public.add_event(r.id, 'priority_changed', null, null, case when pr = 'urgent' then 'Marked urgent' else 'Urgent flag removed' end);
  end if;
  perform public.log_event('request.edited', 'pi_request', r.ref);
end $$;

-- The submitting introducer, the assigned ops user or bsd can flag an open request as urgent (or clear it).
create or replace function public.set_priority(p_request uuid, p_priority text)
returns void language plpgsql security definer set search_path = public as $$
declare r public.pi_requests;
begin
  select * into r from public.pi_requests where id = p_request for update;
  if r.id is null or not public.can_view_request(p_request) then raise exception 'Request not found'; end if;
  if not coalesce((public.has_role('introducer') and r.introducer_id = auth.uid())
          or public.has_role('bsd') or (public.has_role('ops') and r.assignee_id = auth.uid()), false) then
    raise exception 'Only the introducer, the assigned ops user or bsd can change the priority';
  end if;
  if p_priority not in ('normal', 'urgent') then raise exception 'Priority must be normal or urgent'; end if;
  if r.status in ('completed', 'removed') then raise exception 'A % request cannot change priority', r.status; end if;
  if r.priority = p_priority then return; end if;
  update public.pi_requests set priority = p_priority, updated_at = now() where id = r.id;
  perform public.add_event(r.id, 'priority_changed', null, null, case when p_priority = 'urgent' then 'Marked urgent' else 'Urgent flag removed' end);
  if p_priority = 'urgent' and r.assignee_id is not null and r.assignee_id <> auth.uid() then
    perform public.notify(r.assignee_id, r.id, 'urgent', r.ref || ' was marked urgent');
  end if;
  perform public.log_event('request.priority', 'pi_request', r.ref, jsonb_build_object('priority', p_priority));
end $$;

-- Reopen a completed request when the client wants changes. The introducer who submitted it, or bsd.
-- It goes back to the same ops user (In progress) if they are still active, otherwise to the unassigned pool,
-- and the deadline starts again. The reason stays on the request (status_reason) until its next status change.
create or replace function public.reopen_request(p_request uuid, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare r public.pi_requests; nxt request_status; keep uuid;
begin
  select * into r from public.pi_requests where id = p_request for update;
  if r.id is null or not public.can_view_request(p_request) then raise exception 'Request not found'; end if;
  if not coalesce((public.has_role('introducer') and r.introducer_id = auth.uid()) or public.has_role('bsd'), false) then
    raise exception 'Only the introducer who submitted it or bsd can reopen a request';
  end if;
  if r.status <> 'completed' then raise exception 'Only a completed request can be reopened'; end if;
  if coalesce(btrim(p_reason), '') = '' then raise exception 'Say what the client wants changed'; end if;
  select id into keep from public.profiles where id = r.assignee_id and role = 'ops' and active;
  nxt := case when keep is null then 'submitted' else 'in_progress' end;
  update public.pi_requests set status = nxt, assignee_id = keep, completed_at = null, paused_at = null, status_reason = btrim(p_reason),
    due_at = now() + make_interval(hours => (select deadline_hours from public.app_settings)), updated_at = now()
  where id = r.id;
  perform public.add_event(r.id, 'reopened', r.status, nxt, p_reason);
  if keep is not null and keep <> auth.uid() then
    perform public.notify(keep, r.id, 'reopened', r.ref || ' was reopened: ' || btrim(p_reason));
  end if;
  if public.has_role('bsd') then
    perform public.notify(r.introducer_id, r.id, 'reopened', r.ref || ' was reopened by the ops team');
  end if;
  perform public.clear_stale_deadline_notices(r.id);
  perform public.log_event('request.reopened', 'pi_request', r.ref, jsonb_build_object('reason', p_reason));
end $$;

create or replace function public.resubmit_request(p_request uuid, p_note text default null)
returns void language plpgsql security definer set search_path = public as $$
declare r public.pi_requests; nxt request_status;
begin
  select * into r from public.pi_requests where id = p_request for update;
  if r.id is null or r.introducer_id <> auth.uid() or not public.has_role('introducer') then raise exception 'Not your request'; end if;
  if r.status <> 'sent_back' then raise exception 'Only a request that was sent back can be resubmitted'; end if;
  nxt := case when r.assignee_id is null then 'submitted' else 'in_progress' end;
  update public.pi_requests set status = nxt, status_reason = null, updated_at = now(),
    due_at = case when paused_at is null then due_at else due_at + (now() - paused_at) end, paused_at = null
  where id = r.id;
  if coalesce(btrim(p_note), '') <> '' then
    insert into public.request_comments (request_id, author_id, body, internal) values (r.id, auth.uid(), btrim(p_note), false);
  end if;
  perform public.add_event(r.id, 'resubmitted', r.status, nxt, p_note);
  if r.assignee_id is not null then
    perform public.notify(r.assignee_id, r.id, 'resubmitted', r.ref || ' was corrected and resubmitted by the introducer');
  end if;
  perform public.clear_stale_deadline_notices(r.id);
  perform public.log_event('request.resubmitted', 'pi_request', r.ref);
end $$;

-- ---------------------------------------------------------------------------
-- Ops and bsd: status changes pause the clock while sent back; bulk assign
-- ---------------------------------------------------------------------------
create or replace function public.change_status(p_request uuid, p_to request_status, p_reason text default null)
returns void language plpgsql security definer set search_path = public as $$
declare r public.pi_requests; ok boolean := false; is_bsd boolean := public.has_role('bsd');
        pause boolean := (select pause_when_sent_back from public.app_settings);
begin
  select * into r from public.pi_requests where id = p_request for update;
  if r.id is null then raise exception 'Request not found'; end if;
  if not (is_bsd or (public.has_role('ops') and r.assignee_id = auth.uid())) then
    raise exception 'Only the assigned ops user or bsd can change the status';
  end if;
  if r.status = 'removed' then raise exception 'A removed request cannot be changed'; end if;
  if p_to = 'removed' then raise exception 'Use remove for that'; end if;

  if is_bsd then
    ok := p_to <> r.status and (p_to = 'submitted' or r.assignee_id is not null);
  else
    -- ops move their own work freely between Unassigned (released to the pool), Assigned and In progress
    ok := (r.status in ('assigned', 'in_progress') and p_to in ('assigned', 'in_progress', 'submitted', 'sent_back') and p_to <> r.status)
       or (r.status = 'in_progress' and p_to = 'completed');
  end if;
  if not ok then raise exception 'You cannot move this request from % to %', r.status, p_to; end if;
  if p_to = 'sent_back' and coalesce(btrim(p_reason), '') = '' then raise exception 'A reason is required to send a request back'; end if;
  if p_to = 'completed' and not exists (select 1 from public.request_documents d where d.request_id = r.id and d.kind = 'pi_output') then
    raise exception 'Upload at least one PI document before completing';
  end if;

  update public.pi_requests set
    status = p_to, updated_at = now(),
    assignee_id = case when p_to = 'submitted' then null else assignee_id end,
    status_reason = case when p_to = 'sent_back' then btrim(p_reason) else null end,
    completed_at = case when p_to = 'completed' then now() else null end,
    -- the clock stops while the introducer fixes a sent-back request (if bsd turned that on) and restarts after
    due_at = case when paused_at is not null and p_to <> 'sent_back' then due_at + (now() - paused_at) else due_at end,
    paused_at = case when p_to = 'sent_back' then (case when pause then coalesce(paused_at, now()) end) else null end
  where id = r.id;
  perform public.add_event(r.id,
    case p_to when 'in_progress' then 'started' when 'sent_back' then 'sent_back' when 'completed' then 'completed'
              when 'submitted' then 'released' else 'status_changed' end,
    r.status, p_to, p_reason, p_to in ('sent_back', 'completed'));
  if p_to = 'sent_back' then
    perform public.notify(r.introducer_id, r.id, 'sent_back', r.ref || ' was sent back: ' || btrim(p_reason));
  elsif p_to = 'completed' then
    perform public.notify(r.introducer_id, r.id, 'completed', r.ref || ' is completed. Your policy illustrations are ready.');
  end if;
  if r.paused_at is not null and p_to <> 'sent_back' then perform public.clear_stale_deadline_notices(r.id); end if;
  perform public.log_event('request.' || p_to, 'pi_request', r.ref, jsonb_build_object('reason', p_reason));
end $$;

-- Assign several requests to one ops user at once (bsd). All or nothing; requests already with that user are skipped.
create or replace function public.assign_requests(p_requests uuid[], p_user uuid)
returns int language plpgsql security definer set search_path = public as $$
declare rid uuid; n int := 0;
begin
  if not public.has_role('bsd') then raise exception 'Only bsd can assign requests'; end if;
  if p_requests is null or cardinality(p_requests) = 0 then raise exception 'Choose at least one request'; end if;
  foreach rid in array p_requests loop
    continue when exists (select 1 from public.pi_requests where id = rid and assignee_id = p_user);
    perform public.assign_request(rid, p_user);
    n := n + 1;
  end loop;
  return n;
end $$;

-- ---------------------------------------------------------------------------
-- Saved backlog filters (each user sees only their own)
-- ---------------------------------------------------------------------------
create table if not exists public.saved_filters (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 60),
  filters jsonb not null default '{}',
  created_at timestamptz not null default now(),
  unique (user_id, name)
);
alter table public.saved_filters enable row level security;
drop policy if exists saved_filters_own on public.saved_filters;
create policy saved_filters_own on public.saved_filters for select to authenticated
  using (user_id = auth.uid() and public.is_active_user());
revoke insert, update, delete on public.saved_filters from authenticated, anon;

create or replace function public.save_filter(p_name text, p_filters jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare fid uuid;
begin
  if not public.is_active_user() then raise exception 'Sign in first'; end if;
  if coalesce(btrim(p_name), '') = '' then raise exception 'Give the filter a name'; end if;
  insert into public.saved_filters (user_id, name, filters) values (auth.uid(), btrim(p_name), coalesce(p_filters, '{}'))
  on conflict (user_id, name) do update set filters = excluded.filters
  returning id into fid;
  return fid;
end $$;

create or replace function public.delete_saved_filter(p_id uuid)
returns void language sql security definer set search_path = public as $$
  delete from public.saved_filters where id = p_id and user_id = auth.uid();
$$;

-- ---------------------------------------------------------------------------
-- Email alerts (not switched on yet): each user's opt-out. Sending would be done by the notify-email
-- Edge Function parked in docs/email-alerts/ once an email provider is set up.
-- ---------------------------------------------------------------------------
create or replace function public.set_email_alerts(p_on boolean)
returns void language sql security definer set search_path = public as $$
  update public.profiles set email_alerts = coalesce(p_on, true) where id = auth.uid();
$$;

-- Urgent is for ops and bsd only (11 Nov 2026):
--  * introducers no longer see the urgent flag, the due time or the deadline colours, on screen or through the API,
--    and can no longer mark a request urgent (on the form or later)
--  * every overdue open request is marked urgent automatically
-- Rule for the automatic flag:
--  * a request becomes urgent ("automatically") as soon as it is overdue: open (not completed or removed),
--    the clock is running (not paused while sent back) and the due time has passed
--  * the automatic flag is cleared again when the request is no longer late: its due time moves later
--    (bsd lengthens the deadline, or it is reopened with a fresh deadline) or it is completed or removed
--  * while a request is sent back with the clock paused, the flag stays as it was (it is still late when it comes back)
--  * an urgent flag set by hand by ops or bsd is never cleared automatically
--  * ops and bsd cannot remove the urgent flag from a request that is overdue
-- Safe to run more than once.

-- ---------------------------------------------------------------------------
-- Who set the flag: true = the overdue rule, so it can be cleared again when the request is no longer late
-- ---------------------------------------------------------------------------
alter table public.pi_requests add column if not exists urgent_auto boolean not null default false;

create or replace function public.is_overdue(p_status request_status, p_due timestamptz, p_paused timestamptz)
returns boolean language sql stable set search_path = public as $$
  select p_status not in ('completed', 'removed') and p_paused is null and p_due < now();
$$;

-- Applies the rule on every change to a request (status, due time, priority), and notes automatic
-- changes on the timeline (staff only, no actor).
create or replace function public.apply_overdue_urgent()
returns trigger language plpgsql security definer set search_path = public as $$
declare note text;
begin
  if public.is_overdue(new.status, new.due_at, new.paused_at) then
    if new.priority = 'normal' then
      new.priority := 'urgent'; new.urgent_auto := true; note := 'Marked urgent automatically: overdue';
    end if;
  elsif new.urgent_auto and new.priority = 'urgent' and (new.status in ('completed', 'removed') or new.due_at >= now()) then
    new.priority := 'normal'; new.urgent_auto := false; note := 'Urgent flag removed automatically: no longer overdue';
  end if;
  if new.priority = 'normal' then new.urgent_auto := false; end if;
  if note is not null and tg_op = 'UPDATE' then
    insert into public.request_events (request_id, actor_id, kind, detail, introducer_visible)
    values (new.id, null, 'priority_changed', note, false);
  end if;
  return new;
end $$;
revoke execute on function public.apply_overdue_urgent() from public, anon, authenticated;
drop trigger if exists pi_requests_overdue_urgent on public.pi_requests;
create trigger pi_requests_overdue_urgent before insert or update on public.pi_requests
  for each row execute function public.apply_overdue_urgent();

-- Requests become overdue just by time passing, so this sweep marks them. The deadline check runs it
-- (every 15 minutes with 5-schedule-deadline-checks.sql, and every minute while ops or bsd have the app open).
create or replace function public.mark_overdue_urgent()
returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  -- The trigger above does the marking (and the timeline entry).
  update public.pi_requests set urgent_auto = urgent_auto
   where priority = 'normal' and public.is_overdue(status, due_at, paused_at);
  get diagnostics n = row_count;
  return n;
end $$;
revoke execute on function public.mark_overdue_urgent() from public, anon, authenticated;

create or replace function public.generate_deadline_notifications()
returns void language plpgsql security definer set search_path = public as $$
declare r record; k text; msg text; u uuid; s public.app_settings; left_h numeric;
begin
  perform public.mark_overdue_urgent();
  select * into s from public.app_settings;
  for r in select id, ref, assignee_id, due_at, priority from public.pi_requests
           where status not in ('completed', 'removed') and paused_at is null loop
    left_h := extract(epoch from r.due_at - now()) / 3600;
    continue when left_h > s.due_soon_hours;
    k := case when left_h < 0 then 'overdue' else 'due_soon' end;
    msg := case when r.priority = 'urgent' then 'URGENT ' else '' end || r.ref ||
           case when k = 'overdue' then ' is overdue' else ' is due in ' || greatest(ceil(left_h), 1) || 'h' end;
    for u in select id from public.profiles where active and role = 'bsd'
             union select id from public.profiles where active and role = 'ops' and id = r.assignee_id loop
      perform public.notify(u, r.id, k, msg);
    end loop;
  end loop;
end $$;
revoke execute on function public.generate_deadline_notifications() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Introducers cannot read the priority or deadline columns
-- ---------------------------------------------------------------------------
-- Column-level read access on the table: everything except priority, urgent_auto, due_at and paused_at.
-- (A column added later is hidden from everyone until it is added here or to the view below.)
revoke select on public.pi_requests from authenticated, anon;
grant select (id, ref, introducer_id, status, assignee_id, plan_category, product, age_band, gender, smoker,
              coverage_term, sum_assured_band, premium_type, ci_benefit, remarks, status_reason,
              submitted_at, completed_at, created_at, updated_at)
  on public.pi_requests to authenticated;

-- The app reads requests through this view. Same rows as the table's access rule (can_view_request);
-- priority and deadline columns are empty (null) unless the reader is ops or bsd. Priority already counts
-- a request as urgent the moment it is overdue, before the next sweep stores it.
drop view if exists public.request_list;
create view public.request_list with (security_barrier = true) as
select r.id, r.ref, r.introducer_id, r.status, r.assignee_id, r.plan_category, r.product, r.age_band, r.gender, r.smoker,
       r.coverage_term, r.sum_assured_band, r.premium_type, r.ci_benefit, r.remarks, r.status_reason,
       r.submitted_at, r.completed_at, r.created_at, r.updated_at,
       case when st.staff then
         case when r.priority = 'urgent' or public.is_overdue(r.status, r.due_at, r.paused_at) then 'urgent' else 'normal' end
       end as priority,
       case when st.staff then
         (r.priority = 'urgent' and r.urgent_auto) or (r.priority = 'normal' and public.is_overdue(r.status, r.due_at, r.paused_at))
       end as urgent_auto,
       case when st.staff then r.due_at end as due_at,
       case when st.staff then r.paused_at end as paused_at
  from public.pi_requests r
  cross join lateral (select public.has_role('ops') or public.has_role('bsd') as staff) st
 where public.can_view_request(r.id);
revoke all on public.request_list from public, anon, authenticated;
grant select on public.request_list to authenticated;

-- ---------------------------------------------------------------------------
-- Timeline: priority changes are internal
-- ---------------------------------------------------------------------------
update public.request_events set introducer_visible = false where kind = 'priority_changed';
insert into public.request_events (request_id, actor_id, kind, detail, introducer_visible, at)
select request_id, actor_id, 'priority_changed', 'Marked urgent when submitted', false, at
  from public.request_events where kind = 'submitted' and detail = 'Marked urgent';
update public.request_events set detail = null where kind = 'submitted' and detail = 'Marked urgent';

-- ---------------------------------------------------------------------------
-- Introducers no longer set the priority. A "priority" sent by an older screen is ignored.
-- ---------------------------------------------------------------------------
create or replace function public.create_request(p jsonb, p_client jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare rid uuid; rref text;
begin
  if not public.has_role('introducer') then raise exception 'Only introducers can submit requests'; end if;
  perform public.check_fields(p);
  if coalesce(btrim(p_client ->> 'client_name'), '') = '' then raise exception 'Enter the client name'; end if;
  insert into public.pi_requests (introducer_id, plan_category, product, age_band, gender, smoker,
      coverage_term, sum_assured_band, premium_type, ci_benefit, remarks)
  values (auth.uid(), coalesce(p ->> 'plan_category', 'All'), coalesce(p ->> 'product', 'Term life'),
      p ->> 'age_band', p ->> 'gender', (p ->> 'smoker')::boolean, p ->> 'coverage_term', p ->> 'sum_assured_band',
      coalesce(p ->> 'premium_type', 'Annual'), coalesce((p ->> 'ci_benefit')::boolean, false), nullif(btrim(p ->> 'remarks'), ''))
  returning id, ref into rid, rref;
  insert into public.request_clients (request_id, owner_id, client_name, nric, contact)
  values (rid, auth.uid(), btrim(p_client ->> 'client_name'), nullif(btrim(p_client ->> 'nric'), ''), nullif(btrim(p_client ->> 'contact'), ''));
  perform public.add_event(rid, 'submitted', null, 'submitted');
  perform public.log_event('request.submitted', 'pi_request', rref);
  return rid;
end $$;

create or replace function public.update_request(p_request uuid, p jsonb, p_client jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare r public.pi_requests;
begin
  select * into r from public.pi_requests where id = p_request for update;
  if r.id is null or r.introducer_id <> auth.uid() or not public.has_role('introducer') then raise exception 'Not your request'; end if;
  if r.status not in ('submitted', 'sent_back') then raise exception 'This request can no longer be edited'; end if;
  perform public.check_fields(p);
  update public.pi_requests set
    plan_category = coalesce(p ->> 'plan_category', plan_category), age_band = p ->> 'age_band', gender = p ->> 'gender',
    smoker = (p ->> 'smoker')::boolean, coverage_term = p ->> 'coverage_term', sum_assured_band = p ->> 'sum_assured_band',
    premium_type = coalesce(p ->> 'premium_type', premium_type), ci_benefit = coalesce((p ->> 'ci_benefit')::boolean, false),
    remarks = nullif(btrim(p ->> 'remarks'), ''), updated_at = now()
  where id = r.id;
  if p_client is not null then
    if coalesce(btrim(p_client ->> 'client_name'), '') = '' then raise exception 'Enter the client name'; end if;
    update public.request_clients set client_name = btrim(p_client ->> 'client_name'),
      nric = nullif(btrim(p_client ->> 'nric'), ''), contact = nullif(btrim(p_client ->> 'contact'), '')
    where request_id = r.id;
  end if;
  perform public.add_event(r.id, 'edited', r.status, r.status);
  perform public.log_event('request.edited', 'pi_request', r.ref);
end $$;

-- The assigned ops user or bsd can flag an open request as urgent, or clear a flag unless the request is overdue.
create or replace function public.set_priority(p_request uuid, p_priority text)
returns void language plpgsql security definer set search_path = public as $$
declare r public.pi_requests;
begin
  select * into r from public.pi_requests where id = p_request for update;
  if r.id is null or not public.can_view_request(p_request) then raise exception 'Request not found'; end if;
  if not coalesce(public.has_role('bsd') or (public.has_role('ops') and r.assignee_id = auth.uid()), false) then
    raise exception 'Only the assigned ops user or bsd can change the priority';
  end if;
  if p_priority not in ('normal', 'urgent') then raise exception 'Priority must be normal or urgent'; end if;
  if r.status in ('completed', 'removed') then raise exception 'A % request cannot change priority', r.status; end if;
  if p_priority = 'normal' and public.is_overdue(r.status, r.due_at, r.paused_at) then
    raise exception 'Overdue requests stay urgent until they are completed or their deadline moves later';
  end if;
  if r.priority = p_priority and not r.urgent_auto then return; end if;
  -- Flagging by hand (also on a request that was flagged automatically) makes it a manual flag that stays.
  update public.pi_requests set priority = p_priority, urgent_auto = false, updated_at = now() where id = r.id;
  if r.priority = p_priority then return; end if;
  perform public.add_event(r.id, 'priority_changed', null, null,
    case when p_priority = 'urgent' then 'Marked urgent' else 'Urgent flag removed' end, false);
  if p_priority = 'urgent' and r.assignee_id is not null and r.assignee_id <> auth.uid() then
    perform public.notify(r.assignee_id, r.id, 'urgent', r.ref || ' was marked urgent');
  end if;
  perform public.log_event('request.priority', 'pi_request', r.ref, jsonb_build_object('priority', p_priority));
end $$;

-- Mark what is overdue right now.
select public.mark_overdue_urgent();

commit;
