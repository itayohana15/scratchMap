-- =====================================================================
-- ScratchMap — AI country recommendations
-- One cached AI-generated recommendation set per country (keyed by
-- iso_a2, not the user's countries row — recommendations are about the
-- real-world country and should be visible even for countries the user
-- hasn't added to their tracked list yet), so the Gemini call only
-- happens once per country rather than on every panel open.
-- Same single-user / permissive-RLS posture as 0001_init.sql — see that
-- file's header comment for the auth-tightening TODO.
-- =====================================================================

create table public.ai_recommendations (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid null,
  iso_a2      text not null,
  content     jsonb not null,
  model       text not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint ai_recommendations_iso_a2_key unique (iso_a2)
);
create trigger set_ai_recommendations_updated_at before update on public.ai_recommendations
  for each row execute function public.set_updated_at();
alter table public.ai_recommendations enable row level security;
-- TODO(auth): replace with `using (auth.uid() = user_id)` once auth ships.
create policy "ai_recommendations_anon_all_TEMP" on public.ai_recommendations
  for all to anon, authenticated using (true) with check (true);
