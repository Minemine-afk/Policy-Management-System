-- Product Comparison Matrix module (23 Nov 2026, Kumar: the Compare products pop-up "appears under Product
-- Comparison Matrix for all users which have it, and there's an option to add the selected products to whichever PI
-- they're working on, using the PI number").
--
-- * The module goes live. By default introducers, ops and bsd have it (an admin can switch it off per user or role).
-- * Its page is the same finder and side-by-side table as the pop-up on the PI request form, reading the same checked
--   Knowledge Bank products. Users with only this module (PI Requests off) can still compare.
-- * "Add to PI request": the 2 or 3 chosen products become the request's product (field 9) and the products to
--   compare (12 and 13), on a request the user may change, chosen by its PI number:
--     introducer: their own request while it is submitted or sent back (the same rule as editing it);
--     ops: a request assigned to them that is not completed or removed;
--     bsd: any request that is not completed or removed.
--   Adding needs PI Requests too (that module decides who works on requests). The request's history and the audit
--   log record it.
-- Safe to run more than once.

do $$ begin
  -- Only the first time (the module was "coming soon"): switch it on for every role that can have it.
  if exists (select 1 from public.app_modules where key = 'product_matrix' and not live) then
    update public.module_role_defaults set enabled = true where module_key = 'product_matrix' and role in ('introducer', 'ops', 'bsd');
  end if;
end $$;
update public.app_modules set live = true,
  description = 'Find and compare checked term products side by side, and add them to a PI request'
 where key = 'product_matrix';

-- Who can read the checked products: PI Requests users (the form's pop-up) and Product Comparison Matrix users.
create or replace function public.can_compare_products()
returns boolean language sql stable security definer set search_path = public as $$
  select public.has_role('introducer') or public.has_role('ops') or public.has_role('bsd')
      or ((public.is_role('introducer') or public.is_role('ops') or public.is_role('bsd')) and public.has_module('product_matrix'));
$$;
revoke execute on function public.can_compare_products() from public, anon;
grant execute on function public.can_compare_products() to authenticated;

-- May the current user put products on this request?
create or replace function public.can_add_products(r public.pi_requests)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(public.has_module('product_matrix') and (
       (public.has_role('introducer') and r.introducer_id = auth.uid() and r.status in ('submitted', 'sent_back'))
    or (public.has_role('ops') and r.assignee_id = auth.uid() and r.status not in ('completed', 'removed'))
    or (public.has_role('bsd') and r.status not in ('completed', 'removed'))), false);
$$;
revoke execute on function public.can_add_products(public.pi_requests) from public, anon, authenticated;

-- The requests the current user can add products to (for the picker on the matrix page).
create or replace function public.requests_for_products()
returns table (id uuid, ref text, status request_status, insurer text, plan_name text, compare_term boolean, submitted_at timestamptz)
language sql stable security definer set search_path = public as $$
  select r.id, r.ref, r.status, r.insurer, r.plan_name, r.compare_term, r.submitted_at
    from public.pi_requests r
   where public.can_add_products(r)
   order by r.submitted_at desc
   limit 200;
$$;
revoke execute on function public.requests_for_products() from public, anon;
grant execute on function public.requests_for_products() to authenticated;

-- Puts 2 or 3 checked products on a request: the first is the product (9), the others are compared (12, 13).
create or replace function public.add_products_to_request(p_ref text, p_ids uuid[])
returns uuid language plpgsql security definer set search_path = public as $$
declare r public.pi_requests; fp jsonb; n int := coalesce(array_length(p_ids, 1), 0); was text;
begin
  if not public.has_module('product_matrix') then raise exception 'You do not have the Product Comparison Matrix'; end if;
  select * into r from public.pi_requests where upper(ref) = upper(btrim(p_ref)) for update;
  if r.id is null or not public.can_view_request(r.id) then raise exception 'No PI request % that you can see', upper(btrim(p_ref)); end if;
  if not public.can_add_products(r) then
    raise exception 'You cannot change the products on % (it is %, or not yours to work on)', r.ref, replace(r.status::text, '_', ' ');
  end if;
  if n < 2 or n > 3 then raise exception 'Choose 2 or 3 products'; end if;
  if (select count(distinct x) from unnest(p_ids) x) <> n then raise exception 'Choose different products'; end if;
  fp := public.form_products(jsonb_build_object('plan_kb_id', p_ids[1], 'compare_term', true, 'compare_kb_1', p_ids[2], 'compare_kb_2', p_ids[3]));
  was := concat_ws(', ', nullif(concat_ws(' · ', r.insurer, r.plan_name), ''), r.compare_product_1, r.compare_product_2);
  update public.pi_requests set
    insurer = fp ->> 'insurer', plan_name = fp ->> 'plan_name', plan_kb_id = (fp ->> 'plan_kb_id')::uuid,
    compare_term = true, compare_product_1 = fp ->> 'compare_product_1', compare_kb_1 = (fp ->> 'compare_kb_1')::uuid,
    compare_product_2 = fp ->> 'compare_product_2', compare_kb_2 = (fp ->> 'compare_kb_2')::uuid, updated_at = now()
  where id = r.id;
  perform public.add_event(r.id, 'products_added', r.status, r.status,
    concat_ws(', ', (fp ->> 'insurer') || ' · ' || (fp ->> 'plan_name'), fp ->> 'compare_product_1', fp ->> 'compare_product_2'));
  perform public.log_event('request.products_added', 'pi_request', r.ref,
    jsonb_build_object('products', to_jsonb(array_remove(array[(fp ->> 'insurer') || ' · ' || (fp ->> 'plan_name'), fp ->> 'compare_product_1', fp ->> 'compare_product_2'], null)),
                       'before', nullif(was, '')));
  return r.id;
end $$;
revoke execute on function public.add_products_to_request(text, uuid[]) from public, anon;
grant execute on function public.add_products_to_request(text, uuid[]) to authenticated;
