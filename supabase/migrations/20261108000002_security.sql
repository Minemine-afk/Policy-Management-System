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
