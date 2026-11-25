-- UPGRADE for a project that already ran 1r-upgrade.sql (or 1q). Paste the whole file into SQL Editor and Run once.
-- Deletes nothing. Safe to run again. Adds the Knowledge Bank document types Training material, Product Financing,
-- Circulars and Others (with a typed name).

begin;
-- More Knowledge Bank document types (25 Nov 2026, Kumar: "add the option to add files other than just product
-- summaries, such as training material, Product Financing, Circulars, Others (whereby user will be prompted to fill
-- in a textbox and that will be the new name displayed)").
--
-- * New types: Training material, Product Financing, Circulars, and Others. "Others" needs a name typed by the
--   uploader (doc_type_name, up to 60 characters), shown everywhere instead of "Others".
-- * The old "Other" type becomes "Others" named "Other" (nothing is lost).
-- * For these four types the insurer is optional (a circular or training deck may not come from one insurer); the
--   product link stays optional for every type. Versions, expiry, checking and who can see them are unchanged.
-- Safe to run more than once.

alter table public.kb_documents add column if not exists doc_type_name text;
alter table public.kb_documents drop constraint if exists kb_documents_doc_type_check;
update public.kb_documents set doc_type = 'Others', doc_type_name = coalesce(nullif(btrim(doc_type_name), ''), 'Other')
 where doc_type = 'Other';
alter table public.kb_documents add constraint kb_documents_doc_type_check check (doc_type in (
  'Product Summary', 'Rate sheet', 'Brochure', 'Policy wording', 'Guide', 'Training material', 'Product Financing',
  'Circulars', 'Campaign', 'Regulatory', 'Others'));
alter table public.kb_documents drop constraint if exists kb_documents_doc_type_name_check;
alter table public.kb_documents add constraint kb_documents_doc_type_name_check check (
  (doc_type = 'Others' and length(btrim(coalesce(doc_type_name, ''))) between 1 and 60)
  or (doc_type <> 'Others' and doc_type_name is null));

-- Types whose insurer may be left blank.
create or replace function public.kb_type_needs_insurer(p_type text)
returns boolean language sql immutable as $$
  select coalesce(p_type, '') not in ('Training material', 'Product Financing', 'Circulars', 'Others')
$$;

create or replace function public.kb_doc_fields(p jsonb)
returns void language plpgsql stable as $$
begin
  if coalesce(p ->> 'doc_type', '') not in ('Product Summary', 'Rate sheet', 'Brochure', 'Policy wording', 'Guide',
       'Training material', 'Product Financing', 'Circulars', 'Campaign', 'Regulatory', 'Others') then
    raise exception 'Choose the document type';
  end if;
  if p ->> 'doc_type' = 'Others' and coalesce(btrim(p ->> 'doc_type_name'), '') = '' then
    raise exception 'Type a name for the document type';
  end if;
  if p ->> 'doc_type' = 'Others' and length(btrim(p ->> 'doc_type_name')) > 60 then
    raise exception 'Keep the document type name to 60 characters';
  end if;
  if public.kb_type_needs_insurer(p ->> 'doc_type') and coalesce(btrim(p ->> 'insurer'), '') = '' then
    raise exception 'Fill in the insurer';
  end if;
  if coalesce(btrim(p ->> 'title'), '') = '' then raise exception 'Fill in the document name'; end if;
  if nullif(p ->> 'effective_from', '') is null then raise exception 'Fill in the effective date'; end if;
  if nullif(p ->> 'valid_until', '') is not null and (p ->> 'valid_until')::date < (p ->> 'effective_from')::date then
    raise exception 'The valid-until date is before the effective date';
  end if;
end $$;

-- The type name to keep: the typed name for "Others", nothing for the rest.
create or replace function public.kb_doc_type_name(p jsonb)
returns text language sql immutable as $$
  select case when p ->> 'doc_type' = 'Others' then left(btrim(p ->> 'doc_type_name'), 60) end
$$;

-- Lists an uploaded file. p: insurer, product_id (optional), title, doc_type, doc_type_name (for "Others"), version,
-- effective_from, valid_until, storage_path, file_name, file_size, replaces (optional: the document this is a new version of).
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
          nullif(p ->> 'file_size', '')::bigint, old.id, 'new', auth.uid())
  returning id into d;
  perform public.log_event('kb.document_uploaded', 'kb_document', d::text,
    jsonb_build_object('title', btrim(p ->> 'title'), 'insurer', nullif(btrim(p ->> 'insurer'), ''), 'replaces', old.title));
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
  update public.kb_documents set insurer = coalesce(btrim(p ->> 'insurer'), ''), product_id = nullif(p ->> 'product_id', '')::uuid,
         title = left(btrim(p ->> 'title'), 200), doc_type = p ->> 'doc_type', doc_type_name = public.kb_doc_type_name(p),
         version = left(coalesce(btrim(p ->> 'version'), ''), 40),
         effective_from = (p ->> 'effective_from')::date, valid_until = nullif(p ->> 'valid_until', '')::date,
         status = 'new', checked_by = null, checked_at = null, updated_at = now(), uploaded_by = auth.uid()
   where id = p_id;
  perform public.log_event('kb.document_changed', 'kb_document', p_id::text, jsonb_build_object('title', btrim(p ->> 'title')));
end $$;

revoke execute on function public.kb_type_needs_insurer(text), public.kb_doc_type_name(jsonb) from public, anon, authenticated;

commit;
