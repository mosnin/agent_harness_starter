-- Row-level security for agent tables.
-- The HTTP adapter uses SUPABASE_SERVICE_ROLE_KEY and bypasses RLS.
-- Anon / user JWTs can only see rows they own (auth.uid()::text = user_id).

alter table agent_threads enable row level security;
alter table agent_messages enable row level security;
alter table agent_runs enable row level security;

drop policy if exists agent_threads_owner on agent_threads;
create policy agent_threads_owner on agent_threads
  using (user_id = auth.uid()::text)
  with check (user_id = auth.uid()::text);

drop policy if exists agent_messages_owner on agent_messages;
create policy agent_messages_owner on agent_messages
  using (
    exists (
      select 1 from agent_threads t
      where t.id = thread_id and t.user_id = auth.uid()::text
    )
  )
  with check (
    exists (
      select 1 from agent_threads t
      where t.id = thread_id and t.user_id = auth.uid()::text
    )
  );

drop policy if exists agent_runs_owner on agent_runs;
create policy agent_runs_owner on agent_runs
  using (
    exists (
      select 1 from agent_threads t
      where t.id = thread_id and t.user_id = auth.uid()::text
    )
  )
  with check (
    exists (
      select 1 from agent_threads t
      where t.id = thread_id and t.user_id = auth.uid()::text
    )
  );
