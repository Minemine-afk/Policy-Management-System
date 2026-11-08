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
  if exists (select 1 from profiles where role = 'introducer' and id <> auth.uid()) then raise exception 'introducer sees other introducer profiles'; end if;
  raise notice 'ok: introducers are isolated from each other';
end $$;
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

-- 5. Introducer 1 now sees the finished PI
select pg_temp.as_user('00000000-0000-0000-0000-000000000001');
do $$ begin
  if (select count(*) from request_documents where kind = 'pi_output') <> 3 then raise exception 'introducer should see 3 PIs on completed requests, saw %', (select count(*) from request_documents where kind = 'pi_output'); end if;
  raise notice 'ok: PIs reach the introducer once completed';
end $$;

-- 6. Bsd sees all, assigns, removes; cannot read client details
select pg_temp.as_user('00000000-0000-0000-0000-000000000005');
do $$ begin
  if (select count(*) from pi_requests) <> 7 then raise exception 'bsd should see all 7, saw %', (select count(*) from pi_requests); end if;
  if exists (select 1 from request_clients) then raise exception 'bsd sees client details'; end if;
  raise notice 'ok: bsd sees every request but not client details';
end $$;
select assign_request((select id from pi_requests where ref = 'PI-00002'), '00000000-0000-0000-0000-000000000004');
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
