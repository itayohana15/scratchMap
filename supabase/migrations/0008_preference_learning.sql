-- Stage 7: personal travel preference profile + recommendation feedback.
--
-- Single-user app, no real authentication yet (every table's RLS is
-- `using (true)`, same TODO(auth) posture as everywhere else) -- `user_id`
-- columns are included as forward-compatible placeholders (same precedent
-- as trip_documents.user_id in 0007), unused until auth ships.
--
-- preference_profile is an app-level singleton: the app always reads/creates
-- the first row rather than filtering by any key.
create table public.preference_profile (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid null,
  explicit_preferences  jsonb not null default '{}'::jsonb,
  inferred_preferences  jsonb not null default '{}'::jsonb,
  dismissed_suggestions jsonb not null default '[]'::jsonb,
  learning_enabled      boolean not null default true,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create trigger set_preference_profile_updated_at before update on public.preference_profile
  for each row execute function public.set_updated_at();
alter table public.preference_profile enable row level security;
create policy "preference_profile_anon_all_TEMP" on public.preference_profile
  for all to anon, authenticated using (true) with check (true);

-- One row per thumbs up/down. Aggregated by place_key (never a per-row
-- blacklist) -- see src/lib/preference-learning.ts.
create table public.recommendation_feedback (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid null,
  place_key   text not null,
  trip_id     uuid null references public.country_itineraries(id) on delete set null,
  category    text not null,
  feedback    text not null check (feedback in ('up', 'down')),
  reason      text null,
  created_at  timestamptz not null default now()
);
create index recommendation_feedback_place_key_idx on public.recommendation_feedback(place_key);
create index recommendation_feedback_trip_id_idx on public.recommendation_feedback(trip_id);
alter table public.recommendation_feedback enable row level security;
create policy "recommendation_feedback_anon_all_TEMP" on public.recommendation_feedback
  for all to anon, authenticated using (true) with check (true);
