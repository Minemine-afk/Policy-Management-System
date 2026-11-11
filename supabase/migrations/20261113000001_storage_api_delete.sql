-- Supabase no longer lets SQL delete rows from storage.objects ("Direct deletion from storage tables is not
-- allowed. Use the Storage API instead."). remove_document now only takes the file off the request; the app then
-- deletes the file itself through the Storage API. Storage lets you delete (and see) only files you uploaded
-- that are no longer listed on any request, so a listed file can't be deleted from under the request.
create or replace function public.file_is_listed(p_path text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.request_documents where storage_path = p_path)
$$;
revoke execute on function public.file_is_listed(text) from public, anon;
grant execute on function public.file_is_listed(text) to authenticated;

create or replace function public.remove_document(p_document uuid)
returns void language plpgsql security definer set search_path = public as $$
declare d public.request_documents;
begin
  select * into d from public.request_documents where id = p_document;
  if d.id is null or d.uploaded_by <> auth.uid() or not public.can_upload(d.request_id, d.kind) then
    raise exception 'You cannot remove this file';
  end if;
  delete from public.request_documents where id = d.id;
end $$;

drop policy if exists "request docs read own unlisted" on storage.objects;
create policy "request docs read own unlisted" on storage.objects for select to authenticated
  using (bucket_id = 'request-docs' and owner = auth.uid() and not public.file_is_listed(name));
drop policy if exists "request docs delete" on storage.objects;
create policy "request docs delete" on storage.objects for delete to authenticated
  using (bucket_id = 'request-docs' and owner = auth.uid() and not public.file_is_listed(name));
