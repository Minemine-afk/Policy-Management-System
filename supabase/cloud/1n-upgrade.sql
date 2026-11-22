-- UPGRADE for a project that already ran 1m-upgrade.sql (teach a new insurer). Paste the whole file into SQL Editor
-- and Run once. Deletes nothing; places already learned are kept. Safe to run again.
-- 22 Nov 2026: the PI reader also learns values in year-by-year tables (e.g. the total premium on the policy term's
-- row) and remembers when ops CORRECTED its own value, so the next PI of that insurer uses the taught place instead.

begin;
alter table public.insurer_label_rules drop constraint if exists insurer_label_rules_how_check;
alter table public.insurer_label_rules add constraint insurer_label_rules_how_check check (how in ('beside', 'under', 'row'));
alter table public.insurer_label_rules add column if not exists row_at text not null default '';
alter table public.insurer_label_rules drop constraint if exists insurer_label_rules_row_at_check;
alter table public.insurer_label_rules add constraint insurer_label_rules_row_at_check check (row_at in ('', 'term', 'last'));
alter table public.insurer_label_rules add column if not exists corrects boolean not null default false;
drop index if exists public.insurer_label_rules_once;
create unique index if not exists insurer_label_rules_once2
  on public.insurer_label_rules (lower(insurer), field, how, label, label_offset, factor, cut, lower(plan), row_at);

-- Ops or bsd save the places learned from one comparison column. p_rules: a JSON array of
-- {insurer, field, how, label, offset, factor, cut, plan, row, corrects}. Places already known are skipped (a known place
-- that ops corrected again is marked as a correction). Returns how many were new.
create or replace function public.teach_insurer(p_rules jsonb)
returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if not (public.has_role('ops') or public.has_role('bsd')) then raise exception 'Only ops or bsd can teach the PI reader'; end if;
  if jsonb_typeof(p_rules) <> 'array' or jsonb_array_length(p_rules) > 200 then raise exception 'Bad list of places'; end if;
  with x as (
    insert into public.insurer_label_rules (insurer, field, how, label, label_offset, factor, cut, plan, row_at, corrects)
    select btrim(r ->> 'insurer'), r ->> 'field', r ->> 'how', r ->> 'label', coalesce((r ->> 'offset')::int, 0),
           coalesce((r ->> 'factor')::int, 1), coalesce(r ->> 'cut', ''), btrim(coalesce(r ->> 'plan', '')),
           coalesce(r ->> 'row', ''), coalesce((r ->> 'corrects')::boolean, false)
      from jsonb_array_elements(p_rules) r
    on conflict (lower(insurer), field, how, label, label_offset, factor, cut, lower(plan), row_at)
      do update set corrects = insurer_label_rules.corrects or excluded.corrects
      where excluded.corrects and not insurer_label_rules.corrects
    returning (xmax = 0) as added)
  select count(*) filter (where added) into n from x;
  if n > 0 then
    perform public.log_event('insurer.taught', 'insurer', (select btrim(p_rules -> 0 ->> 'insurer')), jsonb_build_object('places', n));
  end if;
  return n;
end $$;

commit;
