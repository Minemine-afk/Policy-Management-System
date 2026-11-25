-- Premium financing as a product category (25 Nov 2026, Kumar: "i still need financing documents as a product type
-- since they are also an add on policy"; "it doesnt need to be accessed by the compare matrix for now but can you
-- make sure it can be scanned and saved?").
--
-- * A 13th category, 'Premium financing': a bank loan that pays part of a policy's premium. It is grouped as
--   Insurance (ins) because Kumar describes it as an add-on to a policy (it is neither insurance nor an investment
--   product). To make it (inv), change kb_plan_group below and families.ts.
-- * A Product Financing document (a bank's factsheet, or its monthly cost-of-funds sheet) is read in the browser
--   into a Premium financing product record: the lender goes in the insurer field, the loan currencies in
--   currencies, the facts (policies it can finance, pricing, spread, tenors, quantum of finance, cancellation fee,
--   margin call and close out, key risks ...) in facts, and the cost-of-funds and drawdown rates in the new column
--   kb_products.fin_rates. Saving, versions, history, withdraw and delete work as for every other record.
-- * Premium financing records are NOT offered in Compare products or the Product Comparison Matrix for now
--   (kb_checked_products leaves them out). Entry ages, sum assured and "who can apply" do not apply to a loan.
-- * A Product Financing document uploaded with no product record and no category is filed under Premium financing
--   (existing ones too). Documents filed under another category ("All Universal life products") keep it.
-- Safe to run more than once. Deletes nothing.

create or replace function public.kb_plan_group(p_type text)
returns text language sql immutable as $$
  select case when p_type in ('Investment-linked', 'Universal life', 'Endowment', 'Retirement and annuity') then 'Investment'
              when p_type = 'Premium financing' then 'Insurance'   -- an add-on to a policy (Kumar); swap here if needed
              else 'Insurance' end
$$;
create or replace function public.kb_plan_key(p_type text)
returns text language sql immutable as $$
  select case when btrim(coalesce(p_type, '')) = 'Term' then 'Term life'
              when btrim(p_type) in ('Term life', 'Critical illness', 'Whole life', 'Health', 'Personal accident', 'Disability income',
                                     'Long-term care', 'Mortgage cover', 'Investment-linked', 'Universal life', 'Endowment',
                                     'Retirement and annuity', 'Premium financing') then btrim(p_type) end
$$;
create or replace function public.kb_plan_types()
returns jsonb language sql immutable as $$
  select jsonb_agg(jsonb_build_object('key', k, 'group', public.kb_plan_group(k)) order by n)
    from unnest(array['Term life', 'Critical illness', 'Whole life', 'Health', 'Personal accident', 'Disability income', 'Long-term care',
                      'Mortgage cover', 'Investment-linked', 'Universal life', 'Endowment', 'Retirement and annuity',
                      'Premium financing']) with ordinality as t(k, n)
$$;

-- Rates of a financing product: [{currency, tenor_months, rate (% a year), as_of (date or null), kind}], kind 'cof'
-- (the bank's cost of funds for that tenor) or 'drawdown' (an all-in rate, tenor 0 = no fixed tenor).
alter table public.kb_products add column if not exists fin_rates jsonb not null default '[]';
alter table public.kb_products drop constraint if exists kb_products_fin_rates_check;
alter table public.kb_products add constraint kb_products_fin_rates_check check (jsonb_typeof(fin_rates) = 'array');

create or replace function public.kb_clean_fin_rates(p jsonb)
returns jsonb language plpgsql immutable as $$
declare r jsonb; out jsonb := '[]'; seen text[] := '{}'; k text; cur text; ten int; rate numeric; d date; kind text;
begin
  if p is null or jsonb_typeof(p) <> 'array' then raise exception 'Financing rates must be a list'; end if;
  if jsonb_array_length(p) > 2000 then raise exception 'Too many financing rates (2,000 at most)'; end if;
  for r in select * from jsonb_array_elements(p) loop
    begin
      cur := upper(btrim(r ->> 'currency')); ten := (r ->> 'tenor_months')::int; rate := (r ->> 'rate')::numeric;
      d := nullif(r ->> 'as_of', '')::date; kind := coalesce(nullif(r ->> 'kind', ''), 'cof');
      if cur !~ '^[A-Z]{3}$' or ten not between 0 and 120 or rate is null or rate not between -5 and 50 or kind not in ('cof', 'drawdown') then
        raise exception 'bad';
      end if;
    exception when others then
      raise exception 'Check the financing rates: each line needs a currency (SGD), tenor in months, a rate in %% and optionally a date and kind (cof or drawdown)';
    end;
    k := kind || cur || ten::text || coalesce(d::text, '');
    if k = any (seen) then raise exception 'The financing rates list % % months% twice', cur, ten, coalesce(' on ' || d::text, ''); end if;
    seen := seen || k;
    out := out || jsonb_build_array(jsonb_build_object('currency', cur, 'tenor_months', ten, 'rate', rate, 'as_of', d, 'kind', kind));
  end loop;
  return out;
end $$;

create or replace function public.kb_clean_record(p jsonb)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare f record; facts jsonb := '{}'; v_type text := public.kb_plan_key(coalesce(nullif(p ->> 'product_type', ''), 'Term life')); fin boolean; amin int; amax int; smin numeric; smax numeric; cur jsonb; res jsonb;
begin
  if coalesce(btrim(p ->> 'insurer'), '') = '' then raise exception 'Fill in the insurer'; end if;
  if coalesce(btrim(p ->> 'name'), '') = '' then raise exception 'Fill in the product name'; end if;
  if v_type is null then raise exception 'Choose the product category (plan type)'; end if;
  fin := v_type = 'Premium financing';
  if coalesce(p ->> 'jurisdiction', '') not in ('Onshore', 'Offshore') then raise exception 'Choose onshore or offshore'; end if;
  cur := coalesce(p -> 'currencies', '[]'); res := coalesce(p -> 'residency', '[]');
  if jsonb_typeof(cur) <> 'array' or jsonb_array_length(cur) = 0 then
    raise exception '%', case when fin then 'Choose at least one loan currency' else 'Choose at least one policy currency' end;
  end if;
  if jsonb_typeof(res) <> 'array' then res := '[]'; end if;
  if jsonb_array_length(res) = 0 and not fin then raise exception 'Choose who can apply'; end if;
  begin
    if not fin then amin := (p ->> 'entry_age_min')::int; amax := (p ->> 'entry_age_max')::int; end if;
    smin := nullif(p ->> 'sa_min', '')::numeric; smax := nullif(p ->> 'sa_max', '')::numeric;
  exception when others then raise exception 'Entry ages and sums assured must be numbers'; end;
  -- A loan has no entry ages or sum assured: they are kept at "any age" and empty.
  if fin then amin := 0; amax := 100; smin := null; smax := null; end if;
  if amin is null or amax is null or amin < 0 or amax > 100 or amin > amax then raise exception 'Check the entry ages (0 to 100, lowest first)'; end if;
  if smin is not null and smax is not null and smin > smax then raise exception 'The minimum sum assured is more than the maximum'; end if;
  for f in select key, value from jsonb_each(coalesce(p -> 'facts', '{}')) loop
    if f.key in ('_ps', '_rs', '_cof') then
      if coalesce(f.value ->> 'doc', '') = '' then continue; end if;
    elsif coalesce(btrim(f.value ->> 'v'), '') = '' then continue;
    end if;
    if coalesce(f.value ->> 'doc', '') = '' or not exists (select 1 from public.kb_documents where id::text = f.value ->> 'doc') then
      raise exception 'Choose the source document for every fact (missing for "%")', f.key;
    end if;
    facts := facts || jsonb_build_object(f.key, jsonb_strip_nulls(jsonb_build_object(
      'v', case when f.key in ('_ps', '_rs', '_cof') then null else left(btrim(f.value ->> 'v'), 600) end,
      'doc', f.value ->> 'doc', 'page', case when coalesce(f.value ->> 'page', '') ~ '^\d{1,4}$' then (f.value ->> 'page')::int end)));
  end loop;
  return jsonb_build_object('insurer', btrim(p ->> 'insurer'), 'name', btrim(p ->> 'name'), 'product_type', v_type, 'category', public.kb_plan_group(v_type),
    'dpi', coalesce((p ->> 'dpi')::boolean, false), 'jurisdiction', p ->> 'jurisdiction', 'currencies', cur,
    'entry_age_min', amin, 'entry_age_max', amax, 'residency', res, 'sa_min', smin, 'sa_max', smax,
    'has_tpd', coalesce((p ->> 'has_tpd')::boolean, false), 'has_ci', coalesce((p ->> 'has_ci')::boolean, false), 'facts', facts)
    || case when p ? 'rates' then jsonb_build_object('rates', public.kb_clean_rates(p -> 'rates')) else '{}' end
    || case when p ? 'fin_rates' then jsonb_build_object('fin_rates', public.kb_clean_fin_rates(p -> 'fin_rates')) else '{}' end;
end $$;

create or replace function public.kb_apply(p_id uuid, rec jsonb, p_by uuid, p_source text)
returns int language plpgsql security definer set search_path = public as $$
declare pr public.kb_products; nv int;
begin
  select * into pr from public.kb_products where id = p_id for update;
  nv := case when pr.verified_at is not null then pr.version + 1 else pr.version end;
  update public.kb_products set insurer = rec ->> 'insurer', name = rec ->> 'name',
         product_type = coalesce(public.kb_plan_key(rec ->> 'product_type'), product_type),
         dpi = (rec ->> 'dpi')::boolean, jurisdiction = rec ->> 'jurisdiction',
         currencies = array(select jsonb_array_elements_text(rec -> 'currencies')),
         entry_age_min = (rec ->> 'entry_age_min')::int, entry_age_max = (rec ->> 'entry_age_max')::int,
         residency = array(select jsonb_array_elements_text(rec -> 'residency')),
         sa_min = nullif(rec ->> 'sa_min', '')::numeric, sa_max = nullif(rec ->> 'sa_max', '')::numeric,
         has_tpd = (rec ->> 'has_tpd')::boolean, has_ci = (rec ->> 'has_ci')::boolean, facts = rec -> 'facts',
         fin_rates = case when rec ? 'fin_rates' then rec -> 'fin_rates' else fin_rates end,
         status = case when pr.status = 'withdrawn' then 'withdrawn' else 'verified' end, version = nv,
         verified_by = p_by, verified_at = now(), auto_read = false, auto_fields = '{}', missing = '{}', read_note = null,
         pending = null, pending_state = null, pending_note = null, pending_at = null, pending_by = null, submitted_by = null, updated_at = now()
   where id = p_id;
  if rec ? 'rates' then
    delete from public.kb_rates where product_id = p_id;
    insert into public.kb_rates (product_id, age, gender, smoker, rate, ci_rate)
    select p_id, (r ->> 'age')::int, r ->> 'gender', (r ->> 'smoker')::boolean, (r ->> 'rate')::numeric, nullif(r ->> 'ci_rate', '')::numeric
      from jsonb_array_elements(rec -> 'rates') r;
  end if;
  insert into public.kb_product_history (product_id, version, record, changed_by, checked_by, source)
  values (p_id, nv, public.kb_snapshot(p_id, rec ? 'rates'), p_by, null, p_source);
  return nv;
end $$;

create or replace function public.kb_record(p_id uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('insurer', p.insurer, 'name', p.name, 'product_type', p.product_type, 'category', p.category, 'dpi', p.dpi,
           'jurisdiction', p.jurisdiction, 'currencies', to_jsonb(p.currencies), 'entry_age_min', p.entry_age_min,
           'entry_age_max', p.entry_age_max, 'residency', to_jsonb(p.residency), 'sa_min', p.sa_min, 'sa_max', p.sa_max,
           'has_tpd', p.has_tpd, 'has_ci', p.has_ci, 'facts', p.facts, 'fin_rates', p.fin_rates)
    from public.kb_products p where p.id = p_id and public.kb_member();
$$;

create or replace function public.kb_snapshot(p_id uuid, p_rates boolean)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('insurer', p.insurer, 'name', p.name, 'product_type', p.product_type, 'category', p.category, 'dpi', p.dpi,
           'jurisdiction', p.jurisdiction, 'currencies', to_jsonb(p.currencies), 'entry_age_min', p.entry_age_min,
           'entry_age_max', p.entry_age_max, 'residency', to_jsonb(p.residency), 'sa_min', p.sa_min, 'sa_max', p.sa_max,
           'has_tpd', p.has_tpd, 'has_ci', p.has_ci, 'facts', p.facts, 'fin_rates', p.fin_rates, 'rates_changed', p_rates)
    from public.kb_products p where p.id = p_id;
$$;

create or replace function public.kb_auto_product(p_doc uuid, p jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare d public.kb_documents; pr public.kb_products; target uuid; ins text; nm text; r jsonb := coalesce(p -> 'record', '{}');
        got text[] := array(select jsonb_array_elements_text(coalesce(p -> 'found', '[]'))); kind text; made boolean := false; ptype text := public.kb_plan_key(p ->> 'product_type');
        rf jsonb := '{}'; f record; cur text[]; amin int; amax int; rates jsonb; nv int; miss text[]; frates jsonb; src text;
begin
  if not public.kb_member() then raise exception 'Only ops and BSD with the Knowledge Hub can add product records'; end if;
  select * into d from public.kb_documents where id = p_doc;
  if d.id is null then raise exception 'Document not found'; end if;
  if d.doc_type not in ('Product Summary', 'Rate sheet', 'Product Financing') then
    raise exception 'Only a Product Summary, rate sheet or Product Financing document makes a product record';
  end if;
  kind := case when d.doc_type = 'Rate sheet' then 'rates' when d.doc_type = 'Product Financing' then 'financing' else 'summary' end;
  -- A bank's financing document makes a Premium financing record (its lender in the insurer field).
  if kind = 'financing' then ptype := 'Premium financing'; end if;
  ins := left(coalesce(nullif(btrim(p ->> 'insurer'), ''), d.insurer), 120);
  nm := left(btrim(coalesce(p ->> 'name', '')), 160);

  target := nullif(p ->> 'product_id', '')::uuid;
  if target is null then select id into target from public.kb_products where p_doc = any (public.kb_fact_docs(kb_products.facts)) order by created_at limit 1; end if;
  if target is null then target := d.product_id; end if;
  -- A financing document only goes on a Premium financing record (never turns a policy's record into a loan).
  if kind = 'financing' and target is not null and not exists (select 1 from public.kb_products where id = target and product_type = 'Premium financing') then
    if nullif(p ->> 'product_id', '') is not null then raise exception 'A Product Financing document can only be read into a Premium financing product record'; end if;
    target := null;
  end if;
  if target is null then
    if ins = '' then raise exception 'Fill in the insurer'; end if;
    if nm = '' then raise exception 'Fill in the product name'; end if;
    select id into target from public.kb_products where lower(insurer) = lower(ins) and lower(name) = lower(nm);
  end if;

  -- What was read, tidied. Anything that does not make sense is left out (never guessed).
  for f in select key, value from jsonb_each(coalesce(p -> 'facts', '{}')) loop
    if f.key !~ '^[a-zA-Z]{1,20}$' or coalesce(btrim(f.value ->> 'v'), '') = '' then continue; end if;
    rf := rf || jsonb_build_object(f.key, jsonb_strip_nulls(jsonb_build_object('v', left(btrim(f.value ->> 'v'), 600), 'doc', p_doc::text,
      'page', case when coalesce(f.value ->> 'page', '') ~ '^\d{1,4}$' then (f.value ->> 'page')::int end)));
  end loop;
  cur := array(select x from jsonb_array_elements_text(case when jsonb_typeof(r -> 'currencies') = 'array' then r -> 'currencies' else '[]' end) x
                where x in ('SGD', 'USD', 'AUD', 'GBP', 'EUR', 'HKD', 'CHF', 'JPY', 'CNY'));
  begin amin := (r ->> 'entry_age_min')::int; amax := (r ->> 'entry_age_max')::int; exception when others then amin := null; amax := null; end;
  if amin is null or amax is null or amin < 0 or amax > 100 or amin > amax then amin := null; amax := null; end if;
  rates := case when kind = 'rates' and jsonb_typeof(p -> 'rates') = 'array' and jsonb_array_length(p -> 'rates') > 0
                then public.kb_clean_rates(p -> 'rates') end;
  frates := case when kind = 'financing' and jsonb_typeof(p -> 'fin_rates') = 'array' and jsonb_array_length(p -> 'fin_rates') > 0
                 then public.kb_clean_fin_rates(p -> 'fin_rates') end;
  src := case when kind = 'financing' and p ->> 'source' = '_cof' then '_cof' end;

  if target is null then
    insert into public.kb_products (insurer, name, product_type, status, version, created_by, missing, currencies)
    values (ins, nm, coalesce(ptype, 'Term life'), 'draft', 1, auth.uid(),
            case when kind = 'financing' then '{currencies}' else '{currencies,entry_age}' end::text[], '{SGD}')
    returning id into target;
    made := true;
  end if;
  select * into pr from public.kb_products where id = target for update;
  if pr.id is null then raise exception 'Product record not found'; end if;
  miss := pr.missing;
  if cardinality(cur) > 0 then miss := array_remove(miss, 'currencies'); end if;
  if amin is not null or ptype = 'Premium financing' or pr.product_type = 'Premium financing' then miss := array_remove(miss, 'entry_age'); end if;
  nv := case when pr.verified_at is not null then pr.version + 1 else pr.version end;

  update public.kb_products set
    product_type = coalesce(ptype, product_type),
    currencies = case when cardinality(cur) > 0 then cur else currencies end,
    entry_age_min = case when kind = 'financing' then 0 else coalesce(amin, entry_age_min) end,
    entry_age_max = case when kind = 'financing' then 100 else coalesce(amax, entry_age_max) end,
    residency = case when jsonb_typeof(r -> 'residency') = 'array' and jsonb_array_length(r -> 'residency') > 0
                     then array(select jsonb_array_elements_text(r -> 'residency')) else residency end,
    sa_min = case when r ->> 'sa_min' ~ '^\d+(\.\d+)?$' then (r ->> 'sa_min')::numeric else sa_min end,
    sa_max = case when r ->> 'sa_max' ~ '^\d+(\.\d+)?$' then (r ->> 'sa_max')::numeric else sa_max end,
    dpi = case when r ? 'dpi' then coalesce((r ->> 'dpi')::boolean, dpi) else dpi end,
    jurisdiction = case when r ->> 'jurisdiction' in ('Onshore', 'Offshore') then r ->> 'jurisdiction' else jurisdiction end,
    has_tpd = case when r ? 'has_tpd' then coalesce((r ->> 'has_tpd')::boolean, has_tpd) else has_tpd end,
    has_ci = case when r ? 'has_ci' then coalesce((r ->> 'has_ci')::boolean, has_ci)
                  when rates is not null and exists (select 1 from jsonb_array_elements(rates) x where x ->> 'ci_rate' is not null) then true
                  else has_ci end,
    facts = facts || public.kb_products_facts_from(coalesce(src, kind), p_doc, rf),
    fin_rates = coalesce(frates, fin_rates),
    status = case when status = 'withdrawn' then 'withdrawn' else 'verified' end,
    version = nv, verified_at = now(), verified_by = null,
    auto_read = true, auto_fields = array(select distinct x from unnest(auto_fields || got) x), missing = miss,
    read_note = left(nullif(btrim(coalesce(p ->> 'notes', '')), ''), 1000), updated_at = now()
  where id = target;
  if rates is not null then
    delete from public.kb_rates where product_id = target;
    insert into public.kb_rates (product_id, age, gender, smoker, rate, ci_rate)
    select target, (x ->> 'age')::int, x ->> 'gender', (x ->> 'smoker')::boolean, (x ->> 'rate')::numeric, nullif(x ->> 'ci_rate', '')::numeric
      from jsonb_array_elements(rates) x;
  end if;
  update public.kb_documents set product_id = target where id = p_doc and product_id is null;
  insert into public.kb_product_history (product_id, version, record, changed_by, checked_by, source)
  values (target, nv, public.kb_snapshot(target, rates is not null), auth.uid(), null, 'read');
  perform public.log_event('kb.product_auto_read', 'kb_product', target::text, jsonb_build_object(
    'product', ins || ' · ' || (select name from public.kb_products where id = target), 'title', d.title, 'created', made,
    'version', nv, 'searchable', public.kb_product_usable(target)));
  return target;
end $$;

-- The record's documents: the Product Summary (or financing factsheet), rate sheet, or cost-of-funds sheet.
create or replace function public.kb_products_facts_from(p_kind text, p_doc uuid, p_read jsonb)
returns jsonb language sql immutable as $$
  select coalesce(p_read, '{}') || jsonb_build_object(case when p_kind = 'rates' then '_rs' when p_kind = '_cof' then '_cof' else '_ps' end,
                                                      jsonb_build_object('doc', p_doc::text));
$$;

-- A Product Financing document with no product record and no category is filed under Premium financing.
create or replace function public.kb_doc_plan(p jsonb)
returns text language sql immutable as $$
  select case when public.kb_type_has_product(p ->> 'doc_type') and public.kb_doc_product(p) is null
              then coalesce(public.kb_plan_key(nullif(btrim(coalesce(p ->> 'plan_type', '')), '')),
                            -- (a new version takes its earlier version's category instead: kb_take_over)
                            case when p ->> 'doc_type' = 'Product Financing' and nullif(p ->> 'replaces', '') is null then 'Premium financing' end) end
$$;
update public.kb_documents set plan_type = 'Premium financing'
 where doc_type = 'Product Financing' and product_id is null and plan_type is null;

-- Compare products and the Product Comparison Matrix leave premium financing out for now.
create or replace view public.kb_checked_products with (security_barrier = true) as
select p.id, p.insurer, p.name, p.product_type, p.category, p.dpi, p.jurisdiction, p.currencies, p.entry_age_min,
       p.entry_age_max, p.residency, p.sa_min, p.sa_max, p.has_tpd, p.has_ci, p.facts, p.version, p.is_sample, p.verified_at,
       p.auto_read, not ('entry_age' = any (p.missing)) as ages_stated
  from public.kb_products p
 where public.can_compare_products() and public.kb_product_usable(p.id) and p.product_type <> 'Premium financing';

revoke execute on function public.kb_clean_fin_rates(jsonb) from public, anon, authenticated;
revoke execute on function public.kb_doc_plan(jsonb) from public, anon;

