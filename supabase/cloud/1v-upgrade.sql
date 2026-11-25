-- UPGRADE for a project that already ran 1u-upgrade.sql. Paste the whole file into SQL Editor and Run once.
-- Deletes nothing. Safe to run again. Adds the 12 product categories (insurance / investment) and makes every
-- kind of plan a searchable product.

begin;
-- Product categories for every kind of plan (25 Nov 2026, Kumar: "Add these as categories for the product field ...
-- classify these as either insurance and investment, adding a (ins) for insurance and (inv) for investment ...
-- include not only term plans but the new categories in searchable products as well").
--
-- * kb_products.product_type is the product category (plan type), one of 12. Insurance (ins): Term life, Critical
--   illness, Whole life, Health (hospital / Integrated Shield), Personal accident, Disability income, Long-term care,
--   Mortgage cover. Investment (inv): Investment-linked (ILP), Universal life (incl. indexed), Endowment, Retirement
--   and annuity. The old value 'Term' becomes 'Term life'.
-- * kb_products.category (Insurance / Investment) now always follows the plan type (a trigger keeps it so), so the
--   Knowledge Bank and Compare products can filter by insurance or investment. Existing products are all term plans,
--   so they all become Insurance (a term product someone had marked Investment by hand is put right).
-- * Every plan type can be read from an upload and is searchable (before this only term plans made a product record).
--   kb_auto_product and kb_save_product take product_type (left out = Term life, as before, for older screens).
-- * Only Product Summary, Rate sheet, Brochure and Product Financing documents belong to a product: for any other type
--   (training material, circulars, regulatory ...) the product link is left empty when a document is uploaded or edited.
--   Documents already linked keep their link until they are edited.
-- Safe to run more than once. Deletes nothing.

-- The 12 plan types and their group.
create or replace function public.kb_plan_group(p_type text)
returns text language sql immutable as $$
  select case when p_type in ('Investment-linked', 'Universal life', 'Endowment', 'Retirement and annuity') then 'Investment' else 'Insurance' end
$$;
-- A plan type as stored ('Term' = 'Term life'); null when it is not one of the 12.
create or replace function public.kb_plan_key(p_type text)
returns text language sql immutable as $$
  select case when btrim(coalesce(p_type, '')) = 'Term' then 'Term life'
              when btrim(p_type) in ('Term life', 'Critical illness', 'Whole life', 'Health', 'Personal accident', 'Disability income',
                                     'Long-term care', 'Mortgage cover', 'Investment-linked', 'Universal life', 'Endowment',
                                     'Retirement and annuity') then btrim(p_type) end
$$;
-- The list, for the app (it also tells the app that this upgrade has run).
create or replace function public.kb_plan_types()
returns jsonb language sql immutable as $$
  select jsonb_agg(jsonb_build_object('key', k, 'group', public.kb_plan_group(k)) order by n)
    from unnest(array['Term life', 'Critical illness', 'Whole life', 'Health', 'Personal accident', 'Disability income', 'Long-term care',
                      'Mortgage cover', 'Investment-linked', 'Universal life', 'Endowment', 'Retirement and annuity']) with ordinality as t(k, n)
$$;
-- Document types that belong to a product.
create or replace function public.kb_type_has_product(p_type text)
returns boolean language sql immutable as $$
  select coalesce(p_type, '') in ('Product Summary', 'Rate sheet', 'Brochure', 'Product Financing')
$$;
create or replace function public.kb_doc_product(p jsonb)
returns uuid language sql immutable as $$
  select case when public.kb_type_has_product(p ->> 'doc_type') then nullif(p ->> 'product_id', '')::uuid end
$$;

alter table public.kb_products drop constraint if exists kb_products_product_type_check;
update public.kb_products set product_type = 'Term life' where product_type = 'Term' or public.kb_plan_key(product_type) is null;
alter table public.kb_products alter column product_type set default 'Term life';
alter table public.kb_products add constraint kb_products_product_type_check check (public.kb_plan_key(product_type) = product_type);

-- The group always follows the plan type.
create or replace function public.kb_products_group()
returns trigger language plpgsql as $$
begin
  new.category := public.kb_plan_group(new.product_type);
  return new;
end $$;
drop trigger if exists kb_products_group on public.kb_products;
create trigger kb_products_group before insert or update on public.kb_products for each row execute function public.kb_products_group();
update public.kb_products set category = public.kb_plan_group(product_type) where category is distinct from public.kb_plan_group(product_type);

create or replace function public.kb_clean_record(p jsonb)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare f record; facts jsonb := '{}'; v_type text := public.kb_plan_key(coalesce(nullif(p ->> 'product_type', ''), 'Term life')); amin int; amax int; smin numeric; smax numeric; cur jsonb; res jsonb;
begin
  if coalesce(btrim(p ->> 'insurer'), '') = '' then raise exception 'Fill in the insurer'; end if;
  if coalesce(btrim(p ->> 'name'), '') = '' then raise exception 'Fill in the product name'; end if;
  if v_type is null then raise exception 'Choose the product category (plan type)'; end if;
  if coalesce(p ->> 'jurisdiction', '') not in ('Onshore', 'Offshore') then raise exception 'Choose onshore or offshore'; end if;
  cur := coalesce(p -> 'currencies', '[]'); res := coalesce(p -> 'residency', '[]');
  if jsonb_typeof(cur) <> 'array' or jsonb_array_length(cur) = 0 then raise exception 'Choose at least one policy currency'; end if;
  if jsonb_typeof(res) <> 'array' or jsonb_array_length(res) = 0 then raise exception 'Choose who can apply'; end if;
  begin
    amin := (p ->> 'entry_age_min')::int; amax := (p ->> 'entry_age_max')::int;
    smin := nullif(p ->> 'sa_min', '')::numeric; smax := nullif(p ->> 'sa_max', '')::numeric;
  exception when others then raise exception 'Entry ages and sums assured must be numbers'; end;
  if amin is null or amax is null or amin < 0 or amax > 100 or amin > amax then raise exception 'Check the entry ages (0 to 100, lowest first)'; end if;
  if smin is not null and smax is not null and smin > smax then raise exception 'The minimum sum assured is more than the maximum'; end if;
  for f in select key, value from jsonb_each(coalesce(p -> 'facts', '{}')) loop
    if f.key in ('_ps', '_rs') then
      if coalesce(f.value ->> 'doc', '') = '' then continue; end if;
    elsif coalesce(btrim(f.value ->> 'v'), '') = '' then continue;
    end if;
    if coalesce(f.value ->> 'doc', '') = '' or not exists (select 1 from public.kb_documents where id::text = f.value ->> 'doc') then
      raise exception 'Choose the source document for every fact (missing for "%")', f.key;
    end if;
    facts := facts || jsonb_build_object(f.key, jsonb_strip_nulls(jsonb_build_object(
      'v', case when f.key in ('_ps', '_rs') then null else left(btrim(f.value ->> 'v'), 600) end,
      'doc', f.value ->> 'doc', 'page', case when coalesce(f.value ->> 'page', '') ~ '^\d{1,4}$' then (f.value ->> 'page')::int end)));
  end loop;
  return jsonb_build_object('insurer', btrim(p ->> 'insurer'), 'name', btrim(p ->> 'name'), 'product_type', v_type, 'category', public.kb_plan_group(v_type),
    'dpi', coalesce((p ->> 'dpi')::boolean, false), 'jurisdiction', p ->> 'jurisdiction', 'currencies', cur,
    'entry_age_min', amin, 'entry_age_max', amax, 'residency', res, 'sa_min', smin, 'sa_max', smax,
    'has_tpd', coalesce((p ->> 'has_tpd')::boolean, false), 'has_ci', coalesce((p ->> 'has_ci')::boolean, false), 'facts', facts)
    || case when p ? 'rates' then jsonb_build_object('rates', public.kb_clean_rates(p -> 'rates')) else '{}' end;
end $$;

create or replace function public.kb_record(p_id uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('insurer', p.insurer, 'name', p.name, 'product_type', p.product_type, 'category', p.category, 'dpi', p.dpi,
           'jurisdiction', p.jurisdiction, 'currencies', to_jsonb(p.currencies), 'entry_age_min', p.entry_age_min,
           'entry_age_max', p.entry_age_max, 'residency', to_jsonb(p.residency), 'sa_min', p.sa_min, 'sa_max', p.sa_max,
           'has_tpd', p.has_tpd, 'has_ci', p.has_ci, 'facts', p.facts)
    from public.kb_products p where p.id = p_id and public.kb_member();
$$;

create or replace function public.kb_snapshot(p_id uuid, p_rates boolean)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('insurer', p.insurer, 'name', p.name, 'product_type', p.product_type, 'category', p.category, 'dpi', p.dpi,
           'jurisdiction', p.jurisdiction, 'currencies', to_jsonb(p.currencies), 'entry_age_min', p.entry_age_min,
           'entry_age_max', p.entry_age_max, 'residency', to_jsonb(p.residency), 'sa_min', p.sa_min, 'sa_max', p.sa_max,
           'has_tpd', p.has_tpd, 'has_ci', p.has_ci, 'facts', p.facts, 'rates_changed', p_rates)
    from public.kb_products p where p.id = p_id;
$$;

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

create or replace function public.kb_auto_product(p_doc uuid, p jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare d public.kb_documents; pr public.kb_products; target uuid; ins text; nm text; r jsonb := coalesce(p -> 'record', '{}');
        got text[] := array(select jsonb_array_elements_text(coalesce(p -> 'found', '[]'))); kind text; made boolean := false; ptype text := public.kb_plan_key(p ->> 'product_type');
        rf jsonb := '{}'; f record; cur text[]; amin int; amax int; rates jsonb; nv int; miss text[];
begin
  if not public.kb_member() then raise exception 'Only ops and BSD with the Knowledge Hub can add product records'; end if;
  select * into d from public.kb_documents where id = p_doc;
  if d.id is null then raise exception 'Document not found'; end if;
  if d.doc_type not in ('Product Summary', 'Rate sheet') then raise exception 'Only a Product Summary or rate sheet makes a product record'; end if;
  kind := case when d.doc_type = 'Rate sheet' then 'rates' else 'summary' end;
  ins := left(coalesce(nullif(btrim(p ->> 'insurer'), ''), d.insurer), 120);
  nm := left(btrim(coalesce(p ->> 'name', '')), 160);

  target := nullif(p ->> 'product_id', '')::uuid;
  if target is null then select id into target from public.kb_products where p_doc = any (public.kb_fact_docs(kb_products.facts)) order by created_at limit 1; end if;
  if target is null then target := d.product_id; end if;
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
                where x in ('SGD', 'USD', 'AUD', 'GBP', 'EUR', 'HKD'));
  begin amin := (r ->> 'entry_age_min')::int; amax := (r ->> 'entry_age_max')::int; exception when others then amin := null; amax := null; end;
  if amin is null or amax is null or amin < 0 or amax > 100 or amin > amax then amin := null; amax := null; end if;
  rates := case when kind = 'rates' and jsonb_typeof(p -> 'rates') = 'array' and jsonb_array_length(p -> 'rates') > 0
                then public.kb_clean_rates(p -> 'rates') end;

  if target is null then
    insert into public.kb_products (insurer, name, product_type, status, version, created_by, missing, currencies)
    values (ins, nm, coalesce(ptype, 'Term life'), 'draft', 1, auth.uid(), '{currencies,entry_age}', '{SGD}')
    returning id into target;
    made := true;
  end if;
  select * into pr from public.kb_products where id = target for update;
  if pr.id is null then raise exception 'Product record not found'; end if;
  miss := pr.missing;
  if cardinality(cur) > 0 then miss := array_remove(miss, 'currencies'); end if;
  if amin is not null then miss := array_remove(miss, 'entry_age'); end if;
  nv := case when pr.verified_at is not null then pr.version + 1 else pr.version end;

  update public.kb_products set
    product_type = coalesce(ptype, product_type),
    currencies = case when cardinality(cur) > 0 then cur else currencies end,
    entry_age_min = coalesce(amin, entry_age_min), entry_age_max = coalesce(amax, entry_age_max),
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
    facts = facts || public.kb_products_facts_from(kind, p_doc, rf),
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

create or replace function public.kb_add_document(p jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare d uuid; old public.kb_documents;
begin
  if not public.kb_member() then raise exception 'Only ops and BSD with the Knowledge Hub can upload documents'; end if;
  perform public.kb_doc_fields(p);
  if coalesce(p ->> 'storage_path', '') = '' then raise exception 'Choose a file'; end if;
  if nullif(p ->> 'replaces', '') is not null then
    select * into old from public.kb_documents where id = (p ->> 'replaces')::uuid;
    if old.id is null then raise exception 'The document to replace is gone. Choose it again'; end if;
    if old.replaced_by is not null then raise exception 'That document was already replaced by a newer version'; end if;
  end if;
  insert into public.kb_documents (product_id, insurer, title, doc_type, doc_type_name, version, effective_from, valid_until,
                                   storage_path, file_name, file_size, replaces, status, uploaded_by)
  values (public.kb_doc_product(p), coalesce(btrim(p ->> 'insurer'), ''), left(btrim(p ->> 'title'), 200), p ->> 'doc_type',
          public.kb_doc_type_name(p), left(coalesce(btrim(p ->> 'version'), ''), 40), (p ->> 'effective_from')::date,
          nullif(p ->> 'valid_until', '')::date, p ->> 'storage_path', left(coalesce(p ->> 'file_name', ''), 255),
          nullif(p ->> 'file_size', '')::bigint, old.id, 'checked', auth.uid())
  returning id into d;
  if old.id is not null then perform public.kb_take_over(old.id, d); end if;
  perform public.log_event('kb.document_uploaded', 'kb_document', d::text,
    jsonb_build_object('title', btrim(p ->> 'title'), 'insurer', nullif(btrim(p ->> 'insurer'), ''), 'replaces', old.title));
  return d;
end $$;

create or replace function public.kb_update_document(p_id uuid, p jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare d public.kb_documents;
begin
  if not public.kb_member() then raise exception 'Only ops and BSD with the Knowledge Hub can change documents'; end if;
  select * into d from public.kb_documents where id = p_id;
  if d.id is null then raise exception 'Document not found'; end if;
  perform public.kb_doc_fields(p);
  update public.kb_documents set insurer = coalesce(btrim(p ->> 'insurer'), ''), product_id = public.kb_doc_product(p),
         title = left(btrim(p ->> 'title'), 200), doc_type = p ->> 'doc_type', doc_type_name = public.kb_doc_type_name(p),
         version = left(coalesce(btrim(p ->> 'version'), ''), 40),
         effective_from = (p ->> 'effective_from')::date, valid_until = nullif(p ->> 'valid_until', '')::date, updated_at = now()
   where id = p_id;
  perform public.log_event('kb.document_changed', 'kb_document', p_id::text, jsonb_build_object('title', btrim(p ->> 'title')));
end $$;

create or replace function public.kb_take_over(p_old uuid, p_new uuid)
returns void language plpgsql security definer set search_path = public as $$
declare t text;
begin
  select title into t from public.kb_documents where id = p_new;
  update public.kb_documents set replaced_by = p_new, updated_at = now() where id = p_old;
  update public.kb_products set facts = public.kb_swap_doc(facts, p_old, p_new),
         pending = case when pending is null then null else jsonb_set(pending, '{facts}', public.kb_swap_doc(pending -> 'facts', p_old, p_new)) end,
         auto_read = true, read_note = format('New version of "%s" uploaded. Check the facts against it.', t), updated_at = now()
   where p_old = any (public.kb_fact_docs(facts));
  update public.kb_documents set product_id = (select product_id from public.kb_documents where id = p_old)
   where id = p_new and product_id is null and public.kb_type_has_product(doc_type);
end $$;

revoke execute on function public.kb_plan_group(text), public.kb_plan_key(text), public.kb_type_has_product(text),
  public.kb_doc_product(jsonb), public.kb_products_group() from public, anon;
revoke execute on function public.kb_plan_types() from public, anon;
grant execute on function public.kb_plan_types(), public.kb_plan_group(text), public.kb_plan_key(text) to authenticated;

commit;
