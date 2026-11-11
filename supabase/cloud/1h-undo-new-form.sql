-- ONLY FOR a project that ran 1h-upgrade.sql (the new request form, 11-12 Nov 2026), which Kumar then asked to undo.
-- Puts the original request form back: plan category, age band, coverage term, sum assured band and CI benefit.
-- Paste the whole file into SQL Editor and Run once. Safe to run again, and harmless if 1h-upgrade.sql never ran.
-- What happens to the requests:
--  * requests from before 1h-upgrade.sql get their original values back (1h had copied them into the remarks and the
--    new fields), and that copied "Earlier form: ..." line is removed from the remarks again
--  * requests made with the new form get the closest band (age band from the date of birth, coverage term from the
--    policy term, sum assured band from the amount); their insurer, plan, currency and the other new details are
--    written into the remarks, so nothing is lost
--  * the new-form columns are then removed

begin;
alter table public.pi_requests
  add column if not exists plan_category text not null default 'All',
  add column if not exists age_band text,
  add column if not exists coverage_term text,
  add column if not exists sum_assured_band text,
  add column if not exists ci_benefit boolean not null default false;

do $$
begin
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'pi_requests' and column_name = 'insurer') then
    execute $q$
      update public.pi_requests r set
        age_band = coalesce(substring(r.remarks from 'Earlier form: age (.+?), sum assured '),
          case when r.date_of_birth is null then '30 to 34'
               else (select b from (values (24, '18 to 24'), (29, '25 to 29'), (34, '30 to 34'), (39, '35 to 39'), (44, '40 to 44'),
                     (49, '45 to 49'), (54, '50 to 54'), (59, '55 to 59'), (200, '60 to 64')) v(top, b)
                     where extract(year from age(r.submitted_at::date, r.date_of_birth)) <= v.top order by v.top limit 1) end),
        sum_assured_band = coalesce(substring(r.remarks from 'Earlier form: age .+?, sum assured (.+?)(?:, (?:Direct Purchase|Non-DPI).*)?$'),
          case when r.amount_basis <> 'sum_assured' or r.amount is null then 'S$100,001 to 250,000'
               when r.amount <= 100000 then 'Up to S$100,000' when r.amount <= 250000 then 'S$100,001 to 250,000'
               when r.amount <= 500000 then 'S$250,001 to 500,000' else 'Above S$500,000' end),
        plan_category = coalesce(substring(r.remarks from 'Earlier form: age .+?, sum assured .+?, (Direct Purchase Insurance \(DPI\)|Non-DPI)'), 'All'),
        coverage_term = case
          when r.policy_term in ('5 years or less', '6 to 10 years', '11 to 20 years', '21 to 30 years') then r.policy_term
          when r.policy_term ~ '^\d+ years$' then case when split_part(r.policy_term, ' ', 1)::int <= 5 then '5 years or less'
            when split_part(r.policy_term, ' ', 1)::int <= 10 then '6 to 10 years' when split_part(r.policy_term, ' ', 1)::int <= 20 then '11 to 20 years'
            else '21 to 30 years' end
          else '21 to 30 years' end,
        ci_benefit = 'Critical illness' = any (r.riders),
        product = 'Term life',
        remarks = nullif(btrim(concat_ws(E'\n',
          nullif(btrim(regexp_replace(coalesce(r.remarks, ''), '\n?Earlier form: age [^\n]*', '', 'g')), ''),
          case when r.insurer is not null then 'New form details: ' || concat_ws(', ',
            r.insurer || ' ' || r.product, r.currency || ' ' || r.amount || case when r.amount_basis = 'premium' then ' premium' else ' sum assured' end,
            'DOB ' || r.date_of_birth, r.nationality, 'resides in ' || r.residency, r.client_type, 'policy term ' || r.policy_term,
            'premium term ' || r.premium_term, nullif(array_to_string(r.riders, ', '), ''),
            case when r.compare_term then 'compare with ' || concat_ws(' and ', r.compare_product_1, r.compare_product_2) end) end)), '')
      where r.age_band is null
    $q$;
  end if;
end $$;

update public.pi_requests set age_band = '30 to 34' where age_band is null;
update public.pi_requests set coverage_term = '11 to 20 years' where coverage_term is null;
update public.pi_requests set sum_assured_band = 'S$100,001 to 250,000' where sum_assured_band is null;
alter table public.pi_requests alter column age_band set not null, alter column coverage_term set not null,
  alter column sum_assured_band set not null, alter column product set default 'Term life';

drop view if exists public.request_list;
alter table public.pi_requests
  drop constraint if exists pi_requests_amount_basis_check, drop constraint if exists pi_requests_amount_check,
  drop column if exists client_type, drop column if exists residency, drop column if exists nationality,
  drop column if exists date_of_birth, drop column if exists insurer, drop column if exists currency,
  drop column if exists amount_basis, drop column if exists amount, drop column if exists policy_term,
  drop column if exists premium_term, drop column if exists riders, drop column if exists compare_term,
  drop column if exists compare_product_1, drop column if exists compare_product_2;
drop function if exists public.riders_of(jsonb);

-- The original form's checks and actions
create or replace function public.check_fields(p jsonb)
returns void language plpgsql immutable as $$
begin
  if coalesce(p ->> 'age_band', '') = '' or coalesce(p ->> 'gender', '') = ''
     or coalesce(p ->> 'coverage_term', '') = '' or coalesce(p ->> 'sum_assured_band', '') = ''
     or (p -> 'smoker') is null then
    raise exception 'Fill in age band, gender, smoker status, coverage term and sum assured';
  end if;
end $$;
revoke execute on function public.check_fields(jsonb) from public, anon, authenticated;

create or replace function public.create_request(p jsonb, p_client jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare rid uuid; rref text;
begin
  if not public.has_role('introducer') then raise exception 'Only introducers can submit requests'; end if;
  perform public.check_fields(p);
  if coalesce(btrim(p_client ->> 'client_name'), '') = '' then raise exception 'Enter the client name'; end if;
  insert into public.pi_requests (introducer_id, plan_category, product, age_band, gender, smoker,
      coverage_term, sum_assured_band, premium_type, ci_benefit, remarks)
  values (auth.uid(), coalesce(p ->> 'plan_category', 'All'), coalesce(p ->> 'product', 'Term life'),
      p ->> 'age_band', p ->> 'gender', (p ->> 'smoker')::boolean, p ->> 'coverage_term', p ->> 'sum_assured_band',
      coalesce(p ->> 'premium_type', 'Annual'), coalesce((p ->> 'ci_benefit')::boolean, false), nullif(btrim(p ->> 'remarks'), ''))
  returning id, ref into rid, rref;
  insert into public.request_clients (request_id, owner_id, client_name, contact)
  values (rid, auth.uid(), btrim(p_client ->> 'client_name'), nullif(btrim(p_client ->> 'contact'), ''));
  perform public.add_event(rid, 'submitted', null, 'submitted');
  perform public.log_event('request.submitted', 'pi_request', rref);
  return rid;
end $$;

create or replace function public.update_request(p_request uuid, p jsonb, p_client jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare r public.pi_requests;
begin
  select * into r from public.pi_requests where id = p_request for update;
  if r.id is null or r.introducer_id <> auth.uid() or not public.has_role('introducer') then raise exception 'Not your request'; end if;
  if r.status not in ('submitted', 'sent_back') then raise exception 'This request can no longer be edited'; end if;
  perform public.check_fields(p);
  update public.pi_requests set
    plan_category = coalesce(p ->> 'plan_category', plan_category), age_band = p ->> 'age_band', gender = p ->> 'gender',
    smoker = (p ->> 'smoker')::boolean, coverage_term = p ->> 'coverage_term', sum_assured_band = p ->> 'sum_assured_band',
    premium_type = coalesce(p ->> 'premium_type', premium_type), ci_benefit = coalesce((p ->> 'ci_benefit')::boolean, false),
    remarks = nullif(btrim(p ->> 'remarks'), ''), updated_at = now()
  where id = r.id;
  if p_client is not null then
    if coalesce(btrim(p_client ->> 'client_name'), '') = '' then raise exception 'Enter the client name'; end if;
    update public.request_clients set client_name = btrim(p_client ->> 'client_name'),
      contact = nullif(btrim(p_client ->> 'contact'), '')
    where request_id = r.id;
  end if;
  perform public.add_event(r.id, 'edited', r.status, r.status);
  perform public.log_event('request.edited', 'pi_request', r.ref);
end $$;

revoke select on public.pi_requests from authenticated, anon;
grant select (id, ref, introducer_id, status, assignee_id, plan_category, product, age_band, gender, smoker,
              coverage_term, sum_assured_band, premium_type, ci_benefit, remarks, status_reason,
              submitted_at, completed_at, created_at, updated_at)
  on public.pi_requests to authenticated;

create view public.request_list with (security_barrier = true) as
select r.id, r.ref, r.introducer_id, r.status, r.assignee_id, r.plan_category, r.product, r.age_band, r.gender, r.smoker,
       r.coverage_term, r.sum_assured_band, r.premium_type, r.ci_benefit, r.remarks, r.status_reason,
       r.submitted_at, r.completed_at, r.created_at, r.updated_at,
       case when st.staff then
         case when r.priority = 'urgent' or public.is_overdue(r.status, r.due_at, r.paused_at) then 'urgent' else 'normal' end
       end as priority,
       case when st.staff then
         (r.priority = 'urgent' and r.urgent_auto) or (r.priority = 'normal' and public.is_overdue(r.status, r.due_at, r.paused_at))
       end as urgent_auto,
       case when st.staff then r.due_at end as due_at,
       case when st.staff then r.paused_at end as paused_at
  from public.pi_requests r
  cross join lateral (select public.has_role('ops') or public.has_role('bsd') as staff) st
 where public.can_view_request(r.id);
revoke all on public.request_list from public, anon, authenticated;
grant select on public.request_list to authenticated;
commit;
