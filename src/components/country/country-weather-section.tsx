"use client";

import { format } from "date-fns";
import { he } from "date-fns/locale";
import {
  Cloud,
  CloudDrizzle,
  CloudFog,
  CloudRain,
  CloudSnow,
  CloudSun,
  Droplets,
  Sun,
  TriangleAlert,
  Wind,
  Zap,
} from "lucide-react";

import { Skeleton } from "@/components/ui/skeleton";
import {
  useCountryWeather,
  WEATHER_CODE_LABELS,
  weatherIconKey,
  type WeatherIconKey,
} from "@/lib/weather/country-weather";

const WEATHER_ICONS: Record<WeatherIconKey, typeof Sun> = {
  sun: Sun,
  "cloud-sun": CloudSun,
  cloud: Cloud,
  fog: CloudFog,
  drizzle: CloudDrizzle,
  rain: CloudRain,
  snow: CloudSnow,
  storm: Zap,
};

function WeatherIcon({ code, className }: { code: number; className?: string }) {
  const Icon = WEATHER_ICONS[weatherIconKey(code)];
  return <Icon className={className} />;
}

interface CountryWeatherSectionProps {
  lat: number | undefined;
  lon: number | undefined;
}

export function CountryWeatherSection({ lat, lon }: CountryWeatherSectionProps) {
  const { data, isLoading, isError } = useCountryWeather(lat, lon);

  if (isLoading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-32 rounded-2xl" />
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-24 rounded-xl" />
          ))}
        </div>
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="section-card flex items-start gap-2 px-4 py-3 text-sm text-muted-foreground">
        <TriangleAlert className="mt-0.5 size-4 shrink-0 text-amber-500" />
        <span>לא הצלחנו לטעון את מזג האוויר כרגע.</span>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="section-card flex flex-wrap items-center justify-between gap-6 p-6">
        <div className="flex items-center gap-4">
          <WeatherIcon code={data.current.weatherCode} className="size-14 text-primary" />
          <div>
            <p className="text-4xl font-semibold">{data.current.temperature}°</p>
            <p className="text-sm text-muted-foreground">{WEATHER_CODE_LABELS[data.current.weatherCode] ?? ""}</p>
          </div>
        </div>

        <div className="flex gap-6 text-sm text-muted-foreground">
          <div className="flex items-center gap-1.5">
            <Sun className="size-4" />
            <span>מרגיש כמו {data.current.feelsLike}°</span>
          </div>
          <div className="flex items-center gap-1.5">
            <Droplets className="size-4" />
            <span>{data.current.humidity}% לחות</span>
          </div>
          <div className="flex items-center gap-1.5">
            <Wind className="size-4" />
            <span>{data.current.windSpeed} קמ״ש</span>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
        {data.daily.map((day, i) => (
          <div key={day.date} className="section-card flex flex-col items-center gap-1.5 p-3 text-center">
            <p className="text-xs text-muted-foreground">
              {i === 0 ? "היום" : format(new Date(day.date), "EEEEEE", { locale: he })}
            </p>
            <WeatherIcon code={day.weatherCode} className="size-6 text-primary" />
            <p className="text-xs">
              <span className="font-medium">{day.tempMax}°</span>{" "}
              <span className="text-muted-foreground">{day.tempMin}°</span>
            </p>
          </div>
        ))}
      </div>

      <p className="text-xs text-muted-foreground">
        מקור: Open-Meteo · נמדד ב-{format(new Date(data.current.observedAt), "d בMMM, HH:mm", { locale: he })}
      </p>
    </div>
  );
}
