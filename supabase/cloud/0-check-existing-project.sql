-- Only needed when reusing an existing Supabase project. Read-only: changes nothing.
-- Run it in SQL Editor and send Claude a screenshot of the result.
-- Every row listed is something the setup would collide with (rows marked "(info)" are fine).
select 'table' as kind, table_name as name from information_schema.tables
 where table_schema = 'public' and table_name in ('profiles','audit_log','pi_requests','request_clients','request_comments',
   'request_events','request_documents','introducers','rate_tables','policy_requests')
union all
select 'type', typname from pg_type t join pg_namespace n on n.oid = t.typnamespace
 where n.nspname = 'public' and typname in ('app_role','request_status','document_kind')
union all
select 'trigger on sign-up', tgname from pg_trigger where tgrelid = 'auth.users'::regclass and not tgisinternal
union all
select 'storage bucket', id from storage.buckets where id = 'request-docs'
union all
select 'existing users (info)', count(*)::text from auth.users
union all
select 'all public tables (info)', string_agg(table_name, ', ') from information_schema.tables where table_schema = 'public';
