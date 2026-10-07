create table if not exists public.platform_state (
  id smallint primary key check (id = 1),
  revision bigint not null default 0,
  data jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.platform_state enable row level security;
revoke all on public.platform_state from anon, authenticated;
grant all on public.platform_state to service_role;

create or replace function public.save_platform_state(p_expected_revision bigint, p_data jsonb)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.platform_state
     set data = p_data,
         revision = revision + 1,
         updated_at = now()
   where id = 1
     and revision = p_expected_revision;
  return found;
end;
$$;

revoke all on function public.save_platform_state(bigint, jsonb) from public, anon, authenticated;
grant execute on function public.save_platform_state(bigint, jsonb) to service_role;

insert into storage.buckets (id, name, public)
values ('platform-files', 'platform-files', false)
on conflict (id) do update set public = false;