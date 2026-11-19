-- Automatic deletion of long-overdue requests: the daily schedule. Run once in SQL Editor, AFTER 1k-upgrade.sql and
-- after deploying the Edge Function cleanup-deleted-files (see README.md, "Automatic deletion of long-overdue requests").
--
-- What it schedules:
--  * every day at 3:00 AM Singapore time: delete open requests overdue for more than the set number of days
--    (Admin > Deadline settings, 30 by default; nothing happens while the switch there is off)
--  * every hour, only when files are waiting: ask the Edge Function to remove those files with the Storage API.
-- Check first what would be deleted: Admin > Deadline settings shows the list. Deletion cannot be undone.
--
-- BEFORE RUNNING: replace YOUR-PROJECT-REF everywhere below (Find and replace, "Replace all") with your project's reference (Project Settings > General >
-- Project ID, the part before .supabase.co in the Project URL). The script stops until you do.
-- If "create extension" fails: Database > Extensions, switch on pg_cron and pg_net, then run this again.
create extension if not exists pg_cron;
create extension if not exists pg_net;

do $$ begin
  if 'YOUR-PROJECT-REF' like 'YOUR' || '-PROJECT-%' then
    raise exception 'Replace YOUR-PROJECT-REF everywhere in this file (Find and replace) with your project reference first';
  end if;
end $$;

select cron.unschedule('pi-auto-delete-overdue') where exists (select 1 from cron.job where jobname = 'pi-auto-delete-overdue');
select cron.unschedule('pi-clean-deleted-files') where exists (select 1 from cron.job where jobname = 'pi-clean-deleted-files');

-- 19:00 UTC = 3:00 AM Singapore time.
select cron.schedule('pi-auto-delete-overdue', '0 19 * * *', $$
  select count(*) from public.delete_overdue_requests();
  select net.http_post(url := 'https://YOUR-PROJECT-REF.supabase.co/functions/v1/cleanup-deleted-files', body := '{}'::jsonb)
   where exists (select 1 from public.storage_cleanup_queue);
$$);
select cron.schedule('pi-clean-deleted-files', '30 * * * *', $$
  select net.http_post(url := 'https://YOUR-PROJECT-REF.supabase.co/functions/v1/cleanup-deleted-files', body := '{}'::jsonb)
   where exists (select 1 from public.storage_cleanup_queue);
$$);

select jobname, schedule, active from cron.job where jobname in ('pi-auto-delete-overdue', 'pi-clean-deleted-files');
