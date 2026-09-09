-- CUSTOMER-SIDE EXAMPLE. Review and adapt the two public.profiles references.
-- Run only in the customer's staging Supabase project, never DROP OS's database.
-- The caller is the dedicated test account authenticated by the Action.
create or replace function public.dropos_read_entitlement()
returns table(plan_active boolean)
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce((
    select p.plan = 'pro'
      from public.profiles p
     where p.id = (select auth.uid())
  ), false);
$$;

revoke all on function public.dropos_read_entitlement() from public, anon;
grant execute on function public.dropos_read_entitlement() to authenticated;
