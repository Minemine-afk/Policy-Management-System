-- ONLY if you already ran the OLD setup (the approval-flow prototype, before 8 Nov 2026) on this project.
-- Removes its tables, functions and types so 1-setup.sql can run. Deletes that prototype's data.
-- Skip this file on a fresh project.
begin;
drop table if exists public.rate_rows, public.rate_tables, public.request_private_refs, public.request_documents,
  public.policy_requests, public.kb_documents, public.introducers, public.audit_log, public.profiles cascade;
drop function if exists public.indicative_prices(text, text, boolean, text, text, boolean), public.submit_request(uuid),
  public.decide_request(uuid, text, text), public.withdraw_request(uuid), public.expire_stale_requests(),
  public.report_unredacted(uuid, text), public.approve_rate_table(uuid), public.audit_row(),
  public.can_view_request(uuid), public.has_role(app_role), public.is_active_user(), public.log_event(text, text, text, jsonb),
  public.log_document_view(uuid), public.admin_update_user(uuid, app_role[], boolean), public.handle_new_user() cascade;
drop type if exists public.app_role, public.introducer_status, public.rate_table_status, public.request_status, public.scan_result cascade;
drop sequence if exists public.request_ref_seq;
drop policy if exists "request docs upload" on storage.objects;
drop policy if exists "request docs read" on storage.objects;
drop policy if exists "request docs delete" on storage.objects;
drop policy if exists "kb read" on storage.objects;
drop policy if exists "kb write" on storage.objects;
commit;
