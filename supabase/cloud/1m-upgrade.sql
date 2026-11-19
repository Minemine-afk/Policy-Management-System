-- UPGRADE for a project that already ran 1-setup.sql (before 20 Nov 2026). Paste the whole file into SQL Editor and Run once.
-- Teach a new insurer: a table for the places (label words and positions, never values) that the PI reader learns
-- when ops save a comparison. Deletes nothing. Safe to run again. Run 1b to 1l-upgrade.sql first if you never did.

begin;
-- Teach a new insurer (20 Nov 2026). When ops or bsd save a PI comparison, the browser works out WHERE in the PI each
-- value they filled in or corrected sits (the words beside it, or the column heading above it) and saves those places
-- here, per insurer. The next PI of that insurer is read with those places first, in the browser.
--
-- Only label words and positions are kept: never a value, a client name, a date of birth, a sum or a premium. The
-- browser filters those out, and the checks below refuse any label with an amount, a long number, an e-mail address
-- or a web address in it.
-- Who: ops and bsd read and teach (they make comparisons); bsd and admin see the list and delete places.
create table if not exists public.insurer_label_rules (
  id uuid primary key default gen_random_uuid(),
  insurer text not null check (length(btrim(insurer)) between 1 and 120),
  field text not null check (field in ('insured_name', 'date_of_birth', 'gender', 'residency', 'underwriting_class',
    'cover_age', 'insurer', 'policy_name', 'policy_term', 'premium_term', 'annual_premium', 'total_premium', 'death_sa',
    'base_premium', 'tpd_sa', 'tpd_premium', 'ci_sa', 'ci_premium', 'cash_value')),
  how text not null check (how in ('beside', 'under')),
  label text not null check (length(label) between 2 and 60
    and label !~* '[$€£@]|\mrm\M|\d,\d{3}|\d\.\d|\d{3,}|https?:|www\.|\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}'),
  label_offset int not null default 0 check (label_offset between 0 and 4),
  factor int not null default 1 check (factor in (1, 2, 4, 12)),
  cut text not null default '' check (length(cut) <= 3),
  plan text not null default '' check (length(plan) <= 120),
  created_by uuid references public.profiles (id) on delete set null default auth.uid(),
  created_at timestamptz not null default now()
);
create unique index if not exists insurer_label_rules_once
  on public.insurer_label_rules (lower(insurer), field, how, label, label_offset, factor, cut, lower(plan));

alter table public.insurer_label_rules enable row level security;
revoke all on public.insurer_label_rules from public, anon, authenticated;
grant select on public.insurer_label_rules to authenticated;

drop policy if exists label_rules_read on public.insurer_label_rules;
create policy label_rules_read on public.insurer_label_rules for select to authenticated
  using (public.has_role('ops') or public.has_role('bsd') or public.is_role('admin'));

-- Ops or bsd save the places learned from one comparison column. p_rules: a JSON array of
-- {insurer, field, how, label, offset, factor, cut, plan}. Places already known are skipped. Returns how many were new.
create or replace function public.teach_insurer(p_rules jsonb)
returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if not (public.has_role('ops') or public.has_role('bsd')) then raise exception 'Only ops or bsd can teach the PI reader'; end if;
  if jsonb_typeof(p_rules) <> 'array' or jsonb_array_length(p_rules) > 200 then raise exception 'Bad list of places'; end if;
  with x as (
    insert into public.insurer_label_rules (insurer, field, how, label, label_offset, factor, cut, plan)
    select btrim(r ->> 'insurer'), r ->> 'field', r ->> 'how', r ->> 'label', coalesce((r ->> 'offset')::int, 0),
           coalesce((r ->> 'factor')::int, 1), coalesce(r ->> 'cut', ''), btrim(coalesce(r ->> 'plan', ''))
      from jsonb_array_elements(p_rules) r
    on conflict do nothing returning insurer)
  select count(*) into n from x;
  if n > 0 then
    perform public.log_event('insurer.taught', 'insurer', (select btrim(p_rules -> 0 ->> 'insurer')), jsonb_build_object('places', n));
  end if;
  return n;
end $$;

-- Bsd or admin delete places (all of an insurer's, or chosen ones). Returns how many were deleted.
create or replace function public.forget_insurer_rules(p_ids uuid[])
returns int language plpgsql security definer set search_path = public as $$
declare n int; who text;
begin
  if not (public.has_role('bsd') or public.is_role('admin')) then raise exception 'Only bsd or an admin can delete what the PI reader learned'; end if;
  select string_agg(distinct insurer, ', ') into who from public.insurer_label_rules where id = any(p_ids);
  delete from public.insurer_label_rules where id = any(p_ids);
  get diagnostics n = row_count;
  if n > 0 then perform public.log_event('insurer.forgotten', 'insurer', who, jsonb_build_object('places', n)); end if;
  return n;
end $$;

revoke execute on function public.teach_insurer(jsonb), public.forget_insurer_rules(uuid[]) from public, anon;
grant execute on function public.teach_insurer(jsonb), public.forget_insurer_rules(uuid[]) to authenticated;

commit;
