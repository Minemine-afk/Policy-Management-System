-- SAMPLE DATA ONLY. Names and clients below are made up for the prototype.
-- Every sample login uses the password: password123  (local use only)

do $$
declare u record;
begin
  for u in select * from (values
    ('00000000-0000-0000-0000-000000000001'::uuid, 'introducer1@example.com', 'Sam Introducer'),
    ('00000000-0000-0000-0000-000000000002'::uuid, 'introducer2@example.com', 'Dana Introducer'),
    ('00000000-0000-0000-0000-000000000003'::uuid, 'ops1@example.com',        'Olivia Ops'),
    ('00000000-0000-0000-0000-000000000004'::uuid, 'ops2@example.com',        'Omar Ops'),
    ('00000000-0000-0000-0000-000000000005'::uuid, 'bsd@example.com',         'Pat BSD'),
    ('00000000-0000-0000-0000-000000000006'::uuid, 'admin@example.com',       'Alex Admin')
  ) as t(id, email, full_name)
  loop
    insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
                            raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
                            confirmation_token, recovery_token, email_change_token_new, email_change)
    values ('00000000-0000-0000-0000-000000000000', u.id, 'authenticated', 'authenticated', u.email,
            crypt('password123', gen_salt('bf')), now(),
            '{"provider":"email","providers":["email"]}', jsonb_build_object('full_name', u.full_name),
            now(), now(), '', '', '', '');
    insert into auth.identities (provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
    values (u.id::text, u.id, jsonb_build_object('sub', u.id::text, 'email', u.email), 'email', now(), now(), now());
  end loop;
end $$;

update public.profiles set role = 'introducer', company = '[Sample] Harbour Property Advisory' where email = 'introducer1@example.com';
update public.profiles set role = 'introducer', company = '[Sample] Lion City Accounting'       where email = 'introducer2@example.com';
update public.profiles set role = 'ops'  where email in ('ops1@example.com', 'ops2@example.com');
update public.profiles set role = 'bsd'  where email = 'bsd@example.com';
update public.profiles set role = 'admin' where email = 'admin@example.com';

-- Requests: ids end in the same number as the sample story --------------------------
insert into public.pi_requests (id, ref, introducer_id, status, assignee_id, gender, client_type, residency, nationality,
                                date_of_birth, insurer, product, currency, amount_basis, amount, smoker, policy_term, premium_term,
                                riders, compare_term, compare_product_1, compare_product_2, remarks, status_reason, submitted_at, completed_at) values
 ('20000000-0000-0000-0000-000000000001', 'PI-00001', '00000000-0000-0000-0000-000000000001', 'submitted', null,
  'Female', 'Individual', 'Singapore', 'Singaporean', '1993-04-12', 'Singlife', 'Singlife Elite Term II', 'SGD', 'sum_assured', 300000,
  false, '20 years', 'Same as policy term', '{Critical illness}', true, 'FWD · FWD Term Life', 'Tokio Marine · TM TermProtect Plus',
  'First-time buyer, wants CI cover', null, now() - interval '1 day', null),
 ('20000000-0000-0000-0000-000000000002', 'PI-00002', '00000000-0000-0000-0000-000000000001', 'assigned', '00000000-0000-0000-0000-000000000003',
  'Male', 'High net worth (HNW)', 'Vietnam', 'Vietnamese', '1983-09-30', 'Manulife', 'ManuProtect Term II', 'USD', 'sum_assured', 1000000,
  true, 'To age 65', 'Same as policy term', '{}', false, null, null, null, null, now() - interval '3 days', null),
 ('20000000-0000-0000-0000-000000000003', 'PI-00003', '00000000-0000-0000-0000-000000000002', 'in_progress', '00000000-0000-0000-0000-000000000003',
  'Female', 'Mass affluent', 'Singapore', 'Malaysian', '1988-01-15', 'FWD', 'FWD Term Life', 'SGD', 'premium', 1200,
  false, '25 years', 'Same as policy term', '{Critical illness,Total and permanent disability}', false, null, null, null, null, now() - interval '5 days', null),
 ('20000000-0000-0000-0000-000000000004', 'PI-00004', '00000000-0000-0000-0000-000000000002', 'sent_back', '00000000-0000-0000-0000-000000000004',
  'Male', 'Individual', 'Singapore', 'Singaporean', '1998-06-02', 'Tokio Marine', 'TM TermProtect Plus', 'SGD', 'sum_assured', 100000,
  false, '10 years', 'Same as policy term', '{}', false, null, null, null, 'Please confirm the intended sum assured', now() - interval '6 days', null),
 ('20000000-0000-0000-0000-000000000005', 'PI-00005', '00000000-0000-0000-0000-000000000001', 'completed', '00000000-0000-0000-0000-000000000004',
  'Male', 'Business owner / key person', 'Indonesia', 'Indonesian', '1979-11-30', 'Singlife', 'Singlife Term CI', 'SGD', 'sum_assured', 500000,
  false, '20 years', 'Same as policy term', '{Terminal illness}', true, 'FWD · Future First', null, null, null, now() - interval '12 days', now() - interval '8 days'),
 ('20000000-0000-0000-0000-000000000006', 'PI-00006', '00000000-0000-0000-0000-000000000002', 'removed', null,
  'Female', 'Individual', 'Malaysia', 'Malaysian', '1974-03-08', 'AIA', 'AIA Secure Flexi Term', 'SGD', 'sum_assured', 80000,
  true, '5 years', 'Same as policy term', '{}', false, null, null, null, 'Duplicate of an earlier request', now() - interval '9 days', null);
select setval('public.request_ref_seq', 6);
-- PI-00004 was sent back 3 days ago: its deadline clock is paused until the introducer resubmits.
update public.pi_requests set paused_at = now() - interval '3 days' where ref = 'PI-00004';

insert into public.request_clients (request_id, owner_id, client_name, contact)
select r.id, r.introducer_id, c.name, c.contact
from public.pi_requests r
join (values
  ('PI-00001', '[Sample] Client Alpha', '90000001'),
  ('PI-00002', '[Sample] Client Bravo', '90000002'),
  ('PI-00003', '[Sample] Client Charlie', '90000003'),
  ('PI-00004', '[Sample] Client Delta', '90000004'),
  ('PI-00005', '[Sample] Client Echo', '90000005'),
  ('PI-00006', '[Sample] Client Foxtrot', '90000006')) as c(ref, name, contact) on c.ref = r.ref;

insert into public.request_events (request_id, actor_id, kind, from_status, to_status, detail, introducer_visible, at)
select id, introducer_id, 'submitted', null, 'submitted', null, true, submitted_at from public.pi_requests;
insert into public.request_events (request_id, actor_id, kind, from_status, to_status, detail, introducer_visible, at) values
 ('20000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000003', 'assigned', 'submitted', 'assigned', 'Picked up', false, now() - interval '2 days'),
 ('20000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000005', 'assigned', 'submitted', 'assigned', 'To Olivia Ops', false, now() - interval '4 days'),
 ('20000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000003', 'started', 'assigned', 'in_progress', null, false, now() - interval '3 days'),
 ('20000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000004', 'assigned', 'submitted', 'assigned', 'Picked up', false, now() - interval '5 days'),
 ('20000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000004', 'sent_back', 'assigned', 'sent_back', 'Please confirm the intended sum assured', true, now() - interval '3 days'),
 ('20000000-0000-0000-0000-000000000005', '00000000-0000-0000-0000-000000000004', 'assigned', 'submitted', 'assigned', 'Picked up', false, now() - interval '11 days'),
 ('20000000-0000-0000-0000-000000000005', '00000000-0000-0000-0000-000000000004', 'completed', 'in_progress', 'completed', null, true, now() - interval '8 days'),
 ('20000000-0000-0000-0000-000000000006', '00000000-0000-0000-0000-000000000005', 'removed', 'submitted', 'removed', 'Duplicate of an earlier request', true, now() - interval '8 days');

insert into public.request_comments (request_id, author_id, body, internal, created_at) values
 ('20000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000003', 'Internal: waiting on the insurer C quote before finishing.', true, now() - interval '2 days'),
 ('20000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000003', 'Working on this now, PIs by tomorrow.', false, now() - interval '2 days'),
 ('20000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000004', 'Is the client looking at 100k or 150k cover?', false, now() - interval '4 days');

insert into public.request_documents (request_id, kind, storage_path, file_name, uploaded_by) values
 ('20000000-0000-0000-0000-000000000005', 'pi_output', '20000000-0000-0000-0000-000000000005/insurer-a-pi.pdf', 'insurer-a-pi.pdf', '00000000-0000-0000-0000-000000000004'),
 ('20000000-0000-0000-0000-000000000005', 'pi_output', '20000000-0000-0000-0000-000000000005/insurer-b-pi.pdf', 'insurer-b-pi.pdf', '00000000-0000-0000-0000-000000000004');
