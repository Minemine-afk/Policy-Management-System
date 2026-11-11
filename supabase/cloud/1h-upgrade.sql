-- UPGRADE for a project that already ran 1-setup.sql (before 14 Nov 2026). Paste the whole file into SQL Editor and Run once.
-- New PI request form: insurer, plan, currency, amount, date of birth, nationality, residency, client type, terms, riders, term comparison.
-- Old requests keep their details: coverage term becomes the policy term, CI benefit becomes the Critical illness rider,
-- age band and sum assured band are copied into the remarks, then those old columns are dropped.
-- Safe to run again. Never ran 1b to 1g-upgrade.sql? Run those first, in order, then this one.

begin;
-- New PI request form (14 Nov 2026), following Kumar's "PWS PI Request Submission" wireframe:
--  * new fields: client type, residency, nationality, date of birth, insurer, plan (product, filtered by insurer),
--    currency, one amount that is either the sum assured or the premium, policy term, premium term, riders, and an
--    optional term comparison with a 1st and 2nd product to compare
--  * the old banded fields go: plan category, age band, coverage term, sum assured band and CI benefit. What old
--    requests held in them is kept: coverage term becomes the policy term, CI benefit becomes the Critical illness
--    rider, and the age band and sum assured band are written into the remarks.
--  * client name and contact stay in request_clients (only the submitting introducer can read them). Date of birth,
--    gender, nationality and residency are on the request, because ops need them to quote; they never see the name.
-- Safe to run more than once.

alter table public.pi_requests
  add column if not exists client_type text,
  add column if not exists residency text,
  add column if not exists nationality text,
  add column if not exists date_of_birth date,
  add column if not exists insurer text,
  add column if not exists currency text not null default 'SGD',
  add column if not exists amount_basis text not null default 'sum_assured',
  add column if not exists amount numeric(14, 2),
  add column if not exists policy_term text,
  add column if not exists premium_term text,
  add column if not exists riders text[] not null default '{}',
  add column if not exists compare_term boolean not null default false,
  add column if not exists compare_product_1 text,
  add column if not exists compare_product_2 text;

alter table public.pi_requests drop constraint if exists pi_requests_amount_basis_check;
alter table public.pi_requests add constraint pi_requests_amount_basis_check check (amount_basis in ('sum_assured', 'premium'));
alter table public.pi_requests drop constraint if exists pi_requests_amount_check;
alter table public.pi_requests add constraint pi_requests_amount_check check (amount is null or amount > 0);

-- Carry the old fields over, then drop them (only if they are still there).
do $$
begin
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'pi_requests' and column_name = 'age_band') then
    execute $q$
      update public.pi_requests set
        policy_term = coalesce(policy_term, coverage_term),
        riders = case when ci_benefit and not ('Critical illness' = any (riders)) then riders || 'Critical illness'::text else riders end,
        remarks = concat_ws(E'\n', remarks, 'Earlier form: age ' || age_band || ', sum assured ' || sum_assured_band ||
                  case when plan_category <> 'All' then ', ' || plan_category else '' end)
    $q$;
  end if;
end $$;
update public.pi_requests set product = 'Term plan (earlier form)' where product = 'Term life' and insurer is null;

drop view if exists public.request_list;
alter table public.pi_requests
  drop column if exists plan_category, drop column if exists age_band, drop column if exists coverage_term,
  drop column if exists sum_assured_band, drop column if exists ci_benefit;
alter table public.pi_requests alter column product drop default;

-- ---------------------------------------------------------------------------
-- Checks for a submitted form
-- ---------------------------------------------------------------------------
create or replace function public.check_fields(p jsonb)
returns void language plpgsql immutable as $$
declare missing text[] := '{}'; dob date; amt numeric;
begin
  if coalesce(p ->> 'gender', '') not in ('Male', 'Female') then missing := missing || 'gender'::text; end if;
  if coalesce(btrim(p ->> 'client_type'), '') = '' then missing := missing || 'client type'::text; end if;
  if coalesce(btrim(p ->> 'residency'), '') = '' then missing := missing || 'residency'::text; end if;
  if coalesce(btrim(p ->> 'nationality'), '') = '' then missing := missing || 'nationality'::text; end if;
  if coalesce(p ->> 'date_of_birth', '') = '' then missing := missing || 'date of birth'::text; end if;
  if coalesce(btrim(p ->> 'insurer'), '') = '' then missing := missing || 'insurer'::text; end if;
  if coalesce(btrim(p ->> 'product'), '') = '' then missing := missing || 'product'::text; end if;
  if coalesce(btrim(p ->> 'currency'), '') = '' then missing := missing || 'currency'::text; end if;
  if coalesce(p ->> 'amount', '') = '' then missing := missing || 'sum assured / premium'::text; end if;
  if (p -> 'smoker') is null or jsonb_typeof(p -> 'smoker') <> 'boolean' then missing := missing || 'smoker status'::text; end if;
  if coalesce(btrim(p ->> 'policy_term'), '') = '' then missing := missing || 'policy term'::text; end if;
  if coalesce((p ->> 'compare_term')::boolean, false) and coalesce(btrim(p ->> 'compare_product_1'), '') = '' then
    missing := missing || '1st product to compare'::text;
  end if;
  if array_length(missing, 1) > 0 then raise exception 'Fill in %', array_to_string(missing, ', '); end if;

  begin dob := (p ->> 'date_of_birth')::date;
  exception when others then raise exception 'Date of birth is not a valid date'; end;
  if dob > current_date then raise exception 'Date of birth cannot be in the future'; end if;
  if dob < current_date - interval '100 years' then raise exception 'Check the date of birth'; end if;
  begin amt := (p ->> 'amount')::numeric;
  exception when others then raise exception 'Sum assured / premium must be a number'; end;
  if amt <= 0 then raise exception 'Sum assured / premium must be more than 0'; end if;
  if coalesce(p ->> 'amount_basis', 'sum_assured') not in ('sum_assured', 'premium') then raise exception 'Choose sum assured or premium'; end if;
end $$;
revoke execute on function public.check_fields(jsonb) from public, anon, authenticated;

-- Riders arrive as a JSON array of names.
create or replace function public.riders_of(p jsonb)
returns text[] language sql immutable as $$
  select coalesce(array(select btrim(x) from jsonb_array_elements_text(case when jsonb_typeof(p -> 'riders') = 'array' then p -> 'riders' else '[]'::jsonb end) x
                         where btrim(x) <> ''), '{}')
$$;
revoke execute on function public.riders_of(jsonb) from public, anon, authenticated;

create or replace function public.create_request(p jsonb, p_client jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare rid uuid; rref text; cmp boolean := coalesce((p ->> 'compare_term')::boolean, false);
begin
  if not public.has_role('introducer') then raise exception 'Only introducers can submit requests'; end if;
  perform public.check_fields(p);
  if coalesce(btrim(p_client ->> 'client_name'), '') = '' then raise exception 'Enter the client name'; end if;
  insert into public.pi_requests (introducer_id, gender, client_type, residency, nationality, date_of_birth, insurer, product,
      currency, amount_basis, amount, smoker, policy_term, premium_term, premium_type, riders,
      compare_term, compare_product_1, compare_product_2, remarks)
  values (auth.uid(), p ->> 'gender', btrim(p ->> 'client_type'), btrim(p ->> 'residency'), btrim(p ->> 'nationality'),
      (p ->> 'date_of_birth')::date, btrim(p ->> 'insurer'), btrim(p ->> 'product'),
      btrim(p ->> 'currency'), coalesce(p ->> 'amount_basis', 'sum_assured'), (p ->> 'amount')::numeric, (p ->> 'smoker')::boolean,
      btrim(p ->> 'policy_term'), nullif(btrim(p ->> 'premium_term'), ''), coalesce(nullif(p ->> 'premium_type', ''), 'Annual'),
      public.riders_of(p), cmp,
      case when cmp then nullif(btrim(p ->> 'compare_product_1'), '') end,
      case when cmp then nullif(btrim(p ->> 'compare_product_2'), '') end,
      nullif(btrim(p ->> 'remarks'), ''))
  returning id, ref into rid, rref;
  insert into public.request_clients (request_id, owner_id, client_name, contact)
  values (rid, auth.uid(), btrim(p_client ->> 'client_name'), nullif(btrim(p_client ->> 'contact'), ''));
  perform public.add_event(rid, 'submitted', null, 'submitted');
  perform public.log_event('request.submitted', 'pi_request', rref);
  return rid;
end $$;

create or replace function public.update_request(p_request uuid, p jsonb, p_client jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare r public.pi_requests; cmp boolean := coalesce((p ->> 'compare_term')::boolean, false);
begin
  select * into r from public.pi_requests where id = p_request for update;
  if r.id is null or r.introducer_id <> auth.uid() or not public.has_role('introducer') then raise exception 'Not your request'; end if;
  if r.status not in ('submitted', 'sent_back') then raise exception 'This request can no longer be edited'; end if;
  perform public.check_fields(p);
  update public.pi_requests set
    gender = p ->> 'gender', client_type = btrim(p ->> 'client_type'), residency = btrim(p ->> 'residency'),
    nationality = btrim(p ->> 'nationality'), date_of_birth = (p ->> 'date_of_birth')::date,
    insurer = btrim(p ->> 'insurer'), product = btrim(p ->> 'product'), currency = btrim(p ->> 'currency'),
    amount_basis = coalesce(p ->> 'amount_basis', 'sum_assured'), amount = (p ->> 'amount')::numeric,
    smoker = (p ->> 'smoker')::boolean, policy_term = btrim(p ->> 'policy_term'),
    premium_term = nullif(btrim(p ->> 'premium_term'), ''), premium_type = coalesce(nullif(p ->> 'premium_type', ''), premium_type),
    riders = public.riders_of(p), compare_term = cmp,
    compare_product_1 = case when cmp then nullif(btrim(p ->> 'compare_product_1'), '') end,
    compare_product_2 = case when cmp then nullif(btrim(p ->> 'compare_product_2'), '') end,
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

-- ---------------------------------------------------------------------------
-- Read access: same rules as before (introducers never see priority or deadline columns), new columns added
-- ---------------------------------------------------------------------------
revoke select on public.pi_requests from authenticated, anon;
grant select (id, ref, introducer_id, status, assignee_id, gender, client_type, residency, nationality, date_of_birth,
              insurer, product, currency, amount_basis, amount, smoker, policy_term, premium_term, premium_type, riders,
              compare_term, compare_product_1, compare_product_2, remarks, status_reason,
              submitted_at, completed_at, created_at, updated_at)
  on public.pi_requests to authenticated;

create view public.request_list with (security_barrier = true) as
select r.id, r.ref, r.introducer_id, r.status, r.assignee_id, r.gender, r.client_type, r.residency, r.nationality,
       r.date_of_birth, r.insurer, r.product, r.currency, r.amount_basis, r.amount, r.smoker, r.policy_term,
       r.premium_term, r.premium_type, r.riders, r.compare_term, r.compare_product_1, r.compare_product_2,
       r.remarks, r.status_reason, r.submitted_at, r.completed_at, r.created_at, r.updated_at,
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
