-- Trip-scoped photos + per-trip ratings.
--
-- photos: scope to a specific trip (country_itineraries), independent of the
-- legacy, effectively-unused photos.trip_id -> public.trips column (that
-- table predates the country_itineraries model and is not written to by any
-- current app flow).
alter table public.photos
  add column itinerary_id uuid null references public.country_itineraries(id) on delete set null,
  add column day_id text null,
  add column place_id text null,
  add column favorite boolean not null default false;
create index photos_itinerary_id_idx on public.photos(itinerary_id);

-- trip_ratings: one row per trip, explicit user-entered overall (not a
-- generated column, unlike country_ratings.overall), 14 categories.
create table public.trip_ratings (
  id                   uuid primary key default gen_random_uuid(),
  itinerary_id         uuid not null unique references public.country_itineraries(id) on delete cascade,
  overall              smallint null check (overall between 1 and 10),
  food                 smallint null check (food between 1 and 10),
  culture              smallint null check (culture between 1 and 10),
  nature               smallint null check (nature between 1 and 10),
  attractions          smallint null check (attractions between 1 and 10),
  nightlife            smallint null check (nightlife between 1 and 10),
  transportation       smallint null check (transportation between 1 and 10),
  value_for_money      smallint null check (value_for_money between 1 and 10),
  safety               smallint null check (safety between 1 and 10),
  cleanliness          smallint null check (cleanliness between 1 and 10),
  tourist_convenience  smallint null check (tourist_convenience between 1 and 10),
  locals_hospitality   smallint null check (locals_hospitality between 1 and 10),
  shopping             smallint null check (shopping between 1 and 10),
  weather              smallint null check (weather between 1 and 10),
  would_return         smallint null check (would_return between 1 and 10),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create trigger set_trip_ratings_updated_at before update on public.trip_ratings
  for each row execute function public.set_updated_at();
alter table public.trip_ratings enable row level security;
create policy "trip_ratings_anon_all_TEMP" on public.trip_ratings
  for all to anon, authenticated using (true) with check (true);
