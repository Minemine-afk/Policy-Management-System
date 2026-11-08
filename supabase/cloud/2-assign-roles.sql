-- Give people access. Add each user first in Authentication > Users > Add user (tick Auto Confirm User),
-- then change the emails below and run. Roles: introducer, ops, bsd.
-- You need at least one bsd user to manage everyone else from the Admin page afterwards.
update public.profiles set full_name = 'Kumar Chandru', role = 'bsd'
  where email = 'kumar.chandru@finexis.com.sg';

-- More examples (remove the leading -- to use):
-- update public.profiles set full_name = 'Test Ops',        role = 'ops'                                  where email = 'colleague1@finexis.com.sg';
-- update public.profiles set full_name = 'Test Introducer', role = 'introducer', company = 'Test Firm'  where email = 'colleague2@finexis.com.sg';

select full_name, email, company, role, active from public.profiles order by email;
