-- Give people access. Add each user first in Authentication > Users > Add user,
-- then change the emails below and run. Roles: submitter, approver, content_editor, admin.
update public.profiles set full_name = 'Kumar Chandru', roles = '{admin,submitter,approver,content_editor}'
  where email = 'kumar.chandru@finexis.com.sg';

-- More examples (remove the leading -- to use):
-- update public.profiles set full_name = 'Second Admin',  roles = '{admin,approver}' where email = 'colleague1@finexis.com.sg';
-- update public.profiles set full_name = 'Test Submitter', roles = '{submitter}'     where email = 'colleague2@finexis.com.sg';

select full_name, email, roles, active from public.profiles order by email;
