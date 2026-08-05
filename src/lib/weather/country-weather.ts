"use client";

import { useQuery } from "@tanstack/react-query";

export interface CountryWeather {
  current: {
    temperature: number;
    feelsLike: number;
    humidity: number;
    windSpeed: number;
    weatherCode: number;
  };
  daily: {
    date: string;
    weatherCode: number;
    tempMax: number;
    tempMin: number;
  }[];
}

interface OpenMeteoResponse {
  current: {
    temperature_2m: number;
    apparent_temperature: number;
    relative_humidity_2m: number;
    wind_speed_10m: number;
    weather_code: number;
  };
  daily: {
    time: string[];
    weather_code: number[];
    temperature_2m_max: number[];
    temperature_2m_min: number[];
  };
}

async function fetchCountryWeather(lat: number, lon: number): Promise<CountryWeather> {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,weather_code&daily=weather_code,temperature_2m_max,temperature_2m_min&timezone=auto&forecast_days=6`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("Failed to load weather");
  const data = (await res.json()) as OpenMeteoResponse;

  return {
    current: {
      temperature: Math.round(data.current.temperature_2m),
      feelsLike: Math.round(data.current.apparent_temperature),
      humidity: Math.round(data.current.relative_humidity_2m),
      windSpeed: Math.round(data.current.wind_speed_10m),
      weatherCode: data.current.weather_code,
    },
    daily: data.daily.time.map((date, i) => ({
      date,
      weatherCode: data.daily.weather_code[i],
      tempMax: Math.round(data.daily.temperature_2m_max[i]),
      tempMin: Math.round(data.daily.temperature_2m_min[i]),
    })),
  };
}

export function useCountryWeather(lat: number | undefined, lon: number | undefined) {
  return useQuery({
    queryKey: ["country-weather", lat?.toFixed(1) ?? "", lon?.toFixed(1) ?? ""],
    enabled: lat != null && lon != null,
    queryFn: () => fetchCountryWeather(lat!, lon!),
    staleTime: 1000 * 60 * 15,
    retry: false,
  });
}

// WMO weather codes (used by Open-Meteo) -> Hebrew label + icon key.
export const WEATHER_CODE_LABELS: Record<number, string> = {
  0: "בהיר",
  1: "בהיר בעיקר",
  2: "מעונן חלקית",
  3: "מעונן",
  45: "ערפל",
  48: "ערפל קופא",
  51: "טפטוף קל",
  53: "טפטוף",
  55: "טפטוף חזק",
  56: "טפטוף קופא",
  57: "טפטוף קופא חזק",
  61: "גשם קל",
  63: "גשם",
  65: "גשם חזק",
  66: "גשם קופא",
  67: "גשם קופא חזק",
  71: "שלג קל",
  73: "שלג",
  75: "שלג חזק",
  77: "גרגירי שלג",
  80: "ממטרים קלים",
  81: "ממטרים",
  82: "ממטרים חזקים",
  85: "ממטרי שלג קלים",
  86: "ממטרי שלג חזקים",
  95: "סופת רעמים",
  96: "סופת רעמים עם ברד",
  99: "סופת רעמים עם ברד כבד",
};

export type WeatherIconKey = "sun" | "cloud-sun" | "cloud" | "fog" | "drizzle" | "rain" | "snow" | "storm";

export function weatherIconKey(code: number): WeatherIconKey {
  if (code === 0) return "sun";
  if (code === 1 || code === 2) return "cloud-sun";
  if (code === 3) return "cloud";
  if (code === 45 || code === 48) return "fog";
  if ([51, 53, 55, 56, 57].includes(code)) return "drizzle";
  if ([61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return "rain";
  if ([71, 73, 75, 77, 85, 86].includes(code)) return "snow";
  if ([95, 96, 99].includes(code)) return "storm";
  return "cloud";
}
