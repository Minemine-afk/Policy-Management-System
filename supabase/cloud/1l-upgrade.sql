-- UPGRADE for a project that already ran 1-setup.sql (before 19 Nov 2026, client date of birth). Paste the whole
-- file into SQL Editor and Run once. Safe to run again. Run the earlier upgrade files first if you never did.
-- The request form asks for the client's date of birth (compulsory) instead of an age band.

begin;
-- Client date of birth (19 Nov 2026, Kumar): compulsory on the request form instead of picking an age band.
-- Ops and bsd see it (like the age band before), because they need it to produce the PI; the client's name and
-- contact stay visible only to the introducer. The age band is now worked out from the date of birth, so lists,
-- filters and exports keep working. Requests made before this keep their age band and have no date of birth.
alter table public.pi_requests add column if not exists date_of_birth date;
grant select (date_of_birth) on public.pi_requests to authenticated;

-- The date of birth from the form (YYYY-MM-DD): required, not in the future, at most 100 years ago.
create or replace function public.check_dob(p jsonb)
returns date language plpgsql stable as $$
declare d date;
begin
  if coalesce(btrim(p ->> 'date_of_birth'), '') = '' then raise exception 'Enter the client''s date of birth'; end if;
  begin d := (p ->> 'date_of_birth')::date;
  exception when others then raise exception 'Enter the date of birth as a date (day, month, year)'; end;
  if d > current_date then raise exception 'The date of birth can''t be in the future'; end if;
  if d < current_date - interval '100 years' then raise exception 'Check the date of birth: that is over 100 years ago'; end if;
  return d;
end $$;

-- Age band (age last birthday today), in the bands the form used to offer.
create or replace function public.age_band_of(d date)
returns text language sql stable as $$
  select case
    when a < 18 then 'Under 18'
    when a >= 65 then '65 and over'
    when a < 25 then '18 to 24'
    else (25 + ((a - 25) / 5) * 5)::text || ' to ' || (29 + ((a - 25) / 5) * 5)::text end
  from (select extract(year from age(current_date, d))::int as a) x
$$;

create or replace function public.create_request(p jsonb, p_client jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare rid uuid; rref text; dob date := public.check_dob(p);
begin
  if not public.has_role('introducer') then raise exception 'Only introducers can submit requests'; end if;
  p := p || jsonb_build_object('age_band', public.age_band_of(dob));
  perform public.check_fields(p);
  if coalesce(btrim(p_client ->> 'client_name'), '') = '' then raise exception 'Enter the client name'; end if;
  insert into public.pi_requests (introducer_id, plan_category, product, age_band, date_of_birth, gender, smoker,
      coverage_term, sum_assured_band, premium_type, ci_benefit, remarks)
  values (auth.uid(), coalesce(p ->> 'plan_category', 'All'), coalesce(p ->> 'product', 'Term life'),
      p ->> 'age_band', dob, p ->> 'gender', (p ->> 'smoker')::boolean, p ->> 'coverage_term', p ->> 'sum_assured_band',
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
declare r public.pi_requests; dob date := public.check_dob(p);
begin
  select * into r from public.pi_requests where id = p_request for update;
  if r.id is null or r.introducer_id <> auth.uid() or not public.has_role('introducer') then raise exception 'Not your request'; end if;
  if r.status not in ('submitted', 'sent_back') then raise exception 'This request can no longer be edited'; end if;
  p := p || jsonb_build_object('age_band', public.age_band_of(dob));
  perform public.check_fields(p);
  update public.pi_requests set
    plan_category = coalesce(p ->> 'plan_category', plan_category), age_band = p ->> 'age_band', date_of_birth = dob, gender = p ->> 'gender',
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

-- The app reads requests through this view; the date of birth is added at the end.
create or replace view public.request_list with (security_barrier = true) as
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
       case when st.staff then r.paused_at end as paused_at,
       r.date_of_birth
  from public.pi_requests r
  cross join lateral (select public.has_role('ops') or public.has_role('bsd') as staff) st
 where public.can_view_request(r.id);
revoke execute on function public.check_dob(jsonb), public.age_band_of(date) from public, anon, authenticated;
commit;
