-- ============================================================================================================
-- FAKE SAMPLE DATA ONLY: 20 made-up users (5 introducers, 5 ops, 5 bsd, 5 admin) and 3 made-up requests per introducer.
-- Every name, firm, client and phone number below is invented. Do not use with real client data.
--
-- Run after 1-setup.sql (and the 1b to 1e upgrade files if you use them). Safe to run twice: it skips users that exist.
-- Remove everything it adds with 4b-remove-sample-users.sql.
--
-- !! SET THE PASSWORD on the line marked "CHANGE THIS" first. All 20 sample logins share it, and 5 of them are
-- !! admin (can create users and change anyone's role). The site is online, so never use a guessable password, and remove the sample users
-- !! before real data goes in.
--
-- Logins: sample.introducer1@example.com ... sample.introducer5@example.com,
--         sample.ops1@example.com ... sample.ops5@example.com, sample.bsd1@example.com ... sample.bsd5@example.com,
--         sample.admin1@example.com ... sample.admin5@example.com
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
    ('sample.bsd1@example.com',        '[Sample] Kelvin BSD',       'bsd',        ''),
    ('sample.bsd2@example.com',        '[Sample] Li Ting BSD',      'bsd',        ''),
    ('sample.bsd3@example.com',        '[Sample] Marcus BSD',       'bsd',        ''),
    ('sample.bsd4@example.com',        '[Sample] Nadia BSD',        'bsd',        ''),
    ('sample.bsd5@example.com',        '[Sample] Oliver BSD',       'bsd',        ''),
    ('sample.admin1@example.com',      '[Sample] Priya Admin',      'admin',      ''),
    ('sample.admin2@example.com',      '[Sample] Qing Admin',       'admin',      ''),
    ('sample.admin3@example.com',      '[Sample] Rahul Admin',      'admin',      ''),
    ('sample.admin4@example.com',      '[Sample] Siti Admin',       'admin',      ''),
    ('sample.admin5@example.com',      '[Sample] Terence Admin',    'admin',      '')
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
      insert into public.pi_requests (introducer_id, status, assignee_id, gender, client_type, residency, nationality,
                                      date_of_birth, insurer, product, currency, amount_basis, amount, smoker, policy_term,
                                      premium_term, riders, compare_term, compare_product_1, compare_product_2,
                                      remarks, status_reason, submitted_at, completed_at, priority)
      values (
        u.id,
        (array['submitted', 'in_progress', 'completed'])[k]::request_status,      -- one waiting, one being worked on, one done
        case when k = 1 then null else ops_ids[1 + (i + k) % 5] end,
        case when (i + k) % 2 = 0 then 'Female' else 'Male' end,
        (array['Individual', 'Mass affluent', 'High net worth (HNW)', 'Business owner / key person'])[1 + (i + k) % 4],
        (array['Singapore', 'Malaysia', 'Indonesia', 'Vietnam', 'Singapore'])[1 + (i + k) % 5],
        (array['Singaporean', 'Malaysian', 'Indonesian', 'Vietnamese', 'Chinese'])[1 + (i + k) % 5],
        make_date(1970 + (i * 3 + k * 5) % 30, 1 + (i + k) % 12, 1 + (i * k) % 28),
        (array['Singlife', 'FWD', 'Tokio Marine', 'Manulife', 'AIA'])[1 + (i + k) % 5],
        (array['Singlife Elite Term II', 'FWD Term Life', 'TM TermProtect Plus', 'ManuProtect Term II', 'AIA Secure Flexi Term'])[1 + (i + k) % 5],
        case when (i + k) % 5 = 3 then 'USD' else 'SGD' end,
        case when k = 2 then 'premium' else 'sum_assured' end,
        case when k = 2 then 1200 + i * 100 else (array[100000, 250000, 500000, 1000000])[1 + (i + k) % 4] end,
        (i + k) % 4 = 0,
        (array['10 years', '20 years', 'To age 65'])[k],
        'Same as policy term',
        case when k <> 2 then '{Critical illness}'::text[] else '{}'::text[] end,
        k = 1,
        case when k = 1 then 'FWD · FWD Term Life' end,
        case when k = 1 then 'AIA · AIA Secure Flexi Term' end,
        '[Sample] Made-up request for testing',
        null,
        now() - make_interval(days => (4 - k) * 2 + i, hours => i * 3),
        case when k = 3 then now() - make_interval(days => i, hours => 1) end,
        case when k = 2 and i % 2 = 1 then 'urgent' else 'normal' end)   -- a few marked urgent
      returning id into rid;
      insert into public.request_clients (request_id, owner_id, client_name, contact)
      values (rid, u.id, format('[Sample] Client %s-%s', i, k), format('9000%s%s00', i, k));
      insert into public.request_events (request_id, actor_id, kind, to_status, at)
      values (rid, u.id, 'submitted', 'submitted', now() - make_interval(days => (4 - k) * 2 + i, hours => i * 3));
    end loop;
  end loop;
end $$;
commit;

select full_name, email, company, role, active,
       (select count(*) from public.pi_requests r where r.introducer_id = p.id) as requests
from public.profiles p where email like 'sample.%@example.com' order by role, email;
