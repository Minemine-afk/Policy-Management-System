-- A separate Admin role (12 Nov 2026). This file only adds the new role value; the rules that use it are in the
-- next file. (PostgreSQL can't use a new enum value in the same transaction that adds it, so it is on its own.)
alter type public.app_role add value if not exists 'admin';
