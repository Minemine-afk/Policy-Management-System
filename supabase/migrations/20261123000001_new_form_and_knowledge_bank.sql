-- New PI request form and the Knowledge Bank (23 Nov 2026, Kumar).
--
-- 1. The request form follows the deck's wireframe 2: gender, client name, client type, residency, nationality, date of
--    birth, insurer, product, currency, sum assured or premium, plus smoker status, coverage term and critical illness
--    (kept from the earlier form), and an optional term product comparison of 2 or 3 plans.
--    Nothing is dropped: old requests keep their fields, and the age band and sum assured text are still filled in so
--    lists, filters and exports keep working. The client's real name stays in request_clients (only the introducer who
--    submitted the request reads it); everyone else sees "Mr VIP" or "Ms VIP".
-- 2. The Knowledge Bank holds insurer documents and the product facts taken from them. The PI request form reads only
--    CHECKED products whose documents are still in date, through the kb_checked_* views. Screens to upload documents
--    and check products come in the next change; until then products are added with SQL (see 3c-sample-products.sql).
-- Safe to run more than once.

-- ---------------------------------------------------------------------------
-- Knowledge Bank
-- ---------------------------------------------------------------------------
create table if not exists public.kb_products (
  id uuid primary key default gen_random_uuid(),
  insurer text not null check (length(btrim(insurer)) between 1 and 120),
  name text not null check (length(btrim(name)) between 1 and 160),
  product_type text not null default 'Term' check (product_type in ('Term')),
  category text not null default 'Insurance' check (category in ('Insurance', 'Investment')),
  dpi boolean not null default false,                      -- Direct Purchase Insurance
  jurisdiction text not null default 'Onshore' check (jurisdiction in ('Onshore', 'Offshore')),
  currencies text[] not null default '{SGD}',
  entry_age_min int not null default 18 check (entry_age_min between 0 and 100),
  entry_age_max int not null default 65 check (entry_age_max between 0 and 100),
  residency text[] not null default '{}',                 -- who can apply: values of the form's Residency list
  sa_min numeric(14, 2),
  sa_max numeric(14, 2),
  has_tpd boolean not null default false,
  has_ci boolean not null default false,                  -- critical illness cover is available (built in or as a rider)
  -- One entry per comparison row: {"key": {"v": "value as written", "doc": "<kb_documents.id>", "page": 4}}
  facts jsonb not null default '{}' check (jsonb_typeof(facts) = 'object'),
  status text not null default 'draft' check (status in ('draft', 'check', 'verified')),
  version int not null default 1,
  is_sample boolean not null default false,
  created_by uuid references public.profiles (id) on delete set null,
  verified_by uuid references public.profiles (id) on delete set null,
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists kb_products_once on public.kb_products (lower(insurer), lower(name));

create table if not exists public.kb_documents (
  id uuid primary key default gen_random_uuid(),
  product_id uuid references public.kb_products (id) on delete cascade,
  insurer text not null,
  title text not null check (length(btrim(title)) between 1 and 200),
  doc_type text not null check (doc_type in ('Product Summary', 'Rate sheet', 'Brochure', 'Policy wording', 'Guide', 'Campaign', 'Regulatory', 'Other')),
  version text not null default '',
  effective_from date,
  valid_until date,
  storage_path text,                                      -- the PDF, once uploads come in
  status text not null default 'new' check (status in ('new', 'checked')),
  is_sample boolean not null default false,
  uploaded_by uuid references public.profiles (id) on delete set null,
  checked_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists kb_documents_product on public.kb_documents (product_id);

-- Indicative premium rates from the insurer's rate sheet: annual premium per 1,000 of sum assured, paying to age 65,
-- by age next birthday, gender and smoker status. ci_rate is the extra for a critical illness rider (null if none).
create table if not exists public.kb_rates (
  product_id uuid not null references public.kb_products (id) on delete cascade,
  age int not null check (age between 0 and 100),
  gender text not null check (gender in ('Male', 'Female')),
  smoker boolean not null,
  rate numeric(10, 4) not null check (rate > 0),
  ci_rate numeric(10, 4) check (ci_rate is null or ci_rate > 0),
  primary key (product_id, age, gender, smoker)
);

alter table public.kb_products enable row level security;
alter table public.kb_documents enable row level security;
alter table public.kb_rates enable row level security;
revoke all on public.kb_products, public.kb_documents, public.kb_rates from public, anon, authenticated;
grant select on public.kb_products, public.kb_documents, public.kb_rates to authenticated;
-- Ops and bsd see everything in the Knowledge Bank, drafts included. Introducers only use the checked views below.
drop policy if exists kb_products_staff on public.kb_products;
create policy kb_products_staff on public.kb_products for select to authenticated using (public.has_role('ops') or public.has_role('bsd'));
drop policy if exists kb_documents_staff on public.kb_documents;
create policy kb_documents_staff on public.kb_documents for select to authenticated using (public.has_role('ops') or public.has_role('bsd'));
drop policy if exists kb_rates_staff on public.kb_rates;
create policy kb_rates_staff on public.kb_rates for select to authenticated using (public.has_role('ops') or public.has_role('bsd'));

-- Who can compare products on the PI request form.
create or replace function public.can_compare_products()
returns boolean language sql stable security definer set search_path = public as $$
  select public.has_role('introducer') or public.has_role('ops') or public.has_role('bsd');
$$;
revoke execute on function public.can_compare_products() from public, anon;
grant execute on function public.can_compare_products() to authenticated;

-- A product is usable when it was checked and none of its documents has passed its valid-until date.
create or replace function public.kb_product_usable(p_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.kb_products p where p.id = p_id and p.status = 'verified')
     and not exists (select 1 from public.kb_documents d where d.product_id = p_id and d.valid_until < current_date);
$$;
revoke execute on function public.kb_product_usable(uuid) from public, anon;
grant execute on function public.kb_product_usable(uuid) to authenticated;   -- used by the views below; says only yes or no

drop view if exists public.kb_checked_rates;
drop view if exists public.kb_checked_documents;
drop view if exists public.kb_checked_products;
create view public.kb_checked_products with (security_barrier = true) as
select p.id, p.insurer, p.name, p.product_type, p.category, p.dpi, p.jurisdiction, p.currencies, p.entry_age_min,
       p.entry_age_max, p.residency, p.sa_min, p.sa_max, p.has_tpd, p.has_ci, p.facts, p.version, p.is_sample, p.verified_at
  from public.kb_products p
 where public.can_compare_products() and public.kb_product_usable(p.id);
create view public.kb_checked_documents with (security_barrier = true) as
select d.id, d.product_id, d.insurer, d.title, d.doc_type, d.version, d.effective_from, d.valid_until
  from public.kb_documents d
 where public.can_compare_products() and d.product_id is not null and public.kb_product_usable(d.product_id);
create view public.kb_checked_rates with (security_barrier = true) as
select r.product_id, r.age, r.gender, r.smoker, r.rate, r.ci_rate
  from public.kb_rates r
 where public.can_compare_products() and public.kb_product_usable(r.product_id);
revoke all on public.kb_checked_products, public.kb_checked_documents, public.kb_checked_rates from public, anon, authenticated;
grant select on public.kb_checked_products, public.kb_checked_documents, public.kb_checked_rates to authenticated;

-- ---------------------------------------------------------------------------
-- New request form fields
-- ---------------------------------------------------------------------------
alter table public.pi_requests
  add column if not exists client_type text,
  add column if not exists residency text,
  add column if not exists nationality text,
  add column if not exists insurer text,
  add column if not exists plan_name text,
  add column if not exists plan_kb_id uuid references public.kb_products (id) on delete set null,
  add column if not exists currency text,
  add column if not exists amount_basis text,
  add column if not exists amount numeric(14, 2),
  add column if not exists compare_term boolean not null default false,
  add column if not exists compare_product_1 text,
  add column if not exists compare_kb_1 uuid references public.kb_products (id) on delete set null,
  add column if not exists compare_product_2 text,
  add column if not exists compare_kb_2 uuid references public.kb_products (id) on delete set null;
alter table public.pi_requests drop constraint if exists pi_requests_amount_basis_check;
alter table public.pi_requests add constraint pi_requests_amount_basis_check check (amount_basis is null or amount_basis in ('sum_assured', 'premium'));
alter table public.pi_requests drop constraint if exists pi_requests_amount_check;
alter table public.pi_requests add constraint pi_requests_amount_check check (amount is null or amount > 0);
grant select (client_type, residency, nationality, insurer, plan_name, plan_kb_id, currency, amount_basis, amount,
              compare_term, compare_product_1, compare_kb_1, compare_product_2, compare_kb_2)
  on public.pi_requests to authenticated;

-- The form's checks (after check_dob). Raises one message naming everything that is missing.
create or replace function public.check_fields(p jsonb)
returns void language plpgsql immutable as $$
declare missing text[] := '{}'; amt numeric;
begin
  if coalesce(p ->> 'gender', '') not in ('Male', 'Female') then missing := missing || 'gender'::text; end if;
  if coalesce(btrim(p ->> 'client_type'), '') = '' then missing := missing || 'client type'::text; end if;
  if coalesce(btrim(p ->> 'residency'), '') = '' then missing := missing || 'residency'::text; end if;
  if coalesce(btrim(p ->> 'nationality'), '') = '' then missing := missing || 'nationality'::text; end if;
  if coalesce(btrim(p ->> 'insurer'), '') = '' and coalesce(btrim(p ->> 'plan_kb_id'), '') = '' then missing := missing || 'insurer'::text; end if;
  if coalesce(btrim(p ->> 'plan_kb_id'), '') = '' and coalesce(btrim(p ->> 'plan_name'), '') = '' then missing := missing || 'product'::text; end if;
  if coalesce(btrim(p ->> 'currency'), '') = '' then missing := missing || 'currency'::text; end if;
  if coalesce(btrim(p ->> 'amount'), '') = '' then missing := missing || 'sum assured / premium'::text; end if;
  if (p -> 'smoker') is null or jsonb_typeof(p -> 'smoker') <> 'boolean' then missing := missing || 'smoker status'::text; end if;
  if coalesce(btrim(p ->> 'coverage_term'), '') = '' then missing := missing || 'coverage term'::text; end if;
  if array_length(missing, 1) > 0 then raise exception 'Fill in %', array_to_string(missing, ', '); end if;
  begin amt := (p ->> 'amount')::numeric;
  exception when others then raise exception 'Sum assured / premium must be a number'; end;
  if amt <= 0 then raise exception 'Sum assured / premium must be more than 0'; end if;
  if coalesce(p ->> 'amount_basis', 'sum_assured') not in ('sum_assured', 'premium') then raise exception 'Choose sum assured or premium'; end if;
end $$;
revoke execute on function public.check_fields(jsonb) from public, anon, authenticated;

-- Works out the insurer, product and the products to compare from the form, using the Knowledge Bank names (never
-- the names the browser sends) for anything picked from it. Returns the columns to store, as JSON.
create or replace function public.form_products(p jsonb)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  cmp boolean := coalesce((p ->> 'compare_term')::boolean, false);
  plan_id uuid := nullif(btrim(p ->> 'plan_kb_id'), '')::uuid;
  c1 uuid := case when cmp then nullif(btrim(p ->> 'compare_kb_1'), '')::uuid end;
  c2 uuid := case when cmp then nullif(btrim(p ->> 'compare_kb_2'), '')::uuid end;
  pl public.kb_products; k1 public.kb_products; k2 public.kb_products; n int;
begin
  if plan_id is not null then
    select * into pl from public.kb_products where id = plan_id;
    if pl.id is null or not public.kb_product_usable(pl.id) then raise exception 'The product is no longer in the Knowledge Bank. Choose it again'; end if;
  end if;
  if cmp then
    if c1 is null then raise exception 'Fill in the 1st product to compare'; end if;
    select * into k1 from public.kb_products where id = c1;
    if k1.id is null or not public.kb_product_usable(k1.id) then raise exception 'The 1st product to compare is no longer in the Knowledge Bank. Choose it again'; end if;
    if c2 is not null then
      select * into k2 from public.kb_products where id = c2;
      if k2.id is null or not public.kb_product_usable(k2.id) then raise exception 'The 2nd product to compare is no longer in the Knowledge Bank. Choose it again'; end if;
    end if;
    if c1 = plan_id or c2 = plan_id or c1 = c2 then raise exception 'Choose different products to compare'; end if;
    n := (case when plan_id is not null then 1 else 0 end) + 1 + (case when c2 is not null then 1 else 0 end);
    if n < 2 then raise exception 'A comparison needs at least 2 products from the Knowledge Bank. Choose a 2nd product'; end if;
  end if;
  return jsonb_build_object(
    'insurer', coalesce(pl.insurer, btrim(p ->> 'insurer')),
    'plan_name', coalesce(pl.name, left(btrim(p ->> 'plan_name'), 160)),
    'plan_kb_id', pl.id,
    'compare_term', cmp,
    'compare_product_1', case when k1.id is not null then k1.insurer || ' · ' || k1.name end,
    'compare_kb_1', k1.id,
    'compare_product_2', case when k2.id is not null then k2.insurer || ' · ' || k2.name end,
    'compare_kb_2', k2.id);
end $$;
revoke execute on function public.form_products(jsonb) from public, anon, authenticated;

-- The amount as text, kept in sum_assured_band so older lists and exports still show something useful.
create or replace function public.amount_text(p jsonb)
returns text language sql immutable as $$
  select case when coalesce(p ->> 'amount_basis', 'sum_assured') = 'premium' then 'Premium ' else 'Sum assured ' end
         || btrim(p ->> 'currency') || ' ' || to_char((p ->> 'amount')::numeric, 'FM999,999,999,990.##')
$$;
revoke execute on function public.amount_text(jsonb) from public, anon, authenticated;

create or replace function public.create_request(p jsonb, p_client jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare rid uuid; rref text; dob date; fp jsonb;
begin
  if not public.has_role('introducer') then raise exception 'Only introducers can submit requests'; end if;
  dob := public.check_dob(p);
  perform public.check_fields(p);
  if coalesce(btrim(p_client ->> 'client_name'), '') = '' then raise exception 'Enter the client name'; end if;
  fp := public.form_products(p);
  insert into public.pi_requests (introducer_id, plan_category, product, age_band, date_of_birth, gender, smoker,
      coverage_term, sum_assured_band, premium_type, ci_benefit, remarks,
      client_type, residency, nationality, insurer, plan_name, plan_kb_id, currency, amount_basis, amount,
      compare_term, compare_product_1, compare_kb_1, compare_product_2, compare_kb_2)
  values (auth.uid(), 'All', 'Term life', public.age_band_of(dob), dob, p ->> 'gender', (p ->> 'smoker')::boolean,
      btrim(p ->> 'coverage_term'), public.amount_text(p), 'Annual', coalesce((p ->> 'ci_benefit')::boolean, false),
      nullif(btrim(p ->> 'remarks'), ''),
      btrim(p ->> 'client_type'), btrim(p ->> 'residency'), btrim(p ->> 'nationality'), fp ->> 'insurer', fp ->> 'plan_name',
      (fp ->> 'plan_kb_id')::uuid, btrim(p ->> 'currency'), coalesce(p ->> 'amount_basis', 'sum_assured'), (p ->> 'amount')::numeric,
      (fp ->> 'compare_term')::boolean, fp ->> 'compare_product_1', (fp ->> 'compare_kb_1')::uuid,
      fp ->> 'compare_product_2', (fp ->> 'compare_kb_2')::uuid)
  returning id, ref into rid, rref;
  insert into public.request_clients (request_id, owner_id, client_name, contact)
  values (rid, auth.uid(), btrim(p_client ->> 'client_name'), nullif(btrim(p_client ->> 'contact'), ''));
  perform public.add_event(rid, 'submitted', null, 'submitted');
  perform public.log_event('request.submitted', 'pi_request', rref);
  return rid;
end $$;

create or replace function public.update_request(p_request uuid, p jsonb, p_client jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare r public.pi_requests; dob date; fp jsonb;
begin
  select * into r from public.pi_requests where id = p_request for update;
  if r.id is null or r.introducer_id <> auth.uid() or not public.has_role('introducer') then raise exception 'Not your request'; end if;
  if r.status not in ('submitted', 'sent_back') then raise exception 'This request can no longer be edited'; end if;
  dob := public.check_dob(p);
  perform public.check_fields(p);
  fp := public.form_products(p);
  update public.pi_requests set
    age_band = public.age_band_of(dob), date_of_birth = dob, gender = p ->> 'gender', smoker = (p ->> 'smoker')::boolean,
    coverage_term = btrim(p ->> 'coverage_term'), sum_assured_band = public.amount_text(p),
    ci_benefit = coalesce((p ->> 'ci_benefit')::boolean, false), remarks = nullif(btrim(p ->> 'remarks'), ''),
    client_type = btrim(p ->> 'client_type'), residency = btrim(p ->> 'residency'), nationality = btrim(p ->> 'nationality'),
    insurer = fp ->> 'insurer', plan_name = fp ->> 'plan_name', plan_kb_id = (fp ->> 'plan_kb_id')::uuid,
    currency = btrim(p ->> 'currency'), amount_basis = coalesce(p ->> 'amount_basis', 'sum_assured'), amount = (p ->> 'amount')::numeric,
    compare_term = (fp ->> 'compare_term')::boolean, compare_product_1 = fp ->> 'compare_product_1', compare_kb_1 = (fp ->> 'compare_kb_1')::uuid,
    compare_product_2 = fp ->> 'compare_product_2', compare_kb_2 = (fp ->> 'compare_kb_2')::uuid,
    updated_at = now()
  where id = r.id;
  if p_client is not null then
    if coalesce(btrim(p_client ->> 'client_name'), '') = '' then raise exception 'Enter the client name'; end if;
    update public.request_clients set client_name = btrim(p_client ->> 'client_name'),
      contact = coalesce(nullif(btrim(p_client ->> 'contact'), ''), contact)
    where request_id = r.id;
  end if;
  perform public.add_event(r.id, 'edited', r.status, r.status);
  perform public.log_event('request.edited', 'pi_request', r.ref);
end $$;

-- The app reads requests through this view; the new form's fields are added at the end.
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
       r.date_of_birth,
       r.client_type, r.residency, r.nationality, r.insurer, r.plan_name, r.plan_kb_id, r.currency, r.amount_basis, r.amount,
       r.compare_term, r.compare_product_1, r.compare_kb_1, r.compare_product_2, r.compare_kb_2
  from public.pi_requests r
  cross join lateral (select public.has_role('ops') or public.has_role('bsd') as staff) st
 where public.can_view_request(r.id);
