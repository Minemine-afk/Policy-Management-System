-- Products are searchable without entry ages (25 Nov 2026, Kumar: "They should still be searchable"). Real Singapore
-- Product Summaries (FWD Future First, Singlife Elite Term II) do not state entry ages, so an auto-read term product
-- stayed out of search until someone typed them in.
--
-- * A product is searchable when its policy currency is known; entry ages are no longer required.
-- * kb_products.missing still lists 'entry_age' while the ages are not known (the record keeps the 18 to 65 column
--   defaults, which are NOT the product's ages). kb_checked_products gives ages_stated = false for those, and the app
--   shows "Entry ages not stated in the document" and skips them in the age filter instead of leaving them out.
-- * Saving the record (with the ages typed in) clears it, as before.

create or replace function public.kb_product_usable(p_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.kb_products p
     where p.id = p_id and p.status = 'verified' and cardinality(array_remove(p.missing, 'entry_age')) = 0
       and not exists (select 1 from public.kb_documents d
                        where d.id = any (public.kb_fact_docs(p.facts)) and d.valid_until < current_date));
$$;

create or replace view public.kb_checked_products with (security_barrier = true) as
select p.id, p.insurer, p.name, p.product_type, p.category, p.dpi, p.jurisdiction, p.currencies, p.entry_age_min,
       p.entry_age_max, p.residency, p.sa_min, p.sa_max, p.has_tpd, p.has_ci, p.facts, p.version, p.is_sample, p.verified_at,
       p.auto_read, not ('entry_age' = any (p.missing)) as ages_stated
  from public.kb_products p
 where public.can_compare_products() and public.kb_product_usable(p.id);

