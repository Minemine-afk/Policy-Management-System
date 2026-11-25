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
create type app_role as enum ('introducer', 'ops', 'bsd', 'admin');   -- 'admin' added here so the whole setup runs as one transaction

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
  insert into public.request_clients (request_id, owner_id, client_name, contact)
  values (rid, auth.uid(), btrim(p_client ->> 'client_name'), nullif(btrim(p_client ->> 'contact'), ''));
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
      contact = nullif(btrim(p_client ->> 'contact'), '')
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
  delete from public.request_documents where id = d.id;   -- the app then deletes the file through the Storage API
end $$;

-- True when a stored file is still listed on a request (storage policies use it; definer so it sees every row).
create or replace function public.file_is_listed(p_path text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.request_documents where storage_path = p_path)
$$;
revoke execute on function public.file_is_listed(text) from public, anon;
grant execute on function public.file_is_listed(text) to authenticated;

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
-- Files are deleted through the Storage API (Supabase blocks SQL deletes on storage tables), only by the
-- uploader and only once the file is off the request (remove_document); the uploader may see it until then.
create policy "request docs read own unlisted" on storage.objects for select to authenticated
  using (bucket_id = 'request-docs' and owner = auth.uid() and not public.file_is_listed(name));
create policy "request docs delete" on storage.objects for delete to authenticated
  using (bucket_id = 'request-docs' and owner = auth.uid() and not public.file_is_listed(name));

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
  insert into public.request_clients (request_id, owner_id, client_name, contact)
  values (rid, auth.uid(), btrim(p_client ->> 'client_name'), nullif(btrim(p_client ->> 'contact'), ''));
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
      contact = nullif(btrim(p_client ->> 'contact'), '')
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
  insert into public.request_clients (request_id, owner_id, client_name, contact)
  values (rid, auth.uid(), btrim(p_client ->> 'client_name'), nullif(btrim(p_client ->> 'contact'), ''));
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
      contact = nullif(btrim(p_client ->> 'contact'), '')
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

-- A separate Admin role (12 Nov 2026). This file only adds the new role value; the rules that use it are in the
-- next file. (PostgreSQL can't use a new enum value in the same transaction that adds it, so it is on its own.)
alter type public.app_role add value if not exists 'admin';

-- A separate Admin role (12 Nov 2026):
--  * admin (new) manages the system: creates users and changes their role, name, firm and active state,
--    changes the deadline settings and reads the audit log
--  * bsd keeps its work on requests (sees every request, assigns, reassigns, bulk assigns, removes, reopens,
--    flags urgent, gets deadline notices) but can no longer manage users, change settings or read the audit log
--  * admin does not work on requests: it does not see requests or client details
-- Existing bsd users keep working; give at least one login the admin role (see 1e-upgrade.sql).

-- Profiles: you see yourself; ops, bsd and admin see everyone.
drop policy if exists profiles_read on public.profiles;
create policy profiles_read on public.profiles for select to authenticated
  using (id = auth.uid() or public.has_role('admin') or public.has_role('bsd') or public.has_role('ops'));

-- Audit log: admin only.
drop policy if exists audit_read on public.audit_log;
create policy audit_read on public.audit_log for select to authenticated using (public.has_role('admin'));

-- Users: admin only. An admin cannot take away their own admin access (so there is always one left).
create or replace function public.admin_update_user(p_user uuid, p_role app_role, p_active boolean,
                                                    p_full_name text default null, p_company text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.has_role('admin') then raise exception 'Only an admin can manage users'; end if;
  if p_user = auth.uid() and (not p_active or p_role is distinct from 'admin') then
    raise exception 'You cannot remove your own admin access';
  end if;
  if not exists (select 1 from public.profiles where id = p_user) then raise exception 'User not found'; end if;
  update public.profiles set role = p_role, active = p_active,
    full_name = coalesce(p_full_name, full_name), company = coalesce(p_company, company) where id = p_user;
  perform public.log_event('user.updated', 'profile', p_user::text,
                           jsonb_build_object('role', p_role, 'active', p_active));
end $$;

-- Deadline settings: admin only.
create or replace function public.update_settings(p_deadline_hours int, p_due_soon_hours int, p_pause boolean)
returns void language plpgsql security definer set search_path = public as $$
declare old public.app_settings;
begin
  if not public.has_role('admin') then raise exception 'Only an admin can change settings'; end if;
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

-- Module access (14 Nov 2026). The app is a set of modules: PI Requests (live) and future modules
-- (Product Comparison Matrix, Introducer Intelligence, Knowledge Hub, Content Studio, LinkedIn Outreach).
--  * A user's role (introducer, ops, bsd) decides what they see and do INSIDE a module.
--  * Whether a user can open a module at all = the role's default, unless an admin switched it on or off for that
--    user. Each module lists the roles it can ever be given to (e.g. Introducer Intelligence is staff only), and no
--    switch can go past that.
--  * Admin pages stay with the admin role and are not modules, so an admin can never lock themselves out.
--  * Enforced here, not just in the screens: has_role('introducer' | 'ops' | 'bsd') is the PI Requests check used by
--    every request rule, and it is now false when the user's PI Requests module is off. Future modules check
--    public.is_role(...) together with public.has_module('<key>').
-- Defaults keep everyone exactly as before: PI Requests on for introducer, ops and bsd; future modules off.

create table if not exists public.app_modules (
  key text primary key,
  name text not null,
  description text not null default '',
  live boolean not null default false,            -- false = coming soon (can be switched on ahead of launch)
  roles app_role[] not null,                       -- roles that can ever be given this module
  sort int not null default 0
);

insert into public.app_modules (key, name, description, live, roles, sort) values
  ('pi_requests', 'PI Requests', 'Submit, track and work on policy illustration requests', true, '{introducer,ops,bsd}', 1),
  ('product_matrix', 'Product Comparison Matrix', 'Side-by-side product facts from verified insurer documents', false, '{introducer,ops,bsd}', 2),
  ('introducer_intelligence', 'Introducer Intelligence', 'Introducer profiles, segments and engagement timeline (staff only)', false, '{ops,bsd}', 3),
  ('knowledge_hub', 'Knowledge Hub', 'Document repository with versions and expiry dates', false, '{introducer,ops,bsd}', 4),
  ('content_studio', 'Content Studio', 'Draft and approve content and email campaigns (staff only)', false, '{ops,bsd}', 5),
  ('linkedin_outreach', 'LinkedIn Outreach', 'Introducer lead outreach (staff only)', false, '{ops,bsd}', 6)
on conflict (key) do update set name = excluded.name, description = excluded.description, roles = excluded.roles, sort = excluded.sort;

create table if not exists public.module_role_defaults (
  module_key text not null references public.app_modules (key) on delete cascade,
  role app_role not null,
  enabled boolean not null,
  primary key (module_key, role)
);
insert into public.module_role_defaults (module_key, role, enabled)
select m.key, r, m.key = 'pi_requests' from public.app_modules m, unnest(m.roles) r
on conflict do nothing;

-- Per-user switch. No row = follow the role default.
create table if not exists public.user_module_access (
  user_id uuid not null references public.profiles (id) on delete cascade,
  module_key text not null references public.app_modules (key) on delete cascade,
  enabled boolean not null,
  updated_by uuid references public.profiles (id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key (user_id, module_key)
);

alter table public.app_modules enable row level security;
alter table public.module_role_defaults enable row level security;
alter table public.user_module_access enable row level security;
drop policy if exists modules_read on public.app_modules;
create policy modules_read on public.app_modules for select to authenticated using (true);
drop policy if exists module_defaults_read on public.module_role_defaults;
create policy module_defaults_read on public.module_role_defaults for select to authenticated using (true);
drop policy if exists module_access_read on public.user_module_access;
create policy module_access_read on public.user_module_access for select to authenticated
  using (user_id = auth.uid() or public.has_role('admin'));
revoke insert, update, delete on public.app_modules, public.module_role_defaults, public.user_module_access from authenticated, anon;
grant select on public.app_modules, public.module_role_defaults, public.user_module_access to authenticated;

-- The role check alone, for future modules (combine with has_module).
create or replace function public.is_role(r app_role)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles p where p.id = auth.uid() and p.active and p.role = r);
$$;

create or replace function public.user_has_module(p_user uuid, p_module text)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((
    select coalesce(o.enabled, d.enabled, false)
      from public.profiles p
      join public.app_modules m on m.key = p_module and p.role = any (m.roles)
      left join public.module_role_defaults d on d.module_key = m.key and d.role = p.role
      left join public.user_module_access o on o.module_key = m.key and o.user_id = p.id
     where p.id = p_user and p.active), false);
$$;

create or replace function public.has_module(p_module text)
returns boolean language sql stable security definer set search_path = public as $$
  select public.user_has_module(auth.uid(), p_module);
$$;

-- has_role is the PI Requests check for introducer, ops and bsd (admin is not a module).
create or replace function public.has_role(r app_role)
returns boolean language sql stable security definer set search_path = public as $$
  select public.is_role(r) and (r = 'admin' or public.has_module('pi_requests'));
$$;

-- The modules the signed-in user can open.
create or replace function public.my_modules()
returns text[] language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(m.key order by m.sort), '{}') from public.app_modules m where public.has_module(m.key);
$$;

-- Ops and bsd need to know who can be given requests.
create or replace function public.module_members(p_module text)
returns setof uuid language sql stable security definer set search_path = public as $$
  select p.id from public.profiles p
   where (public.has_role('ops') or public.has_role('bsd') or public.has_role('admin'))
     and public.user_has_module(p.id, p_module);
$$;

-- Requests can only be given to someone whose PI Requests module is on.
create or replace function public.check_assignee_module()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.assignee_id is not null and new.assignee_id is distinct from old.assignee_id
     and not public.user_has_module(new.assignee_id, 'pi_requests') then
    raise exception 'This person does not have access to PI Requests';
  end if;
  return new;
end $$;
drop trigger if exists pi_requests_assignee_module on public.pi_requests;
create trigger pi_requests_assignee_module before update of assignee_id on public.pi_requests
  for each row execute function public.check_assignee_module();

-- No request notices for people who can't open PI Requests.
create or replace function public.notify(p_user uuid, p_request uuid, p_kind text, p_message text)
returns void language sql security definer set search_path = public as $$
  insert into public.notifications (user_id, request_id, kind, message)
  select p_user, p_request, p_kind, p_message
   where p_request is null or public.user_has_module(p_user, 'pi_requests')
  on conflict (user_id, request_id, kind) where kind in ('due_soon', 'overdue') do nothing;
$$;
revoke execute on function public.notify(uuid, uuid, text, text) from public, anon, authenticated;

-- Admin: switch a module on or off for one user (p_enabled null = back to the role default).
create or replace function public.admin_set_user_module(p_user uuid, p_module text, p_enabled boolean)
returns void language plpgsql security definer set search_path = public as $$
declare m public.app_modules; r app_role;
begin
  if not public.has_role('admin') then raise exception 'Only an admin can change module access'; end if;
  select * into m from public.app_modules where key = p_module;
  if m.key is null then raise exception 'Unknown module'; end if;
  select role into r from public.profiles where id = p_user;
  if not found then raise exception 'User not found'; end if;
  if p_enabled and (r is null or not r = any (m.roles)) then
    raise exception '% can''t be given to the % role', m.name, coalesce(r::text, 'no');
  end if;
  if p_enabled is null then
    delete from public.user_module_access where user_id = p_user and module_key = p_module;
  else
    insert into public.user_module_access (user_id, module_key, enabled, updated_by, updated_at)
    values (p_user, p_module, p_enabled, auth.uid(), now())
    on conflict (user_id, module_key) do update set enabled = excluded.enabled, updated_by = excluded.updated_by, updated_at = now();
  end if;
  perform public.log_event('access.user_module', 'profile', p_user::text,
    jsonb_build_object('module', p_module, 'module_name', m.name,
                       'setting', case when p_enabled is null then 'default' when p_enabled then 'on' else 'off' end));
end $$;

-- Admin: change a role's default for a module (applies to everyone in that role without their own switch).
create or replace function public.admin_set_role_module(p_role app_role, p_module text, p_enabled boolean)
returns void language plpgsql security definer set search_path = public as $$
declare m public.app_modules;
begin
  if not public.has_role('admin') then raise exception 'Only an admin can change module access'; end if;
  select * into m from public.app_modules where key = p_module;
  if m.key is null then raise exception 'Unknown module'; end if;
  if p_enabled is null then raise exception 'Choose on or off'; end if;
  if not p_role = any (m.roles) then raise exception '% can''t be given to the % role', m.name, p_role; end if;
  insert into public.module_role_defaults (module_key, role, enabled) values (p_module, p_role, p_enabled)
  on conflict (module_key, role) do update set enabled = excluded.enabled;
  perform public.log_event('access.role_module', 'module', p_module,
    jsonb_build_object('module', p_module, 'module_name', m.name, 'role', p_role, 'setting', case when p_enabled then 'on' else 'off' end));
end $$;

revoke execute on function public.user_has_module(uuid, text), public.check_assignee_module() from public, anon, authenticated;
revoke execute on function public.is_role(app_role), public.has_module(text), public.my_modules(), public.module_members(text),
  public.admin_set_user_module(uuid, text, boolean), public.admin_set_role_module(app_role, text, boolean) from public, anon;
grant execute on function public.is_role(app_role), public.has_module(text), public.my_modules(), public.module_members(text),
  public.admin_set_user_module(uuid, text, boolean), public.admin_set_role_module(app_role, text, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- PI pack (15 Nov 2026): when a request is completed, the introducer receives ONE PDF, made in the ops/bsd browser,
-- with the comparison first and then every PI PDF unchanged, restricted against editing. Introducers never get the
-- Excel file or the separate PIs of a request that has a pack. Requests completed before this change have no pack;
-- their introducers keep seeing the PI PDFs (never the Excel).
alter table public.request_documents
  add column if not exists is_pack boolean not null default false,
  add column if not exists sha256 text,      -- fingerprint of the pack as saved, to prove a copy was not changed
  add column if not exists pack_of uuid[];   -- the PI PDFs the pack was made from

-- The PI PDFs on a request (not the pack, not Excel files), in a fixed order.
create or replace function public.request_pi_pdfs(p_request uuid)
returns uuid[] language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(id order by id), '{}') from public.request_documents
  where request_id = p_request and kind = 'pi_output' and not is_pack and file_name ilike '%.pdf'
$$;

create or replace function public.newest_pack(p_request uuid)
returns uuid language sql stable security definer set search_path = public as $$
  select id from public.request_documents where request_id = p_request and is_pack
  order by uploaded_at desc, id desc limit 1
$$;

-- True when the newest pack was made from exactly the PI PDFs on the request now.
create or replace function public.pack_is_current(p_request uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select array(select unnest(d.pack_of) order by 1) = public.request_pi_pdfs(p_request)
                   from public.request_documents d where d.id = public.newest_pack(p_request)), false)
$$;

-- What an introducer may open on their own request: their attachments, and once it is completed, the newest pack
-- (or, on a request completed before packs existed, its PI PDFs).
create or replace function public.introducer_sees_document(p_document uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.request_documents d join public.pi_requests r on r.id = d.request_id
    where d.id = p_document and (
      d.kind = 'attachment'
      or (r.status = 'completed' and d.kind = 'pi_output' and case
            when public.newest_pack(r.id) is not null then d.id = public.newest_pack(r.id)
            else not d.is_pack and d.file_name ilike '%.pdf' end)))
$$;

drop policy if exists docs_read on public.request_documents;
create policy docs_read on public.request_documents for select to authenticated
  using (public.can_view_request(request_id) and (not public.has_role('introducer') or public.introducer_sees_document(id)));

drop policy if exists "request docs read" on storage.objects;
create policy "request docs read" on storage.objects for select to authenticated
  using (bucket_id = 'request-docs' and exists (
    select 1 from public.request_documents d where d.storage_path = name and public.can_view_request(d.request_id)
      and (not public.has_role('introducer') or public.introducer_sees_document(d.id))));

-- Ops (assigned) or bsd save the pack. p_docs: the PI PDFs it was made from, which must be every PI PDF on the request.
create or replace function public.add_pi_pack(p_request uuid, p_path text, p_name text, p_sha256 text, p_docs uuid[])
returns uuid language plpgsql security definer set search_path = public as $$
declare did uuid;
begin
  if not public.can_upload(p_request, 'pi_output') then raise exception 'You cannot save a PI pack to this request now'; end if;
  if split_part(p_path, '/', 1) <> p_request::text then raise exception 'Bad storage path'; end if;
  if p_name !~* '\.pdf$' then raise exception 'The PI pack must be a PDF'; end if;
  if coalesce(p_sha256, '') !~ '^[0-9a-f]{64}$' then raise exception 'The PI pack fingerprint is missing'; end if;
  if coalesce(array_length(p_docs, 1), 0) = 0 then raise exception 'The PI pack needs at least one PI'; end if;
  if array(select distinct unnest(p_docs) order by 1) <> public.request_pi_pdfs(p_request) then
    raise exception 'The PIs on this request changed while the pack was being made. Refresh the page and save again';
  end if;
  insert into public.request_documents (request_id, kind, storage_path, file_name, is_pack, sha256, pack_of)
  values (p_request, 'pi_output', p_path, p_name, true, p_sha256, p_docs) returning id into did;
  perform public.add_event(p_request, 'pi_pack_saved', null, null, p_name, false);
  perform public.log_event('document.pack_saved', 'request_document', did::text,
    jsonb_build_object('file', p_name, 'sha256', p_sha256, 'pis', array_length(p_docs, 1)));
  return did;
end $$;

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
  if p_to = 'completed' and not public.pack_is_current(r.id) then
    raise exception 'Save the PI pack (the comparison and the PIs as one PDF) before completing. If the PIs changed since, save it again';
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


revoke execute on function public.request_pi_pdfs(uuid), public.newest_pack(uuid) from public, anon, authenticated;
-- introducer_sees_document is used by the access rules, which run as the signed-in user.
revoke execute on function public.introducer_sees_document(uuid), public.pack_is_current(uuid),
  public.add_pi_pack(uuid, text, text, text, uuid[]) from public, anon;
grant execute on function public.introducer_sees_document(uuid), public.pack_is_current(uuid),
  public.add_pi_pack(uuid, text, text, text, uuid[]) to authenticated;

-- Automatic deletion of long-overdue requests (19 Nov 2026).
--
-- Rule ("overdue for more than N days", N = 30 by default, set by an admin under Admin > Deadline settings):
--  * the request is OPEN: Submitted, Assigned, In progress, or Sent back with the clock running
--    (the same meaning of "overdue" as the red colour and the automatic urgent flag, see is_overdue)
--  * and its due time passed more than N days ago.
-- Never deleted: Completed and Removed requests, and requests that are sent back while the clock is paused
-- (they wait for the introducer and are not counted as overdue).
--
-- What goes, for good: the request, its client details (request_clients), comments, timeline, notifications,
-- file records (attachments, PIs, comparison Excel files, PI packs) and, through the Storage API, the files themselves.
-- Free text that could name the client is also taken out of earlier audit entries of that request (reasons, file names).
-- What stays: one audit entry per deleted request (action request.auto_deleted, no actor = the system,
-- the reference PI-xxxxx, status, due time, days overdue, number of files; no client details).
--
-- Files: Supabase blocks SQL deletes on storage tables, so SQL only puts the file paths in storage_cleanup_queue
-- (the file records are gone, so nobody can open the files any more). The Edge Function cleanup-deleted-files
-- removes them with the Storage API and empties the queue. The schedule is in supabase/cloud/5b-schedule-auto-delete.sql.
-- Safe to run more than once.

alter table public.app_settings
  add column if not exists auto_delete_on boolean not null default true,
  add column if not exists auto_delete_days int not null default 30 check (auto_delete_days between 1 and 365);

-- Files of deleted requests, waiting for the Storage API. Server only: no browser role can read or change it.
create table if not exists public.storage_cleanup_queue (
  bucket text not null,
  path text not null,
  queued_at timestamptz not null default now(),
  attempts int not null default 0,
  last_error text,
  primary key (bucket, path)
);
alter table public.storage_cleanup_queue enable row level security;
revoke all on public.storage_cleanup_queue from public, anon, authenticated;
grant select, insert, update, delete on public.storage_cleanup_queue to service_role;

-- The requests the rule matches right now (oldest due first).
create or replace function public.overdue_requests_to_delete()
returns table (id uuid, ref text, status request_status, due_at timestamptz, days_overdue int, files int)
language sql stable security definer set search_path = public as $$
  select r.id, r.ref, r.status, r.due_at, floor(extract(epoch from now() - r.due_at) / 86400)::int,
         (select count(*)::int from public.request_documents d where d.request_id = r.id)
    from public.pi_requests r, public.app_settings s
   where public.is_overdue(r.status, r.due_at, r.paused_at)
     and r.due_at < now() - make_interval(days => s.auto_delete_days)
   order by r.due_at, r.ref
$$;

-- Deletes the matching requests (only while the switch is on). Not callable from the browser: the daily schedule runs it,
-- and an admin runs it through run_overdue_deletion(). Returns what it deleted.
create or replace function public.delete_overdue_requests()
returns table (ref text, files int) language plpgsql security definer set search_path = public as $$
declare s public.app_settings; c record; docs text[];
begin
  select * into s from public.app_settings;
  if not s.auto_delete_on then return; end if;
  for c in select * from public.overdue_requests_to_delete() loop
    -- Check again on the locked row, so a request that was just completed or moved is never deleted.
    perform 1 from public.pi_requests r
     where r.id = c.id and public.is_overdue(r.status, r.due_at, r.paused_at)
       and r.due_at < now() - make_interval(days => s.auto_delete_days)
       for update skip locked;
    continue when not found;
    insert into public.storage_cleanup_queue (bucket, path)
      select 'request-docs', d.storage_path from public.request_documents d where d.request_id = c.id
      on conflict (bucket, path) do nothing;
    select coalesce(array_agg(d.id::text), '{}') into docs from public.request_documents d where d.request_id = c.id;
    -- Earlier audit entries keep who did what and when, but lose free text that could name the client.
    -- (A reason key is kept, emptied, because "returned to the pool" is told apart from "submitted" by it.)
    update public.audit_log a set details = (a.details - 'file')
        || case when a.details ? 'reason' then jsonb_build_object('reason', null) else '{}'::jsonb end
        || jsonb_build_object('request', c.ref, 'details_removed', true)
     where (a.entity = 'request_document' and a.entity_id = any(docs) or a.entity = 'pi_request' and a.entity_id = c.ref)
       and (nullif(a.details ->> 'file', '') is not null or nullif(a.details ->> 'reason', '') is not null);
    delete from public.pi_requests r where r.id = c.id;   -- client details, comments, timeline, file records, notifications go with it
    perform public.log_event('request.auto_deleted', 'pi_request', c.ref, jsonb_build_object(
      'status', c.status, 'due_at', c.due_at, 'days_overdue', c.days_overdue, 'files', c.files, 'after_days', s.auto_delete_days));
    ref := c.ref; files := c.files;
    return next;
  end loop;
end $$;

-- Admin: see what the rule would delete now (references and dates only, no client details).
create or replace function public.preview_overdue_deletion()
returns table (id uuid, ref text, status request_status, due_at timestamptz, days_overdue int, files int)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.has_role('admin') then raise exception 'Only an admin can see this'; end if;
  return query select * from public.overdue_requests_to_delete();
end $$;

-- Admin: delete them now instead of waiting for the daily run. The audit log shows the admin as the one who ran it.
create or replace function public.run_overdue_deletion()
returns table (ref text, files int) language plpgsql security definer set search_path = public as $$
begin
  if not public.has_role('admin') then raise exception 'Only an admin can delete requests this way'; end if;
  if not (select auto_delete_on from public.app_settings) then raise exception 'Automatic deletion is switched off. Switch it on first'; end if;
  return query select * from public.delete_overdue_requests();
end $$;

-- Admin: the switch and the number of days.
create or replace function public.update_auto_delete(p_on boolean, p_days int)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.has_role('admin') then raise exception 'Only an admin can change settings'; end if;
  if p_days is null or p_days < 1 or p_days > 365 then raise exception 'The number of days must be between 1 and 365'; end if;
  update public.app_settings set auto_delete_on = coalesce(p_on, false), auto_delete_days = p_days, updated_at = now() where id;
  perform public.log_event('settings.auto_delete', 'app_settings', null,
    jsonb_build_object('auto_delete_on', coalesce(p_on, false), 'auto_delete_days', p_days));
end $$;

-- Admin: how many files are still waiting to be removed (should be 0 a few minutes after a run).
create or replace function public.files_waiting_for_cleanup()
returns int language plpgsql stable security definer set search_path = public as $$
begin
  if not public.has_role('admin') then raise exception 'Only an admin can see this'; end if;
  return (select count(*)::int from public.storage_cleanup_queue);
end $$;

-- For the Edge Function only (service role): the next files to remove, and the result.
create or replace function public.files_to_clean(p_limit int default 100)
returns table (bucket text, path text) language sql stable security definer set search_path = public as $$
  select q.bucket, q.path from public.storage_cleanup_queue q order by q.attempts, q.queued_at limit greatest(1, least(coalesce(p_limit, 100), 500))
$$;

create or replace function public.files_cleaned(p_bucket text, p_paths text[], p_error text default null)
returns void language sql security definer set search_path = public as $$
  delete from public.storage_cleanup_queue where p_error is null and bucket = p_bucket and path = any(p_paths);
  update public.storage_cleanup_queue set attempts = attempts + 1, last_error = left(p_error, 500)
   where p_error is not null and bucket = p_bucket and path = any(p_paths);
$$;

revoke execute on function public.overdue_requests_to_delete(), public.delete_overdue_requests(),
  public.files_to_clean(int), public.files_cleaned(text, text[], text) from public, anon, authenticated;
grant execute on function public.files_to_clean(int), public.files_cleaned(text, text[], text) to service_role;
revoke execute on function public.preview_overdue_deletion(), public.run_overdue_deletion(),
  public.update_auto_delete(boolean, int), public.files_waiting_for_cleanup() from public, anon;
grant execute on function public.preview_overdue_deletion(), public.run_overdue_deletion(),
  public.update_auto_delete(boolean, int), public.files_waiting_for_cleanup() to authenticated;

-- ---------------------------------------------------------------------------
-- Client date of birth (19 Nov 2026, Kumar): compulsory on the request form instead of picking an age band.
-- Ops and bsd see it (like the age band before), because they need it to produce the PI; the client's name and
-- contact stay visible only to the introducer. The age band is now worked out from the date of birth, so lists,
-- filters and exports keep working. Requests made before this keep their age band and have no date of birth.
alter table public.pi_requests add column if not exists date_of_birth date;
grant select (date_of_birth) on public.pi_requests to authenticated;

-- The date of birth from the form (YYYY-MM-DD): required, not in the future, at most 100 years ago.
create or replace function public.check_dob(p jsonb)
returns date language plpgsql stable as $$
declare d date;
begin
  if coalesce(btrim(p ->> 'date_of_birth'), '') = '' then raise exception 'Enter the client''s date of birth'; end if;
  begin d := (p ->> 'date_of_birth')::date;
  exception when others then raise exception 'Enter the date of birth as a date (day, month, year)'; end;
  if d > current_date then raise exception 'The date of birth can''t be in the future'; end if;
  if d < current_date - interval '100 years' then raise exception 'Check the date of birth: that is over 100 years ago'; end if;
  return d;
end $$;

-- Age band (age last birthday today), in the bands the form used to offer.
create or replace function public.age_band_of(d date)
returns text language sql stable as $$
  select case
    when a < 18 then 'Under 18'
    when a >= 65 then '65 and over'
    when a < 25 then '18 to 24'
    else (25 + ((a - 25) / 5) * 5)::text || ' to ' || (29 + ((a - 25) / 5) * 5)::text end
  from (select extract(year from age(current_date, d))::int as a) x
$$;

create or replace function public.create_request(p jsonb, p_client jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare rid uuid; rref text; dob date := public.check_dob(p);
begin
  if not public.has_role('introducer') then raise exception 'Only introducers can submit requests'; end if;
  p := p || jsonb_build_object('age_band', public.age_band_of(dob));
  perform public.check_fields(p);
  if coalesce(btrim(p_client ->> 'client_name'), '') = '' then raise exception 'Enter the client name'; end if;
  insert into public.pi_requests (introducer_id, plan_category, product, age_band, date_of_birth, gender, smoker,
      coverage_term, sum_assured_band, premium_type, ci_benefit, remarks)
  values (auth.uid(), coalesce(p ->> 'plan_category', 'All'), coalesce(p ->> 'product', 'Term life'),
      p ->> 'age_band', dob, p ->> 'gender', (p ->> 'smoker')::boolean, p ->> 'coverage_term', p ->> 'sum_assured_band',
      coalesce(p ->> 'premium_type', 'Annual'), coalesce((p ->> 'ci_benefit')::boolean, false), nullif(btrim(p ->> 'remarks'), ''))
  returning id, ref into rid, rref;
  insert into public.request_clients (request_id, owner_id, client_name, contact)
  values (rid, auth.uid(), btrim(p_client ->> 'client_name'), nullif(btrim(p_client ->> 'contact'), ''));
  perform public.add_event(rid, 'submitted', null, 'submitted');
  perform public.log_event('request.submitted', 'pi_request', rref);
  return rid;
end $$;

create or replace function public.update_request(p_request uuid, p jsonb, p_client jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare r public.pi_requests; dob date := public.check_dob(p);
begin
  select * into r from public.pi_requests where id = p_request for update;
  if r.id is null or r.introducer_id <> auth.uid() or not public.has_role('introducer') then raise exception 'Not your request'; end if;
  if r.status not in ('submitted', 'sent_back') then raise exception 'This request can no longer be edited'; end if;
  p := p || jsonb_build_object('age_band', public.age_band_of(dob));
  perform public.check_fields(p);
  update public.pi_requests set
    plan_category = coalesce(p ->> 'plan_category', plan_category), age_band = p ->> 'age_band', date_of_birth = dob, gender = p ->> 'gender',
    smoker = (p ->> 'smoker')::boolean, coverage_term = p ->> 'coverage_term', sum_assured_band = p ->> 'sum_assured_band',
    premium_type = coalesce(p ->> 'premium_type', premium_type), ci_benefit = coalesce((p ->> 'ci_benefit')::boolean, false),
    remarks = nullif(btrim(p ->> 'remarks'), ''), updated_at = now()
  where id = r.id;
  if p_client is not null then
    if coalesce(btrim(p_client ->> 'client_name'), '') = '' then raise exception 'Enter the client name'; end if;
    update public.request_clients set client_name = btrim(p_client ->> 'client_name'),
      contact = nullif(btrim(p_client ->> 'contact'), '')
    where request_id = r.id;
  end if;
  perform public.add_event(r.id, 'edited', r.status, r.status);
  perform public.log_event('request.edited', 'pi_request', r.ref);
end $$;

-- The app reads requests through this view; the date of birth is added at the end.
create or replace view public.request_list with (security_barrier = true) as
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
       case when st.staff then r.paused_at end as paused_at,
       r.date_of_birth
  from public.pi_requests r
  cross join lateral (select public.has_role('ops') or public.has_role('bsd') as staff) st
 where public.can_view_request(r.id);
revoke execute on function public.check_dob(jsonb), public.age_band_of(date) from public, anon, authenticated;

-- Teach a new insurer (20 Nov 2026). When ops or bsd save a PI comparison, the browser works out WHERE in the PI each
-- value they filled in or corrected sits (the words beside it, or the column heading above it) and saves those places
-- here, per insurer. The next PI of that insurer is read with those places first, in the browser.
--
-- Only label words and positions are kept: never a value, a client name, a date of birth, a sum or a premium. The
-- browser filters those out, and the checks below refuse any label with an amount, a long number, an e-mail address
-- or a web address in it.
-- Who: ops and bsd read and teach (they make comparisons); bsd and admin see the list and delete places.
create table if not exists public.insurer_label_rules (
  id uuid primary key default gen_random_uuid(),
  insurer text not null check (length(btrim(insurer)) between 1 and 120),
  field text not null check (field in ('insured_name', 'date_of_birth', 'gender', 'residency', 'underwriting_class',
    'cover_age', 'insurer', 'policy_name', 'policy_term', 'premium_term', 'annual_premium', 'total_premium', 'death_sa',
    'base_premium', 'tpd_sa', 'tpd_premium', 'ci_sa', 'ci_premium', 'cash_value')),
  how text not null check (how in ('beside', 'under')),
  label text not null check (length(label) between 2 and 60
    and label !~* '[$€£@]|\mrm\M|\d,\d{3}|\d\.\d|\d{3,}|https?:|www\.|\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}'),
  label_offset int not null default 0 check (label_offset between 0 and 4),
  factor int not null default 1 check (factor in (1, 2, 4, 12)),
  cut text not null default '' check (length(cut) <= 3),
  plan text not null default '' check (length(plan) <= 120),
  created_by uuid references public.profiles (id) on delete set null default auth.uid(),
  created_at timestamptz not null default now()
);
create unique index if not exists insurer_label_rules_once
  on public.insurer_label_rules (lower(insurer), field, how, label, label_offset, factor, cut, lower(plan));

alter table public.insurer_label_rules enable row level security;
revoke all on public.insurer_label_rules from public, anon, authenticated;
grant select on public.insurer_label_rules to authenticated;

drop policy if exists label_rules_read on public.insurer_label_rules;
create policy label_rules_read on public.insurer_label_rules for select to authenticated
  using (public.has_role('ops') or public.has_role('bsd') or public.is_role('admin'));

-- Ops or bsd save the places learned from one comparison column. p_rules: a JSON array of
-- {insurer, field, how, label, offset, factor, cut, plan}. Places already known are skipped. Returns how many were new.
create or replace function public.teach_insurer(p_rules jsonb)
returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if not (public.has_role('ops') or public.has_role('bsd')) then raise exception 'Only ops or bsd can teach the PI reader'; end if;
  if jsonb_typeof(p_rules) <> 'array' or jsonb_array_length(p_rules) > 200 then raise exception 'Bad list of places'; end if;
  with x as (
    insert into public.insurer_label_rules (insurer, field, how, label, label_offset, factor, cut, plan)
    select btrim(r ->> 'insurer'), r ->> 'field', r ->> 'how', r ->> 'label', coalesce((r ->> 'offset')::int, 0),
           coalesce((r ->> 'factor')::int, 1), coalesce(r ->> 'cut', ''), btrim(coalesce(r ->> 'plan', ''))
      from jsonb_array_elements(p_rules) r
    on conflict do nothing returning insurer)
  select count(*) into n from x;
  if n > 0 then
    perform public.log_event('insurer.taught', 'insurer', (select btrim(p_rules -> 0 ->> 'insurer')), jsonb_build_object('places', n));
  end if;
  return n;
end $$;

-- Bsd or admin delete places (all of an insurer's, or chosen ones). Returns how many were deleted.
create or replace function public.forget_insurer_rules(p_ids uuid[])
returns int language plpgsql security definer set search_path = public as $$
declare n int; who text;
begin
  if not (public.has_role('bsd') or public.is_role('admin')) then raise exception 'Only bsd or an admin can delete what the PI reader learned'; end if;
  select string_agg(distinct insurer, ', ') into who from public.insurer_label_rules where id = any(p_ids);
  delete from public.insurer_label_rules where id = any(p_ids);
  get diagnostics n = row_count;
  if n > 0 then perform public.log_event('insurer.forgotten', 'insurer', who, jsonb_build_object('places', n)); end if;
  return n;
end $$;

revoke execute on function public.teach_insurer(jsonb), public.forget_insurer_rules(uuid[]) from public, anon;
grant execute on function public.teach_insurer(jsonb), public.forget_insurer_rules(uuid[]) to authenticated;

-- PI reader learning, step 2 (22 Nov 2026): places in year-by-year tables ('row', e.g. the total premium on the policy
-- term's row) and corrections (ops changed the reader's own value: the next PI of that insurer uses the taught place).
alter table public.insurer_label_rules drop constraint if exists insurer_label_rules_how_check;
alter table public.insurer_label_rules add constraint insurer_label_rules_how_check check (how in ('beside', 'under', 'row'));
alter table public.insurer_label_rules add column if not exists row_at text not null default '';
alter table public.insurer_label_rules drop constraint if exists insurer_label_rules_row_at_check;
alter table public.insurer_label_rules add constraint insurer_label_rules_row_at_check check (row_at in ('', 'term', 'last'));
alter table public.insurer_label_rules add column if not exists corrects boolean not null default false;
drop index if exists public.insurer_label_rules_once;
create unique index if not exists insurer_label_rules_once2
  on public.insurer_label_rules (lower(insurer), field, how, label, label_offset, factor, cut, lower(plan), row_at);

-- Ops or bsd save the places learned from one comparison column. p_rules: a JSON array of
-- {insurer, field, how, label, offset, factor, cut, plan, row, corrects}. Places already known are skipped (a known place
-- that ops corrected again is marked as a correction). Returns how many were new.
create or replace function public.teach_insurer(p_rules jsonb)
returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if not (public.has_role('ops') or public.has_role('bsd')) then raise exception 'Only ops or bsd can teach the PI reader'; end if;
  if jsonb_typeof(p_rules) <> 'array' or jsonb_array_length(p_rules) > 200 then raise exception 'Bad list of places'; end if;
  with x as (
    insert into public.insurer_label_rules (insurer, field, how, label, label_offset, factor, cut, plan, row_at, corrects)
    select btrim(r ->> 'insurer'), r ->> 'field', r ->> 'how', r ->> 'label', coalesce((r ->> 'offset')::int, 0),
           coalesce((r ->> 'factor')::int, 1), coalesce(r ->> 'cut', ''), btrim(coalesce(r ->> 'plan', '')),
           coalesce(r ->> 'row', ''), coalesce((r ->> 'corrects')::boolean, false)
      from jsonb_array_elements(p_rules) r
    on conflict (lower(insurer), field, how, label, label_offset, factor, cut, lower(plan), row_at)
      do update set corrects = insurer_label_rules.corrects or excluded.corrects
      where excluded.corrects and not insurer_label_rules.corrects
    returning (xmax = 0) as added)
  select count(*) filter (where added) into n from x;
  if n > 0 then
    perform public.log_event('insurer.taught', 'insurer', (select btrim(p_rules -> 0 ->> 'insurer')), jsonb_build_object('places', n));
  end if;
  return n;
end $$;

-- PI reader learning, step 3 (22 Nov 2026): ops' NAs are remembered per plan ('na': no such rider, no cash value, no
-- campaign), so the next PI of that plan fills them; accidental death and campaigns can be remembered as NA too.
alter table public.insurer_label_rules drop constraint if exists insurer_label_rules_how_check;
alter table public.insurer_label_rules add constraint insurer_label_rules_how_check check (how in ('beside', 'under', 'row', 'na'));
alter table public.insurer_label_rules drop constraint if exists insurer_label_rules_field_check;
alter table public.insurer_label_rules add constraint insurer_label_rules_field_check check (field in ('insured_name', 'date_of_birth',
  'gender', 'residency', 'underwriting_class', 'cover_age', 'insurer', 'policy_name', 'policy_term', 'premium_term',
  'annual_premium', 'total_premium', 'death_sa', 'accidental_death', 'base_premium', 'tpd_sa', 'tpd_premium', 'ci_sa',
  'ci_premium', 'cash_value', 'campaigns'));
-- An NA place is only "na" and always names its plan.
alter table public.insurer_label_rules drop constraint if exists insurer_label_rules_na_check;
alter table public.insurer_label_rules add constraint insurer_label_rules_na_check check (how <> 'na' or (label = 'na' and length(btrim(plan)) > 0));

commit;

-- New PI request form and the Knowledge Bank (23 Nov 2026, Kumar).
--
-- 1. The request form follows the deck's wireframe 2: gender, client name, client type, residency, nationality, date of
--    birth, insurer, product, currency, sum assured or premium, plus smoker status, coverage term and critical illness
--    (kept from the earlier form), and an optional term product comparison of 2 or 3 plans.
--    Nothing is dropped: old requests keep their fields, and the age band and sum assured text are still filled in so
--    lists, filters and exports keep working. The client's real name stays in request_clients (only the introducer who
--    submitted the request reads it); everyone else sees "Mr VIP" or "Ms VIP".
-- 2. The Knowledge Bank holds insurer documents and the product facts taken from them. The PI request form reads only
--    CHECKED products whose documents are still in date, through the kb_checked_* views. Screens to upload documents
--    and check products come in the next change; until then products are added with SQL (see 3c-sample-products.sql).
-- Safe to run more than once.

-- ---------------------------------------------------------------------------
-- Knowledge Bank
-- ---------------------------------------------------------------------------
create table if not exists public.kb_products (
  id uuid primary key default gen_random_uuid(),
  insurer text not null check (length(btrim(insurer)) between 1 and 120),
  name text not null check (length(btrim(name)) between 1 and 160),
  product_type text not null default 'Term' check (product_type in ('Term')),
  category text not null default 'Insurance' check (category in ('Insurance', 'Investment')),
  dpi boolean not null default false,                      -- Direct Purchase Insurance
  jurisdiction text not null default 'Onshore' check (jurisdiction in ('Onshore', 'Offshore')),
  currencies text[] not null default '{SGD}',
  entry_age_min int not null default 18 check (entry_age_min between 0 and 100),
  entry_age_max int not null default 65 check (entry_age_max between 0 and 100),
  residency text[] not null default '{}',                 -- who can apply: values of the form's Residency list
  sa_min numeric(14, 2),
  sa_max numeric(14, 2),
  has_tpd boolean not null default false,
  has_ci boolean not null default false,                  -- critical illness cover is available (built in or as a rider)
  -- One entry per comparison row: {"key": {"v": "value as written", "doc": "<kb_documents.id>", "page": 4}}
  facts jsonb not null default '{}' check (jsonb_typeof(facts) = 'object'),
  status text not null default 'draft' check (status in ('draft', 'check', 'verified')),
  version int not null default 1,
  is_sample boolean not null default false,
  created_by uuid references public.profiles (id) on delete set null,
  verified_by uuid references public.profiles (id) on delete set null,
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists kb_products_once on public.kb_products (lower(insurer), lower(name));

create table if not exists public.kb_documents (
  id uuid primary key default gen_random_uuid(),
  product_id uuid references public.kb_products (id) on delete cascade,
  insurer text not null,
  title text not null check (length(btrim(title)) between 1 and 200),
  doc_type text not null check (doc_type in ('Product Summary', 'Rate sheet', 'Brochure', 'Policy wording', 'Guide', 'Campaign', 'Regulatory', 'Other')),
  version text not null default '',
  effective_from date,
  valid_until date,
  storage_path text,                                      -- the PDF, once uploads come in
  status text not null default 'new' check (status in ('new', 'checked')),
  is_sample boolean not null default false,
  uploaded_by uuid references public.profiles (id) on delete set null,
  checked_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists kb_documents_product on public.kb_documents (product_id);

-- Indicative premium rates from the insurer's rate sheet: annual premium per 1,000 of sum assured, paying to age 65,
-- by age next birthday, gender and smoker status. ci_rate is the extra for a critical illness rider (null if none).
create table if not exists public.kb_rates (
  product_id uuid not null references public.kb_products (id) on delete cascade,
  age int not null check (age between 0 and 100),
  gender text not null check (gender in ('Male', 'Female')),
  smoker boolean not null,
  rate numeric(10, 4) not null check (rate > 0),
  ci_rate numeric(10, 4) check (ci_rate is null or ci_rate > 0),
  primary key (product_id, age, gender, smoker)
);

alter table public.kb_products enable row level security;
alter table public.kb_documents enable row level security;
alter table public.kb_rates enable row level security;
revoke all on public.kb_products, public.kb_documents, public.kb_rates from public, anon, authenticated;
grant select on public.kb_products, public.kb_documents, public.kb_rates to authenticated;
-- Ops and bsd see everything in the Knowledge Bank, drafts included. Introducers only use the checked views below.
drop policy if exists kb_products_staff on public.kb_products;
create policy kb_products_staff on public.kb_products for select to authenticated using (public.has_role('ops') or public.has_role('bsd'));
drop policy if exists kb_documents_staff on public.kb_documents;
create policy kb_documents_staff on public.kb_documents for select to authenticated using (public.has_role('ops') or public.has_role('bsd'));
drop policy if exists kb_rates_staff on public.kb_rates;
create policy kb_rates_staff on public.kb_rates for select to authenticated using (public.has_role('ops') or public.has_role('bsd'));

-- Who can compare products on the PI request form.
create or replace function public.can_compare_products()
returns boolean language sql stable security definer set search_path = public as $$
  select public.has_role('introducer') or public.has_role('ops') or public.has_role('bsd');
$$;
revoke execute on function public.can_compare_products() from public, anon;
grant execute on function public.can_compare_products() to authenticated;

-- A product is usable when it was checked and none of its documents has passed its valid-until date.
create or replace function public.kb_product_usable(p_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.kb_products p where p.id = p_id and p.status = 'verified')
     and not exists (select 1 from public.kb_documents d where d.product_id = p_id and d.valid_until < current_date);
$$;
revoke execute on function public.kb_product_usable(uuid) from public, anon;
grant execute on function public.kb_product_usable(uuid) to authenticated;   -- used by the views below; says only yes or no

drop view if exists public.kb_checked_rates;
drop view if exists public.kb_checked_documents;
drop view if exists public.kb_checked_products;
create view public.kb_checked_products with (security_barrier = true) as
select p.id, p.insurer, p.name, p.product_type, p.category, p.dpi, p.jurisdiction, p.currencies, p.entry_age_min,
       p.entry_age_max, p.residency, p.sa_min, p.sa_max, p.has_tpd, p.has_ci, p.facts, p.version, p.is_sample, p.verified_at
  from public.kb_products p
 where public.can_compare_products() and public.kb_product_usable(p.id);
create view public.kb_checked_documents with (security_barrier = true) as
select d.id, d.product_id, d.insurer, d.title, d.doc_type, d.version, d.effective_from, d.valid_until
  from public.kb_documents d
 where public.can_compare_products() and d.product_id is not null and public.kb_product_usable(d.product_id);
create view public.kb_checked_rates with (security_barrier = true) as
select r.product_id, r.age, r.gender, r.smoker, r.rate, r.ci_rate
  from public.kb_rates r
 where public.can_compare_products() and public.kb_product_usable(r.product_id);
revoke all on public.kb_checked_products, public.kb_checked_documents, public.kb_checked_rates from public, anon, authenticated;
grant select on public.kb_checked_products, public.kb_checked_documents, public.kb_checked_rates to authenticated;

-- ---------------------------------------------------------------------------
-- New request form fields
-- ---------------------------------------------------------------------------
alter table public.pi_requests
  add column if not exists client_type text,
  add column if not exists residency text,
  add column if not exists nationality text,
  add column if not exists insurer text,
  add column if not exists plan_name text,
  add column if not exists plan_kb_id uuid references public.kb_products (id) on delete set null,
  add column if not exists currency text,
  add column if not exists amount_basis text,
  add column if not exists amount numeric(14, 2),
  add column if not exists compare_term boolean not null default false,
  add column if not exists compare_product_1 text,
  add column if not exists compare_kb_1 uuid references public.kb_products (id) on delete set null,
  add column if not exists compare_product_2 text,
  add column if not exists compare_kb_2 uuid references public.kb_products (id) on delete set null;
alter table public.pi_requests drop constraint if exists pi_requests_amount_basis_check;
alter table public.pi_requests add constraint pi_requests_amount_basis_check check (amount_basis is null or amount_basis in ('sum_assured', 'premium'));
alter table public.pi_requests drop constraint if exists pi_requests_amount_check;
alter table public.pi_requests add constraint pi_requests_amount_check check (amount is null or amount > 0);
grant select (client_type, residency, nationality, insurer, plan_name, plan_kb_id, currency, amount_basis, amount,
              compare_term, compare_product_1, compare_kb_1, compare_product_2, compare_kb_2)
  on public.pi_requests to authenticated;

-- The form's checks (after check_dob). Raises one message naming everything that is missing.
create or replace function public.check_fields(p jsonb)
returns void language plpgsql immutable as $$
declare missing text[] := '{}'; amt numeric;
begin
  if coalesce(p ->> 'gender', '') not in ('Male', 'Female') then missing := missing || 'gender'::text; end if;
  if coalesce(btrim(p ->> 'client_type'), '') = '' then missing := missing || 'client type'::text; end if;
  if coalesce(btrim(p ->> 'residency'), '') = '' then missing := missing || 'residency'::text; end if;
  if coalesce(btrim(p ->> 'nationality'), '') = '' then missing := missing || 'nationality'::text; end if;
  if coalesce(btrim(p ->> 'insurer'), '') = '' and coalesce(btrim(p ->> 'plan_kb_id'), '') = '' then missing := missing || 'insurer'::text; end if;
  if coalesce(btrim(p ->> 'plan_kb_id'), '') = '' and coalesce(btrim(p ->> 'plan_name'), '') = '' then missing := missing || 'product'::text; end if;
  if coalesce(btrim(p ->> 'currency'), '') = '' then missing := missing || 'currency'::text; end if;
  if coalesce(btrim(p ->> 'amount'), '') = '' then missing := missing || 'sum assured / premium'::text; end if;
  if (p -> 'smoker') is null or jsonb_typeof(p -> 'smoker') <> 'boolean' then missing := missing || 'smoker status'::text; end if;
  if coalesce(btrim(p ->> 'coverage_term'), '') = '' then missing := missing || 'coverage term'::text; end if;
  if array_length(missing, 1) > 0 then raise exception 'Fill in %', array_to_string(missing, ', '); end if;
  begin amt := (p ->> 'amount')::numeric;
  exception when others then raise exception 'Sum assured / premium must be a number'; end;
  if amt <= 0 then raise exception 'Sum assured / premium must be more than 0'; end if;
  if coalesce(p ->> 'amount_basis', 'sum_assured') not in ('sum_assured', 'premium') then raise exception 'Choose sum assured or premium'; end if;
end $$;
revoke execute on function public.check_fields(jsonb) from public, anon, authenticated;

-- Works out the insurer, product and the products to compare from the form, using the Knowledge Bank names (never
-- the names the browser sends) for anything picked from it. Returns the columns to store, as JSON.
create or replace function public.form_products(p jsonb)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  cmp boolean := coalesce((p ->> 'compare_term')::boolean, false);
  plan_id uuid := nullif(btrim(p ->> 'plan_kb_id'), '')::uuid;
  c1 uuid := case when cmp then nullif(btrim(p ->> 'compare_kb_1'), '')::uuid end;
  c2 uuid := case when cmp then nullif(btrim(p ->> 'compare_kb_2'), '')::uuid end;
  pl public.kb_products; k1 public.kb_products; k2 public.kb_products; n int;
begin
  if plan_id is not null then
    select * into pl from public.kb_products where id = plan_id;
    if pl.id is null or not public.kb_product_usable(pl.id) then raise exception 'The product is no longer in the Knowledge Bank. Choose it again'; end if;
  end if;
  if cmp then
    if c1 is null then raise exception 'Fill in the 1st product to compare'; end if;
    select * into k1 from public.kb_products where id = c1;
    if k1.id is null or not public.kb_product_usable(k1.id) then raise exception 'The 1st product to compare is no longer in the Knowledge Bank. Choose it again'; end if;
    if c2 is not null then
      select * into k2 from public.kb_products where id = c2;
      if k2.id is null or not public.kb_product_usable(k2.id) then raise exception 'The 2nd product to compare is no longer in the Knowledge Bank. Choose it again'; end if;
    end if;
    if c1 = plan_id or c2 = plan_id or c1 = c2 then raise exception 'Choose different products to compare'; end if;
    n := (case when plan_id is not null then 1 else 0 end) + 1 + (case when c2 is not null then 1 else 0 end);
    if n < 2 then raise exception 'A comparison needs at least 2 products from the Knowledge Bank. Choose a 2nd product'; end if;
  end if;
  return jsonb_build_object(
    'insurer', coalesce(pl.insurer, btrim(p ->> 'insurer')),
    'plan_name', coalesce(pl.name, left(btrim(p ->> 'plan_name'), 160)),
    'plan_kb_id', pl.id,
    'compare_term', cmp,
    'compare_product_1', case when k1.id is not null then k1.insurer || ' · ' || k1.name end,
    'compare_kb_1', k1.id,
    'compare_product_2', case when k2.id is not null then k2.insurer || ' · ' || k2.name end,
    'compare_kb_2', k2.id);
end $$;
revoke execute on function public.form_products(jsonb) from public, anon, authenticated;

-- The amount as text, kept in sum_assured_band so older lists and exports still show something useful.
create or replace function public.amount_text(p jsonb)
returns text language sql immutable as $$
  select case when coalesce(p ->> 'amount_basis', 'sum_assured') = 'premium' then 'Premium ' else 'Sum assured ' end
         || btrim(p ->> 'currency') || ' ' || to_char((p ->> 'amount')::numeric, 'FM999,999,999,990.##')
$$;
revoke execute on function public.amount_text(jsonb) from public, anon, authenticated;

create or replace function public.create_request(p jsonb, p_client jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare rid uuid; rref text; dob date; fp jsonb;
begin
  if not public.has_role('introducer') then raise exception 'Only introducers can submit requests'; end if;
  dob := public.check_dob(p);
  perform public.check_fields(p);
  if coalesce(btrim(p_client ->> 'client_name'), '') = '' then raise exception 'Enter the client name'; end if;
  fp := public.form_products(p);
  insert into public.pi_requests (introducer_id, plan_category, product, age_band, date_of_birth, gender, smoker,
      coverage_term, sum_assured_band, premium_type, ci_benefit, remarks,
      client_type, residency, nationality, insurer, plan_name, plan_kb_id, currency, amount_basis, amount,
      compare_term, compare_product_1, compare_kb_1, compare_product_2, compare_kb_2)
  values (auth.uid(), 'All', 'Term life', public.age_band_of(dob), dob, p ->> 'gender', (p ->> 'smoker')::boolean,
      btrim(p ->> 'coverage_term'), public.amount_text(p), 'Annual', coalesce((p ->> 'ci_benefit')::boolean, false),
      nullif(btrim(p ->> 'remarks'), ''),
      btrim(p ->> 'client_type'), btrim(p ->> 'residency'), btrim(p ->> 'nationality'), fp ->> 'insurer', fp ->> 'plan_name',
      (fp ->> 'plan_kb_id')::uuid, btrim(p ->> 'currency'), coalesce(p ->> 'amount_basis', 'sum_assured'), (p ->> 'amount')::numeric,
      (fp ->> 'compare_term')::boolean, fp ->> 'compare_product_1', (fp ->> 'compare_kb_1')::uuid,
      fp ->> 'compare_product_2', (fp ->> 'compare_kb_2')::uuid)
  returning id, ref into rid, rref;
  insert into public.request_clients (request_id, owner_id, client_name, contact)
  values (rid, auth.uid(), btrim(p_client ->> 'client_name'), nullif(btrim(p_client ->> 'contact'), ''));
  perform public.add_event(rid, 'submitted', null, 'submitted');
  perform public.log_event('request.submitted', 'pi_request', rref);
  return rid;
end $$;

create or replace function public.update_request(p_request uuid, p jsonb, p_client jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare r public.pi_requests; dob date; fp jsonb;
begin
  select * into r from public.pi_requests where id = p_request for update;
  if r.id is null or r.introducer_id <> auth.uid() or not public.has_role('introducer') then raise exception 'Not your request'; end if;
  if r.status not in ('submitted', 'sent_back') then raise exception 'This request can no longer be edited'; end if;
  dob := public.check_dob(p);
  perform public.check_fields(p);
  fp := public.form_products(p);
  update public.pi_requests set
    age_band = public.age_band_of(dob), date_of_birth = dob, gender = p ->> 'gender', smoker = (p ->> 'smoker')::boolean,
    coverage_term = btrim(p ->> 'coverage_term'), sum_assured_band = public.amount_text(p),
    ci_benefit = coalesce((p ->> 'ci_benefit')::boolean, false), remarks = nullif(btrim(p ->> 'remarks'), ''),
    client_type = btrim(p ->> 'client_type'), residency = btrim(p ->> 'residency'), nationality = btrim(p ->> 'nationality'),
    insurer = fp ->> 'insurer', plan_name = fp ->> 'plan_name', plan_kb_id = (fp ->> 'plan_kb_id')::uuid,
    currency = btrim(p ->> 'currency'), amount_basis = coalesce(p ->> 'amount_basis', 'sum_assured'), amount = (p ->> 'amount')::numeric,
    compare_term = (fp ->> 'compare_term')::boolean, compare_product_1 = fp ->> 'compare_product_1', compare_kb_1 = (fp ->> 'compare_kb_1')::uuid,
    compare_product_2 = fp ->> 'compare_product_2', compare_kb_2 = (fp ->> 'compare_kb_2')::uuid,
    updated_at = now()
  where id = r.id;
  if p_client is not null then
    if coalesce(btrim(p_client ->> 'client_name'), '') = '' then raise exception 'Enter the client name'; end if;
    update public.request_clients set client_name = btrim(p_client ->> 'client_name'),
      contact = coalesce(nullif(btrim(p_client ->> 'contact'), ''), contact)
    where request_id = r.id;
  end if;
  perform public.add_event(r.id, 'edited', r.status, r.status);
  perform public.log_event('request.edited', 'pi_request', r.ref);
end $$;

-- The app reads requests through this view; the new form's fields are added at the end.
create or replace view public.request_list with (security_barrier = true) as
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
       case when st.staff then r.paused_at end as paused_at,
       r.date_of_birth,
       r.client_type, r.residency, r.nationality, r.insurer, r.plan_name, r.plan_kb_id, r.currency, r.amount_basis, r.amount,
       r.compare_term, r.compare_product_1, r.compare_kb_1, r.compare_product_2, r.compare_kb_2
  from public.pi_requests r
  cross join lateral (select public.has_role('ops') or public.has_role('bsd') as staff) st
 where public.can_view_request(r.id);

-- Knowledge Hub module: the Knowledge Bank screens (23 Nov 2026, Kumar: "Implement the knowledge bank under
-- Knowledge Hub module").
--
-- * Knowledge Hub goes live. By default ops and bsd have it; introducers can be given it by an admin (they then see
--   only checked, current documents).
-- * Documents: upload a PDF with its insurer, product, type, version, effective and valid-until dates. A new version
--   replaces the earlier one once it is checked. A second person checks each upload (not the uploader).
-- * Product records: ops or bsd fill in a product's facts, each naming the document and page it came from, and the
--   premium rates. Changes are kept as a draft next to the checked version (which stays in Compare products), are
--   sent for checking, and a BSD person who did not make them marks them as checked or sends them back. Each
--   checked version is kept in the history.
-- * Files live in the private storage bucket "kb-docs". Deleting goes through the Storage API (never SQL).
-- Safe to run more than once.

-- ---------------------------------------------------------------------------
-- The module
-- ---------------------------------------------------------------------------
do $$ begin
  -- Only the first time (the module was "coming soon"): switch it on for ops and bsd. Later runs keep the admin's choices.
  if exists (select 1 from public.app_modules where key = 'knowledge_hub' and not live) then
    update public.module_role_defaults set enabled = true where module_key = 'knowledge_hub' and role in ('ops', 'bsd');
  end if;
end $$;
update public.app_modules set live = true,
  description = 'Knowledge Bank: insurer documents with versions and expiry, and checked product facts'
 where key = 'knowledge_hub';

-- Ops and bsd with the Knowledge Hub module keep the Knowledge Bank (upload, edit).
create or replace function public.kb_member()
returns boolean language sql stable security definer set search_path = public as $$
  select (public.is_role('ops') or public.is_role('bsd')) and public.has_module('knowledge_hub');
$$;
-- BSD with the module check other people's uploads and changes.
create or replace function public.kb_checker()
returns boolean language sql stable security definer set search_path = public as $$
  select public.is_role('bsd') and public.has_module('knowledge_hub');
$$;
-- Anyone with the module reads checked, current documents (introducers too, when an admin gives it to them).
create or replace function public.kb_reader()
returns boolean language sql stable security definer set search_path = public as $$
  select public.has_module('knowledge_hub') and not public.is_role('admin');
$$;
revoke execute on function public.kb_member(), public.kb_checker(), public.kb_reader() from public, anon;
grant execute on function public.kb_member(), public.kb_checker(), public.kb_reader() to authenticated;

-- ---------------------------------------------------------------------------
-- Columns
-- ---------------------------------------------------------------------------
alter table public.kb_documents
  add column if not exists file_name text,
  add column if not exists file_size bigint,
  add column if not exists replaces uuid references public.kb_documents (id) on delete set null,
  add column if not exists replaced_by uuid references public.kb_documents (id) on delete set null,
  add column if not exists checked_at timestamptz,
  add column if not exists updated_at timestamptz not null default now();
-- A document no longer belongs to a product's life: removing a product keeps its documents (product left empty).
alter table public.kb_documents drop constraint if exists kb_documents_product_id_fkey;
alter table public.kb_documents add constraint kb_documents_product_id_fkey
  foreign key (product_id) references public.kb_products (id) on delete set null;

alter table public.kb_products drop constraint if exists kb_products_status_check;
alter table public.kb_products add constraint kb_products_status_check check (status in ('draft', 'check', 'verified', 'withdrawn'));
alter table public.kb_products
  add column if not exists pending jsonb check (pending is null or jsonb_typeof(pending) = 'object'),
  add column if not exists pending_state text check (pending_state in ('draft', 'check')),
  add column if not exists pending_by uuid references public.profiles (id) on delete set null,
  add column if not exists pending_at timestamptz,
  add column if not exists pending_note text,
  add column if not exists submitted_by uuid references public.profiles (id) on delete set null;
-- The sample "check" status is now a pending change; nothing else used it.
update public.kb_products set status = 'draft' where status = 'check';

create table if not exists public.kb_product_history (
  id bigint generated always as identity primary key,
  product_id uuid not null references public.kb_products (id) on delete cascade,
  version int not null,
  record jsonb not null,
  changed_by uuid references public.profiles (id) on delete set null,
  checked_by uuid references public.profiles (id) on delete set null,
  checked_at timestamptz not null default now()
);
create index if not exists kb_product_history_product on public.kb_product_history (product_id, version desc);

-- ---------------------------------------------------------------------------
-- Reading rules
-- ---------------------------------------------------------------------------
-- The documents a product's facts name (each fact, plus the Product Summary and rate sheet).
create or replace function public.kb_fact_docs(p_facts jsonb)
returns uuid[] language sql immutable as $$
  select coalesce(array_agg(distinct (e.value ->> 'doc')::uuid), '{}')
    from jsonb_each(coalesce(p_facts, '{}')) e
   where jsonb_typeof(e.value) = 'object' and coalesce(e.value ->> 'doc', '') ~ '^[0-9a-f-]{36}$';
$$;

-- A product can be compared when it was checked and none of the documents its facts rely on is out of date
-- (a brochure or campaign flyer that expires does not take it out).
create or replace function public.kb_product_usable(p_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.kb_products p
     where p.id = p_id and p.status = 'verified'
       and not exists (select 1 from public.kb_documents d
                        where d.id = any (public.kb_fact_docs(p.facts)) and d.valid_until < current_date));
$$;

-- The documents the comparison shows as sources: those named by a comparable product's facts.
create or replace view public.kb_checked_documents with (security_barrier = true) as
select d.id, d.product_id, d.insurer, d.title, d.doc_type, d.version, d.effective_from, d.valid_until
  from public.kb_documents d
 where public.can_compare_products()
   and exists (select 1 from public.kb_products p where d.id = any (public.kb_fact_docs(p.facts)) and public.kb_product_usable(p.id));

alter table public.kb_product_history enable row level security;
revoke all on public.kb_product_history from public, anon, authenticated;
grant select on public.kb_product_history to authenticated;
drop policy if exists kb_history_read on public.kb_product_history;
create policy kb_history_read on public.kb_product_history for select to authenticated using (public.kb_member());

drop policy if exists kb_products_staff on public.kb_products;
create policy kb_products_staff on public.kb_products for select to authenticated using (public.kb_member());
drop policy if exists kb_rates_staff on public.kb_rates;
create policy kb_rates_staff on public.kb_rates for select to authenticated using (public.kb_member());
drop policy if exists kb_documents_staff on public.kb_documents;
create policy kb_documents_staff on public.kb_documents for select to authenticated
  using (public.kb_member() or (public.kb_reader() and status = 'checked' and replaced_by is null));

-- ---------------------------------------------------------------------------
-- Files (private bucket "kb-docs"; path: <random folder>/<file name>)
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public) values ('kb-docs', 'kb-docs', false) on conflict (id) do nothing;
create or replace function public.kb_file_listed(p_path text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.kb_documents where storage_path = p_path)
$$;
revoke execute on function public.kb_file_listed(text) from public, anon;
grant execute on function public.kb_file_listed(text) to authenticated;
drop policy if exists "kb docs upload" on storage.objects;
create policy "kb docs upload" on storage.objects for insert to authenticated
  with check (bucket_id = 'kb-docs' and public.kb_member());
drop policy if exists "kb docs read" on storage.objects;
create policy "kb docs read" on storage.objects for select to authenticated
  using (bucket_id = 'kb-docs' and (
    (public.kb_member() and (public.kb_file_listed(name) or owner = auth.uid()))
    or (public.kb_reader() and exists (select 1 from public.kb_documents d where d.storage_path = name and d.status = 'checked' and d.replaced_by is null))));
drop policy if exists "kb docs delete" on storage.objects;
create policy "kb docs delete" on storage.objects for delete to authenticated
  using (bucket_id = 'kb-docs' and public.kb_member() and not public.kb_file_listed(name));

-- ---------------------------------------------------------------------------
-- Documents
-- ---------------------------------------------------------------------------
create or replace function public.kb_doc_fields(p jsonb)
returns void language plpgsql stable as $$
begin
  if coalesce(btrim(p ->> 'insurer'), '') = '' then raise exception 'Fill in the insurer'; end if;
  if coalesce(btrim(p ->> 'title'), '') = '' then raise exception 'Fill in the document name'; end if;
  if coalesce(p ->> 'doc_type', '') not in ('Product Summary', 'Rate sheet', 'Brochure', 'Policy wording', 'Guide', 'Campaign', 'Regulatory', 'Other') then
    raise exception 'Choose the document type';
  end if;
  if nullif(p ->> 'effective_from', '') is null then raise exception 'Fill in the effective date'; end if;
  if nullif(p ->> 'valid_until', '') is not null and (p ->> 'valid_until')::date < (p ->> 'effective_from')::date then
    raise exception 'The valid-until date is before the effective date';
  end if;
end $$;

-- Lists an uploaded file. p: insurer, product_id (optional), title, doc_type, version, effective_from, valid_until,
-- storage_path, file_name, file_size, replaces (optional: the document this is a new version of).
create or replace function public.kb_add_document(p jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare d uuid; old public.kb_documents;
begin
  if not public.kb_member() then raise exception 'Only ops and BSD with the Knowledge Hub can upload documents'; end if;
  perform public.kb_doc_fields(p);
  if coalesce(p ->> 'storage_path', '') = '' then raise exception 'Choose a file'; end if;
  if nullif(p ->> 'replaces', '') is not null then
    select * into old from public.kb_documents where id = (p ->> 'replaces')::uuid;
    if old.id is null then raise exception 'The document to replace is gone. Choose it again'; end if;
    if old.replaced_by is not null then raise exception 'That document was already replaced by a newer version'; end if;
  end if;
  insert into public.kb_documents (product_id, insurer, title, doc_type, version, effective_from, valid_until, storage_path,
                                   file_name, file_size, replaces, status, uploaded_by)
  values (nullif(p ->> 'product_id', '')::uuid, btrim(p ->> 'insurer'), left(btrim(p ->> 'title'), 200), p ->> 'doc_type',
          left(coalesce(btrim(p ->> 'version'), ''), 40), (p ->> 'effective_from')::date, nullif(p ->> 'valid_until', '')::date,
          p ->> 'storage_path', left(coalesce(p ->> 'file_name', ''), 255), nullif(p ->> 'file_size', '')::bigint, old.id, 'new', auth.uid())
  returning id into d;
  perform public.log_event('kb.document_uploaded', 'kb_document', d::text,
    jsonb_build_object('title', btrim(p ->> 'title'), 'insurer', btrim(p ->> 'insurer'), 'replaces', old.title));
  return d;
end $$;

-- Changes a document's details. A checked document goes back to "new" and must be checked again.
create or replace function public.kb_update_document(p_id uuid, p jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare d public.kb_documents;
begin
  if not public.kb_member() then raise exception 'Only ops and BSD with the Knowledge Hub can change documents'; end if;
  select * into d from public.kb_documents where id = p_id;
  if d.id is null then raise exception 'Document not found'; end if;
  perform public.kb_doc_fields(p);
  update public.kb_documents set insurer = btrim(p ->> 'insurer'), product_id = nullif(p ->> 'product_id', '')::uuid,
         title = left(btrim(p ->> 'title'), 200), doc_type = p ->> 'doc_type', version = left(coalesce(btrim(p ->> 'version'), ''), 40),
         effective_from = (p ->> 'effective_from')::date, valid_until = nullif(p ->> 'valid_until', '')::date,
         status = 'new', checked_by = null, checked_at = null, updated_at = now(), uploaded_by = auth.uid()
   where id = p_id;
  perform public.log_event('kb.document_changed', 'kb_document', p_id::text, jsonb_build_object('title', btrim(p ->> 'title')));
end $$;

-- A BSD person who did not upload (or last change) the document confirms its details. A new version then replaces
-- the one before: products whose facts name the old version get a draft that names the new one, to be re-checked.
create or replace function public.kb_check_document(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare d public.kb_documents; pr record; base jsonb;
begin
  if not public.kb_checker() then raise exception 'Only BSD with the Knowledge Hub can check documents'; end if;
  select * into d from public.kb_documents where id = p_id;
  if d.id is null then raise exception 'Document not found'; end if;
  if d.status = 'checked' then return; end if;
  if d.uploaded_by = auth.uid() then raise exception 'You uploaded this document, so someone else must check it'; end if;
  update public.kb_documents set status = 'checked', checked_by = auth.uid(), checked_at = now() where id = p_id;
  if d.replaces is not null then
    update public.kb_documents set replaced_by = p_id, updated_at = now() where id = d.replaces;
    for pr in select * from public.kb_products p
               where d.replaces = any (public.kb_fact_docs(p.facts)) or d.replaces = any (public.kb_fact_docs(p.pending -> 'facts')) loop
      base := coalesce(pr.pending, public.kb_record(pr.id));
      base := jsonb_set(base, '{facts}', public.kb_swap_doc(base -> 'facts', d.replaces, p_id));
      update public.kb_products set pending = base, pending_state = 'draft', pending_at = now(),
             pending_by = coalesce(pending_by, d.uploaded_by),
             pending_note = format('New version of "%s" checked. Compare the facts with it, then send for check.', d.title)
       where id = pr.id;
    end loop;
  end if;
  perform public.log_event('kb.document_checked', 'kb_document', p_id::text, jsonb_build_object('title', d.title));
end $$;

-- Takes a document off the list. The app then deletes the file through the Storage API.
create or replace function public.kb_remove_document(p_id uuid)
returns text language plpgsql security definer set search_path = public as $$
declare d public.kb_documents;
begin
  if not public.kb_member() then raise exception 'Only ops and BSD with the Knowledge Hub can remove documents'; end if;
  select * into d from public.kb_documents where id = p_id;
  if d.id is null then raise exception 'Document not found'; end if;
  if d.status = 'checked' and not public.kb_checker() then raise exception 'Only BSD can remove a checked document'; end if;
  if exists (select 1 from public.kb_products p
              where p_id = any (public.kb_fact_docs(p.facts)) or p_id = any (public.kb_fact_docs(p.pending -> 'facts'))) then
    raise exception 'A product record names this document. Change the product record first';
  end if;
  update public.kb_documents set replaced_by = null where replaced_by = p_id;
  delete from public.kb_documents where id = p_id;
  perform public.log_event('kb.document_removed', 'kb_document', p_id::text, jsonb_build_object('title', d.title));
  return d.storage_path;
end $$;

-- ---------------------------------------------------------------------------
-- Product records
-- ---------------------------------------------------------------------------
-- The checked record as the JSON the screens edit.
create or replace function public.kb_record(p_id uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('insurer', p.insurer, 'name', p.name, 'category', p.category, 'dpi', p.dpi,
           'jurisdiction', p.jurisdiction, 'currencies', to_jsonb(p.currencies), 'entry_age_min', p.entry_age_min,
           'entry_age_max', p.entry_age_max, 'residency', to_jsonb(p.residency), 'sa_min', p.sa_min, 'sa_max', p.sa_max,
           'has_tpd', p.has_tpd, 'has_ci', p.has_ci, 'facts', p.facts)
    from public.kb_products p where p.id = p_id and public.kb_member();
$$;

create or replace function public.kb_swap_doc(p_facts jsonb, p_old uuid, p_new uuid)
returns jsonb language sql immutable as $$
  select coalesce(jsonb_object_agg(e.key, case when e.value ->> 'doc' = p_old::text then jsonb_set(e.value, '{doc}', to_jsonb(p_new::text)) else e.value end), '{}')
    from jsonb_each(coalesce(p_facts, '{}')) e;
$$;

-- Checks a record before it is saved. Returns it tidied (only the known keys).
create or replace function public.kb_clean_record(p jsonb)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare f record; facts jsonb := '{}'; amin int; amax int; smin numeric; smax numeric; cur jsonb; res jsonb;
begin
  if coalesce(btrim(p ->> 'insurer'), '') = '' then raise exception 'Fill in the insurer'; end if;
  if coalesce(btrim(p ->> 'name'), '') = '' then raise exception 'Fill in the product name'; end if;
  if coalesce(p ->> 'category', '') not in ('Insurance', 'Investment') then raise exception 'Choose the category'; end if;
  if coalesce(p ->> 'jurisdiction', '') not in ('Onshore', 'Offshore') then raise exception 'Choose onshore or offshore'; end if;
  cur := coalesce(p -> 'currencies', '[]'); res := coalesce(p -> 'residency', '[]');
  if jsonb_typeof(cur) <> 'array' or jsonb_array_length(cur) = 0 then raise exception 'Choose at least one policy currency'; end if;
  if jsonb_typeof(res) <> 'array' or jsonb_array_length(res) = 0 then raise exception 'Choose who can apply'; end if;
  begin
    amin := (p ->> 'entry_age_min')::int; amax := (p ->> 'entry_age_max')::int;
    smin := nullif(p ->> 'sa_min', '')::numeric; smax := nullif(p ->> 'sa_max', '')::numeric;
  exception when others then raise exception 'Entry ages and sums assured must be numbers'; end;
  if amin is null or amax is null or amin < 0 or amax > 100 or amin > amax then raise exception 'Check the entry ages (0 to 100, lowest first)'; end if;
  if smin is not null and smax is not null and smin > smax then raise exception 'The minimum sum assured is more than the maximum'; end if;
  for f in select key, value from jsonb_each(coalesce(p -> 'facts', '{}')) loop
    if f.key in ('_ps', '_rs') then
      if coalesce(f.value ->> 'doc', '') = '' then continue; end if;
    elsif coalesce(btrim(f.value ->> 'v'), '') = '' then continue;
    end if;
    if coalesce(f.value ->> 'doc', '') = '' or not exists (select 1 from public.kb_documents where id::text = f.value ->> 'doc') then
      raise exception 'Choose the source document for every fact (missing for "%")', f.key;
    end if;
    facts := facts || jsonb_build_object(f.key, jsonb_strip_nulls(jsonb_build_object(
      'v', case when f.key in ('_ps', '_rs') then null else left(btrim(f.value ->> 'v'), 600) end,
      'doc', f.value ->> 'doc', 'page', case when coalesce(f.value ->> 'page', '') ~ '^\d{1,4}$' then (f.value ->> 'page')::int end)));
  end loop;
  return jsonb_build_object('insurer', btrim(p ->> 'insurer'), 'name', btrim(p ->> 'name'), 'category', p ->> 'category',
    'dpi', coalesce((p ->> 'dpi')::boolean, false), 'jurisdiction', p ->> 'jurisdiction', 'currencies', cur,
    'entry_age_min', amin, 'entry_age_max', amax, 'residency', res, 'sa_min', smin, 'sa_max', smax,
    'has_tpd', coalesce((p ->> 'has_tpd')::boolean, false), 'has_ci', coalesce((p ->> 'has_ci')::boolean, false), 'facts', facts)
    || case when p ? 'rates' then jsonb_build_object('rates', public.kb_clean_rates(p -> 'rates')) else '{}' end;
end $$;

-- Rates as [{age, gender, smoker, rate, ci_rate}], checked.
create or replace function public.kb_clean_rates(p jsonb)
returns jsonb language plpgsql immutable as $$
declare r jsonb; out jsonb := '[]'; seen text[] := '{}'; k text;
begin
  if p is null or jsonb_typeof(p) <> 'array' then raise exception 'Rates must be a list'; end if;
  for r in select * from jsonb_array_elements(p) loop
    begin
      if (r ->> 'age')::int not between 0 and 100 or (r ->> 'gender') not in ('Male', 'Female') or (r ->> 'rate')::numeric <= 0
         or (nullif(r ->> 'ci_rate', '')::numeric <= 0) then raise exception 'bad'; end if;
      k := (r ->> 'age') || (r ->> 'gender') || ((r ->> 'smoker')::boolean)::text;
    exception when others then raise exception 'Check the rates: each line needs age, gender (Male/Female), smoker (yes/no) and a rate above 0'; end;
    if k = any (seen) then raise exception 'The rates list age %, %, % twice', r ->> 'age', r ->> 'gender', case when (r ->> 'smoker')::boolean then 'smoker' else 'non-smoker' end; end if;
    seen := seen || k;
    out := out || jsonb_build_array(jsonb_build_object('age', (r ->> 'age')::int, 'gender', r ->> 'gender', 'smoker', (r ->> 'smoker')::boolean,
                                                       'rate', (r ->> 'rate')::numeric, 'ci_rate', nullif(r ->> 'ci_rate', '')::numeric));
  end loop;
  return out;
end $$;

-- Saves a product record as a draft (a new product when p_id is null). The checked version, if any, stays in
-- Compare products until the draft is checked. Saving a change that is waiting for check takes it back to draft.
create or replace function public.kb_save_product(p_id uuid, p jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare rec jsonb; pr public.kb_products; v_id uuid := p_id;
begin
  if not public.kb_member() then raise exception 'Only ops and BSD with the Knowledge Hub can edit product records'; end if;
  rec := public.kb_clean_record(p);
  if exists (select 1 from public.kb_products where lower(insurer) = lower(rec ->> 'insurer') and lower(name) = lower(rec ->> 'name')
              and kb_products.id is distinct from p_id) then
    raise exception 'There is already a product record for % %', rec ->> 'insurer', rec ->> 'name';
  end if;
  if p_id is null then
    insert into public.kb_products (insurer, name, status, created_by, pending, pending_state, pending_by, pending_at)
    values (rec ->> 'insurer', rec ->> 'name', 'draft', auth.uid(), rec, 'draft', auth.uid(), now())
    returning kb_products.id into v_id;
  else
    select * into pr from public.kb_products where kb_products.id = p_id for update;
    if pr.id is null then raise exception 'Product record not found'; end if;
    update public.kb_products set pending = rec, pending_state = 'draft', pending_by = auth.uid(), pending_at = now(),
           -- a product never checked keeps its name in step, so lists and the duplicate check use it
           insurer = case when pr.status = 'draft' then rec ->> 'insurer' else insurer end,
           name = case when pr.status = 'draft' then rec ->> 'name' else name end, updated_at = now()
     where kb_products.id = p_id;
  end if;
  perform public.log_event('kb.product_saved', 'kb_product', v_id::text, jsonb_build_object('product', (rec ->> 'insurer') || ' · ' || (rec ->> 'name')));
  return v_id;
end $$;

create or replace function public.kb_send_for_check(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare pr public.kb_products;
begin
  if not public.kb_member() then raise exception 'Only ops and BSD with the Knowledge Hub can send records for check'; end if;
  select * into pr from public.kb_products where id = p_id for update;
  if pr.id is null or pr.pending is null then raise exception 'There are no changes to send for check'; end if;
  if pr.pending_state = 'check' then return; end if;
  update public.kb_products set pending_state = 'check', submitted_by = auth.uid(), pending_note = null, updated_at = now() where id = p_id;
  perform public.log_event('kb.product_sent_for_check', 'kb_product', p_id::text, jsonb_build_object('product', (pr.pending ->> 'insurer') || ' · ' || (pr.pending ->> 'name')));
end $$;

-- Maker-checker: a BSD person who neither made nor sent the change marks it as checked. The record then becomes the
-- version Compare products uses, and goes into the history.
create or replace function public.kb_check_product(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare pr public.kb_products; rec jsonb; nv int; bad text;
begin
  if not public.kb_checker() then raise exception 'Only BSD with the Knowledge Hub can check product records'; end if;
  select * into pr from public.kb_products where id = p_id for update;
  if pr.id is null or pr.pending is null or pr.pending_state <> 'check' then raise exception 'This record is not waiting for check'; end if;
  if auth.uid() in (pr.pending_by, pr.submitted_by) then raise exception 'You made or sent these changes, so someone else must check them'; end if;
  rec := pr.pending;
  select string_agg(d.title, ', ') into bad from public.kb_documents d
   where d.id = any (public.kb_fact_docs(rec -> 'facts')) and (d.status <> 'checked' or d.valid_until < current_date);
  if bad is not null then raise exception 'These documents are not checked or are out of date: %', bad; end if;
  nv := case when pr.status in ('verified', 'withdrawn') or pr.verified_at is not null then pr.version + 1 else pr.version end;
  update public.kb_products set insurer = rec ->> 'insurer', name = rec ->> 'name', category = rec ->> 'category',
         dpi = (rec ->> 'dpi')::boolean, jurisdiction = rec ->> 'jurisdiction',
         currencies = array(select jsonb_array_elements_text(rec -> 'currencies')),
         entry_age_min = (rec ->> 'entry_age_min')::int, entry_age_max = (rec ->> 'entry_age_max')::int,
         residency = array(select jsonb_array_elements_text(rec -> 'residency')),
         sa_min = nullif(rec ->> 'sa_min', '')::numeric, sa_max = nullif(rec ->> 'sa_max', '')::numeric,
         has_tpd = (rec ->> 'has_tpd')::boolean, has_ci = (rec ->> 'has_ci')::boolean, facts = rec -> 'facts',
         status = 'verified', version = nv, verified_by = auth.uid(), verified_at = now(),
         pending = null, pending_state = null, pending_note = null, pending_at = null, submitted_by = null, updated_at = now()
   where id = p_id;
  if rec ? 'rates' then
    delete from public.kb_rates where product_id = p_id;
    insert into public.kb_rates (product_id, age, gender, smoker, rate, ci_rate)
    select p_id, (r ->> 'age')::int, r ->> 'gender', (r ->> 'smoker')::boolean, (r ->> 'rate')::numeric, nullif(r ->> 'ci_rate', '')::numeric
      from jsonb_array_elements(rec -> 'rates') r;
  end if;
  insert into public.kb_product_history (product_id, version, record, changed_by, checked_by)
  values (p_id, nv, rec - 'rates' || jsonb_build_object('rates_changed', rec ? 'rates'), pr.pending_by, auth.uid());
  perform public.log_event('kb.product_checked', 'kb_product', p_id::text,
    jsonb_build_object('product', (rec ->> 'insurer') || ' · ' || (rec ->> 'name'), 'version', nv));
end $$;

create or replace function public.kb_send_back_product(p_id uuid, p_note text)
returns void language plpgsql security definer set search_path = public as $$
declare pr public.kb_products;
begin
  if not public.kb_checker() then raise exception 'Only BSD with the Knowledge Hub can send records back'; end if;
  if coalesce(btrim(p_note), '') = '' then raise exception 'Say what needs changing'; end if;
  select * into pr from public.kb_products where id = p_id for update;
  if pr.id is null or pr.pending_state is distinct from 'check' then raise exception 'This record is not waiting for check'; end if;
  update public.kb_products set pending_state = 'draft', pending_note = left(btrim(p_note), 1000), updated_at = now() where id = p_id;
  perform public.log_event('kb.product_sent_back', 'kb_product', p_id::text,
    jsonb_build_object('product', (pr.pending ->> 'insurer') || ' · ' || (pr.pending ->> 'name'), 'reason', btrim(p_note)));
end $$;

-- Throws away the draft. A product that was never checked is deleted with it (its documents stay).
create or replace function public.kb_discard_draft(p_id uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare pr public.kb_products;
begin
  if not public.kb_member() then raise exception 'Only ops and BSD with the Knowledge Hub can discard drafts'; end if;
  select * into pr from public.kb_products where id = p_id for update;
  if pr.id is null then raise exception 'Product record not found'; end if;
  if pr.status = 'draft' and pr.verified_at is null then
    delete from public.kb_products where id = p_id;
    perform public.log_event('kb.product_discarded', 'kb_product', p_id::text, jsonb_build_object('product', pr.insurer || ' · ' || pr.name, 'deleted', true));
    return true;
  end if;
  update public.kb_products set pending = null, pending_state = null, pending_note = null, pending_at = null, submitted_by = null, updated_at = now() where id = p_id;
  perform public.log_event('kb.product_discarded', 'kb_product', p_id::text, jsonb_build_object('product', pr.insurer || ' · ' || pr.name));
  return false;
end $$;

-- BSD take a product out of Compare products (bring it back by checking a change to it).
create or replace function public.kb_withdraw_product(p_id uuid, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare pr public.kb_products;
begin
  if not public.kb_checker() then raise exception 'Only BSD with the Knowledge Hub can withdraw products'; end if;
  if coalesce(btrim(p_reason), '') = '' then raise exception 'Give a reason'; end if;
  select * into pr from public.kb_products where id = p_id for update;
  if pr.id is null or pr.status <> 'verified' then raise exception 'Only a checked product can be withdrawn'; end if;
  update public.kb_products set status = 'withdrawn', updated_at = now() where id = p_id;
  perform public.log_event('kb.product_withdrawn', 'kb_product', p_id::text,
    jsonb_build_object('product', pr.insurer || ' · ' || pr.name, 'reason', btrim(p_reason)));
end $$;

revoke execute on function public.kb_doc_fields(jsonb), public.kb_clean_record(jsonb), public.kb_clean_rates(jsonb),
  public.kb_swap_doc(jsonb, uuid, uuid) from public, anon, authenticated;
revoke execute on function public.kb_add_document(jsonb), public.kb_update_document(uuid, jsonb), public.kb_check_document(uuid),
  public.kb_remove_document(uuid), public.kb_record(uuid), public.kb_save_product(uuid, jsonb), public.kb_send_for_check(uuid),
  public.kb_check_product(uuid), public.kb_send_back_product(uuid, text), public.kb_discard_draft(uuid),
  public.kb_withdraw_product(uuid, text) from public, anon;
grant execute on function public.kb_add_document(jsonb), public.kb_update_document(uuid, jsonb), public.kb_check_document(uuid),
  public.kb_remove_document(uuid), public.kb_save_product(uuid, jsonb), public.kb_send_for_check(uuid),
  public.kb_check_product(uuid), public.kb_send_back_product(uuid, text), public.kb_discard_draft(uuid),
  public.kb_withdraw_product(uuid, text) to authenticated;
grant execute on function public.kb_record(uuid) to authenticated;

-- Product Comparison Matrix module (23 Nov 2026, Kumar: the Compare products pop-up "appears under Product
-- Comparison Matrix for all users which have it, and there's an option to add the selected products to whichever PI
-- they're working on, using the PI number").
--
-- * The module goes live. By default introducers, ops and bsd have it (an admin can switch it off per user or role).
-- * Its page is the same finder and side-by-side table as the pop-up on the PI request form, reading the same checked
--   Knowledge Bank products. Users with only this module (PI Requests off) can still compare.
-- * "Add to PI request": the 2 or 3 chosen products become the request's product (field 9) and the products to
--   compare (12 and 13), on a request the user may change, chosen by its PI number:
--     introducer: their own request while it is submitted or sent back (the same rule as editing it);
--     ops: a request assigned to them that is not completed or removed;
--     bsd: any request that is not completed or removed.
--   Adding needs PI Requests too (that module decides who works on requests). The request's history and the audit
--   log record it.
-- Safe to run more than once.

do $$ begin
  -- Only the first time (the module was "coming soon"): switch it on for every role that can have it.
  if exists (select 1 from public.app_modules where key = 'product_matrix' and not live) then
    update public.module_role_defaults set enabled = true where module_key = 'product_matrix' and role in ('introducer', 'ops', 'bsd');
  end if;
end $$;
update public.app_modules set live = true,
  description = 'Find and compare checked term products side by side, and add them to a PI request'
 where key = 'product_matrix';

-- Who can read the checked products: PI Requests users (the form's pop-up) and Product Comparison Matrix users.
create or replace function public.can_compare_products()
returns boolean language sql stable security definer set search_path = public as $$
  select public.has_role('introducer') or public.has_role('ops') or public.has_role('bsd')
      or ((public.is_role('introducer') or public.is_role('ops') or public.is_role('bsd')) and public.has_module('product_matrix'));
$$;
revoke execute on function public.can_compare_products() from public, anon;
grant execute on function public.can_compare_products() to authenticated;

-- May the current user put products on this request?
create or replace function public.can_add_products(r public.pi_requests)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(public.has_module('product_matrix') and (
       (public.has_role('introducer') and r.introducer_id = auth.uid() and r.status in ('submitted', 'sent_back'))
    or (public.has_role('ops') and r.assignee_id = auth.uid() and r.status not in ('completed', 'removed'))
    or (public.has_role('bsd') and r.status not in ('completed', 'removed'))), false);
$$;
revoke execute on function public.can_add_products(public.pi_requests) from public, anon, authenticated;

-- The requests the current user can add products to (for the picker on the matrix page).
create or replace function public.requests_for_products()
returns table (id uuid, ref text, status request_status, insurer text, plan_name text, compare_term boolean, submitted_at timestamptz)
language sql stable security definer set search_path = public as $$
  select r.id, r.ref, r.status, r.insurer, r.plan_name, r.compare_term, r.submitted_at
    from public.pi_requests r
   where public.can_add_products(r)
   order by r.submitted_at desc
   limit 200;
$$;
revoke execute on function public.requests_for_products() from public, anon;
grant execute on function public.requests_for_products() to authenticated;

-- Puts 2 or 3 checked products on a request: the first is the product (9), the others are compared (12, 13).
create or replace function public.add_products_to_request(p_ref text, p_ids uuid[])
returns uuid language plpgsql security definer set search_path = public as $$
declare r public.pi_requests; fp jsonb; n int := coalesce(array_length(p_ids, 1), 0); was text;
begin
  if not public.has_module('product_matrix') then raise exception 'You do not have the Product Comparison Matrix'; end if;
  select * into r from public.pi_requests where upper(ref) = upper(btrim(p_ref)) for update;
  if r.id is null or not public.can_view_request(r.id) then raise exception 'No PI request % that you can see', upper(btrim(p_ref)); end if;
  if not public.can_add_products(r) then
    raise exception 'You cannot change the products on % (it is %, or not yours to work on)', r.ref, replace(r.status::text, '_', ' ');
  end if;
  if n < 2 or n > 3 then raise exception 'Choose 2 or 3 products'; end if;
  if (select count(distinct x) from unnest(p_ids) x) <> n then raise exception 'Choose different products'; end if;
  fp := public.form_products(jsonb_build_object('plan_kb_id', p_ids[1], 'compare_term', true, 'compare_kb_1', p_ids[2], 'compare_kb_2', p_ids[3]));
  was := concat_ws(', ', nullif(concat_ws(' · ', r.insurer, r.plan_name), ''), r.compare_product_1, r.compare_product_2);
  update public.pi_requests set
    insurer = fp ->> 'insurer', plan_name = fp ->> 'plan_name', plan_kb_id = (fp ->> 'plan_kb_id')::uuid,
    compare_term = true, compare_product_1 = fp ->> 'compare_product_1', compare_kb_1 = (fp ->> 'compare_kb_1')::uuid,
    compare_product_2 = fp ->> 'compare_product_2', compare_kb_2 = (fp ->> 'compare_kb_2')::uuid, updated_at = now()
  where id = r.id;
  perform public.add_event(r.id, 'products_added', r.status, r.status,
    concat_ws(', ', (fp ->> 'insurer') || ' · ' || (fp ->> 'plan_name'), fp ->> 'compare_product_1', fp ->> 'compare_product_2'));
  perform public.log_event('request.products_added', 'pi_request', r.ref,
    jsonb_build_object('products', to_jsonb(array_remove(array[(fp ->> 'insurer') || ' · ' || (fp ->> 'plan_name'), fp ->> 'compare_product_1', fp ->> 'compare_product_2'], null)),
                       'before', nullif(was, '')));
  return r.id;
end $$;
revoke execute on function public.add_products_to_request(text, uuid[]) from public, anon;
grant execute on function public.add_products_to_request(text, uuid[]) to authenticated;

-- More Knowledge Bank document types (25 Nov 2026, Kumar: "add the option to add files other than just product
-- summaries, such as training material, Product Financing, Circulars, Others (whereby user will be prompted to fill
-- in a textbox and that will be the new name displayed)").
--
-- * New types: Training material, Product Financing, Circulars, and Others. "Others" needs a name typed by the
--   uploader (doc_type_name, up to 60 characters), shown everywhere instead of "Others".
-- * The old "Other" type becomes "Others" named "Other" (nothing is lost).
-- * For these four types the insurer is optional (a circular or training deck may not come from one insurer); the
--   product link stays optional for every type. Versions, expiry, checking and who can see them are unchanged.
-- Safe to run more than once.

alter table public.kb_documents add column if not exists doc_type_name text;
alter table public.kb_documents drop constraint if exists kb_documents_doc_type_check;
update public.kb_documents set doc_type = 'Others', doc_type_name = coalesce(nullif(btrim(doc_type_name), ''), 'Other')
 where doc_type = 'Other';
alter table public.kb_documents add constraint kb_documents_doc_type_check check (doc_type in (
  'Product Summary', 'Rate sheet', 'Brochure', 'Policy wording', 'Guide', 'Training material', 'Product Financing',
  'Circulars', 'Campaign', 'Regulatory', 'Others'));
alter table public.kb_documents drop constraint if exists kb_documents_doc_type_name_check;
alter table public.kb_documents add constraint kb_documents_doc_type_name_check check (
  (doc_type = 'Others' and length(btrim(coalesce(doc_type_name, ''))) between 1 and 60)
  or (doc_type <> 'Others' and doc_type_name is null));

-- Types whose insurer may be left blank.
create or replace function public.kb_type_needs_insurer(p_type text)
returns boolean language sql immutable as $$
  select coalesce(p_type, '') not in ('Training material', 'Product Financing', 'Circulars', 'Others')
$$;

create or replace function public.kb_doc_fields(p jsonb)
returns void language plpgsql stable as $$
begin
  if coalesce(p ->> 'doc_type', '') not in ('Product Summary', 'Rate sheet', 'Brochure', 'Policy wording', 'Guide',
       'Training material', 'Product Financing', 'Circulars', 'Campaign', 'Regulatory', 'Others') then
    raise exception 'Choose the document type';
  end if;
  if p ->> 'doc_type' = 'Others' and coalesce(btrim(p ->> 'doc_type_name'), '') = '' then
    raise exception 'Type a name for the document type';
  end if;
  if p ->> 'doc_type' = 'Others' and length(btrim(p ->> 'doc_type_name')) > 60 then
    raise exception 'Keep the document type name to 60 characters';
  end if;
  if public.kb_type_needs_insurer(p ->> 'doc_type') and coalesce(btrim(p ->> 'insurer'), '') = '' then
    raise exception 'Fill in the insurer';
  end if;
  if coalesce(btrim(p ->> 'title'), '') = '' then raise exception 'Fill in the document name'; end if;
  if nullif(p ->> 'effective_from', '') is null then raise exception 'Fill in the effective date'; end if;
  if nullif(p ->> 'valid_until', '') is not null and (p ->> 'valid_until')::date < (p ->> 'effective_from')::date then
    raise exception 'The valid-until date is before the effective date';
  end if;
end $$;

-- The type name to keep: the typed name for "Others", nothing for the rest.
create or replace function public.kb_doc_type_name(p jsonb)
returns text language sql immutable as $$
  select case when p ->> 'doc_type' = 'Others' then left(btrim(p ->> 'doc_type_name'), 60) end
$$;

-- Lists an uploaded file. p: insurer, product_id (optional), title, doc_type, doc_type_name (for "Others"), version,
-- effective_from, valid_until, storage_path, file_name, file_size, replaces (optional: the document this is a new version of).
create or replace function public.kb_add_document(p jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare d uuid; old public.kb_documents;
begin
  if not public.kb_member() then raise exception 'Only ops and BSD with the Knowledge Hub can upload documents'; end if;
  perform public.kb_doc_fields(p);
  if coalesce(p ->> 'storage_path', '') = '' then raise exception 'Choose a file'; end if;
  if nullif(p ->> 'replaces', '') is not null then
    select * into old from public.kb_documents where id = (p ->> 'replaces')::uuid;
    if old.id is null then raise exception 'The document to replace is gone. Choose it again'; end if;
    if old.replaced_by is not null then raise exception 'That document was already replaced by a newer version'; end if;
  end if;
  insert into public.kb_documents (product_id, insurer, title, doc_type, doc_type_name, version, effective_from, valid_until,
                                   storage_path, file_name, file_size, replaces, status, uploaded_by)
  values (nullif(p ->> 'product_id', '')::uuid, coalesce(btrim(p ->> 'insurer'), ''), left(btrim(p ->> 'title'), 200), p ->> 'doc_type',
          public.kb_doc_type_name(p), left(coalesce(btrim(p ->> 'version'), ''), 40), (p ->> 'effective_from')::date,
          nullif(p ->> 'valid_until', '')::date, p ->> 'storage_path', left(coalesce(p ->> 'file_name', ''), 255),
          nullif(p ->> 'file_size', '')::bigint, old.id, 'new', auth.uid())
  returning id into d;
  perform public.log_event('kb.document_uploaded', 'kb_document', d::text,
    jsonb_build_object('title', btrim(p ->> 'title'), 'insurer', nullif(btrim(p ->> 'insurer'), ''), 'replaces', old.title));
  return d;
end $$;

-- Changes a document's details. A checked document goes back to "new" and must be checked again.
create or replace function public.kb_update_document(p_id uuid, p jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare d public.kb_documents;
begin
  if not public.kb_member() then raise exception 'Only ops and BSD with the Knowledge Hub can change documents'; end if;
  select * into d from public.kb_documents where id = p_id;
  if d.id is null then raise exception 'Document not found'; end if;
  perform public.kb_doc_fields(p);
  update public.kb_documents set insurer = coalesce(btrim(p ->> 'insurer'), ''), product_id = nullif(p ->> 'product_id', '')::uuid,
         title = left(btrim(p ->> 'title'), 200), doc_type = p ->> 'doc_type', doc_type_name = public.kb_doc_type_name(p),
         version = left(coalesce(btrim(p ->> 'version'), ''), 40),
         effective_from = (p ->> 'effective_from')::date, valid_until = nullif(p ->> 'valid_until', '')::date,
         status = 'new', checked_by = null, checked_at = null, updated_at = now(), uploaded_by = auth.uid()
   where id = p_id;
  perform public.log_event('kb.document_changed', 'kb_document', p_id::text, jsonb_build_object('title', btrim(p ->> 'title')));
end $$;

revoke execute on function public.kb_type_needs_insurer(text), public.kb_doc_type_name(jsonb) from public, anon, authenticated;

-- Uploads become searchable products straight away (25 Nov 2026, Kumar: "Make it so that the bare upload is turned
-- into a searchable product immediately", "No extra BSD check should be required", "Allow edits and changes to the
-- product record if required but it is not a absolute necessary to make it a searchable product").
--
-- * Uploading a Product Summary or rate sheet reads it in the browser (rules, no AI) and kb_auto_product puts what
--   was read on a product record: a new one, or the existing record for the same insurer and product name (or the
--   record whose document this is a new version of). The record is in Compare products and the Product Comparison
--   Matrix at once, tagged "Auto-read, not yet reviewed" (auto_read) until someone saves or reviews it.
-- * Safeguard: a record is searchable only when the policy currency and entry ages are known (read from a document
--   or saved by a person). What is still missing is kept in kb_products.missing and shown as "why not searchable".
--   Facts the reader did not find stay blank (never guessed).
-- * No BSD check: documents are in use when uploaded (a new version replaces the old one at once), and saving a
--   product record puts it in search straight away. Every save and every read is a version in the history and in
--   the audit log. Any ops or BSD person with the Knowledge Hub can withdraw, put back or delete a record.
-- * Changes waiting for a check (or drafts) when this runs are put live, as their makers saved them. Documents
--   waiting for a check are put in use, and waiting new versions replace the old ones.
-- Safe to run more than once.

alter table public.kb_products
  add column if not exists auto_read boolean not null default false,       -- values read by the reader, nobody reviewed them yet
  add column if not exists auto_fields text[] not null default '{}',     -- what the reader filled in (fields and fact keys)
  add column if not exists missing text[] not null default '{}',         -- needed before it is searchable: 'currencies', 'entry_age'
  add column if not exists read_note text;
alter table public.kb_product_history
  add column if not exists source text not null default 'checked' check (source in ('checked', 'edit', 'read', 'migrated'));

-- A product can be found when it is live, nothing required is missing, and no document its facts rely on is out of date.
create or replace function public.kb_product_usable(p_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.kb_products p
     where p.id = p_id and p.status = 'verified' and cardinality(p.missing) = 0
       and not exists (select 1 from public.kb_documents d
                        where d.id = any (public.kb_fact_docs(p.facts)) and d.valid_until < current_date));
$$;

create or replace view public.kb_checked_products with (security_barrier = true) as
select p.id, p.insurer, p.name, p.product_type, p.category, p.dpi, p.jurisdiction, p.currencies, p.entry_age_min,
       p.entry_age_max, p.residency, p.sa_min, p.sa_max, p.has_tpd, p.has_ci, p.facts, p.version, p.is_sample, p.verified_at,
       p.auto_read
  from public.kb_products p
 where public.can_compare_products() and public.kb_product_usable(p.id);

-- Introducers with the Knowledge Hub read every current document (no check needed any more).
drop policy if exists kb_documents_staff on public.kb_documents;
create policy kb_documents_staff on public.kb_documents for select to authenticated
  using (public.kb_member() or (public.kb_reader() and replaced_by is null));
drop policy if exists "kb docs read" on storage.objects;
create policy "kb docs read" on storage.objects for select to authenticated
  using (bucket_id = 'kb-docs' and (
    (public.kb_member() and (public.kb_file_listed(name) or owner = auth.uid()))
    or (public.kb_reader() and exists (select 1 from public.kb_documents d where d.storage_path = name and d.replaced_by is null))));

-- ---------------------------------------------------------------------------
-- Documents: in use as soon as they are uploaded
-- ---------------------------------------------------------------------------
-- A new version takes over from the old one: product records that named the old one now name the new one.
create or replace function public.kb_take_over(p_old uuid, p_new uuid)
returns void language plpgsql security definer set search_path = public as $$
declare t text;
begin
  select title into t from public.kb_documents where id = p_new;
  update public.kb_documents set replaced_by = p_new, updated_at = now() where id = p_old;
  update public.kb_products set facts = public.kb_swap_doc(facts, p_old, p_new),
         pending = case when pending is null then null else jsonb_set(pending, '{facts}', public.kb_swap_doc(pending -> 'facts', p_old, p_new)) end,
         auto_read = true, read_note = format('New version of "%s" uploaded. Check the facts against it.', t), updated_at = now()
   where p_old = any (public.kb_fact_docs(facts));
  update public.kb_documents set product_id = (select product_id from public.kb_documents where id = p_old)
   where id = p_new and product_id is null;
end $$;

create or replace function public.kb_add_document(p jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare d uuid; old public.kb_documents;
begin
  if not public.kb_member() then raise exception 'Only ops and BSD with the Knowledge Hub can upload documents'; end if;
  perform public.kb_doc_fields(p);
  if coalesce(p ->> 'storage_path', '') = '' then raise exception 'Choose a file'; end if;
  if nullif(p ->> 'replaces', '') is not null then
    select * into old from public.kb_documents where id = (p ->> 'replaces')::uuid;
    if old.id is null then raise exception 'The document to replace is gone. Choose it again'; end if;
    if old.replaced_by is not null then raise exception 'That document was already replaced by a newer version'; end if;
  end if;
  insert into public.kb_documents (product_id, insurer, title, doc_type, doc_type_name, version, effective_from, valid_until,
                                   storage_path, file_name, file_size, replaces, status, uploaded_by)
  values (nullif(p ->> 'product_id', '')::uuid, coalesce(btrim(p ->> 'insurer'), ''), left(btrim(p ->> 'title'), 200), p ->> 'doc_type',
          public.kb_doc_type_name(p), left(coalesce(btrim(p ->> 'version'), ''), 40), (p ->> 'effective_from')::date,
          nullif(p ->> 'valid_until', '')::date, p ->> 'storage_path', left(coalesce(p ->> 'file_name', ''), 255),
          nullif(p ->> 'file_size', '')::bigint, old.id, 'checked', auth.uid())
  returning id into d;
  if old.id is not null then perform public.kb_take_over(old.id, d); end if;
  perform public.log_event('kb.document_uploaded', 'kb_document', d::text,
    jsonb_build_object('title', btrim(p ->> 'title'), 'insurer', nullif(btrim(p ->> 'insurer'), ''), 'replaces', old.title));
  return d;
end $$;

create or replace function public.kb_update_document(p_id uuid, p jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare d public.kb_documents;
begin
  if not public.kb_member() then raise exception 'Only ops and BSD with the Knowledge Hub can change documents'; end if;
  select * into d from public.kb_documents where id = p_id;
  if d.id is null then raise exception 'Document not found'; end if;
  perform public.kb_doc_fields(p);
  update public.kb_documents set insurer = coalesce(btrim(p ->> 'insurer'), ''), product_id = nullif(p ->> 'product_id', '')::uuid,
         title = left(btrim(p ->> 'title'), 200), doc_type = p ->> 'doc_type', doc_type_name = public.kb_doc_type_name(p),
         version = left(coalesce(btrim(p ->> 'version'), ''), 40),
         effective_from = (p ->> 'effective_from')::date, valid_until = nullif(p ->> 'valid_until', '')::date, updated_at = now()
   where id = p_id;
  perform public.log_event('kb.document_changed', 'kb_document', p_id::text, jsonb_build_object('title', btrim(p ->> 'title')));
end $$;

-- The uploader or a BSD person removes a document no product record names.
create or replace function public.kb_remove_document(p_id uuid)
returns text language plpgsql security definer set search_path = public as $$
declare d public.kb_documents;
begin
  if not public.kb_member() then raise exception 'Only ops and BSD with the Knowledge Hub can remove documents'; end if;
  select * into d from public.kb_documents where id = p_id;
  if d.id is null then raise exception 'Document not found'; end if;
  if d.uploaded_by is distinct from auth.uid() and not public.kb_checker() then raise exception 'Only the person who uploaded it or BSD can remove a document'; end if;
  if exists (select 1 from public.kb_products p
              where p_id = any (public.kb_fact_docs(p.facts)) or p_id = any (public.kb_fact_docs(p.pending -> 'facts'))) then
    raise exception 'A product record names this document. Change or delete the product record first';
  end if;
  update public.kb_documents set replaced_by = null where replaced_by = p_id;
  delete from public.kb_documents where id = p_id;
  perform public.log_event('kb.document_removed', 'kb_document', p_id::text, jsonb_build_object('title', d.title));
  return d.storage_path;
end $$;

-- ---------------------------------------------------------------------------
-- Product records: saving puts them in search
-- ---------------------------------------------------------------------------
create or replace function public.kb_snapshot(p_id uuid, p_rates boolean)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('insurer', p.insurer, 'name', p.name, 'category', p.category, 'dpi', p.dpi,
           'jurisdiction', p.jurisdiction, 'currencies', to_jsonb(p.currencies), 'entry_age_min', p.entry_age_min,
           'entry_age_max', p.entry_age_max, 'residency', to_jsonb(p.residency), 'sa_min', p.sa_min, 'sa_max', p.sa_max,
           'has_tpd', p.has_tpd, 'has_ci', p.has_ci, 'facts', p.facts, 'rates_changed', p_rates)
    from public.kb_products p where p.id = p_id;
$$;

-- Puts a cleaned record (kb_clean_record) live on a product and keeps the version.
create or replace function public.kb_apply(p_id uuid, rec jsonb, p_by uuid, p_source text)
returns int language plpgsql security definer set search_path = public as $$
declare pr public.kb_products; nv int;
begin
  select * into pr from public.kb_products where id = p_id for update;
  nv := case when pr.verified_at is not null then pr.version + 1 else pr.version end;
  update public.kb_products set insurer = rec ->> 'insurer', name = rec ->> 'name', category = rec ->> 'category',
         dpi = (rec ->> 'dpi')::boolean, jurisdiction = rec ->> 'jurisdiction',
         currencies = array(select jsonb_array_elements_text(rec -> 'currencies')),
         entry_age_min = (rec ->> 'entry_age_min')::int, entry_age_max = (rec ->> 'entry_age_max')::int,
         residency = array(select jsonb_array_elements_text(rec -> 'residency')),
         sa_min = nullif(rec ->> 'sa_min', '')::numeric, sa_max = nullif(rec ->> 'sa_max', '')::numeric,
         has_tpd = (rec ->> 'has_tpd')::boolean, has_ci = (rec ->> 'has_ci')::boolean, facts = rec -> 'facts',
         status = case when pr.status = 'withdrawn' then 'withdrawn' else 'verified' end, version = nv,
         verified_by = p_by, verified_at = now(), auto_read = false, auto_fields = '{}', missing = '{}', read_note = null,
         pending = null, pending_state = null, pending_note = null, pending_at = null, pending_by = null, submitted_by = null, updated_at = now()
   where id = p_id;
  if rec ? 'rates' then
    delete from public.kb_rates where product_id = p_id;
    insert into public.kb_rates (product_id, age, gender, smoker, rate, ci_rate)
    select p_id, (r ->> 'age')::int, r ->> 'gender', (r ->> 'smoker')::boolean, (r ->> 'rate')::numeric, nullif(r ->> 'ci_rate', '')::numeric
      from jsonb_array_elements(rec -> 'rates') r;
  end if;
  insert into public.kb_product_history (product_id, version, record, changed_by, checked_by, source)
  values (p_id, nv, public.kb_snapshot(p_id, rec ? 'rates'), p_by, null, p_source);
  return nv;
end $$;

-- Saves a product record (a new one when p_id is null). It is in search straight away; saving also counts as
-- reviewing what the reader filled in.
create or replace function public.kb_save_product(p_id uuid, p jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare rec jsonb; v_id uuid := p_id; nv int;
begin
  if not public.kb_member() then raise exception 'Only ops and BSD with the Knowledge Hub can edit product records'; end if;
  rec := public.kb_clean_record(p);
  if exists (select 1 from public.kb_products where lower(insurer) = lower(rec ->> 'insurer') and lower(name) = lower(rec ->> 'name')
              and kb_products.id is distinct from p_id) then
    raise exception 'There is already a product record for % %', rec ->> 'insurer', rec ->> 'name';
  end if;
  if p_id is null then
    insert into public.kb_products (insurer, name, status, created_by) values (rec ->> 'insurer', rec ->> 'name', 'draft', auth.uid())
    returning kb_products.id into v_id;
  elsif not exists (select 1 from public.kb_products where kb_products.id = p_id) then
    raise exception 'Product record not found';
  end if;
  nv := public.kb_apply(v_id, rec, auth.uid(), 'edit');
  perform public.log_event('kb.product_saved', 'kb_product', v_id::text,
    jsonb_build_object('product', (rec ->> 'insurer') || ' · ' || (rec ->> 'name'), 'version', nv, 'live', true));
  return v_id;
end $$;

-- Someone looked over what the reader filled in and it is right: the "not yet reviewed" tag goes.
create or replace function public.kb_mark_reviewed(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare pr public.kb_products;
begin
  if not public.kb_member() then raise exception 'Only ops and BSD with the Knowledge Hub can review product records'; end if;
  select * into pr from public.kb_products where id = p_id for update;
  if pr.id is null then raise exception 'Product record not found'; end if;
  update public.kb_products set auto_read = false, auto_fields = '{}', read_note = null, verified_by = auth.uid(), updated_at = now() where id = p_id;
  perform public.log_event('kb.product_reviewed', 'kb_product', p_id::text, jsonb_build_object('product', pr.insurer || ' · ' || pr.name, 'version', pr.version));
end $$;

-- What the reader found in an uploaded Product Summary or rate sheet goes on a product record, which is then in
-- search (when nothing required is missing). p: product_id (optional), insurer, name, record (fields found),
-- facts {key: {v, page}}, rates [...], found (fields and fact keys read), notes.
-- Which record: p.product_id; else the record that names this document (a new version); else the document's
-- product; else the record with the same insurer and name; else a new record.
create or replace function public.kb_auto_product(p_doc uuid, p jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare d public.kb_documents; pr public.kb_products; target uuid; ins text; nm text; r jsonb := coalesce(p -> 'record', '{}');
        got text[] := array(select jsonb_array_elements_text(coalesce(p -> 'found', '[]'))); kind text; made boolean := false;
        rf jsonb := '{}'; f record; cur text[]; amin int; amax int; rates jsonb; nv int; miss text[];
begin
  if not public.kb_member() then raise exception 'Only ops and BSD with the Knowledge Hub can add product records'; end if;
  select * into d from public.kb_documents where id = p_doc;
  if d.id is null then raise exception 'Document not found'; end if;
  if d.doc_type not in ('Product Summary', 'Rate sheet') then raise exception 'Only a Product Summary or rate sheet makes a product record'; end if;
  kind := case when d.doc_type = 'Rate sheet' then 'rates' else 'summary' end;
  ins := left(coalesce(nullif(btrim(p ->> 'insurer'), ''), d.insurer), 120);
  nm := left(btrim(coalesce(p ->> 'name', '')), 160);

  target := nullif(p ->> 'product_id', '')::uuid;
  if target is null then select id into target from public.kb_products where p_doc = any (public.kb_fact_docs(kb_products.facts)) order by created_at limit 1; end if;
  if target is null then target := d.product_id; end if;
  if target is null then
    if ins = '' then raise exception 'Fill in the insurer'; end if;
    if nm = '' then raise exception 'Fill in the product name'; end if;
    select id into target from public.kb_products where lower(insurer) = lower(ins) and lower(name) = lower(nm);
  end if;

  -- What was read, tidied. Anything that does not make sense is left out (never guessed).
  for f in select key, value from jsonb_each(coalesce(p -> 'facts', '{}')) loop
    if f.key !~ '^[a-zA-Z]{1,20}$' or coalesce(btrim(f.value ->> 'v'), '') = '' then continue; end if;
    rf := rf || jsonb_build_object(f.key, jsonb_strip_nulls(jsonb_build_object('v', left(btrim(f.value ->> 'v'), 600), 'doc', p_doc::text,
      'page', case when coalesce(f.value ->> 'page', '') ~ '^\d{1,4}$' then (f.value ->> 'page')::int end)));
  end loop;
  cur := array(select x from jsonb_array_elements_text(case when jsonb_typeof(r -> 'currencies') = 'array' then r -> 'currencies' else '[]' end) x
                where x in ('SGD', 'USD', 'AUD', 'GBP', 'EUR', 'HKD'));
  begin amin := (r ->> 'entry_age_min')::int; amax := (r ->> 'entry_age_max')::int; exception when others then amin := null; amax := null; end;
  if amin is null or amax is null or amin < 0 or amax > 100 or amin > amax then amin := null; amax := null; end if;
  rates := case when kind = 'rates' and jsonb_typeof(p -> 'rates') = 'array' and jsonb_array_length(p -> 'rates') > 0
                then public.kb_clean_rates(p -> 'rates') end;

  if target is null then
    insert into public.kb_products (insurer, name, status, version, created_by, missing, currencies)
    values (ins, nm, 'draft', 1, auth.uid(), '{currencies,entry_age}', '{SGD}')
    returning id into target;
    made := true;
  end if;
  select * into pr from public.kb_products where id = target for update;
  if pr.id is null then raise exception 'Product record not found'; end if;
  miss := pr.missing;
  if cardinality(cur) > 0 then miss := array_remove(miss, 'currencies'); end if;
  if amin is not null then miss := array_remove(miss, 'entry_age'); end if;
  nv := case when pr.verified_at is not null then pr.version + 1 else pr.version end;

  update public.kb_products set
    currencies = case when cardinality(cur) > 0 then cur else currencies end,
    entry_age_min = coalesce(amin, entry_age_min), entry_age_max = coalesce(amax, entry_age_max),
    residency = case when jsonb_typeof(r -> 'residency') = 'array' and jsonb_array_length(r -> 'residency') > 0
                     then array(select jsonb_array_elements_text(r -> 'residency')) else residency end,
    sa_min = case when r ->> 'sa_min' ~ '^\d+(\.\d+)?$' then (r ->> 'sa_min')::numeric else sa_min end,
    sa_max = case when r ->> 'sa_max' ~ '^\d+(\.\d+)?$' then (r ->> 'sa_max')::numeric else sa_max end,
    dpi = case when r ? 'dpi' then coalesce((r ->> 'dpi')::boolean, dpi) else dpi end,
    jurisdiction = case when r ->> 'jurisdiction' in ('Onshore', 'Offshore') then r ->> 'jurisdiction' else jurisdiction end,
    has_tpd = case when r ? 'has_tpd' then coalesce((r ->> 'has_tpd')::boolean, has_tpd) else has_tpd end,
    has_ci = case when r ? 'has_ci' then coalesce((r ->> 'has_ci')::boolean, has_ci)
                  when rates is not null and exists (select 1 from jsonb_array_elements(rates) x where x ->> 'ci_rate' is not null) then true
                  else has_ci end,
    facts = facts || public.kb_products_facts_from(kind, p_doc, rf),
    status = case when status = 'withdrawn' then 'withdrawn' else 'verified' end,
    version = nv, verified_at = now(), verified_by = null,
    auto_read = true, auto_fields = array(select distinct x from unnest(auto_fields || got) x), missing = miss,
    read_note = left(nullif(btrim(coalesce(p ->> 'notes', '')), ''), 1000), updated_at = now()
  where id = target;
  if rates is not null then
    delete from public.kb_rates where product_id = target;
    insert into public.kb_rates (product_id, age, gender, smoker, rate, ci_rate)
    select target, (x ->> 'age')::int, x ->> 'gender', (x ->> 'smoker')::boolean, (x ->> 'rate')::numeric, nullif(x ->> 'ci_rate', '')::numeric
      from jsonb_array_elements(rates) x;
  end if;
  update public.kb_documents set product_id = target where id = p_doc and product_id is null;
  insert into public.kb_product_history (product_id, version, record, changed_by, checked_by, source)
  values (target, nv, public.kb_snapshot(target, rates is not null), auth.uid(), null, 'read');
  perform public.log_event('kb.product_auto_read', 'kb_product', target::text, jsonb_build_object(
    'product', ins || ' · ' || (select name from public.kb_products where id = target), 'title', d.title, 'created', made,
    'version', nv, 'searchable', public.kb_product_usable(target)));
  return target;
end $$;

-- The facts an upload adds: what was read (each naming the document and page), plus the document as the record's
-- Product Summary or rate sheet.
create or replace function public.kb_products_facts_from(p_kind text, p_doc uuid, p_read jsonb)
returns jsonb language sql immutable as $$
  select coalesce(p_read, '{}') || jsonb_build_object(case when p_kind = 'rates' then '_rs' else '_ps' end, jsonb_build_object('doc', p_doc::text));
$$;

-- Take a product out of search, or put it back. Any ops or BSD person with the Knowledge Hub.
create or replace function public.kb_withdraw_product(p_id uuid, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare pr public.kb_products;
begin
  if not public.kb_member() then raise exception 'Only ops and BSD with the Knowledge Hub can withdraw products'; end if;
  if coalesce(btrim(p_reason), '') = '' then raise exception 'Give a reason'; end if;
  select * into pr from public.kb_products where id = p_id for update;
  if pr.id is null or pr.status <> 'verified' then raise exception 'Only a product in search can be withdrawn'; end if;
  update public.kb_products set status = 'withdrawn', updated_at = now() where id = p_id;
  perform public.log_event('kb.product_withdrawn', 'kb_product', p_id::text,
    jsonb_build_object('product', pr.insurer || ' · ' || pr.name, 'reason', btrim(p_reason)));
end $$;

create or replace function public.kb_restore_product(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare pr public.kb_products;
begin
  if not public.kb_member() then raise exception 'Only ops and BSD with the Knowledge Hub can put products back'; end if;
  select * into pr from public.kb_products where id = p_id for update;
  if pr.id is null or pr.status not in ('withdrawn', 'draft') then raise exception 'This product is already in search'; end if;
  update public.kb_products set status = 'verified', verified_at = coalesce(verified_at, now()), updated_at = now() where id = p_id;
  perform public.log_event('kb.product_restored', 'kb_product', p_id::text, jsonb_build_object('product', pr.insurer || ' · ' || pr.name));
end $$;

-- Deletes a product record (for example one made from a file that was not a product document). Its documents stay;
-- PI requests keep the product's name.
create or replace function public.kb_delete_product(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare pr public.kb_products;
begin
  if not public.kb_member() then raise exception 'Only ops and BSD with the Knowledge Hub can delete product records'; end if;
  select * into pr from public.kb_products where id = p_id for update;
  if pr.id is null then raise exception 'Product record not found'; end if;
  delete from public.kb_products where id = p_id;
  perform public.log_event('kb.product_deleted', 'kb_product', p_id::text, jsonb_build_object('product', pr.insurer || ' · ' || pr.name));
end $$;

revoke execute on function public.kb_take_over(uuid, uuid), public.kb_snapshot(uuid, boolean), public.kb_apply(uuid, jsonb, uuid, text),
  public.kb_products_facts_from(text, uuid, jsonb) from public, anon, authenticated;
revoke execute on function public.kb_mark_reviewed(uuid), public.kb_auto_product(uuid, jsonb), public.kb_restore_product(uuid),
  public.kb_delete_product(uuid) from public, anon;
grant execute on function public.kb_mark_reviewed(uuid), public.kb_auto_product(uuid, jsonb), public.kb_restore_product(uuid),
  public.kb_delete_product(uuid), public.kb_withdraw_product(uuid, text) to authenticated;
-- The old check steps are gone.
revoke execute on function public.kb_check_document(uuid), public.kb_send_for_check(uuid), public.kb_check_product(uuid),
  public.kb_send_back_product(uuid, text) from authenticated;

-- ---------------------------------------------------------------------------
-- What was waiting for a check when this runs
-- ---------------------------------------------------------------------------
do $$
declare x record;
begin
  -- Waiting new versions replace the old ones; every document is in use.
  for x in select d.id, d.replaces from public.kb_documents d join public.kb_documents o on o.id = d.replaces
            where d.status = 'new' and o.replaced_by is null order by d.created_at loop
    perform public.kb_take_over(x.replaces, x.id);
  end loop;
  update public.kb_documents set status = 'checked', checked_at = coalesce(checked_at, now()) where status = 'new';
  -- Drafts and changes waiting for a check go live as their makers saved them.
  for x in select id, pending, pending_by from public.kb_products where pending is not null loop
    perform public.kb_apply(x.id, x.pending, x.pending_by, 'migrated');
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Products are searchable without entry ages (25 Nov 2026, Kumar: "They should still be searchable"). Real Singapore
-- Product Summaries (FWD Future First, Singlife Elite Term II) do not state entry ages, so an auto-read term product
-- stayed out of search until someone typed them in.
--
-- * A product is searchable when its policy currency is known; entry ages are no longer required.
-- * kb_products.missing still lists 'entry_age' while the ages are not known (the record keeps the 18 to 65 column
--   defaults, which are NOT the product's ages). kb_checked_products gives ages_stated = false for those, and the app
--   shows "Entry ages not stated in the document" and skips them in the age filter instead of leaving them out.
-- * Saving the record (with the ages typed in) clears it, as before.

create or replace function public.kb_product_usable(p_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.kb_products p
     where p.id = p_id and p.status = 'verified' and cardinality(array_remove(p.missing, 'entry_age')) = 0
       and not exists (select 1 from public.kb_documents d
                        where d.id = any (public.kb_fact_docs(p.facts)) and d.valid_until < current_date));
$$;

create or replace view public.kb_checked_products with (security_barrier = true) as
select p.id, p.insurer, p.name, p.product_type, p.category, p.dpi, p.jurisdiction, p.currencies, p.entry_age_min,
       p.entry_age_max, p.residency, p.sa_min, p.sa_max, p.has_tpd, p.has_ci, p.facts, p.version, p.is_sample, p.verified_at,
       p.auto_read, not ('entry_age' = any (p.missing)) as ages_stated
  from public.kb_products p
 where public.can_compare_products() and public.kb_product_usable(p.id);

-- ---------------------------------------------------------------------------
-- Product categories for every kind of plan (25 Nov 2026, Kumar: "Add these as categories for the product field ...
-- classify these as either insurance and investment, adding a (ins) for insurance and (inv) for investment ...
-- include not only term plans but the new categories in searchable products as well").
--
-- * kb_products.product_type is the product category (plan type), one of 12. Insurance (ins): Term life, Critical
--   illness, Whole life, Health (hospital / Integrated Shield), Personal accident, Disability income, Long-term care,
--   Mortgage cover. Investment (inv): Investment-linked (ILP), Universal life (incl. indexed), Endowment, Retirement
--   and annuity. The old value 'Term' becomes 'Term life'.
-- * kb_products.category (Insurance / Investment) now always follows the plan type (a trigger keeps it so), so the
--   Knowledge Bank and Compare products can filter by insurance or investment. Existing products are all term plans,
--   so they all become Insurance (a term product someone had marked Investment by hand is put right).
-- * Every plan type can be read from an upload and is searchable (before this only term plans made a product record).
--   kb_auto_product and kb_save_product take product_type (left out = Term life, as before, for older screens).
-- * Only Product Summary, Rate sheet, Brochure and Product Financing documents belong to a product: for any other type
--   (training material, circulars, regulatory ...) the product link is left empty when a document is uploaded or edited.
--   Documents already linked keep their link until they are edited.
-- Safe to run more than once. Deletes nothing.

-- The 12 plan types and their group.
create or replace function public.kb_plan_group(p_type text)
returns text language sql immutable as $$
  select case when p_type in ('Investment-linked', 'Universal life', 'Endowment', 'Retirement and annuity') then 'Investment' else 'Insurance' end
$$;
-- A plan type as stored ('Term' = 'Term life'); null when it is not one of the 12.
create or replace function public.kb_plan_key(p_type text)
returns text language sql immutable as $$
  select case when btrim(coalesce(p_type, '')) = 'Term' then 'Term life'
              when btrim(p_type) in ('Term life', 'Critical illness', 'Whole life', 'Health', 'Personal accident', 'Disability income',
                                     'Long-term care', 'Mortgage cover', 'Investment-linked', 'Universal life', 'Endowment',
                                     'Retirement and annuity') then btrim(p_type) end
$$;
-- The list, for the app (it also tells the app that this upgrade has run).
create or replace function public.kb_plan_types()
returns jsonb language sql immutable as $$
  select jsonb_agg(jsonb_build_object('key', k, 'group', public.kb_plan_group(k)) order by n)
    from unnest(array['Term life', 'Critical illness', 'Whole life', 'Health', 'Personal accident', 'Disability income', 'Long-term care',
                      'Mortgage cover', 'Investment-linked', 'Universal life', 'Endowment', 'Retirement and annuity']) with ordinality as t(k, n)
$$;
-- Document types that belong to a product.
create or replace function public.kb_type_has_product(p_type text)
returns boolean language sql immutable as $$
  select coalesce(p_type, '') in ('Product Summary', 'Rate sheet', 'Brochure', 'Product Financing')
$$;
create or replace function public.kb_doc_product(p jsonb)
returns uuid language sql immutable as $$
  select case when public.kb_type_has_product(p ->> 'doc_type') then nullif(p ->> 'product_id', '')::uuid end
$$;

alter table public.kb_products drop constraint if exists kb_products_product_type_check;
update public.kb_products set product_type = 'Term life' where product_type = 'Term' or public.kb_plan_key(product_type) is null;
alter table public.kb_products alter column product_type set default 'Term life';
alter table public.kb_products add constraint kb_products_product_type_check check (public.kb_plan_key(product_type) = product_type);

-- The group always follows the plan type.
create or replace function public.kb_products_group()
returns trigger language plpgsql as $$
begin
  new.category := public.kb_plan_group(new.product_type);
  return new;
end $$;
drop trigger if exists kb_products_group on public.kb_products;
create trigger kb_products_group before insert or update on public.kb_products for each row execute function public.kb_products_group();
update public.kb_products set category = public.kb_plan_group(product_type) where category is distinct from public.kb_plan_group(product_type);

create or replace function public.kb_clean_record(p jsonb)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare f record; facts jsonb := '{}'; v_type text := public.kb_plan_key(coalesce(nullif(p ->> 'product_type', ''), 'Term life')); amin int; amax int; smin numeric; smax numeric; cur jsonb; res jsonb;
begin
  if coalesce(btrim(p ->> 'insurer'), '') = '' then raise exception 'Fill in the insurer'; end if;
  if coalesce(btrim(p ->> 'name'), '') = '' then raise exception 'Fill in the product name'; end if;
  if v_type is null then raise exception 'Choose the product category (plan type)'; end if;
  if coalesce(p ->> 'jurisdiction', '') not in ('Onshore', 'Offshore') then raise exception 'Choose onshore or offshore'; end if;
  cur := coalesce(p -> 'currencies', '[]'); res := coalesce(p -> 'residency', '[]');
  if jsonb_typeof(cur) <> 'array' or jsonb_array_length(cur) = 0 then raise exception 'Choose at least one policy currency'; end if;
  if jsonb_typeof(res) <> 'array' or jsonb_array_length(res) = 0 then raise exception 'Choose who can apply'; end if;
  begin
    amin := (p ->> 'entry_age_min')::int; amax := (p ->> 'entry_age_max')::int;
    smin := nullif(p ->> 'sa_min', '')::numeric; smax := nullif(p ->> 'sa_max', '')::numeric;
  exception when others then raise exception 'Entry ages and sums assured must be numbers'; end;
  if amin is null or amax is null or amin < 0 or amax > 100 or amin > amax then raise exception 'Check the entry ages (0 to 100, lowest first)'; end if;
  if smin is not null and smax is not null and smin > smax then raise exception 'The minimum sum assured is more than the maximum'; end if;
  for f in select key, value from jsonb_each(coalesce(p -> 'facts', '{}')) loop
    if f.key in ('_ps', '_rs') then
      if coalesce(f.value ->> 'doc', '') = '' then continue; end if;
    elsif coalesce(btrim(f.value ->> 'v'), '') = '' then continue;
    end if;
    if coalesce(f.value ->> 'doc', '') = '' or not exists (select 1 from public.kb_documents where id::text = f.value ->> 'doc') then
      raise exception 'Choose the source document for every fact (missing for "%")', f.key;
    end if;
    facts := facts || jsonb_build_object(f.key, jsonb_strip_nulls(jsonb_build_object(
      'v', case when f.key in ('_ps', '_rs') then null else left(btrim(f.value ->> 'v'), 600) end,
      'doc', f.value ->> 'doc', 'page', case when coalesce(f.value ->> 'page', '') ~ '^\d{1,4}$' then (f.value ->> 'page')::int end)));
  end loop;
  return jsonb_build_object('insurer', btrim(p ->> 'insurer'), 'name', btrim(p ->> 'name'), 'product_type', v_type, 'category', public.kb_plan_group(v_type),
    'dpi', coalesce((p ->> 'dpi')::boolean, false), 'jurisdiction', p ->> 'jurisdiction', 'currencies', cur,
    'entry_age_min', amin, 'entry_age_max', amax, 'residency', res, 'sa_min', smin, 'sa_max', smax,
    'has_tpd', coalesce((p ->> 'has_tpd')::boolean, false), 'has_ci', coalesce((p ->> 'has_ci')::boolean, false), 'facts', facts)
    || case when p ? 'rates' then jsonb_build_object('rates', public.kb_clean_rates(p -> 'rates')) else '{}' end;
end $$;

create or replace function public.kb_record(p_id uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('insurer', p.insurer, 'name', p.name, 'product_type', p.product_type, 'category', p.category, 'dpi', p.dpi,
           'jurisdiction', p.jurisdiction, 'currencies', to_jsonb(p.currencies), 'entry_age_min', p.entry_age_min,
           'entry_age_max', p.entry_age_max, 'residency', to_jsonb(p.residency), 'sa_min', p.sa_min, 'sa_max', p.sa_max,
           'has_tpd', p.has_tpd, 'has_ci', p.has_ci, 'facts', p.facts)
    from public.kb_products p where p.id = p_id and public.kb_member();
$$;

create or replace function public.kb_snapshot(p_id uuid, p_rates boolean)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('insurer', p.insurer, 'name', p.name, 'product_type', p.product_type, 'category', p.category, 'dpi', p.dpi,
           'jurisdiction', p.jurisdiction, 'currencies', to_jsonb(p.currencies), 'entry_age_min', p.entry_age_min,
           'entry_age_max', p.entry_age_max, 'residency', to_jsonb(p.residency), 'sa_min', p.sa_min, 'sa_max', p.sa_max,
           'has_tpd', p.has_tpd, 'has_ci', p.has_ci, 'facts', p.facts, 'rates_changed', p_rates)
    from public.kb_products p where p.id = p_id;
$$;

create or replace function public.kb_apply(p_id uuid, rec jsonb, p_by uuid, p_source text)
returns int language plpgsql security definer set search_path = public as $$
declare pr public.kb_products; nv int;
begin
  select * into pr from public.kb_products where id = p_id for update;
  nv := case when pr.verified_at is not null then pr.version + 1 else pr.version end;
  update public.kb_products set insurer = rec ->> 'insurer', name = rec ->> 'name',
         product_type = coalesce(public.kb_plan_key(rec ->> 'product_type'), product_type),
         dpi = (rec ->> 'dpi')::boolean, jurisdiction = rec ->> 'jurisdiction',
         currencies = array(select jsonb_array_elements_text(rec -> 'currencies')),
         entry_age_min = (rec ->> 'entry_age_min')::int, entry_age_max = (rec ->> 'entry_age_max')::int,
         residency = array(select jsonb_array_elements_text(rec -> 'residency')),
         sa_min = nullif(rec ->> 'sa_min', '')::numeric, sa_max = nullif(rec ->> 'sa_max', '')::numeric,
         has_tpd = (rec ->> 'has_tpd')::boolean, has_ci = (rec ->> 'has_ci')::boolean, facts = rec -> 'facts',
         status = case when pr.status = 'withdrawn' then 'withdrawn' else 'verified' end, version = nv,
         verified_by = p_by, verified_at = now(), auto_read = false, auto_fields = '{}', missing = '{}', read_note = null,
         pending = null, pending_state = null, pending_note = null, pending_at = null, pending_by = null, submitted_by = null, updated_at = now()
   where id = p_id;
  if rec ? 'rates' then
    delete from public.kb_rates where product_id = p_id;
    insert into public.kb_rates (product_id, age, gender, smoker, rate, ci_rate)
    select p_id, (r ->> 'age')::int, r ->> 'gender', (r ->> 'smoker')::boolean, (r ->> 'rate')::numeric, nullif(r ->> 'ci_rate', '')::numeric
      from jsonb_array_elements(rec -> 'rates') r;
  end if;
  insert into public.kb_product_history (product_id, version, record, changed_by, checked_by, source)
  values (p_id, nv, public.kb_snapshot(p_id, rec ? 'rates'), p_by, null, p_source);
  return nv;
end $$;

create or replace function public.kb_auto_product(p_doc uuid, p jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare d public.kb_documents; pr public.kb_products; target uuid; ins text; nm text; r jsonb := coalesce(p -> 'record', '{}');
        got text[] := array(select jsonb_array_elements_text(coalesce(p -> 'found', '[]'))); kind text; made boolean := false; ptype text := public.kb_plan_key(p ->> 'product_type');
        rf jsonb := '{}'; f record; cur text[]; amin int; amax int; rates jsonb; nv int; miss text[];
begin
  if not public.kb_member() then raise exception 'Only ops and BSD with the Knowledge Hub can add product records'; end if;
  select * into d from public.kb_documents where id = p_doc;
  if d.id is null then raise exception 'Document not found'; end if;
  if d.doc_type not in ('Product Summary', 'Rate sheet') then raise exception 'Only a Product Summary or rate sheet makes a product record'; end if;
  kind := case when d.doc_type = 'Rate sheet' then 'rates' else 'summary' end;
  ins := left(coalesce(nullif(btrim(p ->> 'insurer'), ''), d.insurer), 120);
  nm := left(btrim(coalesce(p ->> 'name', '')), 160);

  target := nullif(p ->> 'product_id', '')::uuid;
  if target is null then select id into target from public.kb_products where p_doc = any (public.kb_fact_docs(kb_products.facts)) order by created_at limit 1; end if;
  if target is null then target := d.product_id; end if;
  if target is null then
    if ins = '' then raise exception 'Fill in the insurer'; end if;
    if nm = '' then raise exception 'Fill in the product name'; end if;
    select id into target from public.kb_products where lower(insurer) = lower(ins) and lower(name) = lower(nm);
  end if;

  -- What was read, tidied. Anything that does not make sense is left out (never guessed).
  for f in select key, value from jsonb_each(coalesce(p -> 'facts', '{}')) loop
    if f.key !~ '^[a-zA-Z]{1,20}$' or coalesce(btrim(f.value ->> 'v'), '') = '' then continue; end if;
    rf := rf || jsonb_build_object(f.key, jsonb_strip_nulls(jsonb_build_object('v', left(btrim(f.value ->> 'v'), 600), 'doc', p_doc::text,
      'page', case when coalesce(f.value ->> 'page', '') ~ '^\d{1,4}$' then (f.value ->> 'page')::int end)));
  end loop;
  cur := array(select x from jsonb_array_elements_text(case when jsonb_typeof(r -> 'currencies') = 'array' then r -> 'currencies' else '[]' end) x
                where x in ('SGD', 'USD', 'AUD', 'GBP', 'EUR', 'HKD'));
  begin amin := (r ->> 'entry_age_min')::int; amax := (r ->> 'entry_age_max')::int; exception when others then amin := null; amax := null; end;
  if amin is null or amax is null or amin < 0 or amax > 100 or amin > amax then amin := null; amax := null; end if;
  rates := case when kind = 'rates' and jsonb_typeof(p -> 'rates') = 'array' and jsonb_array_length(p -> 'rates') > 0
                then public.kb_clean_rates(p -> 'rates') end;

  if target is null then
    insert into public.kb_products (insurer, name, product_type, status, version, created_by, missing, currencies)
    values (ins, nm, coalesce(ptype, 'Term life'), 'draft', 1, auth.uid(), '{currencies,entry_age}', '{SGD}')
    returning id into target;
    made := true;
  end if;
  select * into pr from public.kb_products where id = target for update;
  if pr.id is null then raise exception 'Product record not found'; end if;
  miss := pr.missing;
  if cardinality(cur) > 0 then miss := array_remove(miss, 'currencies'); end if;
  if amin is not null then miss := array_remove(miss, 'entry_age'); end if;
  nv := case when pr.verified_at is not null then pr.version + 1 else pr.version end;

  update public.kb_products set
    product_type = coalesce(ptype, product_type),
    currencies = case when cardinality(cur) > 0 then cur else currencies end,
    entry_age_min = coalesce(amin, entry_age_min), entry_age_max = coalesce(amax, entry_age_max),
    residency = case when jsonb_typeof(r -> 'residency') = 'array' and jsonb_array_length(r -> 'residency') > 0
                     then array(select jsonb_array_elements_text(r -> 'residency')) else residency end,
    sa_min = case when r ->> 'sa_min' ~ '^\d+(\.\d+)?$' then (r ->> 'sa_min')::numeric else sa_min end,
    sa_max = case when r ->> 'sa_max' ~ '^\d+(\.\d+)?$' then (r ->> 'sa_max')::numeric else sa_max end,
    dpi = case when r ? 'dpi' then coalesce((r ->> 'dpi')::boolean, dpi) else dpi end,
    jurisdiction = case when r ->> 'jurisdiction' in ('Onshore', 'Offshore') then r ->> 'jurisdiction' else jurisdiction end,
    has_tpd = case when r ? 'has_tpd' then coalesce((r ->> 'has_tpd')::boolean, has_tpd) else has_tpd end,
    has_ci = case when r ? 'has_ci' then coalesce((r ->> 'has_ci')::boolean, has_ci)
                  when rates is not null and exists (select 1 from jsonb_array_elements(rates) x where x ->> 'ci_rate' is not null) then true
                  else has_ci end,
    facts = facts || public.kb_products_facts_from(kind, p_doc, rf),
    status = case when status = 'withdrawn' then 'withdrawn' else 'verified' end,
    version = nv, verified_at = now(), verified_by = null,
    auto_read = true, auto_fields = array(select distinct x from unnest(auto_fields || got) x), missing = miss,
    read_note = left(nullif(btrim(coalesce(p ->> 'notes', '')), ''), 1000), updated_at = now()
  where id = target;
  if rates is not null then
    delete from public.kb_rates where product_id = target;
    insert into public.kb_rates (product_id, age, gender, smoker, rate, ci_rate)
    select target, (x ->> 'age')::int, x ->> 'gender', (x ->> 'smoker')::boolean, (x ->> 'rate')::numeric, nullif(x ->> 'ci_rate', '')::numeric
      from jsonb_array_elements(rates) x;
  end if;
  update public.kb_documents set product_id = target where id = p_doc and product_id is null;
  insert into public.kb_product_history (product_id, version, record, changed_by, checked_by, source)
  values (target, nv, public.kb_snapshot(target, rates is not null), auth.uid(), null, 'read');
  perform public.log_event('kb.product_auto_read', 'kb_product', target::text, jsonb_build_object(
    'product', ins || ' · ' || (select name from public.kb_products where id = target), 'title', d.title, 'created', made,
    'version', nv, 'searchable', public.kb_product_usable(target)));
  return target;
end $$;

create or replace function public.kb_add_document(p jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare d uuid; old public.kb_documents;
begin
  if not public.kb_member() then raise exception 'Only ops and BSD with the Knowledge Hub can upload documents'; end if;
  perform public.kb_doc_fields(p);
  if coalesce(p ->> 'storage_path', '') = '' then raise exception 'Choose a file'; end if;
  if nullif(p ->> 'replaces', '') is not null then
    select * into old from public.kb_documents where id = (p ->> 'replaces')::uuid;
    if old.id is null then raise exception 'The document to replace is gone. Choose it again'; end if;
    if old.replaced_by is not null then raise exception 'That document was already replaced by a newer version'; end if;
  end if;
  insert into public.kb_documents (product_id, insurer, title, doc_type, doc_type_name, version, effective_from, valid_until,
                                   storage_path, file_name, file_size, replaces, status, uploaded_by)
  values (public.kb_doc_product(p), coalesce(btrim(p ->> 'insurer'), ''), left(btrim(p ->> 'title'), 200), p ->> 'doc_type',
          public.kb_doc_type_name(p), left(coalesce(btrim(p ->> 'version'), ''), 40), (p ->> 'effective_from')::date,
          nullif(p ->> 'valid_until', '')::date, p ->> 'storage_path', left(coalesce(p ->> 'file_name', ''), 255),
          nullif(p ->> 'file_size', '')::bigint, old.id, 'checked', auth.uid())
  returning id into d;
  if old.id is not null then perform public.kb_take_over(old.id, d); end if;
  perform public.log_event('kb.document_uploaded', 'kb_document', d::text,
    jsonb_build_object('title', btrim(p ->> 'title'), 'insurer', nullif(btrim(p ->> 'insurer'), ''), 'replaces', old.title));
  return d;
end $$;

create or replace function public.kb_update_document(p_id uuid, p jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare d public.kb_documents;
begin
  if not public.kb_member() then raise exception 'Only ops and BSD with the Knowledge Hub can change documents'; end if;
  select * into d from public.kb_documents where id = p_id;
  if d.id is null then raise exception 'Document not found'; end if;
  perform public.kb_doc_fields(p);
  update public.kb_documents set insurer = coalesce(btrim(p ->> 'insurer'), ''), product_id = public.kb_doc_product(p),
         title = left(btrim(p ->> 'title'), 200), doc_type = p ->> 'doc_type', doc_type_name = public.kb_doc_type_name(p),
         version = left(coalesce(btrim(p ->> 'version'), ''), 40),
         effective_from = (p ->> 'effective_from')::date, valid_until = nullif(p ->> 'valid_until', '')::date, updated_at = now()
   where id = p_id;
  perform public.log_event('kb.document_changed', 'kb_document', p_id::text, jsonb_build_object('title', btrim(p ->> 'title')));
end $$;

create or replace function public.kb_take_over(p_old uuid, p_new uuid)
returns void language plpgsql security definer set search_path = public as $$
declare t text;
begin
  select title into t from public.kb_documents where id = p_new;
  update public.kb_documents set replaced_by = p_new, updated_at = now() where id = p_old;
  update public.kb_products set facts = public.kb_swap_doc(facts, p_old, p_new),
         pending = case when pending is null then null else jsonb_set(pending, '{facts}', public.kb_swap_doc(pending -> 'facts', p_old, p_new)) end,
         auto_read = true, read_note = format('New version of "%s" uploaded. Check the facts against it.', t), updated_at = now()
   where p_old = any (public.kb_fact_docs(facts));
  update public.kb_documents set product_id = (select product_id from public.kb_documents where id = p_old)
   where id = p_new and product_id is null and public.kb_type_has_product(doc_type);
end $$;

revoke execute on function public.kb_plan_group(text), public.kb_plan_key(text), public.kb_type_has_product(text),
  public.kb_doc_product(jsonb), public.kb_products_group() from public, anon;
revoke execute on function public.kb_plan_types() from public, anon;
grant execute on function public.kb_plan_types(), public.kb_plan_group(text), public.kb_plan_key(text) to authenticated;

-- One Product field with the categories under it (25 Nov 2026, Kumar: "i meant for the product categories to be
-- displayed underneath this field instead of creating a seperate new field").
--
-- The upload form's Product field lists the 12 categories as headings with the product records of each under them.
-- A document can belong to one product record, to a whole category ("All Universal life incl. indexed (inv)
-- products", e.g. a bank's premium financing rates for universal life) or to no product ("All products").
-- * kb_documents.plan_type holds that category. It is kept only when the document has no product record (a linked
--   record's own category wins) and only for Product Summary, Rate sheet, Brochure and Product Financing.
-- * The Documents tab's Insurance / Investment and category filters use the product's category, else this one.
-- Safe to run more than once. Deletes nothing.

alter table public.kb_documents add column if not exists plan_type text;
alter table public.kb_documents drop constraint if exists kb_documents_plan_type_check;
alter table public.kb_documents add constraint kb_documents_plan_type_check
  check (plan_type is null or public.kb_plan_key(plan_type) = plan_type);

-- The category a document is saved with: only for the four product types, and only without a product record.
create or replace function public.kb_doc_plan(p jsonb)
returns text language sql immutable as $$
  select case when public.kb_type_has_product(p ->> 'doc_type') and public.kb_doc_product(p) is null
              then public.kb_plan_key(nullif(btrim(coalesce(p ->> 'plan_type', '')), '')) end
$$;

create or replace function public.kb_add_document(p jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare d uuid; old public.kb_documents;
begin
  if not public.kb_member() then raise exception 'Only ops and BSD with the Knowledge Hub can upload documents'; end if;
  perform public.kb_doc_fields(p);
  if coalesce(p ->> 'storage_path', '') = '' then raise exception 'Choose a file'; end if;
  if nullif(p ->> 'replaces', '') is not null then
    select * into old from public.kb_documents where id = (p ->> 'replaces')::uuid;
    if old.id is null then raise exception 'The document to replace is gone. Choose it again'; end if;
    if old.replaced_by is not null then raise exception 'That document was already replaced by a newer version'; end if;
  end if;
  insert into public.kb_documents (product_id, plan_type, insurer, title, doc_type, doc_type_name, version, effective_from, valid_until,
                                   storage_path, file_name, file_size, replaces, status, uploaded_by)
  values (public.kb_doc_product(p), public.kb_doc_plan(p), coalesce(btrim(p ->> 'insurer'), ''), left(btrim(p ->> 'title'), 200), p ->> 'doc_type',
          public.kb_doc_type_name(p), left(coalesce(btrim(p ->> 'version'), ''), 40), (p ->> 'effective_from')::date,
          nullif(p ->> 'valid_until', '')::date, p ->> 'storage_path', left(coalesce(p ->> 'file_name', ''), 255),
          nullif(p ->> 'file_size', '')::bigint, old.id, 'checked', auth.uid())
  returning id into d;
  if old.id is not null then perform public.kb_take_over(old.id, d); end if;
  perform public.log_event('kb.document_uploaded', 'kb_document', d::text,
    jsonb_build_object('title', btrim(p ->> 'title'), 'insurer', nullif(btrim(p ->> 'insurer'), ''), 'replaces', old.title));
  return d;
end $$;

create or replace function public.kb_update_document(p_id uuid, p jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare d public.kb_documents;
begin
  if not public.kb_member() then raise exception 'Only ops and BSD with the Knowledge Hub can change documents'; end if;
  select * into d from public.kb_documents where id = p_id;
  if d.id is null then raise exception 'Document not found'; end if;
  perform public.kb_doc_fields(p);
  update public.kb_documents set insurer = coalesce(btrim(p ->> 'insurer'), ''), product_id = public.kb_doc_product(p),
         plan_type = public.kb_doc_plan(p),
         title = left(btrim(p ->> 'title'), 200), doc_type = p ->> 'doc_type', doc_type_name = public.kb_doc_type_name(p),
         version = left(coalesce(btrim(p ->> 'version'), ''), 40),
         effective_from = (p ->> 'effective_from')::date, valid_until = nullif(p ->> 'valid_until', '')::date, updated_at = now()
   where id = p_id;
  perform public.log_event('kb.document_changed', 'kb_document', p_id::text, jsonb_build_object('title', btrim(p ->> 'title')));
end $$;

-- A new version keeps the earlier one's product record, or else its category.
create or replace function public.kb_take_over(p_old uuid, p_new uuid)
returns void language plpgsql security definer set search_path = public as $$
declare t text;
begin
  select title into t from public.kb_documents where id = p_new;
  update public.kb_documents set replaced_by = p_new, updated_at = now() where id = p_old;
  update public.kb_products set facts = public.kb_swap_doc(facts, p_old, p_new),
         pending = case when pending is null then null else jsonb_set(pending, '{facts}', public.kb_swap_doc(pending -> 'facts', p_old, p_new)) end,
         auto_read = true, read_note = format('New version of "%s" uploaded. Check the facts against it.', t), updated_at = now()
   where p_old = any (public.kb_fact_docs(facts));
  update public.kb_documents set product_id = (select product_id from public.kb_documents where id = p_old)
   where id = p_new and product_id is null and public.kb_type_has_product(doc_type);
  update public.kb_documents set plan_type = (select plan_type from public.kb_documents where id = p_old)
   where id = p_new and product_id is null and plan_type is null and public.kb_type_has_product(doc_type);
end $$;

revoke execute on function public.kb_doc_plan(jsonb) from public, anon;
