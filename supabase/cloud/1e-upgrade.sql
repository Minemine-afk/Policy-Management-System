-- UPGRADE for a project that already ran 1-setup.sql (before 12 Nov 2026). Paste the whole file into SQL Editor and Run once.
-- Adds the separate Admin role. Do NOT run this on a fresh project (use 1-setup.sql).
-- Never ran 1b, 1c or 1d-upgrade.sql? Run those first, in order, then this one.
--
-- !! BEFORE RUNNING: put the email of the login that should become Admin on the line marked "CHANGE THIS" below.
-- !! It must be an account that already exists (Authentication > Users). One role per login: that account stops
-- !! being BSD/ops/introducer. To keep your BSD login as it is, first add a second login for yourself (for example
-- !! you+admin@yourdomain) in Authentication > Users > Add user (tick Auto Confirm User) and use that one here.
-- The script stops without changing anything if the email is not set or not found.

-- Step 1 adds the role on its own (PostgreSQL can't use a new role value in the same transaction that adds it).
alter type public.app_role add value if not exists 'admin';
commit;

begin;
-- A separate Admin role (12 Nov 2026):
--  * admin (new) manages the system: creates users and changes their role, name, firm and active state,
--    changes the deadline settings and reads the audit log
--  * bsd keeps its work on requests (sees every request, assigns, reassigns, bulk assigns, removes, reopens,
--    flags urgent, gets deadline notices) but can no longer manage users, change settings or read the audit log
--  * admin does not work on requests: it does not see requests or client details
-- Existing bsd users keep working; give at least one login the admin role (see 1e-upgrade.sql).

-- Profiles: you see yourself; ops, bsd and admin see everyone.
drop policy if exists profiles_read on public.profiles;
create policy profiles_read on public.profiles for select to authenticated
  using (id = auth.uid() or public.has_role('admin') or public.has_role('bsd') or public.has_role('ops'));

-- Audit log: admin only.
drop policy if exists audit_read on public.audit_log;
create policy audit_read on public.audit_log for select to authenticated using (public.has_role('admin'));

-- Users: admin only. An admin cannot take away their own admin access (so there is always one left).
create or replace function public.admin_update_user(p_user uuid, p_role app_role, p_active boolean,
                                                    p_full_name text default null, p_company text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.has_role('admin') then raise exception 'Only an admin can manage users'; end if;
  if p_user = auth.uid() and (not p_active or p_role is distinct from 'admin') then
    raise exception 'You cannot remove your own admin access';
  end if;
  if not exists (select 1 from public.profiles where id = p_user) then raise exception 'User not found'; end if;
  update public.profiles set role = p_role, active = p_active,
    full_name = coalesce(p_full_name, full_name), company = coalesce(p_company, company) where id = p_user;
  perform public.log_event('user.updated', 'profile', p_user::text,
                           jsonb_build_object('role', p_role, 'active', p_active));
end $$;

-- Deadline settings: admin only.
create or replace function public.update_settings(p_deadline_hours int, p_due_soon_hours int, p_pause boolean)
returns void language plpgsql security definer set search_path = public as $$
declare old public.app_settings;
begin
  if not public.has_role('admin') then raise exception 'Only an admin can change settings'; end if;
  if p_deadline_hours is null or p_deadline_hours < 1 or p_deadline_hours > 720 then raise exception 'The deadline must be between 1 and 720 hours'; end if;
  if p_due_soon_hours is null or p_due_soon_hours < 0 or p_due_soon_hours >= p_deadline_hours then
    raise exception 'The "due soon" warning must be shorter than the deadline';
  end if;
  select * into old from public.app_settings for update;
  update public.app_settings set deadline_hours = p_deadline_hours, due_soon_hours = p_due_soon_hours,
    pause_when_sent_back = coalesce(p_pause, true), updated_at = now() where id;
  -- Open requests move by the same amount, so the new deadline applies to them too.
  if p_deadline_hours <> old.deadline_hours then
    update public.pi_requests set due_at = due_at + make_interval(hours => p_deadline_hours - old.deadline_hours)
     where status not in ('completed', 'removed');
  end if;
  -- Turning the pause off restarts the clock on requests that are sent back now.
  if not coalesce(p_pause, true) then
    update public.pi_requests set due_at = due_at + (now() - paused_at), paused_at = null where paused_at is not null;
  end if;
  perform public.clear_stale_deadline_notices(null);
  perform public.log_event('settings.updated', 'app_settings', null,
    jsonb_build_object('deadline_hours', p_deadline_hours, 'due_soon_hours', p_due_soon_hours, 'pause_when_sent_back', p_pause));
end $$;

-- ---------------------------------------------------------------------------
-- The first admin
-- ---------------------------------------------------------------------------
do $$
declare
  first_admin_email text := 'CHANGE-THIS@example.com';   -- CHANGE THIS
begin
  if exists (select 1 from public.profiles where role = 'admin' and active) then
    raise notice 'There is already an active admin; first_admin_email is ignored.';
    return;
  end if;
  if first_admin_email = 'CHANGE-THIS@example.com' then
    raise exception 'Set first_admin_email near the top of the "The first admin" step first (the login that should become Admin).';
  end if;
  update public.profiles set role = 'admin', active = true where lower(email) = lower(trim(first_admin_email));
  if not found then
    raise exception 'No login with the email %. Add it in Authentication > Users first, then run this again.', first_admin_email;
  end if;
end $$;

-- Sample BSD users (from 3b-sample-users.sql) were called "[Sample] … Admin"; call them "… BSD" now.
update public.profiles set full_name = regexp_replace(full_name, ' Admin$', ' BSD')
 where email like 'sample.bsd_@example.com' and full_name like '[Sample] % Admin';

commit;

select full_name, email, role, active from public.profiles where role in ('admin', 'bsd') order by role, email;
