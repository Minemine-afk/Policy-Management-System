-- Minimal stand-in for the Supabase auth and storage schemas, so the migrations
-- and access rules can be tested on plain PostgreSQL (CI or no Docker).
create extension if not exists pgcrypto;
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end $$;
grant usage on schema public to anon, authenticated;
alter default privileges in schema public grant select, insert, update, delete on tables to anon, authenticated;
alter default privileges in schema public grant execute on functions to anon, authenticated;
alter default privileges in schema public grant usage on sequences to anon, authenticated;

grant usage on schema auth to anon, authenticated;
create schema storage;
create table storage.buckets (id text primary key, name text, public boolean);
create table storage.objects (id uuid default gen_random_uuid() primary key, bucket_id text, name text, owner uuid default auth.uid());
alter table storage.objects enable row level security;
create function storage.foldername(name text) returns text[] language sql immutable as $$
  select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1] $$;
grant usage on schema storage to anon, authenticated;
grant select, insert, delete on storage.objects to authenticated;
