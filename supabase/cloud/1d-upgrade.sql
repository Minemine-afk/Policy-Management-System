-- UPGRADE for a project that already ran 1-setup.sql (before 11 Nov 2026). Paste the whole file into SQL Editor and Run once.
-- Hides the urgent flag and due times from introducers and marks overdue requests urgent automatically. Do NOT run this on a fresh project (use 1-setup.sql).
-- Never ran 1b-upgrade.sql or 1c-upgrade.sql? Run those first, in order, then this one.
begin;
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
