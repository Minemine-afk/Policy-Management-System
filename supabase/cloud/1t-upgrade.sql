-- UPGRADE for a project that already ran 1s-upgrade.sql. Paste the whole file into SQL Editor and Run once.
-- Deletes nothing. Safe to run again. Uploads become searchable products with no BSD check; product records go
-- live when saved; adds the auto-read tag and the 'why not searchable' rule.

begin;
-- Uploads become searchable products straight away (25 Nov 2026, Kumar: "Make it so that the bare upload is turned
-- into a searchable product immediately", "No extra BSD check should be required", "Allow edits and changes to the
-- product record if required but it is not a absolute necessary to make it a searchable product").
--
-- * Uploading a Product Summary or rate sheet reads it in the browser (rules, no AI) and kb_auto_product puts what
--   was read on a product record: a new one, or the existing record for the same insurer and product name (or the
--   record whose document this is a new version of). The record is in Compare products and the Product Comparison
--   Matrix at once, tagged "Auto-read, not yet reviewed" (auto_read) until someone saves or reviews it.
-- * Safeguard: a record is searchable only when the policy currency and entry ages are known (read from a document
--   or saved by a person). What is still missing is kept in kb_products.missing and shown as "why not searchable".
--   Facts the reader did not find stay blank (never guessed).
-- * No BSD check: documents are in use when uploaded (a new version replaces the old one at once), and saving a
--   product record puts it in search straight away. Every save and every read is a version in the history and in
--   the audit log. Any ops or BSD person with the Knowledge Hub can withdraw, put back or delete a record.
-- * Changes waiting for a check (or drafts) when this runs are put live, as their makers saved them. Documents
--   waiting for a check are put in use, and waiting new versions replace the old ones.
-- Safe to run more than once.

alter table public.kb_products
  add column if not exists auto_read boolean not null default false,       -- values read by the reader, nobody reviewed them yet
  add column if not exists auto_fields text[] not null default '{}',     -- what the reader filled in (fields and fact keys)
  add column if not exists missing text[] not null default '{}',         -- needed before it is searchable: 'currencies', 'entry_age'
  add column if not exists read_note text;
alter table public.kb_product_history
  add column if not exists source text not null default 'checked' check (source in ('checked', 'edit', 'read', 'migrated'));

-- A product can be found when it is live, nothing required is missing, and no document its facts rely on is out of date.
create or replace function public.kb_product_usable(p_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.kb_products p
     where p.id = p_id and p.status = 'verified' and cardinality(p.missing) = 0
       and not exists (select 1 from public.kb_documents d
                        where d.id = any (public.kb_fact_docs(p.facts)) and d.valid_until < current_date));
$$;

create or replace view public.kb_checked_products with (security_barrier = true) as
select p.id, p.insurer, p.name, p.product_type, p.category, p.dpi, p.jurisdiction, p.currencies, p.entry_age_min,
       p.entry_age_max, p.residency, p.sa_min, p.sa_max, p.has_tpd, p.has_ci, p.facts, p.version, p.is_sample, p.verified_at,
       p.auto_read
  from public.kb_products p
 where public.can_compare_products() and public.kb_product_usable(p.id);

-- Introducers with the Knowledge Hub read every current document (no check needed any more).
drop policy if exists kb_documents_staff on public.kb_documents;
create policy kb_documents_staff on public.kb_documents for select to authenticated
  using (public.kb_member() or (public.kb_reader() and replaced_by is null));
drop policy if exists "kb docs read" on storage.objects;
create policy "kb docs read" on storage.objects for select to authenticated
  using (bucket_id = 'kb-docs' and (
    (public.kb_member() and (public.kb_file_listed(name) or owner = auth.uid()))
    or (public.kb_reader() and exists (select 1 from public.kb_documents d where d.storage_path = name and d.replaced_by is null))));

-- ---------------------------------------------------------------------------
-- Documents: in use as soon as they are uploaded
-- ---------------------------------------------------------------------------
-- A new version takes over from the old one: product records that named the old one now name the new one.
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
   where id = p_new and product_id is null;
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
  values (nullif(p ->> 'product_id', '')::uuid, coalesce(btrim(p ->> 'insurer'), ''), left(btrim(p ->> 'title'), 200), p ->> 'doc_type',
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
  update public.kb_documents set insurer = coalesce(btrim(p ->> 'insurer'), ''), product_id = nullif(p ->> 'product_id', '')::uuid,
         title = left(btrim(p ->> 'title'), 200), doc_type = p ->> 'doc_type', doc_type_name = public.kb_doc_type_name(p),
         version = left(coalesce(btrim(p ->> 'version'), ''), 40),
         effective_from = (p ->> 'effective_from')::date, valid_until = nullif(p ->> 'valid_until', '')::date, updated_at = now()
   where id = p_id;
  perform public.log_event('kb.document_changed', 'kb_document', p_id::text, jsonb_build_object('title', btrim(p ->> 'title')));
end $$;

-- The uploader or a BSD person removes a document no product record names.
create or replace function public.kb_remove_document(p_id uuid)
returns text language plpgsql security definer set search_path = public as $$
declare d public.kb_documents;
begin
  if not public.kb_member() then raise exception 'Only ops and BSD with the Knowledge Hub can remove documents'; end if;
  select * into d from public.kb_documents where id = p_id;
  if d.id is null then raise exception 'Document not found'; end if;
  if d.uploaded_by is distinct from auth.uid() and not public.kb_checker() then raise exception 'Only the person who uploaded it or BSD can remove a document'; end if;
  if exists (select 1 from public.kb_products p
              where p_id = any (public.kb_fact_docs(p.facts)) or p_id = any (public.kb_fact_docs(p.pending -> 'facts'))) then
    raise exception 'A product record names this document. Change or delete the product record first';
  end if;
  update public.kb_documents set replaced_by = null where replaced_by = p_id;
  delete from public.kb_documents where id = p_id;
  perform public.log_event('kb.document_removed', 'kb_document', p_id::text, jsonb_build_object('title', d.title));
  return d.storage_path;
end $$;

-- ---------------------------------------------------------------------------
-- Product records: saving puts them in search
-- ---------------------------------------------------------------------------
create or replace function public.kb_snapshot(p_id uuid, p_rates boolean)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('insurer', p.insurer, 'name', p.name, 'category', p.category, 'dpi', p.dpi,
           'jurisdiction', p.jurisdiction, 'currencies', to_jsonb(p.currencies), 'entry_age_min', p.entry_age_min,
           'entry_age_max', p.entry_age_max, 'residency', to_jsonb(p.residency), 'sa_min', p.sa_min, 'sa_max', p.sa_max,
           'has_tpd', p.has_tpd, 'has_ci', p.has_ci, 'facts', p.facts, 'rates_changed', p_rates)
    from public.kb_products p where p.id = p_id;
$$;

-- Puts a cleaned record (kb_clean_record) live on a product and keeps the version.
create or replace function public.kb_apply(p_id uuid, rec jsonb, p_by uuid, p_source text)
returns int language plpgsql security definer set search_path = public as $$
declare pr public.kb_products; nv int;
begin
  select * into pr from public.kb_products where id = p_id for update;
  nv := case when pr.verified_at is not null then pr.version + 1 else pr.version end;
  update public.kb_products set insurer = rec ->> 'insurer', name = rec ->> 'name', category = rec ->> 'category',
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

-- Saves a product record (a new one when p_id is null). It is in search straight away; saving also counts as
-- reviewing what the reader filled in.
create or replace function public.kb_save_product(p_id uuid, p jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare rec jsonb; v_id uuid := p_id; nv int;
begin
  if not public.kb_member() then raise exception 'Only ops and BSD with the Knowledge Hub can edit product records'; end if;
  rec := public.kb_clean_record(p);
  if exists (select 1 from public.kb_products where lower(insurer) = lower(rec ->> 'insurer') and lower(name) = lower(rec ->> 'name')
              and kb_products.id is distinct from p_id) then
    raise exception 'There is already a product record for % %', rec ->> 'insurer', rec ->> 'name';
  end if;
  if p_id is null then
    insert into public.kb_products (insurer, name, status, created_by) values (rec ->> 'insurer', rec ->> 'name', 'draft', auth.uid())
    returning kb_products.id into v_id;
  elsif not exists (select 1 from public.kb_products where kb_products.id = p_id) then
    raise exception 'Product record not found';
  end if;
  nv := public.kb_apply(v_id, rec, auth.uid(), 'edit');
  perform public.log_event('kb.product_saved', 'kb_product', v_id::text,
    jsonb_build_object('product', (rec ->> 'insurer') || ' · ' || (rec ->> 'name'), 'version', nv, 'live', true));
  return v_id;
end $$;

-- Someone looked over what the reader filled in and it is right: the "not yet reviewed" tag goes.
create or replace function public.kb_mark_reviewed(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare pr public.kb_products;
begin
  if not public.kb_member() then raise exception 'Only ops and BSD with the Knowledge Hub can review product records'; end if;
  select * into pr from public.kb_products where id = p_id for update;
  if pr.id is null then raise exception 'Product record not found'; end if;
  update public.kb_products set auto_read = false, auto_fields = '{}', read_note = null, verified_by = auth.uid(), updated_at = now() where id = p_id;
  perform public.log_event('kb.product_reviewed', 'kb_product', p_id::text, jsonb_build_object('product', pr.insurer || ' · ' || pr.name, 'version', pr.version));
end $$;

-- What the reader found in an uploaded Product Summary or rate sheet goes on a product record, which is then in
-- search (when nothing required is missing). p: product_id (optional), insurer, name, record (fields found),
-- facts {key: {v, page}}, rates [...], found (fields and fact keys read), notes.
-- Which record: p.product_id; else the record that names this document (a new version); else the document's
-- product; else the record with the same insurer and name; else a new record.
create or replace function public.kb_auto_product(p_doc uuid, p jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare d public.kb_documents; pr public.kb_products; target uuid; ins text; nm text; r jsonb := coalesce(p -> 'record', '{}');
        got text[] := array(select jsonb_array_elements_text(coalesce(p -> 'found', '[]'))); kind text; made boolean := false;
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
    insert into public.kb_products (insurer, name, status, version, created_by, missing, currencies)
    values (ins, nm, 'draft', 1, auth.uid(), '{currencies,entry_age}', '{SGD}')
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

-- The facts an upload adds: what was read (each naming the document and page), plus the document as the record's
-- Product Summary or rate sheet.
create or replace function public.kb_products_facts_from(p_kind text, p_doc uuid, p_read jsonb)
returns jsonb language sql immutable as $$
  select coalesce(p_read, '{}') || jsonb_build_object(case when p_kind = 'rates' then '_rs' else '_ps' end, jsonb_build_object('doc', p_doc::text));
$$;

-- Take a product out of search, or put it back. Any ops or BSD person with the Knowledge Hub.
create or replace function public.kb_withdraw_product(p_id uuid, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare pr public.kb_products;
begin
  if not public.kb_member() then raise exception 'Only ops and BSD with the Knowledge Hub can withdraw products'; end if;
  if coalesce(btrim(p_reason), '') = '' then raise exception 'Give a reason'; end if;
  select * into pr from public.kb_products where id = p_id for update;
  if pr.id is null or pr.status <> 'verified' then raise exception 'Only a product in search can be withdrawn'; end if;
  update public.kb_products set status = 'withdrawn', updated_at = now() where id = p_id;
  perform public.log_event('kb.product_withdrawn', 'kb_product', p_id::text,
    jsonb_build_object('product', pr.insurer || ' · ' || pr.name, 'reason', btrim(p_reason)));
end $$;

create or replace function public.kb_restore_product(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare pr public.kb_products;
begin
  if not public.kb_member() then raise exception 'Only ops and BSD with the Knowledge Hub can put products back'; end if;
  select * into pr from public.kb_products where id = p_id for update;
  if pr.id is null or pr.status not in ('withdrawn', 'draft') then raise exception 'This product is already in search'; end if;
  update public.kb_products set status = 'verified', verified_at = coalesce(verified_at, now()), updated_at = now() where id = p_id;
  perform public.log_event('kb.product_restored', 'kb_product', p_id::text, jsonb_build_object('product', pr.insurer || ' · ' || pr.name));
end $$;

-- Deletes a product record (for example one made from a file that was not a product document). Its documents stay;
-- PI requests keep the product's name.
create or replace function public.kb_delete_product(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare pr public.kb_products;
begin
  if not public.kb_member() then raise exception 'Only ops and BSD with the Knowledge Hub can delete product records'; end if;
  select * into pr from public.kb_products where id = p_id for update;
  if pr.id is null then raise exception 'Product record not found'; end if;
  delete from public.kb_products where id = p_id;
  perform public.log_event('kb.product_deleted', 'kb_product', p_id::text, jsonb_build_object('product', pr.insurer || ' · ' || pr.name));
end $$;

revoke execute on function public.kb_take_over(uuid, uuid), public.kb_snapshot(uuid, boolean), public.kb_apply(uuid, jsonb, uuid, text),
  public.kb_products_facts_from(text, uuid, jsonb) from public, anon, authenticated;
revoke execute on function public.kb_mark_reviewed(uuid), public.kb_auto_product(uuid, jsonb), public.kb_restore_product(uuid),
  public.kb_delete_product(uuid) from public, anon;
grant execute on function public.kb_mark_reviewed(uuid), public.kb_auto_product(uuid, jsonb), public.kb_restore_product(uuid),
  public.kb_delete_product(uuid), public.kb_withdraw_product(uuid, text) to authenticated;
-- The old check steps are gone.
revoke execute on function public.kb_check_document(uuid), public.kb_send_for_check(uuid), public.kb_check_product(uuid),
  public.kb_send_back_product(uuid, text) from authenticated;

-- ---------------------------------------------------------------------------
-- What was waiting for a check when this runs
-- ---------------------------------------------------------------------------
do $$
declare x record;
begin
  -- Waiting new versions replace the old ones; every document is in use.
  for x in select d.id, d.replaces from public.kb_documents d join public.kb_documents o on o.id = d.replaces
            where d.status = 'new' and o.replaced_by is null order by d.created_at loop
    perform public.kb_take_over(x.replaces, x.id);
  end loop;
  update public.kb_documents set status = 'checked', checked_at = coalesce(checked_at, now()) where status = 'new';
  -- Drafts and changes waiting for a check go live as their makers saved them.
  for x in select id, pending, pending_by from public.kb_products where pending is not null loop
    perform public.kb_apply(x.id, x.pending, x.pending_by, 'migrated');
  end loop;
end $$;

commit;
