-- Travel Wallet: document metadata + a private Storage bucket for the
-- actual files (boarding passes, tickets, passport/visa scans, etc.).
--
-- Unlike the `photos` bucket, this bucket is NOT public and has NO
-- anon/authenticated storage policies at all -- only the server-side
-- service-role client (which bypasses RLS/storage policies entirely) ever
-- touches it, via the /documents API routes. Viewing a file always goes
-- through a signed URL minted server-side on explicit user action, never a
-- permanent public link. This app has no real per-user authentication yet
-- (every other table's RLS is `using (true)`, same as here) -- this bucket
-- being private is a meaningful reduction in exposure regardless (no public
-- registration, no guessable/cacheable-forever URL), not a claim that real
-- per-user access control exists.
insert into storage.buckets (id, name, public)
values ('trip-documents', 'trip-documents', false)
on conflict (id) do nothing;

create table public.trip_documents (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid null,
  itinerary_id       uuid not null references public.country_itineraries(id) on delete cascade,
  booking_id         text null,
  itinerary_item_id  text null,
  type               text not null default 'other',
  title              text not null,
  storage_path       text not null,
  file_name          text not null,
  mime_type          text not null,
  notes              text not null default '',
  is_sensitive       boolean not null default false,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index trip_documents_itinerary_id_idx on public.trip_documents(itinerary_id);
create trigger set_trip_documents_updated_at before update on public.trip_documents
  for each row execute function public.set_updated_at();
alter table public.trip_documents enable row level security;
create policy "trip_documents_anon_all_TEMP" on public.trip_documents
  for all to anon, authenticated using (true) with check (true);
