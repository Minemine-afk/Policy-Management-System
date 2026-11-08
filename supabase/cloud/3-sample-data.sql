-- OPTIONAL sample requests, made up. Run after 2-assign-roles.sql, once at least one introducer and one ops user exist.
-- Remove later with 4-remove-sample-data.sql.
begin;
do $$
declare intro uuid; ops uuid; rid uuid;
begin
  select id into intro from public.profiles where role = 'introducer' and active order by created_at limit 1;
  select id into ops   from public.profiles where role = 'ops' and active order by created_at limit 1;
  if intro is null then raise exception 'Assign the introducer role to someone first (2-assign-roles.sql)'; end if;

  insert into public.pi_requests (introducer_id, status, assignee_id, age_band, gender, smoker, coverage_term, sum_assured_band, ci_benefit)
  values (intro, 'submitted', null, '30 to 34', 'Female', false, '11 to 20 years', 'S$250,001 to 500,000', true) returning id into rid;
  insert into public.request_clients (request_id, owner_id, client_name) values (rid, intro, '[Sample] Client Alpha');
  insert into public.request_events (request_id, actor_id, kind, to_status) values (rid, intro, 'submitted', 'submitted');

  insert into public.pi_requests (introducer_id, status, assignee_id, age_band, gender, smoker, coverage_term, sum_assured_band, ci_benefit)
  values (intro, case when ops is null then 'submitted' else 'in_progress' end::request_status, ops, '40 to 44', 'Male', true, '21 to 30 years', 'Above S$500,000', false) returning id into rid;
  insert into public.request_clients (request_id, owner_id, client_name) values (rid, intro, '[Sample] Client Bravo');
  insert into public.request_events (request_id, actor_id, kind, to_status) values (rid, intro, 'submitted', 'submitted');
end $$;
commit;
