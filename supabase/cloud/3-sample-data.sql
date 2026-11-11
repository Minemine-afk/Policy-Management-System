-- OPTIONAL sample requests, made up. Run after 2-assign-roles.sql, once at least one introducer and one ops user exist.
-- Remove later with 4-remove-sample-data.sql.
begin;
do $$
declare intro uuid; ops uuid; rid uuid;
begin
  select id into intro from public.profiles where role = 'introducer' and active order by created_at limit 1;
  select id into ops   from public.profiles where role = 'ops' and active order by created_at limit 1;
  if intro is null then raise exception 'Assign the introducer role to someone first (2-assign-roles.sql)'; end if;

  insert into public.pi_requests (introducer_id, status, assignee_id, gender, client_type, residency, nationality, date_of_birth,
                                  insurer, product, currency, amount_basis, amount, smoker, policy_term, premium_term, riders,
                                  compare_term, compare_product_1, compare_product_2)
  values (intro, 'submitted', null, 'Female', 'Individual', 'Singapore', 'Singaporean', '1993-04-12',
          'Singlife', 'Singlife Elite Term II', 'SGD', 'sum_assured', 300000, false, '20 years', 'Same as policy term', '{Critical illness}',
          true, 'FWD · FWD Term Life', 'Tokio Marine · TM TermProtect Plus') returning id into rid;
  insert into public.request_clients (request_id, owner_id, client_name) values (rid, intro, '[Sample] Client Alpha');
  insert into public.request_events (request_id, actor_id, kind, to_status) values (rid, intro, 'submitted', 'submitted');

  insert into public.pi_requests (introducer_id, status, assignee_id, gender, client_type, residency, nationality, date_of_birth,
                                  insurer, product, currency, amount_basis, amount, smoker, policy_term, premium_term)
  values (intro, case when ops is null then 'submitted' else 'in_progress' end::request_status, ops, 'Male', 'High net worth (HNW)',
          'Vietnam', 'Vietnamese', '1983-09-30', 'Manulife', 'ManuProtect Term II', 'USD', 'sum_assured', 1000000, true,
          'To age 65', 'Same as policy term') returning id into rid;
  insert into public.request_clients (request_id, owner_id, client_name) values (rid, intro, '[Sample] Client Bravo');
  insert into public.request_events (request_id, actor_id, kind, to_status) values (rid, intro, 'submitted', 'submitted');
end $$;
commit;
