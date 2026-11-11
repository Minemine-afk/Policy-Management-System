-- Run after migrations + seed. Each block raises if a rule is broken.
\set ON_ERROR_STOP 1
create or replace function pg_temp.as_user(p uuid) returns void language sql as $$
  select set_config('request.jwt.claim.sub', coalesce(p::text, ''), false) $$;
create or replace function pg_temp.expect_error(sql text, needle text) returns void language plpgsql as $$
begin
  begin execute sql; exception when others then
    if position(needle in sqlerrm) > 0 or needle = '*' then raise notice 'ok (blocked): %', sqlerrm; return; end if;
    raise exception 'wrong error for %: %', sql, sqlerrm;
  end;
  raise exception 'expected failure but succeeded: %', sql;
end $$;
grant execute on all functions in schema pg_temp to authenticated;

set role authenticated;

-- 1. Introducers see only their own requests; client details only for the owner
select pg_temp.as_user('00000000-0000-0000-0000-000000000001');
do $$ begin
  if (select count(*) from pi_requests) <> 3 then raise exception 'introducer 1 should see 3, saw %', (select count(*) from pi_requests); end if;
  if exists (select 1 from pi_requests where introducer_id <> auth.uid()) then raise exception 'introducer sees others'; end if;
  if (select count(*) from request_clients) <> 3 then raise exception 'introducer should see own 3 clients'; end if;
  raise notice 'ok: introducer sees only own requests and clients';
end $$;
select pg_temp.expect_error($$update pi_requests set status = 'completed'$$, 'permission denied');
select pg_temp.expect_error($$select change_status('20000000-0000-0000-0000-000000000001', 'completed')$$, 'assigned ops user or bsd');
select pg_temp.expect_error($$select assign_request('20000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000003')$$, 'Only bsd');
select pg_temp.expect_error($$select add_comment('20000000-0000-0000-0000-000000000001', 'hi', true)$$, 'internal notes');
select pg_temp.expect_error($$select claim_request('20000000-0000-0000-0000-000000000001')$$, 'Ops only');
do $$ begin
  if exists (select 1 from request_comments where internal) then raise exception 'introducer sees internal comments'; end if;
  if exists (select 1 from request_documents d join pi_requests r on r.id = d.request_id where d.kind = 'pi_output' and r.status <> 'completed') then raise exception 'introducer sees PIs before completion'; end if;
  raise notice 'ok: introducer cannot see internal comments';
end $$;

-- 2. Create and edit
select create_request('{"age_band":"30 to 34","gender":"Male","smoker":false,"coverage_term":"6 to 10 years","sum_assured_band":"Up to S$100,000"}',
                      '{"client_name":"[Sample] Client Golf"}');
select pg_temp.expect_error($$select create_request('{"gender":"Male"}', '{"client_name":"x"}')$$, 'Fill in');
select pg_temp.expect_error($$select create_request('{"age_band":"30 to 34","gender":"Male","smoker":false,"coverage_term":"x","sum_assured_band":"y"}', '{"client_name":""}')$$, 'client name');
do $$ begin
  if (select count(*) from pi_requests) <> 4 then raise exception 'new request not visible'; end if;
  raise notice 'ok: introducer created a request';
end $$;
select pg_temp.expect_error($$select update_request('20000000-0000-0000-0000-000000000004', '{"age_band":"30 to 34","gender":"Male","smoker":false,"coverage_term":"x","sum_assured_band":"y"}', null)$$, 'Not your request');
select pg_temp.expect_error($$select resubmit_request('20000000-0000-0000-0000-000000000001')$$, 'sent back');

-- 3. Introducer 2 cannot see introducer 1's data
select pg_temp.as_user('00000000-0000-0000-0000-000000000002');
do $$ begin
  if exists (select 1 from pi_requests where introducer_id <> auth.uid()) then raise exception 'introducer 2 sees introducer 1'; end if;
  if exists (select 1 from request_clients where owner_id <> auth.uid()) then raise exception 'introducer 2 sees others clients'; end if;
  if exists (select 1 from profiles where id <> auth.uid()) then raise exception 'introducer sees other profiles (ops names must stay hidden)'; end if;
  raise notice 'ok: introducers are isolated from each other';
end $$;
select pg_temp.expect_error($$select add_comment('20000000-0000-0000-0000-000000000004', 'hello')$$, 'closed while a request is sent back');
-- Dana resubmits her sent-back request
select resubmit_request('20000000-0000-0000-0000-000000000004', 'Confirmed: 100k');
do $$ begin
  if (select status from pi_requests where ref = 'PI-00004') <> 'in_progress' then raise exception 'resubmit should go back to in_progress'; end if;
  raise notice 'ok: resubmit returns to in_progress';
end $$;

-- 4. Ops: pool plus own assignments; no client details; claim
select pg_temp.as_user('00000000-0000-0000-0000-000000000003');
do $$ begin
  if (select count(*) from pi_requests) <> 4 then raise exception 'ops 1 should see pool(2) + own(2), saw %', (select count(*) from pi_requests); end if;
  if exists (select 1 from request_clients) then raise exception 'ops sees client details'; end if;
  if not exists (select 1 from request_comments where internal) then raise exception 'ops should see internal notes'; end if;
  raise notice 'ok: ops sees pool and own work, never client details';
end $$;
select claim_request((select id from pi_requests where ref = 'PI-00001'));
select pg_temp.expect_error($$select claim_request((select id from pi_requests where ref = 'PI-00001'))$$, 'unassigned pool');
select change_status((select id from pi_requests where ref = 'PI-00001'), 'in_progress');
select pg_temp.expect_error($$select change_status((select id from pi_requests where ref = 'PI-00001'), 'completed')$$, 'Upload at least one PI');
select pg_temp.expect_error($$select change_status((select id from pi_requests where ref = 'PI-00001'), 'sent_back', ' ')$$, 'reason is required');
select add_document((select id from pi_requests where ref = 'PI-00001'), 'pi_output', (select id::text from pi_requests where ref = 'PI-00001') || '/pi.pdf', 'pi.pdf');
select pg_temp.expect_error($$select add_document((select id from pi_requests where ref = 'PI-00001'), 'attachment', (select id::text from pi_requests where ref = 'PI-00001') || '/x.pdf', 'x.pdf')$$, 'cannot upload');
select change_status((select id from pi_requests where ref = 'PI-00001'), 'completed');
select pg_temp.expect_error($$select change_status((select id from pi_requests where ref = 'PI-00001'), 'in_progress')$$, 'cannot move');
select pg_temp.expect_error($$select remove_request((select id from pi_requests where ref = 'PI-00002'), 'x')$$, 'Only bsd');
select pg_temp.expect_error($$select change_status('20000000-0000-0000-0000-000000000004', 'completed')$$, 'assigned ops user or bsd');

-- 4b. Ops move their own work freely between Unassigned, Assigned and In progress
select pg_temp.as_user('00000000-0000-0000-0000-000000000003');
select claim_request((select id from pi_requests where ref = 'PI-00007'), true);
do $$ begin
  if (select status from pi_requests where ref = 'PI-00007') <> 'in_progress' then raise exception 'claim with start should go to in_progress'; end if;
end $$;
select change_status((select id from pi_requests where ref = 'PI-00007'), 'assigned');
select change_status((select id from pi_requests where ref = 'PI-00007'), 'in_progress');
select change_status((select id from pi_requests where ref = 'PI-00007'), 'submitted');
do $$ begin
  if (select assignee_id from pi_requests where ref = 'PI-00007') is not null then raise exception 'release should clear the assignee'; end if;
  raise notice 'ok: ops moved a request between unassigned, assigned and in progress';
end $$;
select claim_request((select id from pi_requests where ref = 'PI-00007'));
select pg_temp.expect_error($$select change_status((select id from pi_requests where ref = 'PI-00007'), 'completed')$$, 'cannot move');
select change_status((select id from pi_requests where ref = 'PI-00007'), 'submitted');

-- 5. Introducer 1 now sees the finished PI
select pg_temp.as_user('00000000-0000-0000-0000-000000000001');
do $$ begin
  if (select count(*) from request_documents where kind = 'pi_output') <> 3 then raise exception 'introducer should see 3 PIs on completed requests, saw %', (select count(*) from request_documents where kind = 'pi_output'); end if;
  raise notice 'ok: PIs reach the introducer once completed';
end $$;

-- 5b. Notifications
do $$ begin
  if (select count(*) from notifications where kind = 'completed') <> 1 then raise exception 'Sam should be told PI-00001 completed'; end if;
  if exists (select 1 from notifications where user_id <> auth.uid()) then raise exception 'introducer sees others notifications'; end if;
  if exists (select 1 from request_events where kind in ('assigned','reassigned','started','status_changed','released')) then raise exception 'introducer sees assignment events'; end if;
  raise notice 'ok: introducer got a completed notice and sees no assignment events';
end $$;
select mark_notifications_read();
do $$ begin
  if exists (select 1 from notifications where read_at is null) then raise exception 'mark read failed'; end if;
  raise notice 'ok: notifications can be marked read';
end $$;
select pg_temp.as_user('00000000-0000-0000-0000-000000000002');
do $$ begin
  if (select count(*) from notifications) <> 0 then raise exception 'Dana should have no notices'; end if;
end $$;
select refresh_deadline_notifications();
do $$ begin
  if (select count(*) from notifications) <> 0 then raise exception 'introducers must not generate or receive deadline notices'; end if;
end $$;
select pg_temp.as_user('00000000-0000-0000-0000-000000000003');
select refresh_deadline_notifications();
select refresh_deadline_notifications();
do $$ begin
  if (select count(*) from notifications where kind = 'overdue') <> 2 then raise exception 'Olivia should have 2 overdue notices (PI-00002, PI-00003), saw %', (select count(*) from notifications where kind = 'overdue'); end if;
  if (select count(*) from notifications where kind in ('due_soon','overdue')) <> 2 then raise exception 'deadline notices should not repeat'; end if;
  raise notice 'ok: ops get one deadline notice per assigned request';
end $$;
select pg_temp.as_user('00000000-0000-0000-0000-000000000004');
do $$ begin
  if (select count(*) from notifications where kind = 'resubmitted') <> 1 then raise exception 'Omar should be told PI-00004 was corrected'; end if;
  if (select count(*) from notifications where kind = 'overdue') <> 1 then raise exception 'Omar should have 1 overdue notice'; end if;
  raise notice 'ok: ops told when a sent-back request is corrected';
end $$;
select pg_temp.as_user('00000000-0000-0000-0000-000000000005');
do $$ begin
  if (select count(*) from notifications where kind = 'overdue') <> 3 then raise exception 'bsd should have 3 overdue notices, saw %', (select count(*) from notifications where kind = 'overdue'); end if;
  raise notice 'ok: bsd gets deadline notices for every open request';
end $$;

-- 6. Bsd sees all, assigns, removes; cannot read client details
select pg_temp.as_user('00000000-0000-0000-0000-000000000005');
do $$ begin
  if (select count(*) from pi_requests) <> 7 then raise exception 'bsd should see all 7, saw %', (select count(*) from pi_requests); end if;
  if exists (select 1 from request_clients) then raise exception 'bsd sees client details'; end if;
  raise notice 'ok: bsd sees every request but not client details';
end $$;
select assign_request((select id from pi_requests where ref = 'PI-00002'), '00000000-0000-0000-0000-000000000004');
select pg_temp.as_user('00000000-0000-0000-0000-000000000004');
do $$ begin
  if (select count(*) from notifications where kind = 'assigned') <> 1 then raise exception 'Omar should be told about the assignment'; end if;
  raise notice 'ok: ops notified when bsd assigns a request';
end $$;
select pg_temp.as_user('00000000-0000-0000-0000-000000000005');
select pg_temp.expect_error($$select assign_request((select id from pi_requests where ref = 'PI-00002'), '00000000-0000-0000-0000-000000000001')$$, 'ops user');
select pg_temp.expect_error($$select assign_request((select id from pi_requests where ref = 'PI-00001'), '00000000-0000-0000-0000-000000000004')$$, 'cannot be reassigned');
select pg_temp.expect_error($$select remove_request((select id from pi_requests where ref = 'PI-00002'), '')$$, 'reason is required');
select remove_request((select id from pi_requests where ref = 'PI-00002'), 'Client withdrew');
select pg_temp.expect_error($$select change_status((select id from pi_requests where ref = 'PI-00002'), 'in_progress')$$, 'removed');
-- bsd no longer manages users, settings or the audit log; admin does (and does not see requests).
select pg_temp.expect_error($$select admin_update_user('00000000-0000-0000-0000-000000000004', 'ops', false)$$, 'Only an admin');
select pg_temp.expect_error($$select update_settings(72, 24, true)$$, 'Only an admin');
do $$ begin
  if exists (select 1 from audit_log) then raise exception 'bsd should not read the audit log'; end if;
  if (select count(*) from profiles) < 6 then raise exception 'bsd should still see everyone (to assign requests)'; end if;
  raise notice 'ok: bsd cannot manage users, change settings or read the audit log';
end $$;
select pg_temp.as_user('00000000-0000-0000-0000-000000000006');
select pg_temp.expect_error($$select admin_update_user('00000000-0000-0000-0000-000000000006', 'bsd', true)$$, 'own admin');
select pg_temp.expect_error($$select admin_update_user('00000000-0000-0000-0000-000000000006', 'admin', false)$$, 'own admin');
select pg_temp.expect_error($$select admin_update_user('00000000-0000-0000-0000-0000000000ff', 'ops', true)$$, 'User not found');
select pg_temp.expect_error($$select assign_request((select id from pi_requests where ref = 'PI-00001'), '00000000-0000-0000-0000-000000000004')$$, 'Only bsd');
select admin_update_user('00000000-0000-0000-0000-000000000004', 'ops', false);
do $$ begin
  if (select count(*) from audit_log where action = 'request.removed') < 1 then raise exception 'removal not audited'; end if;
  if (select count(*) from profiles) < 6 then raise exception 'admin should see everyone'; end if;
  if exists (select 1 from pi_requests) or exists (select 1 from request_clients) or exists (select 1 from request_list) then
    raise exception 'admin should not see requests or client details'; end if;
  raise notice 'ok: admin manages users and reads the audit log, but sees no requests';
end $$;
select pg_temp.expect_error($$delete from audit_log$$, 'permission denied');
select pg_temp.expect_error($$select log_event('fake', 'x', 'y')$$, 'permission denied');

-- 7. Ops 2 deactivated: sees nothing
select pg_temp.as_user('00000000-0000-0000-0000-000000000004');
do $$ begin
  if (select count(*) from pi_requests) <> 0 then raise exception 'deactivated user still sees requests'; end if;
  raise notice 'ok: deactivated user sees nothing';
end $$;
-- 8. Priority (urgent flag): ops and bsd only. Introducers can neither see nor set it, nor see due times.
select pg_temp.as_user('00000000-0000-0000-0000-000000000001');
select pg_temp.expect_error($$select set_priority((select id from pi_requests where ref = 'PI-00007'), 'urgent')$$, 'Only the assigned ops user or bsd');
select create_request('{"age_band":"30 to 34","gender":"Male","smoker":false,"coverage_term":"6 to 10 years","sum_assured_band":"Up to S$100,000","priority":"urgent"}',
                      '{"client_name":"[Sample] Client Hotel"}');
select pg_temp.expect_error($$select priority from pi_requests$$, 'permission denied');
select pg_temp.expect_error($$select urgent_auto from pi_requests$$, 'permission denied');
select pg_temp.expect_error($$select due_at from pi_requests$$, 'permission denied');
select pg_temp.expect_error($$select paused_at from pi_requests$$, 'permission denied');
select pg_temp.expect_error($$select * from pi_requests$$, 'permission denied');
select pg_temp.expect_error($$update request_list set status = 'completed'$$, 'cannot update view');
do $$ begin
  if (select count(*) from request_list) <> 5 then raise exception 'introducer 1 should list 5 requests, saw %', (select count(*) from request_list); end if;
  if exists (select 1 from request_list where introducer_id <> auth.uid()) then raise exception 'request_list shows other introducers'' requests'; end if;
  if exists (select 1 from request_list where priority is not null or urgent_auto is not null or due_at is not null or paused_at is not null) then
    raise exception 'introducer sees priority or deadline fields'; end if;
  if exists (select 1 from request_events where kind = 'priority_changed' or detail ilike '%urgent%') then raise exception 'introducer sees urgent changes on the timeline'; end if;
  if exists (select 1 from notifications where kind = 'urgent' or message ilike '%urgent%') then raise exception 'introducer got an urgent notice'; end if;
  raise notice 'ok: introducers cannot see or set the urgent flag or due times';
end $$;
reset role;
do $$ begin
  if (select priority from pi_requests where ref = 'PI-00008') <> 'normal' then raise exception 'a priority sent by an introducer should be ignored'; end if;
  if (select due_at from pi_requests where ref = 'PI-00008') < now() + interval '47 hours' then raise exception 'new request should be due in 48h'; end if;
end $$;
set role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-000000000002');
select pg_temp.expect_error($$select set_priority('20000000-0000-0000-0000-000000000001', 'urgent')$$, 'not found');
select pg_temp.as_user('00000000-0000-0000-0000-000000000003');
select pg_temp.expect_error($$select set_priority((select id from pi_requests where ref = 'PI-00007'), 'urgent')$$, 'Only the assigned ops user or bsd');
select pg_temp.expect_error($$select generate_deadline_notifications()$$, 'permission denied');
select pg_temp.expect_error($$select mark_overdue_urgent()$$, 'permission denied');
select pg_temp.expect_error($$update request_list set status = 'completed'$$, 'cannot update view');
do $$ begin
  if (select priority from request_list where ref = 'PI-00003') <> 'urgent' or not (select urgent_auto from request_list where ref = 'PI-00003') then
    raise exception 'overdue PI-00003 should be urgent automatically for ops'; end if;
  if (select due_at from request_list where ref = 'PI-00003') is null then raise exception 'ops should see the due time'; end if;
  if (select priority from request_list where ref = 'PI-00007') <> 'normal' then raise exception 'PI-00007 is not overdue and should be normal'; end if;
  raise notice 'ok: ops see overdue requests as urgent automatically';
end $$;
select pg_temp.expect_error($$select set_priority('20000000-0000-0000-0000-000000000003', 'normal')$$, 'Overdue requests stay urgent');
select pg_temp.as_user('00000000-0000-0000-0000-000000000005');
do $$ begin
  if (select priority from request_list where ref = 'PI-00004') <> 'urgent' then raise exception 'PI-00004 was overdue before it was sent back and should stay urgent'; end if;
end $$;
select pg_temp.expect_error($$select set_priority('20000000-0000-0000-0000-000000000003', 'normal')$$, 'Overdue requests stay urgent');
select assign_request((select id from pi_requests where ref = 'PI-00008'), '00000000-0000-0000-0000-000000000003');
select set_priority((select id from pi_requests where ref = 'PI-00008'), 'urgent');
select pg_temp.expect_error($$select set_priority((select id from pi_requests where ref = 'PI-00008'), 'high')$$, 'normal or urgent');
do $$ begin
  if (select priority from request_list where ref = 'PI-00008') <> 'urgent' or (select urgent_auto from request_list where ref = 'PI-00008') then
    raise exception 'bsd could not flag PI-00008 urgent by hand'; end if;
  if not exists (select 1 from request_events e join pi_requests r on r.id = e.request_id
                 where r.ref = 'PI-00008' and e.kind = 'priority_changed' and not e.introducer_visible) then
    raise exception 'priority change should be on the staff timeline only'; end if;
end $$;
select pg_temp.as_user('00000000-0000-0000-0000-000000000003');
do $$ begin
  if (select count(*) from notifications where kind = 'urgent') <> 1 then raise exception 'Olivia should be told PI-00008 is urgent'; end if;
  raise notice 'ok: bsd and the assigned ops user flag requests urgent; the assignee is told';
end $$;

-- 8b. Requests that become overdue as time passes are marked urgent by the deadline check
reset role;
alter table pi_requests disable trigger pi_requests_overdue_urgent;
update pi_requests set due_at = now() - interval '1 hour' where ref = 'PI-00007';
alter table pi_requests enable trigger pi_requests_overdue_urgent;
select generate_deadline_notifications();
do $$ begin
  if (select priority from pi_requests where ref = 'PI-00007') <> 'urgent' or not (select urgent_auto from pi_requests where ref = 'PI-00007') then
    raise exception 'the deadline check should mark overdue PI-00007 urgent'; end if;
  if not exists (select 1 from request_events e join pi_requests r on r.id = e.request_id where r.ref = 'PI-00007'
                 and e.detail = 'Marked urgent automatically: overdue' and not e.introducer_visible) then
    raise exception 'automatic urgent flag should be on the staff timeline'; end if;
  if exists (select 1 from notifications n join profiles p on p.id = n.user_id
             where n.kind = 'overdue' and n.message not like 'URGENT %') then raise exception 'overdue notices should say URGENT'; end if;
  raise notice 'ok: the deadline check marks newly overdue requests urgent';
end $$;
set role authenticated;

-- 9. Reopen a completed request
select pg_temp.as_user('00000000-0000-0000-0000-000000000003');
select pg_temp.expect_error($$select reopen_request('20000000-0000-0000-0000-000000000001', 'x')$$, 'Only the introducer who submitted it or bsd');
select pg_temp.as_user('00000000-0000-0000-0000-000000000002');
select pg_temp.expect_error($$select reopen_request('20000000-0000-0000-0000-000000000001', 'x')$$, 'not found');
select pg_temp.as_user('00000000-0000-0000-0000-000000000001');
select pg_temp.expect_error($$select reopen_request('20000000-0000-0000-0000-000000000001', ' ')$$, 'wants changed');
select pg_temp.expect_error($$select reopen_request((select id from pi_requests where ref = 'PI-00007'), 'x')$$, 'Only a completed');
select reopen_request('20000000-0000-0000-0000-000000000001', 'Client wants 30 years cover');
do $$ begin
  if (select status from pi_requests where ref = 'PI-00001') <> 'in_progress' then raise exception 'reopen should go back to the same ops user, in progress'; end if;
  if (select assignee_id from pi_requests where ref = 'PI-00001') <> '00000000-0000-0000-0000-000000000003' then raise exception 'reopen lost the assignee'; end if;
  if exists (select 1 from request_documents d where d.request_id = '20000000-0000-0000-0000-000000000001' and d.kind = 'pi_output') then raise exception 'introducer should not see PIs of a reopened request'; end if;
  if not exists (select 1 from request_events where request_id = '20000000-0000-0000-0000-000000000001' and kind = 'reopened') then raise exception 'reopen event hidden from introducer'; end if;
end $$;
reset role;
do $$ begin
  if (select due_at from pi_requests where ref = 'PI-00001') < now() + interval '47 hours' then raise exception 'reopen should restart the deadline'; end if;
end $$;
set role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-000000000003');
do $$ begin
  if (select count(*) from notifications where kind = 'reopened') <> 1 then raise exception 'Olivia should be told PI-00001 was reopened'; end if;
end $$;
select pg_temp.as_user('00000000-0000-0000-0000-000000000005');
select reopen_request('20000000-0000-0000-0000-000000000005', 'Client asked for a lower sum assured');
do $$ begin
  if (select status from pi_requests where ref = 'PI-00005') <> 'submitted' or (select assignee_id from pi_requests where ref = 'PI-00005') is not null then
    raise exception 'reopen with a deactivated assignee should go to the unassigned pool'; end if;
end $$;
select pg_temp.as_user('00000000-0000-0000-0000-000000000001');
do $$ begin
  if (select count(*) from notifications where kind = 'reopened') <> 1 then raise exception 'Sam should be told bsd reopened PI-00005'; end if;
  raise notice 'ok: completed requests can be reopened by their introducer or bsd';
end $$;

-- 10. Configurable deadline (admin only)
do $$ begin
  if (select deadline_hours from app_settings) <> 48 then raise exception 'introducers should be able to read the settings'; end if;
end $$;
select pg_temp.expect_error($$select update_settings(72, 24, true)$$, 'Only an admin');
select pg_temp.as_user('00000000-0000-0000-0000-000000000005');
create temp table due_before as select ref, due_at from request_list;
select pg_temp.as_user('00000000-0000-0000-0000-000000000006');
select pg_temp.expect_error($$select update_settings(24, 24, true)$$, 'shorter than the deadline');
select pg_temp.expect_error($$select update_settings(0, 0, true)$$, 'between 1 and 720');
select update_settings(72, 24, true);
select pg_temp.as_user('00000000-0000-0000-0000-000000000005');
do $$ begin
  if exists (select 1 from request_list r join due_before b using (ref)
             where r.status not in ('completed', 'removed') and r.due_at <> b.due_at + interval '24 hours') then
    raise exception 'open requests should move by the change in deadline'; end if;
  if exists (select 1 from request_list r join due_before b using (ref) where r.status in ('completed', 'removed') and r.due_at <> b.due_at) then
    raise exception 'closed requests should not move'; end if;
  raise notice 'ok: admin changes the deadline and open requests follow';
  if (select priority from request_list where ref = 'PI-00007') <> 'normal' then raise exception 'automatic urgent should clear when the deadline moves later'; end if;
  if not exists (select 1 from request_events e join pi_requests r on r.id = e.request_id where r.ref = 'PI-00007'
                 and e.detail = 'Urgent flag removed automatically: no longer overdue') then raise exception 'automatic clear not on the timeline'; end if;
  if (select priority from request_list where ref = 'PI-00008') <> 'urgent' then raise exception 'a flag set by hand should stay'; end if;
  if (select priority from request_list where ref = 'PI-00003') <> 'urgent' then raise exception 'PI-00003 is still overdue and should stay urgent'; end if;
  raise notice 'ok: automatic urgent clears when no longer overdue; flags set by hand stay';
end $$;

-- 11. The clock pauses while a request is sent back
select pg_temp.as_user('00000000-0000-0000-0000-000000000003');
select change_status('20000000-0000-0000-0000-000000000001', 'sent_back', 'Which cover term?');
do $$ begin
  if (select paused_at from request_list where ref = 'PI-00001') is null then raise exception 'sending back should pause the clock'; end if;
end $$;
reset role; update pi_requests set paused_at = now() - interval '10 hours' where ref = 'PI-00001';
create temp table due_paused as select due_at from pi_requests where ref = 'PI-00001';
grant select on due_paused to authenticated;
set role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-000000000001');
select resubmit_request('20000000-0000-0000-0000-000000000001');
reset role;
do $$ begin
  if (select paused_at from pi_requests where ref = 'PI-00001') is not null then raise exception 'resubmit should restart the clock'; end if;
  if (select due_at from pi_requests where ref = 'PI-00001') < (select due_at from due_paused) + interval '10 hours' then raise exception 'paused time should be added to the deadline'; end if;
  raise notice 'ok: sent-back time does not count against the deadline';
end $$;
-- Completing (or removing) an overdue request clears the automatic flag
update pi_requests set status = 'completed', completed_at = now() where ref = 'PI-00003';
do $$ begin
  if (select priority from pi_requests where ref = 'PI-00003') <> 'normal' then raise exception 'completing should clear the automatic urgent flag'; end if;
  raise notice 'ok: completed requests lose the automatic urgent flag';
end $$;
update pi_requests set status = 'in_progress', completed_at = null where ref = 'PI-00003';
do $$ begin
  if (select priority from pi_requests where ref = 'PI-00003') <> 'urgent' then raise exception 'back in progress and overdue: urgent again'; end if;
end $$;
set role authenticated;

-- 12. Bulk assign (bsd)
select pg_temp.as_user('00000000-0000-0000-0000-000000000003');
select pg_temp.expect_error($$select assign_requests(array['20000000-0000-0000-0000-000000000005']::uuid[], '00000000-0000-0000-0000-000000000003')$$, 'Only bsd');
select pg_temp.as_user('00000000-0000-0000-0000-000000000005');
do $$ declare n int; begin
  n := assign_requests(array(select id from pi_requests where ref in ('PI-00005', 'PI-00007', 'PI-00008', 'PI-00003')), '00000000-0000-0000-0000-000000000003');
  if n <> 2 then raise exception 'bulk assign should assign 2 (PI-00003 and PI-00008 already with Olivia), did %', n; end if;
  if (select count(*) from pi_requests where assignee_id = '00000000-0000-0000-0000-000000000003' and ref in ('PI-00005', 'PI-00007', 'PI-00008')) <> 3 then raise exception 'bulk assign failed'; end if;
  raise notice 'ok: bsd assigns several requests at once';
end $$;
select pg_temp.expect_error($$select assign_requests(array['20000000-0000-0000-0000-000000000002']::uuid[], '00000000-0000-0000-0000-000000000003')$$, 'cannot be reassigned');

-- 13. Saved filters are private to each user
select pg_temp.as_user('00000000-0000-0000-0000-000000000001');
select save_filter('Urgent only', '{"priority":"urgent"}');
select save_filter('Urgent only', '{"priority":"urgent","status":"open"}');
select pg_temp.expect_error($$insert into saved_filters (name) values ('x')$$, 'permission denied');
do $$ begin
  if (select count(*) from saved_filters) <> 1 then raise exception 'saving the same name should replace it'; end if;
  if (select filters ->> 'status' from saved_filters) <> 'open' then raise exception 'saved filter not updated'; end if;
end $$;
select pg_temp.as_user('00000000-0000-0000-0000-000000000002');
do $$ begin
  if exists (select 1 from saved_filters) then raise exception 'Dana sees Sam''s saved filters'; end if;
end $$;
select delete_saved_filter((select id from saved_filters limit 1));
select set_email_alerts(false);
select pg_temp.as_user('00000000-0000-0000-0000-000000000001');
do $$ begin
  if (select count(*) from saved_filters) <> 1 then raise exception 'saved filter missing'; end if;
  if not (select email_alerts from profiles where id = auth.uid()) then raise exception 'Dana changed Sam''s email setting'; end if;
end $$;
select delete_saved_filter((select id from saved_filters limit 1));
do $$ begin
  if exists (select 1 from saved_filters) then raise exception 'delete saved filter failed'; end if;
  raise notice 'ok: saved filters and email preferences are per user';
end $$;
-- NRIC is not collected or stored any more.
do $$ begin
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'request_clients' and column_name = 'nric')
    then raise exception 'request_clients still has an nric column'; end if;
  raise notice 'ok: no NRIC column';
end $$;

-- Files: SQL can't delete storage rows (as on Supabase). Through the Storage API only the uploader can delete,
-- and only once the file is off the request.
select pg_temp.as_user('00000000-0000-0000-0000-000000000003');
select set_config('my.req', (select id::text from pi_requests where assignee_id = auth.uid() and status = 'in_progress' limit 1), false);
insert into storage.objects (bucket_id, name) values ('request-docs', current_setting('my.req') || '/del.pdf');
select set_config('my.doc', add_document(current_setting('my.req')::uuid, 'pi_output', current_setting('my.req') || '/del.pdf', 'del.pdf')::text, false);
select pg_temp.expect_error($$delete from storage.objects where name = current_setting('my.req') || '/del.pdf'$$, 'Use the Storage API');
select set_config('storage.allow_delete_query', 'true', false);
delete from storage.objects where name = current_setting('my.req') || '/del.pdf';
select pg_temp.as_user('00000000-0000-0000-0000-000000000001');
select pg_temp.expect_error($$select remove_document(current_setting('my.doc')::uuid)$$, 'cannot remove');
select pg_temp.as_user('00000000-0000-0000-0000-000000000003');
do $$ begin
  if not exists (select 1 from storage.objects where name = current_setting('my.req') || '/del.pdf') then raise exception 'a file still on the request was deleted'; end if;
end $$;
select remove_document(current_setting('my.doc')::uuid);
select pg_temp.as_user('00000000-0000-0000-0000-000000000001');
delete from storage.objects where name = current_setting('my.req') || '/del.pdf';
select pg_temp.as_user('00000000-0000-0000-0000-000000000003');
do $$ begin
  if not exists (select 1 from storage.objects where name = current_setting('my.req') || '/del.pdf') then raise exception 'someone else deleted the uploader''s file'; end if;
end $$;
delete from storage.objects where name = current_setting('my.req') || '/del.pdf';
do $$ begin
  if exists (select 1 from storage.objects where name = current_setting('my.req') || '/del.pdf') then raise exception 'uploader could not delete their removed file'; end if;
  raise notice 'ok: files are deleted through the Storage API, by the uploader, once off the request';
end $$;
select set_config('storage.allow_delete_query', '', false);

do $$ begin raise notice 'ALL ACCESS RULE TESTS PASSED'; end $$;
