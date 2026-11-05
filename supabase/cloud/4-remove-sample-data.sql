-- Removes the sample introducers, rate tables and knowledge-bank entries from 2-sample-data.sql.
begin;
delete from public.introducers where name like '[Sample]%';
delete from public.rate_tables where insurer like '[Sample%';
delete from public.kb_documents where title like '[Sample]%';
commit;
