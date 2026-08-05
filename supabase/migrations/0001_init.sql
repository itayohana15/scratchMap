-- =====================================================================
-- ScratchMap — Phase 1 schema
-- Single-user for now: every table carries a nullable user_id so RLS
-- can be tightened to `auth.uid() = user_id` once Supabase Auth ships,
-- without any breaking migration. All policies below are intentionally
-- permissive for the `anon` role — marked _TEMP, tighten when auth lands.
-- =====================================================================

create extension if not exists pgcrypto;

create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------------------------------------------------------------- countries
create table public.countries (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid null,
  name             text not null,
  iso_a2           text not null check (char_length(iso_a2) = 2),
  iso_a3           text null check (iso_a3 is null or char_length(iso_a3) = 3),
  status           text not null default 'not_visited'
                   check (status in ('visited', 'planned', 'not_visited')),
  overview         text null,
  notes            text null,
  favorite_memory  text null,
  rating           numeric(2,1) null check (rating between 0 and 5),
  latitude         numeric(9,6) null,
  longitude        numeric(9,6) null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint countries_iso_a2_key unique (iso_a2)
);
create trigger set_countries_updated_at before update on public.countries
  for each row execute function public.set_updated_at();
alter table public.countries enable row level security;
-- TODO(auth): replace with `using (auth.uid() = user_id)` once auth ships.
create policy "countries_anon_all_TEMP" on public.countries
  for all to anon, authenticated using (true) with check (true);

-- ------------------------------------------------------------------ cities
create table public.cities (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid null,
  country_id  uuid not null references public.countries(id) on delete cascade,
  name        text not null,
  status      text not null default 'not_visited'
              check (status in ('visited', 'planned', 'not_visited')),
  latitude    numeric(9,6) null,
  longitude   numeric(9,6) null,
  overview    text null,
  notes       text null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint cities_country_name_key unique (country_id, name)
);
create index cities_country_id_idx on public.cities(country_id);
create trigger set_cities_updated_at before update on public.cities
  for each row execute function public.set_updated_at();
alter table public.cities enable row level security;
create policy "cities_anon_all_TEMP" on public.cities
  for all to anon, authenticated using (true) with check (true);

-- ------------------------------------------------------------------- trips
create table public.trips (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid null,
  name        text not null,
  start_date  date null,
  end_date    date null,
  budget      numeric(12,2) null,
  cost        numeric(12,2) null,
  notes       text null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint trips_dates_chk check (
    end_date is null or start_date is null or end_date >= start_date)
);
create trigger set_trips_updated_at before update on public.trips
  for each row execute function public.set_updated_at();
alter table public.trips enable row level security;
create policy "trips_anon_all_TEMP" on public.trips
  for all to anon, authenticated using (true) with check (true);

-- ------------------------------------------------------------- trip_cities
-- One row per trip-city visit (a trip can span multiple cities/countries).
-- This is also the grain a future Excel importer will upsert into.
create table public.trip_cities (
  id             uuid primary key default gen_random_uuid(),
  trip_id        uuid not null references public.trips(id) on delete cascade,
  city_id        uuid not null references public.cities(id) on delete cascade,
  arrival_date   date null,
  departure_date date null,
  notes          text null,
  created_at     timestamptz not null default now(),
  constraint trip_cities_trip_city_key unique (trip_id, city_id),
  constraint trip_cities_dates_chk check (
    departure_date is null or arrival_date is null or departure_date >= arrival_date)
);
create index trip_cities_trip_id_idx on public.trip_cities(trip_id);
create index trip_cities_city_id_idx on public.trip_cities(city_id);
alter table public.trip_cities enable row level security;
create policy "trip_cities_anon_all_TEMP" on public.trip_cities
  for all to anon, authenticated using (true) with check (true);

-- ------------------------------------------------------------------ photos
create table public.photos (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid null,
  country_id   uuid null references public.countries(id) on delete cascade,
  city_id      uuid null references public.cities(id) on delete cascade,
  trip_id      uuid null references public.trips(id) on delete set null,
  storage_path text not null,
  caption      text null,
  taken_at     date null,
  sort_order   int not null default 0,
  width        int null,
  height       int null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint photos_scope_chk check (country_id is not null or city_id is not null)
);
create index photos_country_id_idx on public.photos(country_id);
create index photos_city_id_idx on public.photos(city_id);
create index photos_trip_id_idx on public.photos(trip_id);
create trigger set_photos_updated_at before update on public.photos
  for each row execute function public.set_updated_at();
alter table public.photos enable row level security;
create policy "photos_anon_all_TEMP" on public.photos
  for all to anon, authenticated using (true) with check (true);

-- ------------------------------------------------------------ country_ratings
create table public.country_ratings (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid null,
  country_id      uuid not null references public.countries(id) on delete cascade,
  nature          smallint null check (nature between 1 and 10),
  food            smallint null check (food between 1 and 10),
  transportation  smallint null check (transportation between 1 and 10),
  safety          smallint null check (safety between 1 and 10),
  cleanliness     smallint null check (cleanliness between 1 and 10),
  value_for_money smallint null check (value_for_money between 1 and 10),
  nightlife       smallint null check (nightlife between 1 and 10),
  friendliness    smallint null check (friendliness between 1 and 10),
  overall numeric(4,2) generated always as (
    round(
      (
        coalesce(nature, 0) + coalesce(food, 0) + coalesce(transportation, 0) +
        coalesce(safety, 0) + coalesce(cleanliness, 0) + coalesce(value_for_money, 0) +
        coalesce(nightlife, 0) + coalesce(friendliness, 0)
      )::numeric
      /
      nullif(
        (case when nature is not null then 1 else 0 end) +
        (case when food is not null then 1 else 0 end) +
        (case when transportation is not null then 1 else 0 end) +
        (case when safety is not null then 1 else 0 end) +
        (case when cleanliness is not null then 1 else 0 end) +
        (case when value_for_money is not null then 1 else 0 end) +
        (case when nightlife is not null then 1 else 0 end) +
        (case when friendliness is not null then 1 else 0 end),
        0
      ),
      2
    )
  ) stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint country_ratings_country_key unique (country_id)
);
create trigger set_country_ratings_updated_at before update on public.country_ratings
  for each row execute function public.set_updated_at();
alter table public.country_ratings enable row level security;
create policy "country_ratings_anon_all_TEMP" on public.country_ratings
  for all to anon, authenticated using (true) with check (true);

-- ------------------------------------------------------------------ places
-- Hotels / restaurants / attractions. Phase 1: manually added (source='manual').
-- A later Google Places sync upserts into the SAME table keyed on
-- google_place_id — no schema change needed when the Places API key arrives.
create table public.places (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid null,
  country_id      uuid null references public.countries(id) on delete cascade,
  city_id         uuid null references public.cities(id) on delete cascade,
  kind            text not null check (kind in ('hotel', 'restaurant', 'attraction')),
  name            text not null,
  address         text null,
  latitude        numeric(9,6) null,
  longitude       numeric(9,6) null,
  notes           text null,
  rating          numeric(2,1) null check (rating between 0 and 5),
  source          text not null default 'manual' check (source in ('manual', 'google_places')),
  google_place_id text null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint places_scope_chk check (country_id is not null or city_id is not null),
  constraint places_google_place_id_key unique (google_place_id)
);
create index places_country_id_idx on public.places(country_id);
create index places_city_id_idx on public.places(city_id);
create trigger set_places_updated_at before update on public.places
  for each row execute function public.set_updated_at();
alter table public.places enable row level security;
create policy "places_anon_all_TEMP" on public.places
  for all to anon, authenticated using (true) with check (true);

-- ---------------------------------------------------------- storage bucket
insert into storage.buckets (id, name, public)
values ('photos', 'photos', true)
on conflict (id) do nothing;

-- TODO(auth): tighten storage policies once Supabase Auth ships.
create policy "photos_bucket_read_anon_TEMP" on storage.objects
  for select to anon, authenticated using (bucket_id = 'photos');
create policy "photos_bucket_write_anon_TEMP" on storage.objects
  for insert to anon, authenticated with check (bucket_id = 'photos');
create policy "photos_bucket_update_anon_TEMP" on storage.objects
  for update to anon, authenticated using (bucket_id = 'photos') with check (bucket_id = 'photos');
create policy "photos_bucket_delete_anon_TEMP" on storage.objects
  for delete to anon, authenticated using (bucket_id = 'photos');
