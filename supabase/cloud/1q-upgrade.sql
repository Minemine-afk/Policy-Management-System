-- UPGRADE for a project that already ran 1p-upgrade.sql. Paste the whole file into SQL Editor and Run once.
-- Deletes nothing. Safe to run again. Switches the Knowledge Hub module on for ops and BSD (only the first time).

begin;
-- Knowledge Hub module: the Knowledge Bank screens (23 Nov 2026, Kumar: "Implement the knowledge bank under
-- Knowledge Hub module").
--
-- * Knowledge Hub goes live. By default ops and bsd have it; introducers can be given it by an admin (they then see
--   only checked, current documents).
-- * Documents: upload a PDF with its insurer, product, type, version, effective and valid-until dates. A new version
--   replaces the earlier one once it is checked. A second person checks each upload (not the uploader).
-- * Product records: ops or bsd fill in a product's facts, each naming the document and page it came from, and the
--   premium rates. Changes are kept as a draft next to the checked version (which stays in Compare products), are
--   sent for checking, and a BSD person who did not make them marks them as checked or sends them back. Each
--   checked version is kept in the history.
-- * Files live in the private storage bucket "kb-docs". Deleting goes through the Storage API (never SQL).
-- Safe to run more than once.

-- ---------------------------------------------------------------------------
-- The module
-- ---------------------------------------------------------------------------
do $$ begin
  -- Only the first time (the module was "coming soon"): switch it on for ops and bsd. Later runs keep the admin's choices.
  if exists (select 1 from public.app_modules where key = 'knowledge_hub' and not live) then
    update public.module_role_defaults set enabled = true where module_key = 'knowledge_hub' and role in ('ops', 'bsd');
  end if;
end $$;
update public.app_modules set live = true,
  description = 'Knowledge Bank: insurer documents with versions and expiry, and checked product facts'
 where key = 'knowledge_hub';

-- Ops and bsd with the Knowledge Hub module keep the Knowledge Bank (upload, edit).
create or replace function public.kb_member()
returns boolean language sql stable security definer set search_path = public as $$
  select (public.is_role('ops') or public.is_role('bsd')) and public.has_module('knowledge_hub');
$$;
-- BSD with the module check other people's uploads and changes.
create or replace function public.kb_checker()
returns boolean language sql stable security definer set search_path = public as $$
  select public.is_role('bsd') and public.has_module('knowledge_hub');
$$;
-- Anyone with the module reads checked, current documents (introducers too, when an admin gives it to them).
create or replace function public.kb_reader()
returns boolean language sql stable security definer set search_path = public as $$
  select public.has_module('knowledge_hub') and not public.is_role('admin');
$$;
revoke execute on function public.kb_member(), public.kb_checker(), public.kb_reader() from public, anon;
grant execute on function public.kb_member(), public.kb_checker(), public.kb_reader() to authenticated;

-- ---------------------------------------------------------------------------
-- Columns
-- ---------------------------------------------------------------------------
alter table public.kb_documents
  add column if not exists file_name text,
  add column if not exists file_size bigint,
  add column if not exists replaces uuid references public.kb_documents (id) on delete set null,
  add column if not exists replaced_by uuid references public.kb_documents (id) on delete set null,
  add column if not exists checked_at timestamptz,
  add column if not exists updated_at timestamptz not null default now();
-- A document no longer belongs to a product's life: removing a product keeps its documents (product left empty).
alter table public.kb_documents drop constraint if exists kb_documents_product_id_fkey;
alter table public.kb_documents add constraint kb_documents_product_id_fkey
  foreign key (product_id) references public.kb_products (id) on delete set null;

alter table public.kb_products drop constraint if exists kb_products_status_check;
alter table public.kb_products add constraint kb_products_status_check check (status in ('draft', 'check', 'verified', 'withdrawn'));
alter table public.kb_products
  add column if not exists pending jsonb check (pending is null or jsonb_typeof(pending) = 'object'),
  add column if not exists pending_state text check (pending_state in ('draft', 'check')),
  add column if not exists pending_by uuid references public.profiles (id) on delete set null,
  add column if not exists pending_at timestamptz,
  add column if not exists pending_note text,
  add column if not exists submitted_by uuid references public.profiles (id) on delete set null;
-- The sample "check" status is now a pending change; nothing else used it.
update public.kb_products set status = 'draft' where status = 'check';

create table if not exists public.kb_product_history (
  id bigint generated always as identity primary key,
  product_id uuid not null references public.kb_products (id) on delete cascade,
  version int not null,
  record jsonb not null,
  changed_by uuid references public.profiles (id) on delete set null,
  checked_by uuid references public.profiles (id) on delete set null,
  checked_at timestamptz not null default now()
);
create index if not exists kb_product_history_product on public.kb_product_history (product_id, version desc);

-- ---------------------------------------------------------------------------
-- Reading rules
-- ---------------------------------------------------------------------------
-- The documents a product's facts name (each fact, plus the Product Summary and rate sheet).
create or replace function public.kb_fact_docs(p_facts jsonb)
returns uuid[] language sql immutable as $$
  select coalesce(array_agg(distinct (e.value ->> 'doc')::uuid), '{}')
    from jsonb_each(coalesce(p_facts, '{}')) e
   where jsonb_typeof(e.value) = 'object' and coalesce(e.value ->> 'doc', '') ~ '^[0-9a-f-]{36}$';
$$;

-- A product can be compared when it was checked and none of the documents its facts rely on is out of date
-- (a brochure or campaign flyer that expires does not take it out).
create or replace function public.kb_product_usable(p_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.kb_products p
     where p.id = p_id and p.status = 'verified'
       and not exists (select 1 from public.kb_documents d
                        where d.id = any (public.kb_fact_docs(p.facts)) and d.valid_until < current_date));
$$;

-- The documents the comparison shows as sources: those named by a comparable product's facts.
create or replace view public.kb_checked_documents with (security_barrier = true) as
select d.id, d.product_id, d.insurer, d.title, d.doc_type, d.version, d.effective_from, d.valid_until
  from public.kb_documents d
 where public.can_compare_products()
   and exists (select 1 from public.kb_products p where d.id = any (public.kb_fact_docs(p.facts)) and public.kb_product_usable(p.id));

alter table public.kb_product_history enable row level security;
revoke all on public.kb_product_history from public, anon, authenticated;
grant select on public.kb_product_history to authenticated;
drop policy if exists kb_history_read on public.kb_product_history;
create policy kb_history_read on public.kb_product_history for select to authenticated using (public.kb_member());

drop policy if exists kb_products_staff on public.kb_products;
create policy kb_products_staff on public.kb_products for select to authenticated using (public.kb_member());
drop policy if exists kb_rates_staff on public.kb_rates;
create policy kb_rates_staff on public.kb_rates for select to authenticated using (public.kb_member());
drop policy if exists kb_documents_staff on public.kb_documents;
create policy kb_documents_staff on public.kb_documents for select to authenticated
  using (public.kb_member() or (public.kb_reader() and status = 'checked' and replaced_by is null));

-- ---------------------------------------------------------------------------
-- Files (private bucket "kb-docs"; path: <random folder>/<file name>)
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public) values ('kb-docs', 'kb-docs', false) on conflict (id) do nothing;
create or replace function public.kb_file_listed(p_path text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.kb_documents where storage_path = p_path)
$$;
revoke execute on function public.kb_file_listed(text) from public, anon;
grant execute on function public.kb_file_listed(text) to authenticated;
drop policy if exists "kb docs upload" on storage.objects;
create policy "kb docs upload" on storage.objects for insert to authenticated
  with check (bucket_id = 'kb-docs' and public.kb_member());
drop policy if exists "kb docs read" on storage.objects;
create policy "kb docs read" on storage.objects for select to authenticated
  using (bucket_id = 'kb-docs' and (
    (public.kb_member() and (public.kb_file_listed(name) or owner = auth.uid()))
    or (public.kb_reader() and exists (select 1 from public.kb_documents d where d.storage_path = name and d.status = 'checked' and d.replaced_by is null))));
drop policy if exists "kb docs delete" on storage.objects;
create policy "kb docs delete" on storage.objects for delete to authenticated
  using (bucket_id = 'kb-docs' and public.kb_member() and not public.kb_file_listed(name));

-- ---------------------------------------------------------------------------
-- Documents
-- ---------------------------------------------------------------------------
create or replace function public.kb_doc_fields(p jsonb)
returns void language plpgsql stable as $$
begin
  if coalesce(btrim(p ->> 'insurer'), '') = '' then raise exception 'Fill in the insurer'; end if;
  if coalesce(btrim(p ->> 'title'), '') = '' then raise exception 'Fill in the document name'; end if;
  if coalesce(p ->> 'doc_type', '') not in ('Product Summary', 'Rate sheet', 'Brochure', 'Policy wording', 'Guide', 'Campaign', 'Regulatory', 'Other') then
    raise exception 'Choose the document type';
  end if;
  if nullif(p ->> 'effective_from', '') is null then raise exception 'Fill in the effective date'; end if;
  if nullif(p ->> 'valid_until', '') is not null and (p ->> 'valid_until')::date < (p ->> 'effective_from')::date then
    raise exception 'The valid-until date is before the effective date';
  end if;
end $$;

-- Lists an uploaded file. p: insurer, product_id (optional), title, doc_type, version, effective_from, valid_until,
-- storage_path, file_name, file_size, replaces (optional: the document this is a new version of).
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
  insert into public.kb_documents (product_id, insurer, title, doc_type, version, effective_from, valid_until, storage_path,
                                   file_name, file_size, replaces, status, uploaded_by)
  values (nullif(p ->> 'product_id', '')::uuid, btrim(p ->> 'insurer'), left(btrim(p ->> 'title'), 200), p ->> 'doc_type',
          left(coalesce(btrim(p ->> 'version'), ''), 40), (p ->> 'effective_from')::date, nullif(p ->> 'valid_until', '')::date,
          p ->> 'storage_path', left(coalesce(p ->> 'file_name', ''), 255), nullif(p ->> 'file_size', '')::bigint, old.id, 'new', auth.uid())
  returning id into d;
  perform public.log_event('kb.document_uploaded', 'kb_document', d::text,
    jsonb_build_object('title', btrim(p ->> 'title'), 'insurer', btrim(p ->> 'insurer'), 'replaces', old.title));
  return d;
end $$;

-- Changes a document's details. A checked document goes back to "new" and must be checked again.
create or replace function public.kb_update_document(p_id uuid, p jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare d public.kb_documents;
begin
  if not public.kb_member() then raise exception 'Only ops and BSD with the Knowledge Hub can change documents'; end if;
  select * into d from public.kb_documents where id = p_id;
  if d.id is null then raise exception 'Document not found'; end if;
  perform public.kb_doc_fields(p);
  update public.kb_documents set insurer = btrim(p ->> 'insurer'), product_id = nullif(p ->> 'product_id', '')::uuid,
         title = left(btrim(p ->> 'title'), 200), doc_type = p ->> 'doc_type', version = left(coalesce(btrim(p ->> 'version'), ''), 40),
         effective_from = (p ->> 'effective_from')::date, valid_until = nullif(p ->> 'valid_until', '')::date,
         status = 'new', checked_by = null, checked_at = null, updated_at = now(), uploaded_by = auth.uid()
   where id = p_id;
  perform public.log_event('kb.document_changed', 'kb_document', p_id::text, jsonb_build_object('title', btrim(p ->> 'title')));
end $$;

-- A BSD person who did not upload (or last change) the document confirms its details. A new version then replaces
-- the one before: products whose facts name the old version get a draft that names the new one, to be re-checked.
create or replace function public.kb_check_document(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare d public.kb_documents; pr record; base jsonb;
begin
  if not public.kb_checker() then raise exception 'Only BSD with the Knowledge Hub can check documents'; end if;
  select * into d from public.kb_documents where id = p_id;
  if d.id is null then raise exception 'Document not found'; end if;
  if d.status = 'checked' then return; end if;
  if d.uploaded_by = auth.uid() then raise exception 'You uploaded this document, so someone else must check it'; end if;
  update public.kb_documents set status = 'checked', checked_by = auth.uid(), checked_at = now() where id = p_id;
  if d.replaces is not null then
    update public.kb_documents set replaced_by = p_id, updated_at = now() where id = d.replaces;
    for pr in select * from public.kb_products p
               where d.replaces = any (public.kb_fact_docs(p.facts)) or d.replaces = any (public.kb_fact_docs(p.pending -> 'facts')) loop
      base := coalesce(pr.pending, public.kb_record(pr.id));
      base := jsonb_set(base, '{facts}', public.kb_swap_doc(base -> 'facts', d.replaces, p_id));
      update public.kb_products set pending = base, pending_state = 'draft', pending_at = now(),
             pending_by = coalesce(pending_by, d.uploaded_by),
             pending_note = format('New version of "%s" checked. Compare the facts with it, then send for check.', d.title)
       where id = pr.id;
    end loop;
  end if;
  perform public.log_event('kb.document_checked', 'kb_document', p_id::text, jsonb_build_object('title', d.title));
end $$;

-- Takes a document off the list. The app then deletes the file through the Storage API.
create or replace function public.kb_remove_document(p_id uuid)
returns text language plpgsql security definer set search_path = public as $$
declare d public.kb_documents;
begin
  if not public.kb_member() then raise exception 'Only ops and BSD with the Knowledge Hub can remove documents'; end if;
  select * into d from public.kb_documents where id = p_id;
  if d.id is null then raise exception 'Document not found'; end if;
  if d.status = 'checked' and not public.kb_checker() then raise exception 'Only BSD can remove a checked document'; end if;
  if exists (select 1 from public.kb_products p
              where p_id = any (public.kb_fact_docs(p.facts)) or p_id = any (public.kb_fact_docs(p.pending -> 'facts'))) then
    raise exception 'A product record names this document. Change the product record first';
  end if;
  update public.kb_documents set replaced_by = null where replaced_by = p_id;
  delete from public.kb_documents where id = p_id;
  perform public.log_event('kb.document_removed', 'kb_document', p_id::text, jsonb_build_object('title', d.title));
  return d.storage_path;
end $$;

-- ---------------------------------------------------------------------------
-- Product records
-- ---------------------------------------------------------------------------
-- The checked record as the JSON the screens edit.
create or replace function public.kb_record(p_id uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('insurer', p.insurer, 'name', p.name, 'category', p.category, 'dpi', p.dpi,
           'jurisdiction', p.jurisdiction, 'currencies', to_jsonb(p.currencies), 'entry_age_min', p.entry_age_min,
           'entry_age_max', p.entry_age_max, 'residency', to_jsonb(p.residency), 'sa_min', p.sa_min, 'sa_max', p.sa_max,
           'has_tpd', p.has_tpd, 'has_ci', p.has_ci, 'facts', p.facts)
    from public.kb_products p where p.id = p_id and public.kb_member();
$$;

create or replace function public.kb_swap_doc(p_facts jsonb, p_old uuid, p_new uuid)
returns jsonb language sql immutable as $$
  select coalesce(jsonb_object_agg(e.key, case when e.value ->> 'doc' = p_old::text then jsonb_set(e.value, '{doc}', to_jsonb(p_new::text)) else e.value end), '{}')
    from jsonb_each(coalesce(p_facts, '{}')) e;
$$;

-- Checks a record before it is saved. Returns it tidied (only the known keys).
create or replace function public.kb_clean_record(p jsonb)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare f record; facts jsonb := '{}'; amin int; amax int; smin numeric; smax numeric; cur jsonb; res jsonb;
begin
  if coalesce(btrim(p ->> 'insurer'), '') = '' then raise exception 'Fill in the insurer'; end if;
  if coalesce(btrim(p ->> 'name'), '') = '' then raise exception 'Fill in the product name'; end if;
  if coalesce(p ->> 'category', '') not in ('Insurance', 'Investment') then raise exception 'Choose the category'; end if;
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
  return jsonb_build_object('insurer', btrim(p ->> 'insurer'), 'name', btrim(p ->> 'name'), 'category', p ->> 'category',
    'dpi', coalesce((p ->> 'dpi')::boolean, false), 'jurisdiction', p ->> 'jurisdiction', 'currencies', cur,
    'entry_age_min', amin, 'entry_age_max', amax, 'residency', res, 'sa_min', smin, 'sa_max', smax,
    'has_tpd', coalesce((p ->> 'has_tpd')::boolean, false), 'has_ci', coalesce((p ->> 'has_ci')::boolean, false), 'facts', facts)
    || case when p ? 'rates' then jsonb_build_object('rates', public.kb_clean_rates(p -> 'rates')) else '{}' end;
end $$;

-- Rates as [{age, gender, smoker, rate, ci_rate}], checked.
create or replace function public.kb_clean_rates(p jsonb)
returns jsonb language plpgsql immutable as $$
declare r jsonb; out jsonb := '[]'; seen text[] := '{}'; k text;
begin
  if p is null or jsonb_typeof(p) <> 'array' then raise exception 'Rates must be a list'; end if;
  for r in select * from jsonb_array_elements(p) loop
    begin
      if (r ->> 'age')::int not between 0 and 100 or (r ->> 'gender') not in ('Male', 'Female') or (r ->> 'rate')::numeric <= 0
         or (nullif(r ->> 'ci_rate', '')::numeric <= 0) then raise exception 'bad'; end if;
      k := (r ->> 'age') || (r ->> 'gender') || ((r ->> 'smoker')::boolean)::text;
    exception when others then raise exception 'Check the rates: each line needs age, gender (Male/Female), smoker (yes/no) and a rate above 0'; end;
    if k = any (seen) then raise exception 'The rates list age %, %, % twice', r ->> 'age', r ->> 'gender', case when (r ->> 'smoker')::boolean then 'smoker' else 'non-smoker' end; end if;
    seen := seen || k;
    out := out || jsonb_build_array(jsonb_build_object('age', (r ->> 'age')::int, 'gender', r ->> 'gender', 'smoker', (r ->> 'smoker')::boolean,
                                                       'rate', (r ->> 'rate')::numeric, 'ci_rate', nullif(r ->> 'ci_rate', '')::numeric));
  end loop;
  return out;
end $$;

-- Saves a product record as a draft (a new product when p_id is null). The checked version, if any, stays in
-- Compare products until the draft is checked. Saving a change that is waiting for check takes it back to draft.
create or replace function public.kb_save_product(p_id uuid, p jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare rec jsonb; pr public.kb_products; v_id uuid := p_id;
begin
  if not public.kb_member() then raise exception 'Only ops and BSD with the Knowledge Hub can edit product records'; end if;
  rec := public.kb_clean_record(p);
  if exists (select 1 from public.kb_products where lower(insurer) = lower(rec ->> 'insurer') and lower(name) = lower(rec ->> 'name')
              and kb_products.id is distinct from p_id) then
    raise exception 'There is already a product record for % %', rec ->> 'insurer', rec ->> 'name';
  end if;
  if p_id is null then
    insert into public.kb_products (insurer, name, status, created_by, pending, pending_state, pending_by, pending_at)
    values (rec ->> 'insurer', rec ->> 'name', 'draft', auth.uid(), rec, 'draft', auth.uid(), now())
    returning kb_products.id into v_id;
  else
    select * into pr from public.kb_products where kb_products.id = p_id for update;
    if pr.id is null then raise exception 'Product record not found'; end if;
    update public.kb_products set pending = rec, pending_state = 'draft', pending_by = auth.uid(), pending_at = now(),
           -- a product never checked keeps its name in step, so lists and the duplicate check use it
           insurer = case when pr.status = 'draft' then rec ->> 'insurer' else insurer end,
           name = case when pr.status = 'draft' then rec ->> 'name' else name end, updated_at = now()
     where kb_products.id = p_id;
  end if;
  perform public.log_event('kb.product_saved', 'kb_product', v_id::text, jsonb_build_object('product', (rec ->> 'insurer') || ' · ' || (rec ->> 'name')));
  return v_id;
end $$;

create or replace function public.kb_send_for_check(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare pr public.kb_products;
begin
  if not public.kb_member() then raise exception 'Only ops and BSD with the Knowledge Hub can send records for check'; end if;
  select * into pr from public.kb_products where id = p_id for update;
  if pr.id is null or pr.pending is null then raise exception 'There are no changes to send for check'; end if;
  if pr.pending_state = 'check' then return; end if;
  update public.kb_products set pending_state = 'check', submitted_by = auth.uid(), pending_note = null, updated_at = now() where id = p_id;
  perform public.log_event('kb.product_sent_for_check', 'kb_product', p_id::text, jsonb_build_object('product', (pr.pending ->> 'insurer') || ' · ' || (pr.pending ->> 'name')));
end $$;

-- Maker-checker: a BSD person who neither made nor sent the change marks it as checked. The record then becomes the
-- version Compare products uses, and goes into the history.
create or replace function public.kb_check_product(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare pr public.kb_products; rec jsonb; nv int; bad text;
begin
  if not public.kb_checker() then raise exception 'Only BSD with the Knowledge Hub can check product records'; end if;
  select * into pr from public.kb_products where id = p_id for update;
  if pr.id is null or pr.pending is null or pr.pending_state <> 'check' then raise exception 'This record is not waiting for check'; end if;
  if auth.uid() in (pr.pending_by, pr.submitted_by) then raise exception 'You made or sent these changes, so someone else must check them'; end if;
  rec := pr.pending;
  select string_agg(d.title, ', ') into bad from public.kb_documents d
   where d.id = any (public.kb_fact_docs(rec -> 'facts')) and (d.status <> 'checked' or d.valid_until < current_date);
  if bad is not null then raise exception 'These documents are not checked or are out of date: %', bad; end if;
  nv := case when pr.status in ('verified', 'withdrawn') or pr.verified_at is not null then pr.version + 1 else pr.version end;
  update public.kb_products set insurer = rec ->> 'insurer', name = rec ->> 'name', category = rec ->> 'category',
         dpi = (rec ->> 'dpi')::boolean, jurisdiction = rec ->> 'jurisdiction',
         currencies = array(select jsonb_array_elements_text(rec -> 'currencies')),
         entry_age_min = (rec ->> 'entry_age_min')::int, entry_age_max = (rec ->> 'entry_age_max')::int,
         residency = array(select jsonb_array_elements_text(rec -> 'residency')),
         sa_min = nullif(rec ->> 'sa_min', '')::numeric, sa_max = nullif(rec ->> 'sa_max', '')::numeric,
         has_tpd = (rec ->> 'has_tpd')::boolean, has_ci = (rec ->> 'has_ci')::boolean, facts = rec -> 'facts',
         status = 'verified', version = nv, verified_by = auth.uid(), verified_at = now(),
         pending = null, pending_state = null, pending_note = null, pending_at = null, submitted_by = null, updated_at = now()
   where id = p_id;
  if rec ? 'rates' then
    delete from public.kb_rates where product_id = p_id;
    insert into public.kb_rates (product_id, age, gender, smoker, rate, ci_rate)
    select p_id, (r ->> 'age')::int, r ->> 'gender', (r ->> 'smoker')::boolean, (r ->> 'rate')::numeric, nullif(r ->> 'ci_rate', '')::numeric
      from jsonb_array_elements(rec -> 'rates') r;
  end if;
  insert into public.kb_product_history (product_id, version, record, changed_by, checked_by)
  values (p_id, nv, rec - 'rates' || jsonb_build_object('rates_changed', rec ? 'rates'), pr.pending_by, auth.uid());
  perform public.log_event('kb.product_checked', 'kb_product', p_id::text,
    jsonb_build_object('product', (rec ->> 'insurer') || ' · ' || (rec ->> 'name'), 'version', nv));
end $$;

create or replace function public.kb_send_back_product(p_id uuid, p_note text)
returns void language plpgsql security definer set search_path = public as $$
declare pr public.kb_products;
begin
  if not public.kb_checker() then raise exception 'Only BSD with the Knowledge Hub can send records back'; end if;
  if coalesce(btrim(p_note), '') = '' then raise exception 'Say what needs changing'; end if;
  select * into pr from public.kb_products where id = p_id for update;
  if pr.id is null or pr.pending_state is distinct from 'check' then raise exception 'This record is not waiting for check'; end if;
  update public.kb_products set pending_state = 'draft', pending_note = left(btrim(p_note), 1000), updated_at = now() where id = p_id;
  perform public.log_event('kb.product_sent_back', 'kb_product', p_id::text,
    jsonb_build_object('product', (pr.pending ->> 'insurer') || ' · ' || (pr.pending ->> 'name'), 'reason', btrim(p_note)));
end $$;

-- Throws away the draft. A product that was never checked is deleted with it (its documents stay).
create or replace function public.kb_discard_draft(p_id uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare pr public.kb_products;
begin
  if not public.kb_member() then raise exception 'Only ops and BSD with the Knowledge Hub can discard drafts'; end if;
  select * into pr from public.kb_products where id = p_id for update;
  if pr.id is null then raise exception 'Product record not found'; end if;
  if pr.status = 'draft' and pr.verified_at is null then
    delete from public.kb_products where id = p_id;
    perform public.log_event('kb.product_discarded', 'kb_product', p_id::text, jsonb_build_object('product', pr.insurer || ' · ' || pr.name, 'deleted', true));
    return true;
  end if;
  update public.kb_products set pending = null, pending_state = null, pending_note = null, pending_at = null, submitted_by = null, updated_at = now() where id = p_id;
  perform public.log_event('kb.product_discarded', 'kb_product', p_id::text, jsonb_build_object('product', pr.insurer || ' · ' || pr.name));
  return false;
end $$;

-- BSD take a product out of Compare products (bring it back by checking a change to it).
create or replace function public.kb_withdraw_product(p_id uuid, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare pr public.kb_products;
begin
  if not public.kb_checker() then raise exception 'Only BSD with the Knowledge Hub can withdraw products'; end if;
  if coalesce(btrim(p_reason), '') = '' then raise exception 'Give a reason'; end if;
  select * into pr from public.kb_products where id = p_id for update;
  if pr.id is null or pr.status <> 'verified' then raise exception 'Only a checked product can be withdrawn'; end if;
  update public.kb_products set status = 'withdrawn', updated_at = now() where id = p_id;
  perform public.log_event('kb.product_withdrawn', 'kb_product', p_id::text,
    jsonb_build_object('product', pr.insurer || ' · ' || pr.name, 'reason', btrim(p_reason)));
end $$;

revoke execute on function public.kb_doc_fields(jsonb), public.kb_clean_record(jsonb), public.kb_clean_rates(jsonb),
  public.kb_swap_doc(jsonb, uuid, uuid) from public, anon, authenticated;
revoke execute on function public.kb_add_document(jsonb), public.kb_update_document(uuid, jsonb), public.kb_check_document(uuid),
  public.kb_remove_document(uuid), public.kb_record(uuid), public.kb_save_product(uuid, jsonb), public.kb_send_for_check(uuid),
  public.kb_check_product(uuid), public.kb_send_back_product(uuid, text), public.kb_discard_draft(uuid),
  public.kb_withdraw_product(uuid, text) from public, anon;
grant execute on function public.kb_add_document(jsonb), public.kb_update_document(uuid, jsonb), public.kb_check_document(uuid),
  public.kb_remove_document(uuid), public.kb_save_product(uuid, jsonb), public.kb_send_for_check(uuid),
  public.kb_check_product(uuid), public.kb_send_back_product(uuid, text), public.kb_discard_draft(uuid),
  public.kb_withdraw_product(uuid, text) to authenticated;
grant execute on function public.kb_record(uuid) to authenticated;

commit;
