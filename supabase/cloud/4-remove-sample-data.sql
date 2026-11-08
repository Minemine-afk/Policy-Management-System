-- Removes the sample requests created by 3-sample-data.sql (and their comments, events and files rows).
begin;
delete from public.pi_requests where id in (select request_id from public.request_clients where client_name like '[Sample]%');
commit;
