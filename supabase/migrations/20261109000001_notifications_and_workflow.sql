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
