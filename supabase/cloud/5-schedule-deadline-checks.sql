-- OPTIONAL: check deadlines every 15 minutes, even when nobody has the app open.
-- Without this, "due soon" and "overdue" notices are only created while an ops or bsd user has the app open.
-- Needed for overdue email alerts (see EMAIL-ALERTS.md). Run once in SQL Editor.
-- If "create extension" fails: Database > Extensions, search pg_cron, switch it on, then run this again.
create extension if not exists pg_cron;
select cron.unschedule('pi-deadline-notices') where exists (select 1 from cron.job where jobname = 'pi-deadline-notices');
select cron.schedule('pi-deadline-notices', '*/15 * * * *', $$select public.generate_deadline_notifications()$$);
select jobname, schedule, active from cron.job where jobname = 'pi-deadline-notices';
