-- SAMPLE DATA ONLY. Names, introducers and premiums below are made up for the prototype.
-- Every sample login uses the password: password123  (local use only)

do $$
declare
  u record;
begin
  for u in select * from (values
    ('00000000-0000-0000-0000-000000000001'::uuid, 'submitter@example.com', 'Sam Submitter'),
    ('00000000-0000-0000-0000-000000000002'::uuid, 'approver@example.com',  'Alex Approver'),
    ('00000000-0000-0000-0000-000000000003'::uuid, 'approver2@example.com', 'Jordan Approver'),
    ('00000000-0000-0000-0000-000000000004'::uuid, 'admin@example.com',     'Pat Admin'),
    ('00000000-0000-0000-0000-000000000005'::uuid, 'admin2@example.com',    'Chris Admin'),
    ('00000000-0000-0000-0000-000000000006'::uuid, 'editor@example.com',    'Robin Editor')
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

-- Alex is both a submitter and an approver, to show that nobody can approve their own request.
update public.profiles set roles = '{submitter}'          where email = 'submitter@example.com';
update public.profiles set roles = '{submitter,approver}' where email = 'approver@example.com';
update public.profiles set roles = '{approver}'           where email = 'approver2@example.com';
update public.profiles set roles = '{admin}'              where email = 'admin@example.com';
update public.profiles set roles = '{admin,approver}'     where email = 'admin2@example.com';
update public.profiles set roles = '{content_editor}'     where email = 'editor@example.com';

-- Introducers -------------------------------------------------------------------
insert into public.introducers (name, entity_type, uen_or_ref, specialities, status, date_added, last_active, agreement_expiry, disclosure_on_file, contact_person, notes) values
  ('[Sample] Harbour Property Advisory Pte Ltd', 'Company', 'SAMPLE-001', '{Property,Mortgage}', 'active',     '2025-03-12', '2026-10-28', '2027-03-11', true,  'Contact A', 'Refers new home buyers'),
  ('[Sample] Lion City Accounting LLP',          'Company', 'SAMPLE-002', '{Accounting,SME owners}', 'active', '2024-11-02', '2026-09-15', '2026-11-01', true,  'Contact B', 'Agreement due for renewal'),
  ('[Sample] Orchard Legal Chambers',            'Company', 'SAMPLE-003', '{Legal,Estate planning}', 'active', '2026-01-20', '2026-10-30', '2028-01-19', true,  'Contact C', null),
  ('[Sample] Marina Car Dealers',                'Company', 'SAMPLE-004', '{Motor}', 'suspended',              '2023-06-05', '2025-12-01', '2026-06-04', false, 'Contact D', 'Suspended pending disclosure review'),
  ('[Sample] Individual introducer E',           'Individual', 'SAMPLE-005', '{Community,Referrals}', 'active', '2026-08-14', '2026-10-02', '2027-08-13', true, 'Contact E', null),
  ('[Sample] Tampines HR Consultancy',           'Company', 'SAMPLE-006', '{Employee benefits,SME owners}', 'terminated', '2022-02-10', '2024-05-30', '2025-02-09', true, 'Contact F', 'Terminated 2025');

-- Rate tables: three sample insurers, made-up premiums ---------------------------
insert into public.rate_tables (id, insurer, product_name, version, rates_as_at, status, uploaded_by, approved_by, approved_at) values
  ('10000000-0000-0000-0000-00000000000a', '[Sample Insurer A]', 'Term plan + CI rider', 1, '2026-10-01', 'approved',
   '00000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000005', now()),
  ('10000000-0000-0000-0000-00000000000b', '[Sample Insurer B]', 'Term plan + CI rider', 1, '2026-10-01', 'approved',
   '00000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000005', now()),
  ('10000000-0000-0000-0000-00000000000c', '[Sample Insurer C]', 'Term plan + CI rider', 1, '2026-09-15', 'approved',
   '00000000-0000-0000-0000-000000000005', '00000000-0000-0000-0000-000000000004', now());

with ages(age_band, f) as (values
  ('18 to 24', 0.8), ('25 to 29', 1.0), ('30 to 34', 1.2), ('35 to 39', 1.5), ('40 to 44', 2.0),
  ('45 to 49', 2.8), ('50 to 54', 3.9), ('55 to 59', 5.4), ('60 to 64', 7.5)),
terms(coverage_term, f) as (values
  ('5 years or less', 0.8), ('6 to 10 years', 1.0), ('11 to 20 years', 1.3), ('21 to 30 years', 1.7)),
sums(sum_assured_band, base) as (values
  ('Up to S$100,000', 90), ('S$100,001 to 250,000', 210), ('S$250,001 to 500,000', 420), ('Above S$500,000', 780)),
insurers(id, f) as (values
  ('10000000-0000-0000-0000-00000000000a'::uuid, 1.00),
  ('10000000-0000-0000-0000-00000000000b'::uuid, 1.08),
  ('10000000-0000-0000-0000-00000000000c'::uuid, 0.94))
insert into public.rate_rows (rate_table_id, age_band, gender, smoker, coverage_term, sum_assured_band, ci_benefit, premium_low, premium_high)
select i.id, a.age_band, g.gender, s.smoker, t.coverage_term, su.sum_assured_band, c.ci,
       round(p, 0), round(p * 1.35, 0)
from insurers i, ages a, terms t, sums su,
     (values ('Male', 1.1), ('Female', 1.0)) g(gender, f),
     (values (false, 1.0), (true, 1.8)) s(smoker, f),
     (values (false, 1.0), (true, 2.6)) c(ci, f),
     lateral (select su.base * a.f * t.f * g.f * s.f * c.f * i.f as p) x;

-- Knowledge bank (text only; upload real files through the app) -------------------
insert into public.kb_documents (title, doc_type, insurer, tags, description, body_text, uploaded_by) values
  ('[Sample] Term life product summary, Insurer A', 'Product', '[Sample Insurer A]', '{term,ci}',
   'Key features, exclusions and riders for the sample term plan.',
   'Level term cover. Critical illness rider available. Coverage terms 5 to 30 years. Exclusions apply in the first year for suicide.', '00000000-0000-0000-0000-000000000006'),
  ('[Sample] Term life product summary, Insurer B', 'Product', '[Sample Insurer B]', '{term}',
   'Key features of the sample term plan without CI.',
   'Level term cover with optional total and permanent disability. Renewable to age 85.', '00000000-0000-0000-0000-000000000006'),
  ('[Sample] Critical illness rider guide', 'Product', null, '{term,ci}',
   'How the CI rider works, staged versus late-stage cover.',
   'Critical illness rider pays on diagnosis of a covered illness. Early, intermediate and late stage definitions follow the LIA standard.', '00000000-0000-0000-0000-000000000006'),
  ('[Sample] Introducer onboarding checklist', 'Onboarding', null, '{introducers,onboarding}',
   'Steps to onboard a new introducer under FAA-N02.',
   'Due diligence, written agreement, disclosure document, script, training on what introducers may and may not do. Introducers must not handle client money.', '00000000-0000-0000-0000-000000000006'),
  ('[Sample] How to redact documents before upload', 'Process', null, '{redaction,onboarding}',
   'Black out name, NRIC, date of birth, address and contact details.',
   'Use a redaction tool that removes the text, then flatten the PDF. Drawing a box over text is not enough. NRIC phone email address must be removed.', '00000000-0000-0000-0000-000000000006'),
  ('[Sample] New adviser onboarding guide', 'Onboarding', null, '{onboarding}',
   'First week for new representatives.',
   'Systems access, compliance training, CMFAS and RES requirements, supervisor introductions.', '00000000-0000-0000-0000-000000000006');

-- A few requests so every screen has something to show --------------------------
do $$
declare r uuid;
begin
  -- Sam: submitted, waiting
  perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', true);
  insert into public.policy_requests (age_band, gender, smoker, coverage_term, sum_assured_band, ci_benefit, introducer_id, attested)
  values ('40 to 44', 'Male', false, '11 to 20 years', 'Above S$500,000', false,
          (select id from public.introducers where uen_or_ref = 'SAMPLE-001'), true)
  returning id into r;
  perform public.submit_request(r);

  insert into public.policy_requests (age_band, gender, smoker, coverage_term, sum_assured_band, ci_benefit, introducer_id, attested)
  values ('30 to 34', 'Female', false, '6 to 10 years', 'Up to S$100,000', true,
          (select id from public.introducers where uen_or_ref = 'SAMPLE-003'), true)
  returning id into r;
  perform public.submit_request(r);

  -- Sam: draft
  insert into public.policy_requests (age_band, gender, smoker, coverage_term, sum_assured_band, ci_benefit)
  values ('25 to 29', 'Male', false, '6 to 10 years', 'S$100,001 to 250,000', true);

  -- Alex (submitter + approver): own request, which Alex cannot approve
  perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000002', true);
  insert into public.policy_requests (age_band, gender, smoker, coverage_term, sum_assured_band, ci_benefit, attested)
  values ('35 to 39', 'Female', true, '21 to 30 years', 'S$250,001 to 500,000', false, true)
  returning id into r;
  perform public.submit_request(r);
  perform set_config('request.jwt.claim.sub', '', true);
end $$;
