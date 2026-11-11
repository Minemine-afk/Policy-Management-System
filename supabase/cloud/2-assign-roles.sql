-- Give people access. Add each user first in Authentication > Users > Add user (tick Auto Confirm User),
-- then change the emails below and run. Roles: introducer, ops, bsd, admin.
-- bsd works on requests (sees all, assigns, removes); admin manages users, deadline settings and the audit log.
-- You need at least one admin user to manage everyone else from the Admin page afterwards (one role per login).
update public.profiles set full_name = 'Kumar Chandru', role = 'admin'
  where email = 'kumar.chandru@finexis.com.sg';

-- More examples (remove the leading -- to use):
-- update public.profiles set full_name = 'Test Admin',      role = 'admin'                                where email = 'you+admin@finexis.com.sg';
-- update public.profiles set full_name = 'Test Ops',        role = 'ops'                                  where email = 'colleague1@finexis.com.sg';
-- update public.profiles set full_name = 'Test Introducer', role = 'introducer', company = 'Test Firm'  where email = 'colleague2@finexis.com.sg';

select full_name, email, company, role, active from public.profiles order by email;
