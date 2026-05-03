-- Agent starter kit tables for Supabase
-- Run in the Supabase SQL editor or via supabase db push

create table if not exists agent_threads (
  id         uuid primary key default gen_random_uuid(),
  user_id    text not null,
  title      text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists agent_threads_user_id_idx on agent_threads (user_id);

create table if not exists agent_messages (
  id           uuid primary key default gen_random_uuid(),
  thread_id    uuid not null references agent_threads(id) on delete cascade,
  role         text not null check (role in ('user','assistant','system','tool')),
  content      text not null,
  tool_call_id text,
  tool_name    text,
  created_at   timestamptz not null default now()
);

create index if not exists agent_messages_thread_id_idx on agent_messages (thread_id, created_at);

create table if not exists agent_runs (
  id           uuid primary key default gen_random_uuid(),
  thread_id    uuid not null references agent_threads(id) on delete cascade,
  agent_name   text not null,
  status       text not null check (status in ('pending','running','completed','failed','cancelled')),
  started_at   timestamptz not null default now(),
  completed_at timestamptz,
  error        text,
  metadata     jsonb
);

create index if not exists agent_runs_thread_id_idx on agent_runs (thread_id);

-- Trigger to auto-update agent_threads.updated_at
create or replace function update_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger agent_threads_updated_at
  before update on agent_threads
  for each row execute procedure update_updated_at();
