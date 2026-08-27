alter table public.country_itineraries add column if not exists client_request_id text null;

-- Partial unique index: only rows that actually carry a client-generated
-- request id are constrained, so historical rows and any future insert path
-- that never sets one are unaffected. This is the last-resort guarantee
-- against duplicate itinerary generation from the same wizard submission
-- (double-click, network retry, or a race past the application-level
-- lookup) — the application checks first, but the database is the real
-- backstop per spec.
create unique index if not exists country_itineraries_client_request_id_key
  on public.country_itineraries(client_request_id) where client_request_id is not null;
