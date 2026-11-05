-- Only needed when reusing an existing Supabase project. Read-only: changes nothing.
-- Run it in SQL Editor and send Claude a screenshot of the result.
-- Every row listed is something the DMS setup would collide with.
select 'table or view' as kind, table_name as name from information_schema.tables
 where table_schema = 'public' and table_name in ('profiles','audit_log','introducers','rate_tables','rate_rows',
   'policy_requests','request_private_refs','request_documents','kb_documents')
union all
select 'type', typname from pg_type t join pg_namespace n on n.oid = t.typnamespace
 where n.nspname = 'public' and typname in ('app_role','introducer_status','rate_table_status','request_status','scan_result')
union all
select 'function', proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and proname in ('handle_new_user','has_role','is_active_user','log_event','can_view_request',
   'indicative_prices','submit_request','decide_request','withdraw_request','expire_stale_requests',
   'report_unredacted','log_document_view','approve_rate_table','admin_update_user','audit_row')
union all
select 'trigger on sign-up', tgname from pg_trigger where tgrelid = 'auth.users'::regclass and not tgisinternal
union all
select 'storage bucket', id from storage.buckets where id in ('request-docs','kb')
union all
select 'sequence', sequencename from pg_sequences where schemaname = 'public' and sequencename = 'request_ref_seq'
union all
select 'existing users (info)', count(*)::text from auth.users
union all
select 'all public tables (info)', string_agg(table_name, ', ') from information_schema.tables where table_schema = 'public';
