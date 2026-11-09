-- ============================================================================================================
-- FAKE SAMPLE DATA ONLY: 15 made-up users (5 introducers, 5 ops, 5 bsd) and 3 made-up requests per introducer.
-- Every name, firm, client, NRIC and phone number below is invented. Do not use with real client data.
--
-- Run after 1-setup.sql (and 1b/1c-upgrade.sql if you use them). Safe to run twice: it skips users that exist.
-- Remove everything it adds with 4b-remove-sample-users.sql.
--
-- !! SET THE PASSWORD on the line marked "CHANGE THIS" first. All 15 sample logins share it, and 5 of them are
-- !! bsd (full admin). The site is online, so never use a guessable password, and remove the sample users
-- !! before real data goes in.
--
-- Logins: sample.introducer1@example.com ... sample.introducer5@example.com,
--         sample.ops1@example.com ... sample.ops5@example.com, sample.bsd1@example.com ... sample.bsd5@example.com
-- ============================================================================================================
begin;
do $$
declare
  sample_password text := 'CHANGE-THIS-PASSWORD';   -- CHANGE THIS (at least 8 characters)
  u record; uid uuid; rid uuid; ops_ids uuid[]; i int; k int;
begin
  if sample_password = 'CHANGE-THIS-PASSWORD' or length(sample_password) < 8 then
    raise exception 'Set sample_password near the top of this script first (at least 8 characters).';
  end if;

  -- 1. Users ---------------------------------------------------------------------------------------------------
  for u in select * from (values
    ('sample.introducer1@example.com', '[Sample] Aisha Introducer', 'introducer', '[Sample] Marina Bay Property'),
    ('sample.introducer2@example.com', '[Sample] Ben Introducer',   'introducer', '[Sample] Orchard Accounting'),
    ('sample.introducer3@example.com', '[Sample] Chloe Introducer', 'introducer', '[Sample] Tampines Law Practice'),
    ('sample.introducer4@example.com', '[Sample] Daniel Introducer','introducer', '[Sample] Jurong Car Dealers'),
    ('sample.introducer5@example.com', '[Sample] Esther Introducer','introducer', '[Sample] Bedok Mortgage Brokers'),
    ('sample.ops1@example.com',        '[Sample] Farah Ops',        'ops',        ''),
    ('sample.ops2@example.com',        '[Sample] Gavin Ops',        'ops',        ''),
    ('sample.ops3@example.com',        '[Sample] Hui Min Ops',      'ops',        ''),
    ('sample.ops4@example.com',        '[Sample] Imran Ops',        'ops',        ''),
    ('sample.ops5@example.com',        '[Sample] Jia Hui Ops',      'ops',        ''),
    ('sample.bsd1@example.com',        '[Sample] Kelvin Admin',       'bsd',        ''),
    ('sample.bsd2@example.com',        '[Sample] Li Ting Admin',      'bsd',        ''),
    ('sample.bsd3@example.com',        '[Sample] Marcus Admin',       'bsd',        ''),
    ('sample.bsd4@example.com',        '[Sample] Nadia Admin',        'bsd',        ''),
    ('sample.bsd5@example.com',        '[Sample] Oliver Admin',       'bsd',        '')
  ) as t(email, full_name, role, company)
  loop
    if not exists (select 1 from auth.users where email = u.email) then
      uid := gen_random_uuid();
      insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
                              raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
                              confirmation_token, recovery_token, email_change_token_new, email_change)
      values ('00000000-0000-0000-0000-000000000000', uid, 'authenticated', 'authenticated', u.email,
              crypt(sample_password, gen_salt('bf')), now(),
              '{"provider":"email","providers":["email"],"sample":true}', jsonb_build_object('full_name', u.full_name),
              now(), now(), '', '', '', '');
      insert into auth.identities (provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
      values (uid::text, uid, jsonb_build_object('sub', uid::text, 'email', u.email, 'email_verified', true), 'email', now(), now(), now());
    end if;
    -- The profile row is made by the on_auth_user_created trigger; give it the role.
    update public.profiles set full_name = u.full_name, role = u.role::app_role, company = u.company, active = true
      where email = u.email;
  end loop;

  -- 2. Requests: 3 per sample introducer (only if they have none yet) ------------------------------------------
  select array_agg(id order by email) into ops_ids from public.profiles where email like 'sample.ops_@example.com';
  i := 0;
  for u in select p.id, p.email from public.profiles p where p.email like 'sample.introducer_@example.com' order by p.email
  loop
    i := i + 1;
    continue when exists (select 1 from public.pi_requests where introducer_id = u.id);
    for k in 1..3 loop
      insert into public.pi_requests (introducer_id, status, assignee_id, age_band, gender, smoker, coverage_term,
                                      sum_assured_band, ci_benefit, remarks, status_reason, submitted_at, completed_at, priority)
      values (
        u.id,
        (array['submitted', 'in_progress', 'completed'])[k]::request_status,      -- one waiting, one being worked on, one done
        case when k = 1 then null else ops_ids[1 + (i + k) % 5] end,
        (array['25 to 29', '30 to 34', '35 to 39', '40 to 44', '45 to 49'])[1 + (i + k) % 5],
        case when (i + k) % 2 = 0 then 'Female' else 'Male' end,
        (i + k) % 4 = 0,
        (array['6 to 10 years', '11 to 20 years', '21 to 30 years'])[k],
        (array['Up to S$100,000', 'S$100,001 to 250,000', 'S$250,001 to 500,000', 'Above S$500,000'])[1 + (i + k) % 4],
        k <> 2,
        '[Sample] Made-up request for testing',
        null,
        now() - make_interval(days => (4 - k) * 2 + i, hours => i * 3),
        case when k = 3 then now() - make_interval(days => i, hours => 1) end,
        case when k = 2 and i % 2 = 1 then 'urgent' else 'normal' end)   -- a few marked urgent
      returning id into rid;
      insert into public.request_clients (request_id, owner_id, client_name, nric, contact)
      values (rid, u.id, format('[Sample] Client %s-%s', i, k), format('S99%s%s000Z', i, k), format('9000%s%s00', i, k));
      insert into public.request_events (request_id, actor_id, kind, to_status, at)
      values (rid, u.id, 'submitted', 'submitted', now() - make_interval(days => (4 - k) * 2 + i, hours => i * 3));
    end loop;
  end loop;
end $$;
commit;

select full_name, email, company, role, active,
       (select count(*) from public.pi_requests r where r.introducer_id = p.id) as requests
from public.profiles p where email like 'sample.%@example.com' order by role, email;
