-- UPGRADE for a project that already ran 1-setup.sql (before 15 Nov 2026). Paste the whole file into SQL Editor and Run once.
-- PI pack: introducers receive one PDF (comparison + PIs, edit-restricted) instead of the Excel file and separate PIs,
-- and "Mark completed" needs an up-to-date pack. Safe to run again. Run 1b to 1i-upgrade.sql first if you never did.

begin;
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
commit;
