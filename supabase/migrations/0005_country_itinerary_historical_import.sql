-- Adds support for lightweight, manually-entered historical trip records
-- (trips that happened before this app existed, with no AI-generated
-- day-by-day itinerary) and fixes a pre-existing gap: country_itineraries
-- had row level security enabled with zero policies, which silently denied
-- all anon/authenticated access -- the "My Trips" page could never actually
-- read or write this table through the normal app client.

-- ------------------------------------------------------------------ RLS gap
-- TODO(auth): replace with `using (auth.uid() = user_id)` once auth ships,
-- matching every other table's temporary permissive policy.
create policy "country_itineraries_anon_all_TEMP" on public.country_itineraries
  for all to anon, authenticated using (true) with check (true);

-- ------------------------------------------------------- idempotency key
-- Lets a seed/import script safely re-run without creating duplicates.
alter table public.country_itineraries add column external_key text null;

create unique index country_itineraries_external_key_key
  on public.country_itineraries(external_key)
  where external_key is not null;

-- ------------------------------------------------- historical source value
-- Distinguishes manually-entered historical trips (no generated content)
-- from hand-edited AI itineraries, which already used 'manual'.
alter table public.country_itineraries drop constraint country_itineraries_source_check;
alter table public.country_itineraries add constraint country_itineraries_source_check
  check (source in ('ai', 'manual', 'historical_manual'));
