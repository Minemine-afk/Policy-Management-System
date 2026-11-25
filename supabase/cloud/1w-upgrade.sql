-- UPGRADE for a project that already ran 1v-upgrade.sql. Paste the whole file into SQL Editor and Run once.
-- Deletes nothing. Safe to run again. Lets a document belong to a whole product category (one Product field).

begin;
-- One Product field with the categories under it (25 Nov 2026, Kumar: "i meant for the product categories to be
-- displayed underneath this field instead of creating a seperate new field").
--
-- The upload form's Product field lists the 12 categories as headings with the product records of each under them.
-- A document can belong to one product record, to a whole category ("All Universal life incl. indexed (inv)
-- products", e.g. a bank's premium financing rates for universal life) or to no product ("All products").
-- * kb_documents.plan_type holds that category. It is kept only when the document has no product record (a linked
--   record's own category wins) and only for Product Summary, Rate sheet, Brochure and Product Financing.
-- * The Documents tab's Insurance / Investment and category filters use the product's category, else this one.
-- Safe to run more than once. Deletes nothing.

alter table public.kb_documents add column if not exists plan_type text;
alter table public.kb_documents drop constraint if exists kb_documents_plan_type_check;
alter table public.kb_documents add constraint kb_documents_plan_type_check
  check (plan_type is null or public.kb_plan_key(plan_type) = plan_type);

-- The category a document is saved with: only for the four product types, and only without a product record.
create or replace function public.kb_doc_plan(p jsonb)
returns text language sql immutable as $$
  select case when public.kb_type_has_product(p ->> 'doc_type') and public.kb_doc_product(p) is null
              then public.kb_plan_key(nullif(btrim(coalesce(p ->> 'plan_type', '')), '')) end
$$;

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
  insert into public.kb_documents (product_id, plan_type, insurer, title, doc_type, doc_type_name, version, effective_from, valid_until,
                                   storage_path, file_name, file_size, replaces, status, uploaded_by)
  values (public.kb_doc_product(p), public.kb_doc_plan(p), coalesce(btrim(p ->> 'insurer'), ''), left(btrim(p ->> 'title'), 200), p ->> 'doc_type',
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
         plan_type = public.kb_doc_plan(p),
         title = left(btrim(p ->> 'title'), 200), doc_type = p ->> 'doc_type', doc_type_name = public.kb_doc_type_name(p),
         version = left(coalesce(btrim(p ->> 'version'), ''), 40),
         effective_from = (p ->> 'effective_from')::date, valid_until = nullif(p ->> 'valid_until', '')::date, updated_at = now()
   where id = p_id;
  perform public.log_event('kb.document_changed', 'kb_document', p_id::text, jsonb_build_object('title', btrim(p ->> 'title')));
end $$;

-- A new version keeps the earlier one's product record, or else its category.
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
  update public.kb_documents set plan_type = (select plan_type from public.kb_documents where id = p_old)
   where id = p_new and product_id is null and plan_type is null and public.kb_type_has_product(doc_type);
end $$;

revoke execute on function public.kb_doc_plan(jsonb) from public, anon;

commit;
