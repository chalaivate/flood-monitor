-- Cross-process leases (e.g. "alerts") so only one worker evaluates and sends alerts at a time.
create table if not exists public.locks (
  name        text primary key,
  owner       text not null,
  expires_at  timestamptz not null
);

alter table public.locks enable row level security;
revoke all on table public.locks from anon, authenticated;
grant select, insert, update, delete on table public.locks to service_role;

-- Atomically take (or extend, when already held by the same owner) a lease.
create or replace function public.try_lock(p_name text, p_owner text, p_ttl_ms integer)
returns boolean
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_owner text;
begin
  delete from public.locks where name = p_name and expires_at < now();
  insert into public.locks (name, owner, expires_at)
  values (p_name, p_owner, now() + make_interval(secs => p_ttl_ms / 1000.0))
  on conflict (name) do update
    set expires_at = excluded.expires_at
    where public.locks.owner = excluded.owner;
  select owner into v_owner from public.locks where name = p_name;
  return v_owner = p_owner;
end;
$$;

revoke all on function public.try_lock(text, text, integer) from public, anon, authenticated;
grant execute on function public.try_lock(text, text, integer) to service_role;
