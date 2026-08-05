alter table public.country_ratings
  drop constraint if exists country_ratings_nature_check,
  drop constraint if exists country_ratings_food_check,
  drop constraint if exists country_ratings_transportation_check,
  drop constraint if exists country_ratings_safety_check,
  drop constraint if exists country_ratings_cleanliness_check,
  drop constraint if exists country_ratings_value_for_money_check,
  drop constraint if exists country_ratings_nightlife_check,
  drop constraint if exists country_ratings_friendliness_check;

alter table public.country_ratings
  add constraint country_ratings_nature_check check (nature between 1 and 10),
  add constraint country_ratings_food_check check (food between 1 and 10),
  add constraint country_ratings_transportation_check check (transportation between 1 and 10),
  add constraint country_ratings_safety_check check (safety between 1 and 10),
  add constraint country_ratings_cleanliness_check check (cleanliness between 1 and 10),
  add constraint country_ratings_value_for_money_check check (value_for_money between 1 and 10),
  add constraint country_ratings_nightlife_check check (nightlife between 1 and 10),
  add constraint country_ratings_friendliness_check check (friendliness between 1 and 10);

alter table public.country_ratings
  drop column if exists overall;

alter table public.country_ratings
  add column overall numeric(4,2) generated always as (
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
  ) stored;
