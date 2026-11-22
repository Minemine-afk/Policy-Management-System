-- Removes the made-up Knowledge Bank products added by 3c-sample-products.sql (with their documents and rates).
-- Requests that named one keep the product's name; only the link to the Knowledge Bank goes.
begin;
delete from public.kb_products where is_sample;
delete from public.kb_documents where is_sample;
commit;
