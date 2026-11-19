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
    update public.audit_log a set details = (a.details - 'file' - 'reason') || jsonb_build_object('request', c.ref, 'details_removed', true)
     where (a.entity = 'request_document' and a.entity_id = any(docs) or a.entity = 'pi_request' and a.entity_id = c.ref)
       and (a.details ? 'file' or a.details ? 'reason');
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
