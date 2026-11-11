-- Removes the FAKE sample users made by 3b-sample-users.sql (sample.*@example.com), their sample requests,
-- (including the sample admins), and anything they touched. Real users and real requests are kept:
--   * real requests a sample ops/bsd user was handling go back to the unassigned pool (status Submitted);
--   * comments a sample user wrote on real requests are deleted; their history entries stay, without a name.
-- Files a sample user uploaded to a real request lose their list entry (the file itself stays in storage).
begin;
create temp table sample_ids on commit drop as
  select id from auth.users where email like 'sample.%@example.com' and raw_app_meta_data ->> 'sample' = 'true';

delete from public.pi_requests where introducer_id in (select id from sample_ids);   -- clients, comments, events, files, notices go too
update public.pi_requests set assignee_id = null,
       status = case when status in ('assigned', 'in_progress') then 'submitted'::request_status else status end
  where assignee_id in (select id from sample_ids);
delete from public.request_comments  where author_id   in (select id from sample_ids);
delete from public.request_documents where uploaded_by in (select id from sample_ids);
update public.request_events set actor_id = null where actor_id in (select id from sample_ids);
delete from auth.users where id in (select id from sample_ids);                     -- profiles and notices go too

select count(*) as sample_users_left from auth.users where email like 'sample.%@example.com';
commit;
