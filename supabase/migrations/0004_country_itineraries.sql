create table public.country_itineraries (
  id                   uuid primary key default gen_random_uuid(),
  user_id              uuid null,
  country_id           uuid not null references public.countries(id) on delete cascade,
  iso_a2               text not null,
  title                text not null,
  start_date           date null,
  end_date             date null,
  days_count           integer not null default 0 check (days_count >= 0),
  travelers            integer not null default 1 check (travelers > 0),
  budget               numeric(12,2) null,
  generation_mode      text not null default 'balanced',
  source               text not null default 'ai' check (source in ('ai', 'manual')),
  model                text null,
  summary              text null,
  preferences_snapshot jsonb not null default '{}'::jsonb,
  workspace_snapshot   jsonb not null default '{}'::jsonb,
  itinerary_days       jsonb not null default '[]'::jsonb,
  cost_summary         jsonb not null default '{}'::jsonb,
  status               text not null default 'upcoming' check (status in ('draft', 'upcoming', 'active', 'completed', 'archived')),
  version              integer not null default 1 check (version > 0),
  parent_itinerary_id  uuid null references public.country_itineraries(id) on delete set null,
  manually_edited      boolean not null default false,
  archived             boolean not null default false,
  generated_at         timestamptz not null default now(),
  deleted_at           timestamptz null,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint country_itineraries_dates_chk check (
    end_date is null or start_date is null or end_date >= start_date
  )
);

create index country_itineraries_country_id_idx on public.country_itineraries(country_id);
create index country_itineraries_iso_a2_idx on public.country_itineraries(iso_a2);
create index country_itineraries_updated_at_idx on public.country_itineraries(updated_at desc);
create index country_itineraries_deleted_at_idx on public.country_itineraries(deleted_at);

create trigger set_country_itineraries_updated_at before update on public.country_itineraries
  for each row execute function public.set_updated_at();

alter table public.country_itineraries enable row level security;

create table public.country_itinerary_versions (
  id                        uuid primary key default gen_random_uuid(),
  itinerary_id              uuid not null references public.country_itineraries(id) on delete cascade,
  version                   integer not null check (version > 0),
  change_reason             text null,
  source                    text not null default 'ai' check (source in ('ai', 'manual', 'duplicate', 'restore', 'regenerate')),
  model                     text null,
  snapshot                  jsonb not null default '{}'::jsonb,
  restored_from_version_id  uuid null references public.country_itinerary_versions(id) on delete set null,
  created_at                timestamptz not null default now(),
  constraint country_itinerary_versions_unique unique (itinerary_id, version)
);

create index country_itinerary_versions_itinerary_id_idx
  on public.country_itinerary_versions(itinerary_id, created_at desc);

alter table public.country_itinerary_versions enable row level security;
