-- Workflow improvements (10 Nov 2026):
--  * priority (urgent) flag on requests
--  * configurable deadline (bsd), optionally paused while a request is sent back
--  * reopen a completed request
--  * bulk assign for bsd
--  * saved backlog filters per user
--  * email alert preference per user, and a deadline check that a schedule (pg_cron) can run
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
-- Email alerts: each user can turn them off. Sending is done by the notify-email
-- Edge Function (supabase/functions/notify-email) once an email provider is set up.
-- ---------------------------------------------------------------------------
create or replace function public.set_email_alerts(p_on boolean)
returns void language sql security definer set search_path = public as $$
  update public.profiles set email_alerts = coalesce(p_on, true) where id = auth.uid();
$$;
