-- Idempotent seed: pre-app historical trips with no day-by-day itinerary
-- data (nothing was generated for these; they only carry dates/destination).
-- Safe to re-run -- each row is keyed by external_key, protected by the
-- partial unique index added in migrations/0005_country_itinerary_historical_import.sql.
--
-- Requires that migration to have run first (adds external_key,
-- 'historical_manual' as an allowed source value, and the missing RLS
-- policy on country_itineraries).
--
-- Country ids below are this project's actual `countries` row ids (looked
-- up by iso_a2 at authoring time). If re-seeding a different database,
-- replace the subquery below with your own country id, or swap the literal
-- ids for `(select id from public.countries where iso_a2 = 'XX')`.

insert into public.country_itineraries
  (country_id, iso_a2, title, start_date, end_date, days_count, source, status, external_key, preferences_snapshot)
select c.id, v.iso_a2, v.title, v.start_date::date, v.end_date::date, v.days_count, 'historical_manual', 'completed',
       v.external_key, v.preferences_snapshot::jsonb
from (
  values
    ('TR', 'טורקיה — יולי 2008',            '2008-07-11', '2008-07-18', 8,  'historical:TR:2008-07-11',            '{}'),
    ('IT', 'איטליה — יולי 2010',             '2010-07-05', '2010-07-13', 9,  'historical:IT:2010-07-05',            '{}'),
    ('NL', 'הולנד — יוני–יולי 2013',         '2013-06-24', '2013-07-02', 9,  'historical:NL:2013-06-24',            '{}'),
    ('FR', 'צרפת — יוני 2015',               '2015-06-12', '2015-06-20', 9,  'historical:FR:2015-06-12',            '{}'),
    ('GR', 'רודוס — יולי 2017',              '2017-07-06', '2017-07-14', 9,  'historical:GR-RHODES:2017-07-06',     '{"accommodationArea":"רודוס"}'),
    ('TH', 'תאילנד — אוגוסט 2017',           '2017-08-05', '2017-08-28', 24, 'historical:TH:2017-08-05',            '{}'),
    ('NL', 'אמסטרדם — יוני–יולי 2018',       '2018-06-24', '2018-07-02', 9,  'historical:NL-AMSTERDAM:2018-06-24',  '{"accommodationArea":"אמסטרדם"}'),
    ('NL', 'אמסטרדם — פברואר–מרץ 2019',      '2019-02-25', '2019-03-03', 7,  'historical:NL-AMSTERDAM:2019-02-25',  '{"accommodationArea":"אמסטרדם"}'),
    ('AT', 'אוסטריה — יולי 2023',            '2023-07-06', '2023-07-14', 9,  'historical:AT:2023-07-06',            '{}')
) as v(iso_a2, title, start_date, end_date, days_count, external_key, preferences_snapshot)
join public.countries c on c.iso_a2 = v.iso_a2
on conflict (external_key) where external_key is not null do nothing;

-- Note: Japan (07/10/2026-25/10/2026) was intentionally NOT seeded here.
-- Six real AI-generated itineraries already exist for that same trip
-- (country_itineraries.iso_a2 = 'JP', same Oct 2026 date range) -- adding a
-- historical stub would create a confusing duplicate on the same trip.
