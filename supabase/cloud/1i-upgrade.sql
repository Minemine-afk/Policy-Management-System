-- UPGRADE for a project that already ran 1-setup.sql (before 14 Nov 2026). Paste the whole file into SQL Editor and Run once.
-- Adds module access: an admin can switch modules (PI Requests and future modules) on or off per role and per person.
-- Nobody's access changes: PI Requests stays on for introducer, ops and bsd. Safe to run again. Never ran 1b to 1g? Run those first.

begin;
-- Module access (14 Nov 2026). The app is a set of modules: PI Requests (live) and future modules
-- (Product Comparison Matrix, Introducer Intelligence, Knowledge Hub, Content Studio, LinkedIn Outreach).
--  * A user's role (introducer, ops, bsd) decides what they see and do INSIDE a module.
--  * Whether a user can open a module at all = the role's default, unless an admin switched it on or off for that
--    user. Each module lists the roles it can ever be given to (e.g. Introducer Intelligence is staff only), and no
--    switch can go past that.
--  * Admin pages stay with the admin role and are not modules, so an admin can never lock themselves out.
--  * Enforced here, not just in the screens: has_role('introducer' | 'ops' | 'bsd') is the PI Requests check used by
--    every request rule, and it is now false when the user's PI Requests module is off. Future modules check
--    public.is_role(...) together with public.has_module('<key>').
-- Defaults keep everyone exactly as before: PI Requests on for introducer, ops and bsd; future modules off.

create table if not exists public.app_modules (
  key text primary key,
  name text not null,
  description text not null default '',
  live boolean not null default false,            -- false = coming soon (can be switched on ahead of launch)
  roles app_role[] not null,                       -- roles that can ever be given this module
  sort int not null default 0
);

insert into public.app_modules (key, name, description, live, roles, sort) values
  ('pi_requests', 'PI Requests', 'Submit, track and work on policy illustration requests', true, '{introducer,ops,bsd}', 1),
  ('product_matrix', 'Product Comparison Matrix', 'Side-by-side product facts from verified insurer documents', false, '{introducer,ops,bsd}', 2),
  ('introducer_intelligence', 'Introducer Intelligence', 'Introducer profiles, segments and engagement timeline (staff only)', false, '{ops,bsd}', 3),
  ('knowledge_hub', 'Knowledge Hub', 'Document repository with versions and expiry dates', false, '{introducer,ops,bsd}', 4),
  ('content_studio', 'Content Studio', 'Draft and approve content and email campaigns (staff only)', false, '{ops,bsd}', 5),
  ('linkedin_outreach', 'LinkedIn Outreach', 'Introducer lead outreach (staff only)', false, '{ops,bsd}', 6)
on conflict (key) do update set name = excluded.name, description = excluded.description, roles = excluded.roles, sort = excluded.sort;

create table if not exists public.module_role_defaults (
  module_key text not null references public.app_modules (key) on delete cascade,
  role app_role not null,
  enabled boolean not null,
  primary key (module_key, role)
);
insert into public.module_role_defaults (module_key, role, enabled)
select m.key, r, m.key = 'pi_requests' from public.app_modules m, unnest(m.roles) r
on conflict do nothing;

-- Per-user switch. No row = follow the role default.
create table if not exists public.user_module_access (
  user_id uuid not null references public.profiles (id) on delete cascade,
  module_key text not null references public.app_modules (key) on delete cascade,
  enabled boolean not null,
  updated_by uuid references public.profiles (id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key (user_id, module_key)
);

alter table public.app_modules enable row level security;
alter table public.module_role_defaults enable row level security;
alter table public.user_module_access enable row level security;
drop policy if exists modules_read on public.app_modules;
create policy modules_read on public.app_modules for select to authenticated using (true);
drop policy if exists module_defaults_read on public.module_role_defaults;
create policy module_defaults_read on public.module_role_defaults for select to authenticated using (true);
drop policy if exists module_access_read on public.user_module_access;
create policy module_access_read on public.user_module_access for select to authenticated
  using (user_id = auth.uid() or public.has_role('admin'));
revoke insert, update, delete on public.app_modules, public.module_role_defaults, public.user_module_access from authenticated, anon;
grant select on public.app_modules, public.module_role_defaults, public.user_module_access to authenticated;

-- The role check alone, for future modules (combine with has_module).
create or replace function public.is_role(r app_role)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles p where p.id = auth.uid() and p.active and p.role = r);
$$;

create or replace function public.user_has_module(p_user uuid, p_module text)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((
    select coalesce(o.enabled, d.enabled, false)
      from public.profiles p
      join public.app_modules m on m.key = p_module and p.role = any (m.roles)
      left join public.module_role_defaults d on d.module_key = m.key and d.role = p.role
      left join public.user_module_access o on o.module_key = m.key and o.user_id = p.id
     where p.id = p_user and p.active), false);
$$;

create or replace function public.has_module(p_module text)
returns boolean language sql stable security definer set search_path = public as $$
  select public.user_has_module(auth.uid(), p_module);
$$;

-- has_role is the PI Requests check for introducer, ops and bsd (admin is not a module).
create or replace function public.has_role(r app_role)
returns boolean language sql stable security definer set search_path = public as $$
  select public.is_role(r) and (r = 'admin' or public.has_module('pi_requests'));
$$;

-- The modules the signed-in user can open.
create or replace function public.my_modules()
returns text[] language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(m.key order by m.sort), '{}') from public.app_modules m where public.has_module(m.key);
$$;

-- Ops and bsd need to know who can be given requests.
create or replace function public.module_members(p_module text)
returns setof uuid language sql stable security definer set search_path = public as $$
  select p.id from public.profiles p
   where (public.has_role('ops') or public.has_role('bsd') or public.has_role('admin'))
     and public.user_has_module(p.id, p_module);
$$;

-- Requests can only be given to someone whose PI Requests module is on.
create or replace function public.check_assignee_module()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.assignee_id is not null and new.assignee_id is distinct from old.assignee_id
     and not public.user_has_module(new.assignee_id, 'pi_requests') then
    raise exception 'This person does not have access to PI Requests';
  end if;
  return new;
end $$;
drop trigger if exists pi_requests_assignee_module on public.pi_requests;
create trigger pi_requests_assignee_module before update of assignee_id on public.pi_requests
  for each row execute function public.check_assignee_module();

-- No request notices for people who can't open PI Requests.
create or replace function public.notify(p_user uuid, p_request uuid, p_kind text, p_message text)
returns void language sql security definer set search_path = public as $$
  insert into public.notifications (user_id, request_id, kind, message)
  select p_user, p_request, p_kind, p_message
   where p_request is null or public.user_has_module(p_user, 'pi_requests')
  on conflict (user_id, request_id, kind) where kind in ('due_soon', 'overdue') do nothing;
$$;
revoke execute on function public.notify(uuid, uuid, text, text) from public, anon, authenticated;

-- Admin: switch a module on or off for one user (p_enabled null = back to the role default).
create or replace function public.admin_set_user_module(p_user uuid, p_module text, p_enabled boolean)
returns void language plpgsql security definer set search_path = public as $$
declare m public.app_modules; r app_role;
begin
  if not public.has_role('admin') then raise exception 'Only an admin can change module access'; end if;
  select * into m from public.app_modules where key = p_module;
  if m.key is null then raise exception 'Unknown module'; end if;
  select role into r from public.profiles where id = p_user;
  if not found then raise exception 'User not found'; end if;
  if p_enabled and (r is null or not r = any (m.roles)) then
    raise exception '% can''t be given to the % role', m.name, coalesce(r::text, 'no');
  end if;
  if p_enabled is null then
    delete from public.user_module_access where user_id = p_user and module_key = p_module;
  else
    insert into public.user_module_access (user_id, module_key, enabled, updated_by, updated_at)
    values (p_user, p_module, p_enabled, auth.uid(), now())
    on conflict (user_id, module_key) do update set enabled = excluded.enabled, updated_by = excluded.updated_by, updated_at = now();
  end if;
  perform public.log_event('access.user_module', 'profile', p_user::text,
    jsonb_build_object('module', p_module, 'module_name', m.name,
                       'setting', case when p_enabled is null then 'default' when p_enabled then 'on' else 'off' end));
end $$;

-- Admin: change a role's default for a module (applies to everyone in that role without their own switch).
create or replace function public.admin_set_role_module(p_role app_role, p_module text, p_enabled boolean)
returns void language plpgsql security definer set search_path = public as $$
declare m public.app_modules;
begin
  if not public.has_role('admin') then raise exception 'Only an admin can change module access'; end if;
  select * into m from public.app_modules where key = p_module;
  if m.key is null then raise exception 'Unknown module'; end if;
  if p_enabled is null then raise exception 'Choose on or off'; end if;
  if not p_role = any (m.roles) then raise exception '% can''t be given to the % role', m.name, p_role; end if;
  insert into public.module_role_defaults (module_key, role, enabled) values (p_module, p_role, p_enabled)
  on conflict (module_key, role) do update set enabled = excluded.enabled;
  perform public.log_event('access.role_module', 'module', p_module,
    jsonb_build_object('module', p_module, 'module_name', m.name, 'role', p_role, 'setting', case when p_enabled then 'on' else 'off' end));
end $$;

revoke execute on function public.user_has_module(uuid, text), public.check_assignee_module() from public, anon, authenticated;
revoke execute on function public.is_role(app_role), public.has_module(text), public.my_modules(), public.module_members(text),
  public.admin_set_user_module(uuid, text, boolean), public.admin_set_role_module(app_role, text, boolean) from public, anon;
grant execute on function public.is_role(app_role), public.has_module(text), public.my_modules(), public.module_members(text),
  public.admin_set_user_module(uuid, text, boolean), public.admin_set_role_module(app_role, text, boolean) to authenticated;

commit;
