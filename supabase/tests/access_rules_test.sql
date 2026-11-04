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

-- 1. Submitter sees only own requests
select pg_temp.as_user('00000000-0000-0000-0000-000000000001');
do $$ begin
  if (select count(*) from policy_requests) <> 3 then raise exception 'submitter should see 3, saw %', (select count(*) from policy_requests); end if;
  if exists (select 1 from policy_requests where submitter_id <> auth.uid()) then raise exception 'submitter sees others'; end if;
  raise notice 'ok: submitter sees only own 3 requests';
end $$;

-- 2. Submitter cannot set status directly or approve
select pg_temp.expect_error($$update policy_requests set status = 'approved'$$, 'permission denied');
select pg_temp.expect_error($$select decide_request((select id from policy_requests where status='submitted' limit 1), 'approve')$$, 'Approver role');

-- 3. Submit needs attestation
select pg_temp.expect_error($$select submit_request((select id from policy_requests where status='draft' limit 1))$$, 'redacted');
update policy_requests set attested = true where status = 'draft';
select submit_request((select id from policy_requests where status='draft' limit 1));
do $$ begin
  if (select jsonb_array_length(price_snapshot) from policy_requests where age_band='25 to 29' and submitter_id = auth.uid()) <> 3
  then raise exception 'expected 3 insurer price ranges'; end if;
  raise notice 'ok: submit froze 3 price ranges';
end $$;

-- 4. Alex (submitter + approver) sees others' submitted requests but cannot decide own
select pg_temp.as_user('00000000-0000-0000-0000-000000000002');
do $$ begin
  if (select count(*) from policy_requests where submitter_id <> auth.uid()) <> 3 then raise exception 'approver should see 3 of Sam''s submitted'; end if;
  if exists (select 1 from policy_requests where status = 'draft' and submitter_id <> auth.uid()) then raise exception 'approver sees drafts'; end if;
  raise notice 'ok: approver sees submitted requests, not drafts';
end $$;
select pg_temp.expect_error($$select decide_request((select id from policy_requests where submitter_id = auth.uid()), 'approve')$$, 'own request');

-- 5. Reason required to reject / refer back
select pg_temp.expect_error($$select decide_request((select id from policy_requests where age_band='40 to 44'), 'reject', '  ')$$, 'reason is required');
select decide_request((select id from policy_requests where age_band='40 to 44'), 'refer_back', 'Please attach the needs analysis');
select decide_request((select id from policy_requests where age_band='30 to 34'), 'approve');
select pg_temp.expect_error($$select decide_request((select id from policy_requests where age_band='30 to 34'), 'reject', 'x')$$, 'not awaiting');

-- 6. Approvers cannot read private case refs or the audit log
do $$ begin
  if exists (select 1 from request_private_refs) then raise exception 'approver sees private refs'; end if;
  if exists (select 1 from audit_log) then raise exception 'non-admin sees audit log'; end if;
  raise notice 'ok: private refs and audit log hidden from approver';
end $$;

-- 7. Admin sees everything; rate table needs a second admin
select pg_temp.as_user('00000000-0000-0000-0000-000000000004');
do $$ begin
  if (select count(*) from policy_requests) <> 4 then raise exception 'admin should see 4'; end if;
  if (select count(*) from audit_log) = 0 then raise exception 'audit log empty'; end if;
  raise notice 'ok: admin sees all 4 requests and the audit log';
end $$;
insert into rate_tables (insurer, product_name, version, rates_as_at, uploaded_by)
  values ('[Sample Insurer A]', 'Term plan + CI rider', 2, '2026-11-01', auth.uid());
select pg_temp.expect_error($$select approve_rate_table((select id from rate_tables where version = 2))$$, 'second admin');
select pg_temp.as_user('00000000-0000-0000-0000-000000000005');
select approve_rate_table((select id from rate_tables where version = 2));
do $$ begin
  if (select status from rate_tables where insurer = '[Sample Insurer A]' and version = 1) <> 'retired' then raise exception 'old table not retired'; end if;
  raise notice 'ok: second admin approved v2, v1 retired';
end $$;
select pg_temp.expect_error($$select admin_update_user(auth.uid(), '{approver}', true)$$, 'own admin');

-- 8. Inactive users see nothing
reset role;
update profiles set active = false where email = 'submitter@example.com';
set role authenticated;
select pg_temp.as_user('00000000-0000-0000-0000-000000000001');
do $$ begin
  if exists (select 1 from policy_requests) or exists (select 1 from introducers) then raise exception 'inactive user sees data'; end if;
  raise notice 'ok: deactivated user sees nothing';
end $$;

-- 9. Knowledge bank search
select pg_temp.as_user('00000000-0000-0000-0000-000000000003');
do $$ begin
  if not exists (select 1 from kb_documents where search @@ websearch_to_tsquery('english', 'critical illness')) then raise exception 'search failed'; end if;
  if (select count(*) from kb_documents where tags && '{term}') < 3 then raise exception 'tag match failed'; end if;
  raise notice 'ok: knowledge bank search and tag match';
end $$;
select pg_temp.expect_error($$insert into kb_documents (title, doc_type) values ('x', 'Product')$$, 'row-level security');

-- 10. Report unredacted hides the file
reset role;
insert into request_documents (request_id, storage_path, file_name, uploaded_by)
  select id, id || '/form.pdf', 'form.pdf', submitter_id from policy_requests where age_band = '30 to 34';
set role authenticated;
select report_unredacted((select id from request_documents limit 1), 'NRIC visible page 1');
do $$ begin
  if exists (select 1 from request_documents) then raise exception 'reported file still visible to approver'; end if;
  raise notice 'ok: reported file hidden from approver';
end $$;
\echo ALL ACCESS RULE TESTS PASSED
