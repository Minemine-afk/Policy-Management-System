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
                      '{"client_name":"[Sample] Client Golf","nric":"S0000007G"}');
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
select pg_temp.expect_error($$select admin_update_user('00000000-0000-0000-0000-000000000005', 'ops', true)$$, 'own bsd');
select admin_update_user('00000000-0000-0000-0000-000000000004', 'ops', false);
do $$ begin
  if (select count(*) from audit_log where action = 'request.removed') < 1 then raise exception 'removal not audited'; end if;
  raise notice 'ok: assign, remove and user changes work and are audited';
end $$;
select pg_temp.expect_error($$delete from audit_log$$, 'permission denied');
select pg_temp.expect_error($$select log_event('fake', 'x', 'y')$$, 'permission denied');

-- 7. Ops 2 deactivated: sees nothing
select pg_temp.as_user('00000000-0000-0000-0000-000000000004');
do $$ begin
  if (select count(*) from pi_requests) <> 0 then raise exception 'deactivated user still sees requests'; end if;
  raise notice 'ok: deactivated user sees nothing';
end $$;
do $$ begin raise notice 'ALL ACCESS RULE TESTS PASSED'; end $$;
