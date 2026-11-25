-- Why isn't my upload in the Product Comparison Matrix?  READ ONLY: changes nothing. Safe to run any time.
-- Paste into Supabase > SQL Editor > Run. One row per Knowledge Bank document that belongs to a product
-- (Product Summary, Rate sheet, Brochure, Product Financing), newest first, with its product record and the reason.
-- Needs 1t-upgrade.sql or later (kb_products.missing).
with docs as (
  select d.*,
         coalesce(d.product_id,
                  (select p.id from public.kb_products p where d.id = any (public.kb_fact_docs(p.facts)) order by p.created_at limit 1)) as pid
    from public.kb_documents d
   where d.doc_type in ('Product Summary', 'Rate sheet', 'Brochure', 'Product Financing')
)
select d.title                                   as document,
       d.doc_type                                as type,
       d.file_name                               as file,
       to_char(d.created_at at time zone 'Asia/Singapore', 'DD Mon YYYY HH24:MI') as uploaded_sgt,
       d.effective_from, d.valid_until,
       p.insurer || ' · ' || p.name              as product_record,
       p.product_type                            as category,
       p.currencies,
       p.missing,
       p.is_sample                               as sample,
       coalesce(public.kb_product_usable(p.id) and p.product_type <> 'Premium financing', false) as in_matrix,
       case
         when d.replaced_by is not null then 'Older version: the newer upload is the one used'
         when p.id is null and d.doc_type in ('Product Summary', 'Rate sheet') and d.file_name ~* '\.(pdf|xlsx?|csv)$'
           then 'No product record was made from it (uploaded before reading was switched on, or the reading did not finish). Knowledge Bank > Documents > Read again'
         when p.id is null and d.doc_type = 'Brochure' then 'Brochures are filed, not read. Upload the Product Summary to put the product in the matrix'
         when p.id is null then 'This file type is not read (only PDF, Excel or CSV). Upload the PDF version'
         when p.product_type = 'Premium financing' then 'Premium financing: kept in the Knowledge Bank, not in the matrix (by design)'
         when p.status = 'withdrawn' then 'The product record is withdrawn'
         when cardinality(array_remove(p.missing, 'entry_age')) > 0
           then 'Not searchable: ' || replace(array_to_string(array_remove(p.missing, 'entry_age'), ', '), 'currencies', 'policy currency')
                || ' not found in the document. Open the product record and fill it in (or Read again after the reader fix)'
         when exists (select 1 from public.kb_documents x where x.id = any (public.kb_fact_docs(p.facts)) and x.valid_until < current_date)
           then 'A source document is past its valid-until date. Upload the new version or change the date'
         when p.status <> 'verified' then 'The product record was never saved'
         when p.is_sample then 'In the matrix (sample product: hidden when "Exclude sample products" is on)'
         else 'In the matrix' || case when 'entry_age' = any (p.missing) then ' (entry ages not stated: the age filter skips it)' else '' end
              || case when not ('SGD' = any (p.currencies)) then '. Policy currency ' || array_to_string(p.currencies, ', ')
                      || ' only: set the Currency filter to Any currency or ' || p.currencies[1] || ' to see it' else '' end
       end as why
  from docs d
  left join public.kb_products p on p.id = d.pid
 order by d.is_sample, d.created_at desc;
