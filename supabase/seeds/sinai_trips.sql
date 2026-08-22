-- Idempotent seed: two historical Sinai visits. Sinai is a region within
-- Egypt, not a separate country -- both rows use Egypt's country_id/iso_a2,
-- with the region name captured via preferences_snapshot.accommodationArea
-- (same convention already used for Rhodes/Amsterdam in historical_trips.sql).
--
-- Exact dates for both trips are unknown, so start_date/end_date are left
-- NULL (the schema already allows this) and days_count stays 0 rather than
-- guessing a range. The known "YYYY-MM" is captured in
-- preferences_snapshot.partialDate so the app can still sort/group these
-- trips correctly by year and month until exact dates are entered later.
--
-- Safe to re-run -- each row is keyed by external_key, protected by the
-- partial unique index added in migrations/0005_country_itinerary_historical_import.sql.

insert into public.country_itineraries
  (country_id, iso_a2, title, start_date, end_date, days_count, source, status, external_key, preferences_snapshot)
select c.id, v.iso_a2, v.title, null, null, 0, 'historical_manual', 'completed',
       v.external_key, v.preferences_snapshot::jsonb
from (
  values
    ('EG', 'סיני — ספטמבר 2022', 'historical:EG-SINAI:2022-09',
     '{"accommodationArea":"סיני","partialDate":"2022-09"}'),
    ('EG', 'סיני — יוני 2023', 'historical:EG-SINAI:2023-06',
     '{"accommodationArea":"סיני","partialDate":"2023-06"}')
) as v(iso_a2, title, external_key, preferences_snapshot)
join public.countries c on c.iso_a2 = v.iso_a2
on conflict (external_key) where external_key is not null do nothing;
