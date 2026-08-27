/**
 * Curated major-airport dataset — no paid aviation API is available in this
 * project (see flight-planning.ts's HOME_COUNTRY_ISO_A2 comment for the
 * same reasoning), so this hand-maintained list is the "stored dataset"
 * tier: IATA code, display name, city, ISO country, coordinates, and the
 * airport's own IANA timezone (not just the country-level one from
 * country-timezones.ts — a country like the US spans many zones, and even
 * a single-zone country's airport should carry its own real zone rather
 * than a "representative" one). Not exhaustive — covers major hubs and the
 * destinations this app is most likely to plan trips to. Anything missing
 * falls back to country-level timezone + a distance-based duration
 * estimate (see flight-planning.ts).
 */
export interface AirportInfo {
  iata: string;
  name: string;
  city: string;
  countryIso: string;
  lat: number;
  lon: number;
  timezone: string;
  /** The canonical primary international gateway for this country — never inferred from array order (spec item 3). Exactly one per country in this dataset. */
  isPrimary?: boolean;
}

/**
 * Hebrew display names for exactly the countries this airport dataset
 * covers — a small inline map rather than pulling the full `i18n-iso-countries`
 * package into the client bundle just for the ~70 names actually needed here.
 */
export const COUNTRY_NAMES_HE: Record<string, string> = {
  AE: "איחוד האמירויות",
  AL: "אלבניה",
  AM: "ארמניה",
  AR: "ארגנטינה",
  AT: "אוסטריה",
  AU: "אוסטרליה",
  AZ: "אזרבייג'ן",
  BE: "בלגיה",
  BG: "בולגריה",
  BR: "ברזיל",
  CA: "קנדה",
  CH: "שווייץ",
  CL: "צ'ילה",
  CN: "סין",
  CO: "קולומביה",
  CY: "קפריסין",
  CZ: "צ'כיה",
  DE: "גרמניה",
  DK: "דנמרק",
  EE: "אסטוניה",
  EG: "מצרים",
  ES: "ספרד",
  ET: "אתיופיה",
  FI: "פינלנד",
  FR: "צרפת",
  GB: "בריטניה",
  GE: "גאורגיה",
  GR: "יוון",
  HK: "הונג קונג",
  HR: "קרואטיה",
  HU: "הונגריה",
  ID: "אינדונזיה",
  IE: "אירלנד",
  IL: "ישראל",
  IN: "הודו",
  IS: "איסלנד",
  IT: "איטליה",
  JO: "ירדן",
  JP: "יפן",
  KE: "קניה",
  KR: "דרום קוריאה",
  KZ: "קזחסטן",
  LK: "סרי לנקה",
  LT: "ליטא",
  LU: "לוקסמבורג",
  LV: "לטביה",
  MA: "מרוקו",
  MU: "מאוריציוס",
  MV: "האיים המלדיביים",
  MX: "מקסיקו",
  MY: "מלזיה",
  NL: "הולנד",
  NO: "נורווגיה",
  NP: "נפאל",
  NZ: "ניו זילנד",
  PE: "פרו",
  PH: "פיליפינים",
  PL: "פולין",
  PT: "פורטוגל",
  QA: "קטאר",
  RO: "רומניה",
  RS: "סרביה",
  RU: "רוסיה",
  SA: "ערב הסעודית",
  SE: "שוודיה",
  SG: "סינגפור",
  TH: "תאילנד",
  TN: "תוניסיה",
  TR: "טורקיה",
  TW: "טייוואן",
  TZ: "טנזניה",
  US: "ארצות הברית",
  UZ: "אוזבקיסטן",
  VN: "וייטנאם",
  ZA: "דרום אפריקה",
};

/** ISO country code → flag emoji, from the two-letter regional-indicator Unicode trick — no image assets needed. */
export function countryFlagEmoji(countryIso: string): string {
  const normalized = countryIso.trim().toUpperCase();
  if (normalized.length !== 2) return "";
  const codePoints = [...normalized].map((char) => 0x1f1e6 - 65 + char.charCodeAt(0));
  return String.fromCodePoint(...codePoints);
}

export const AIRPORTS: AirportInfo[] = [
  { iata: "TLV", name: "Ben Gurion Airport", city: "Tel Aviv", countryIso: "IL", lat: 32.0055, lon: 34.8854, timezone: "Asia/Jerusalem", isPrimary: true },
  { iata: "ETH", name: "Eilat Ramon Airport", city: "Eilat", countryIso: "IL", lat: 29.7217, lon: 35.0114, timezone: "Asia/Jerusalem" },

  // Georgia
  { iata: "TBS", name: "Tbilisi International Airport", city: "Tbilisi", countryIso: "GE", lat: 41.6693, lon: 44.9547, timezone: "Asia/Tbilisi", isPrimary: true },
  { iata: "BUS", name: "Batumi International Airport", city: "Batumi", countryIso: "GE", lat: 41.6103, lon: 41.5997, timezone: "Asia/Tbilisi" },
  { iata: "KUT", name: "Kutaisi International Airport", city: "Kutaisi", countryIso: "GE", lat: 42.1775, lon: 42.4828, timezone: "Asia/Tbilisi" },

  // Turkey
  { iata: "IST", name: "Istanbul Airport", city: "Istanbul", countryIso: "TR", lat: 41.2753, lon: 28.7519, timezone: "Europe/Istanbul", isPrimary: true },
  { iata: "SAW", name: "Sabiha Gökçen Airport", city: "Istanbul", countryIso: "TR", lat: 40.8986, lon: 29.3092, timezone: "Europe/Istanbul" },
  { iata: "AYT", name: "Antalya Airport", city: "Antalya", countryIso: "TR", lat: 36.8987, lon: 30.8005, timezone: "Europe/Istanbul" },
  { iata: "ADB", name: "Adnan Menderes Airport", city: "Izmir", countryIso: "TR", lat: 38.2924, lon: 27.1569, timezone: "Europe/Istanbul" },
  { iata: "ESB", name: "Esenboğa Airport", city: "Ankara", countryIso: "TR", lat: 40.1281, lon: 32.9951, timezone: "Europe/Istanbul" },
  { iata: "BJV", name: "Milas–Bodrum Airport", city: "Bodrum", countryIso: "TR", lat: 37.2506, lon: 27.6642, timezone: "Europe/Istanbul" },
  { iata: "DLM", name: "Dalaman Airport", city: "Dalaman", countryIso: "TR", lat: 36.7131, lon: 28.7925, timezone: "Europe/Istanbul" },

  // Greece
  { iata: "ATH", name: "Athens International Airport", city: "Athens", countryIso: "GR", lat: 37.9364, lon: 23.9445, timezone: "Europe/Athens", isPrimary: true },
  { iata: "SKG", name: "Thessaloniki Airport", city: "Thessaloniki", countryIso: "GR", lat: 40.5197, lon: 22.9709, timezone: "Europe/Athens" },
  { iata: "HER", name: "Heraklion Airport", city: "Heraklion", countryIso: "GR", lat: 35.3397, lon: 25.1803, timezone: "Europe/Athens" },
  { iata: "JMK", name: "Mykonos Airport", city: "Mykonos", countryIso: "GR", lat: 37.4351, lon: 25.3481, timezone: "Europe/Athens" },
  { iata: "JTR", name: "Santorini Airport", city: "Santorini", countryIso: "GR", lat: 36.3992, lon: 25.4793, timezone: "Europe/Athens" },
  { iata: "RHO", name: "Rhodes Airport", city: "Rhodes", countryIso: "GR", lat: 36.4054, lon: 28.0862, timezone: "Europe/Athens" },
  { iata: "CFU", name: "Corfu Airport", city: "Corfu", countryIso: "GR", lat: 39.6019, lon: 19.9117, timezone: "Europe/Athens" },

  // Cyprus
  { iata: "LCA", name: "Larnaca International Airport", city: "Larnaca", countryIso: "CY", lat: 34.8751, lon: 33.6249, timezone: "Asia/Nicosia", isPrimary: true },
  { iata: "PFO", name: "Paphos International Airport", city: "Paphos", countryIso: "CY", lat: 34.7180, lon: 32.4857, timezone: "Asia/Nicosia" },

  // Italy
  { iata: "FCO", name: "Leonardo da Vinci–Fiumicino Airport", city: "Rome", countryIso: "IT", lat: 41.8003, lon: 12.2389, timezone: "Europe/Rome", isPrimary: true },
  { iata: "MXP", name: "Malpensa Airport", city: "Milan", countryIso: "IT", lat: 45.6306, lon: 8.7281, timezone: "Europe/Rome" },
  { iata: "LIN", name: "Linate Airport", city: "Milan", countryIso: "IT", lat: 45.4451, lon: 9.2767, timezone: "Europe/Rome" },
  { iata: "VCE", name: "Venice Marco Polo Airport", city: "Venice", countryIso: "IT", lat: 45.5053, lon: 12.3519, timezone: "Europe/Rome" },
  { iata: "NAP", name: "Naples International Airport", city: "Naples", countryIso: "IT", lat: 40.8860, lon: 14.2908, timezone: "Europe/Rome" },
  { iata: "BLQ", name: "Bologna Airport", city: "Bologna", countryIso: "IT", lat: 44.5354, lon: 11.2887, timezone: "Europe/Rome" },
  { iata: "FLR", name: "Florence Airport", city: "Florence", countryIso: "IT", lat: 43.8100, lon: 11.2051, timezone: "Europe/Rome" },
  { iata: "CTA", name: "Catania Airport", city: "Catania", countryIso: "IT", lat: 37.4668, lon: 15.0664, timezone: "Europe/Rome" },
  { iata: "PMO", name: "Palermo Airport", city: "Palermo", countryIso: "IT", lat: 38.1759, lon: 13.0910, timezone: "Europe/Rome" },
  { iata: "PSA", name: "Pisa International Airport", city: "Pisa", countryIso: "IT", lat: 43.6839, lon: 10.3927, timezone: "Europe/Rome" },
  { iata: "BRI", name: "Bari Karol Wojtyła Airport", city: "Bari", countryIso: "IT", lat: 41.1389, lon: 16.7606, timezone: "Europe/Rome" },

  // Spain
  { iata: "MAD", name: "Adolfo Suárez Madrid–Barajas Airport", city: "Madrid", countryIso: "ES", lat: 40.4936, lon: -3.5668, timezone: "Europe/Madrid", isPrimary: true },
  { iata: "BCN", name: "Josep Tarradellas Barcelona-El Prat Airport", city: "Barcelona", countryIso: "ES", lat: 41.2971, lon: 2.0785, timezone: "Europe/Madrid" },
  { iata: "AGP", name: "Málaga Airport", city: "Málaga", countryIso: "ES", lat: 36.6749, lon: -4.4991, timezone: "Europe/Madrid" },
  { iata: "PMI", name: "Palma de Mallorca Airport", city: "Palma de Mallorca", countryIso: "ES", lat: 39.5517, lon: 2.7388, timezone: "Europe/Madrid" },
  { iata: "SVQ", name: "Seville Airport", city: "Seville", countryIso: "ES", lat: 37.4180, lon: -5.8931, timezone: "Europe/Madrid" },
  { iata: "VLC", name: "Valencia Airport", city: "Valencia", countryIso: "ES", lat: 39.4893, lon: -0.4816, timezone: "Europe/Madrid" },
  { iata: "IBZ", name: "Ibiza Airport", city: "Ibiza", countryIso: "ES", lat: 38.8729, lon: 1.3731, timezone: "Europe/Madrid" },
  { iata: "TFS", name: "Tenerife South Airport", city: "Tenerife", countryIso: "ES", lat: 28.0445, lon: -16.5725, timezone: "Atlantic/Canary" },
  { iata: "LPA", name: "Gran Canaria Airport", city: "Las Palmas", countryIso: "ES", lat: 27.9319, lon: -15.3866, timezone: "Atlantic/Canary" },

  // Portugal
  { iata: "LIS", name: "Humberto Delgado Airport", city: "Lisbon", countryIso: "PT", lat: 38.7813, lon: -9.1359, timezone: "Europe/Lisbon", isPrimary: true },
  { iata: "OPO", name: "Francisco Sá Carneiro Airport", city: "Porto", countryIso: "PT", lat: 41.2481, lon: -8.6814, timezone: "Europe/Lisbon" },
  { iata: "FAO", name: "Faro Airport", city: "Faro", countryIso: "PT", lat: 37.0144, lon: -7.9659, timezone: "Europe/Lisbon" },
  { iata: "FNC", name: "Madeira Airport", city: "Funchal", countryIso: "PT", lat: 32.6979, lon: -16.7745, timezone: "Atlantic/Madeira" },

  // France
  { iata: "CDG", name: "Charles de Gaulle Airport", city: "Paris", countryIso: "FR", lat: 49.0097, lon: 2.5479, timezone: "Europe/Paris", isPrimary: true },
  { iata: "ORY", name: "Orly Airport", city: "Paris", countryIso: "FR", lat: 48.7233, lon: 2.3794, timezone: "Europe/Paris" },
  { iata: "NCE", name: "Nice Côte d'Azur Airport", city: "Nice", countryIso: "FR", lat: 43.6653, lon: 7.2150, timezone: "Europe/Paris" },
  { iata: "LYS", name: "Lyon–Saint Exupéry Airport", city: "Lyon", countryIso: "FR", lat: 45.7256, lon: 5.0811, timezone: "Europe/Paris" },
  { iata: "MRS", name: "Marseille Provence Airport", city: "Marseille", countryIso: "FR", lat: 43.4393, lon: 5.2214, timezone: "Europe/Paris" },
  { iata: "TLS", name: "Toulouse–Blagnac Airport", city: "Toulouse", countryIso: "FR", lat: 43.6291, lon: 1.3638, timezone: "Europe/Paris" },
  { iata: "BOD", name: "Bordeaux–Mérignac Airport", city: "Bordeaux", countryIso: "FR", lat: 44.8283, lon: -0.7156, timezone: "Europe/Paris" },

  // UK & Ireland
  { iata: "LHR", name: "Heathrow Airport", city: "London", countryIso: "GB", lat: 51.4700, lon: -0.4543, timezone: "Europe/London", isPrimary: true },
  { iata: "LGW", name: "Gatwick Airport", city: "London", countryIso: "GB", lat: 51.1537, lon: -0.1821, timezone: "Europe/London" },
  { iata: "STN", name: "Stansted Airport", city: "London", countryIso: "GB", lat: 51.8860, lon: 0.2389, timezone: "Europe/London" },
  { iata: "LTN", name: "Luton Airport", city: "London", countryIso: "GB", lat: 51.8747, lon: -0.3683, timezone: "Europe/London" },
  { iata: "MAN", name: "Manchester Airport", city: "Manchester", countryIso: "GB", lat: 53.3537, lon: -2.2750, timezone: "Europe/London" },
  { iata: "EDI", name: "Edinburgh Airport", city: "Edinburgh", countryIso: "GB", lat: 55.9500, lon: -3.3725, timezone: "Europe/London" },
  { iata: "BHX", name: "Birmingham Airport", city: "Birmingham", countryIso: "GB", lat: 52.4539, lon: -1.7480, timezone: "Europe/London" },
  { iata: "DUB", name: "Dublin Airport", city: "Dublin", countryIso: "IE", lat: 53.4213, lon: -6.2701, timezone: "Europe/Dublin", isPrimary: true },

  // Germany, Austria, Switzerland
  { iata: "FRA", name: "Frankfurt Airport", city: "Frankfurt", countryIso: "DE", lat: 50.0379, lon: 8.5622, timezone: "Europe/Berlin", isPrimary: true },
  { iata: "MUC", name: "Munich Airport", city: "Munich", countryIso: "DE", lat: 48.3538, lon: 11.7861, timezone: "Europe/Berlin" },
  { iata: "BER", name: "Berlin Brandenburg Airport", city: "Berlin", countryIso: "DE", lat: 52.3667, lon: 13.5033, timezone: "Europe/Berlin" },
  { iata: "DUS", name: "Düsseldorf Airport", city: "Düsseldorf", countryIso: "DE", lat: 51.2895, lon: 6.7668, timezone: "Europe/Berlin" },
  { iata: "HAM", name: "Hamburg Airport", city: "Hamburg", countryIso: "DE", lat: 53.6304, lon: 9.9882, timezone: "Europe/Berlin" },
  { iata: "CGN", name: "Cologne Bonn Airport", city: "Cologne", countryIso: "DE", lat: 50.8659, lon: 7.1427, timezone: "Europe/Berlin" },
  { iata: "STR", name: "Stuttgart Airport", city: "Stuttgart", countryIso: "DE", lat: 48.6899, lon: 9.2220, timezone: "Europe/Berlin" },
  { iata: "VIE", name: "Vienna International Airport", city: "Vienna", countryIso: "AT", lat: 48.1103, lon: 16.5697, timezone: "Europe/Vienna", isPrimary: true },
  { iata: "SZG", name: "Salzburg Airport", city: "Salzburg", countryIso: "AT", lat: 47.7933, lon: 13.0043, timezone: "Europe/Vienna" },
  { iata: "ZRH", name: "Zurich Airport", city: "Zurich", countryIso: "CH", lat: 47.4647, lon: 8.5492, timezone: "Europe/Zurich", isPrimary: true },
  { iata: "GVA", name: "Geneva Airport", city: "Geneva", countryIso: "CH", lat: 46.2381, lon: 6.1090, timezone: "Europe/Zurich" },

  // Benelux
  { iata: "AMS", name: "Amsterdam Airport Schiphol", city: "Amsterdam", countryIso: "NL", lat: 52.3105, lon: 4.7683, timezone: "Europe/Amsterdam", isPrimary: true },
  { iata: "BRU", name: "Brussels Airport", city: "Brussels", countryIso: "BE", lat: 50.9014, lon: 4.4844, timezone: "Europe/Brussels", isPrimary: true },
  { iata: "LUX", name: "Luxembourg Airport", city: "Luxembourg", countryIso: "LU", lat: 49.6233, lon: 6.2044, timezone: "Europe/Luxembourg", isPrimary: true },

  // Scandinavia
  { iata: "CPH", name: "Copenhagen Airport", city: "Copenhagen", countryIso: "DK", lat: 55.6180, lon: 12.6560, timezone: "Europe/Copenhagen", isPrimary: true },
  { iata: "ARN", name: "Stockholm Arlanda Airport", city: "Stockholm", countryIso: "SE", lat: 59.6519, lon: 17.9186, timezone: "Europe/Stockholm", isPrimary: true },
  { iata: "OSL", name: "Oslo Airport", city: "Oslo", countryIso: "NO", lat: 60.1976, lon: 11.1004, timezone: "Europe/Oslo", isPrimary: true },
  { iata: "HEL", name: "Helsinki Airport", city: "Helsinki", countryIso: "FI", lat: 60.3172, lon: 24.9633, timezone: "Europe/Helsinki", isPrimary: true },
  { iata: "KEF", name: "Keflavík International Airport", city: "Reykjavik", countryIso: "IS", lat: 63.9850, lon: -22.6056, timezone: "Atlantic/Reykjavik", isPrimary: true },

  // Eastern Europe
  { iata: "WAW", name: "Warsaw Chopin Airport", city: "Warsaw", countryIso: "PL", lat: 52.1657, lon: 20.9671, timezone: "Europe/Warsaw", isPrimary: true },
  { iata: "KRK", name: "Kraków Airport", city: "Kraków", countryIso: "PL", lat: 50.0777, lon: 19.7848, timezone: "Europe/Warsaw" },
  { iata: "PRG", name: "Václav Havel Airport Prague", city: "Prague", countryIso: "CZ", lat: 50.1008, lon: 14.2600, timezone: "Europe/Prague", isPrimary: true },
  { iata: "BUD", name: "Budapest Ferenc Liszt International Airport", city: "Budapest", countryIso: "HU", lat: 47.4369, lon: 19.2556, timezone: "Europe/Budapest", isPrimary: true },
  { iata: "OTP", name: "Henri Coandă International Airport", city: "Bucharest", countryIso: "RO", lat: 44.5711, lon: 26.0850, timezone: "Europe/Bucharest", isPrimary: true },
  { iata: "SOF", name: "Sofia Airport", city: "Sofia", countryIso: "BG", lat: 42.6952, lon: 23.4062, timezone: "Europe/Sofia", isPrimary: true },
  { iata: "ZAG", name: "Franjo Tuđman Airport", city: "Zagreb", countryIso: "HR", lat: 45.7429, lon: 16.0688, timezone: "Europe/Zagreb", isPrimary: true },
  { iata: "SPU", name: "Split Airport", city: "Split", countryIso: "HR", lat: 43.5389, lon: 16.2980, timezone: "Europe/Zagreb" },
  { iata: "DBV", name: "Dubrovnik Airport", city: "Dubrovnik", countryIso: "HR", lat: 42.5614, lon: 18.2682, timezone: "Europe/Zagreb" },
  { iata: "BEG", name: "Belgrade Nikola Tesla Airport", city: "Belgrade", countryIso: "RS", lat: 44.8184, lon: 20.3091, timezone: "Europe/Belgrade", isPrimary: true },
  { iata: "TIA", name: "Tirana International Airport", city: "Tirana", countryIso: "AL", lat: 41.4147, lon: 19.7206, timezone: "Europe/Tirane", isPrimary: true },

  // Baltics & Russia region
  { iata: "TLL", name: "Tallinn Airport", city: "Tallinn", countryIso: "EE", lat: 59.4133, lon: 24.8328, timezone: "Europe/Tallinn", isPrimary: true },
  { iata: "RIX", name: "Riga International Airport", city: "Riga", countryIso: "LV", lat: 56.9236, lon: 23.9711, timezone: "Europe/Riga", isPrimary: true },
  { iata: "VNO", name: "Vilnius Airport", city: "Vilnius", countryIso: "LT", lat: 54.6341, lon: 25.2858, timezone: "Europe/Vilnius", isPrimary: true },
  { iata: "SVO", name: "Sheremetyevo International Airport", city: "Moscow", countryIso: "RU", lat: 55.9726, lon: 37.4146, timezone: "Europe/Moscow", isPrimary: true },

  // Middle East & Gulf
  { iata: "DXB", name: "Dubai International Airport", city: "Dubai", countryIso: "AE", lat: 25.2532, lon: 55.3657, timezone: "Asia/Dubai", isPrimary: true },
  { iata: "AUH", name: "Abu Dhabi International Airport", city: "Abu Dhabi", countryIso: "AE", lat: 24.4330, lon: 54.6511, timezone: "Asia/Dubai" },
  { iata: "DOH", name: "Hamad International Airport", city: "Doha", countryIso: "QA", lat: 25.2609, lon: 51.6138, timezone: "Asia/Qatar", isPrimary: true },
  { iata: "AMM", name: "Queen Alia International Airport", city: "Amman", countryIso: "JO", lat: 31.7226, lon: 35.9932, timezone: "Asia/Amman", isPrimary: true },
  { iata: "CAI", name: "Cairo International Airport", city: "Cairo", countryIso: "EG", lat: 30.1219, lon: 31.4056, timezone: "Africa/Cairo", isPrimary: true },
  { iata: "SSH", name: "Sharm El Sheikh International Airport", city: "Sharm El Sheikh", countryIso: "EG", lat: 27.9773, lon: 34.3950, timezone: "Africa/Cairo" },
  { iata: "RUH", name: "King Khalid International Airport", city: "Riyadh", countryIso: "SA", lat: 24.9576, lon: 46.6988, timezone: "Asia/Riyadh", isPrimary: true },
  { iata: "JED", name: "King Abdulaziz International Airport", city: "Jeddah", countryIso: "SA", lat: 21.6796, lon: 39.1565, timezone: "Asia/Riyadh" },
  { iata: "EVN", name: "Zvartnots International Airport", city: "Yerevan", countryIso: "AM", lat: 40.1473, lon: 44.3959, timezone: "Asia/Yerevan", isPrimary: true },
  { iata: "GYD", name: "Heydar Aliyev International Airport", city: "Baku", countryIso: "AZ", lat: 40.4675, lon: 50.0467, timezone: "Asia/Baku", isPrimary: true },

  // Asia
  { iata: "NRT", name: "Narita International Airport", city: "Tokyo", countryIso: "JP", lat: 35.7719, lon: 140.3929, timezone: "Asia/Tokyo" },
  { iata: "HND", name: "Haneda Airport", city: "Tokyo", countryIso: "JP", lat: 35.5494, lon: 139.7798, timezone: "Asia/Tokyo", isPrimary: true },
  { iata: "KIX", name: "Kansai International Airport", city: "Osaka", countryIso: "JP", lat: 34.4347, lon: 135.2441, timezone: "Asia/Tokyo" },
  { iata: "ICN", name: "Incheon International Airport", city: "Seoul", countryIso: "KR", lat: 37.4602, lon: 126.4407, timezone: "Asia/Seoul", isPrimary: true },
  { iata: "PEK", name: "Beijing Capital International Airport", city: "Beijing", countryIso: "CN", lat: 40.0799, lon: 116.6031, timezone: "Asia/Shanghai", isPrimary: true },
  { iata: "PVG", name: "Shanghai Pudong International Airport", city: "Shanghai", countryIso: "CN", lat: 31.1443, lon: 121.8083, timezone: "Asia/Shanghai" },
  { iata: "HKG", name: "Hong Kong International Airport", city: "Hong Kong", countryIso: "HK", lat: 22.3080, lon: 113.9185, timezone: "Asia/Hong_Kong", isPrimary: true },
  { iata: "TPE", name: "Taiwan Taoyuan International Airport", city: "Taipei", countryIso: "TW", lat: 25.0777, lon: 121.2328, timezone: "Asia/Taipei", isPrimary: true },
  { iata: "BKK", name: "Suvarnabhumi Airport", city: "Bangkok", countryIso: "TH", lat: 13.6900, lon: 100.7501, timezone: "Asia/Bangkok", isPrimary: true },
  { iata: "DMK", name: "Don Mueang International Airport", city: "Bangkok", countryIso: "TH", lat: 13.9126, lon: 100.6067, timezone: "Asia/Bangkok" },
  { iata: "HKT", name: "Phuket International Airport", city: "Phuket", countryIso: "TH", lat: 8.1132, lon: 98.3169, timezone: "Asia/Bangkok" },
  { iata: "CNX", name: "Chiang Mai International Airport", city: "Chiang Mai", countryIso: "TH", lat: 18.7669, lon: 98.9626, timezone: "Asia/Bangkok" },
  { iata: "SGN", name: "Tan Son Nhat International Airport", city: "Ho Chi Minh City", countryIso: "VN", lat: 10.8188, lon: 106.6520, timezone: "Asia/Ho_Chi_Minh", isPrimary: true },
  { iata: "HAN", name: "Noi Bai International Airport", city: "Hanoi", countryIso: "VN", lat: 21.2212, lon: 105.8072, timezone: "Asia/Ho_Chi_Minh" },
  { iata: "SIN", name: "Singapore Changi Airport", city: "Singapore", countryIso: "SG", lat: 1.3644, lon: 103.9915, timezone: "Asia/Singapore", isPrimary: true },
  { iata: "KUL", name: "Kuala Lumpur International Airport", city: "Kuala Lumpur", countryIso: "MY", lat: 2.7456, lon: 101.7099, timezone: "Asia/Kuala_Lumpur", isPrimary: true },
  { iata: "DPS", name: "Ngurah Rai International Airport", city: "Bali (Denpasar)", countryIso: "ID", lat: -8.7482, lon: 115.1672, timezone: "Asia/Makassar", isPrimary: true },
  { iata: "CGK", name: "Soekarno-Hatta International Airport", city: "Jakarta", countryIso: "ID", lat: -6.1256, lon: 106.6559, timezone: "Asia/Jakarta" },
  { iata: "MNL", name: "Ninoy Aquino International Airport", city: "Manila", countryIso: "PH", lat: 14.5086, lon: 121.0198, timezone: "Asia/Manila", isPrimary: true },
  { iata: "DEL", name: "Indira Gandhi International Airport", city: "Delhi", countryIso: "IN", lat: 28.5562, lon: 77.1000, timezone: "Asia/Kolkata", isPrimary: true },
  { iata: "BOM", name: "Chhatrapati Shivaji Maharaj International Airport", city: "Mumbai", countryIso: "IN", lat: 19.0896, lon: 72.8656, timezone: "Asia/Kolkata" },
  { iata: "GOI", name: "Goa International Airport", city: "Goa", countryIso: "IN", lat: 15.3808, lon: 73.8314, timezone: "Asia/Kolkata" },
  { iata: "KTM", name: "Tribhuvan International Airport", city: "Kathmandu", countryIso: "NP", lat: 27.6966, lon: 85.3591, timezone: "Asia/Kathmandu", isPrimary: true },
  { iata: "MLE", name: "Velana International Airport", city: "Malé", countryIso: "MV", lat: 4.1918, lon: 73.5290, timezone: "Indian/Maldives", isPrimary: true },
  { iata: "CMB", name: "Bandaranaike International Airport", city: "Colombo", countryIso: "LK", lat: 7.1808, lon: 79.8841, timezone: "Asia/Colombo", isPrimary: true },
  { iata: "TAS", name: "Tashkent International Airport", city: "Tashkent", countryIso: "UZ", lat: 41.2579, lon: 69.2812, timezone: "Asia/Tashkent", isPrimary: true },
  { iata: "ALA", name: "Almaty International Airport", city: "Almaty", countryIso: "KZ", lat: 43.3521, lon: 77.0405, timezone: "Asia/Almaty", isPrimary: true },

  // North America
  { iata: "JFK", name: "John F. Kennedy International Airport", city: "New York", countryIso: "US", lat: 40.6413, lon: -73.7781, timezone: "America/New_York", isPrimary: true },
  { iata: "EWR", name: "Newark Liberty International Airport", city: "Newark", countryIso: "US", lat: 40.6895, lon: -74.1745, timezone: "America/New_York" },
  { iata: "LGA", name: "LaGuardia Airport", city: "New York", countryIso: "US", lat: 40.7769, lon: -73.8740, timezone: "America/New_York" },
  { iata: "BOS", name: "Logan International Airport", city: "Boston", countryIso: "US", lat: 42.3656, lon: -71.0096, timezone: "America/New_York" },
  { iata: "MIA", name: "Miami International Airport", city: "Miami", countryIso: "US", lat: 25.7959, lon: -80.2870, timezone: "America/New_York" },
  { iata: "MCO", name: "Orlando International Airport", city: "Orlando", countryIso: "US", lat: 28.4312, lon: -81.3081, timezone: "America/New_York" },
  { iata: "ATL", name: "Hartsfield–Jackson Atlanta International Airport", city: "Atlanta", countryIso: "US", lat: 33.6407, lon: -84.4277, timezone: "America/New_York" },
  { iata: "ORD", name: "O'Hare International Airport", city: "Chicago", countryIso: "US", lat: 41.9742, lon: -87.9073, timezone: "America/Chicago" },
  { iata: "DFW", name: "Dallas/Fort Worth International Airport", city: "Dallas", countryIso: "US", lat: 32.8998, lon: -97.0403, timezone: "America/Chicago" },
  { iata: "IAH", name: "George Bush Intercontinental Airport", city: "Houston", countryIso: "US", lat: 29.9902, lon: -95.3368, timezone: "America/Chicago" },
  { iata: "DEN", name: "Denver International Airport", city: "Denver", countryIso: "US", lat: 39.8561, lon: -104.6737, timezone: "America/Denver" },
  { iata: "LAX", name: "Los Angeles International Airport", city: "Los Angeles", countryIso: "US", lat: 33.9416, lon: -118.4085, timezone: "America/Los_Angeles" },
  { iata: "SFO", name: "San Francisco International Airport", city: "San Francisco", countryIso: "US", lat: 37.6213, lon: -122.3790, timezone: "America/Los_Angeles" },
  { iata: "SEA", name: "Seattle–Tacoma International Airport", city: "Seattle", countryIso: "US", lat: 47.4502, lon: -122.3088, timezone: "America/Los_Angeles" },
  { iata: "LAS", name: "Harry Reid International Airport", city: "Las Vegas", countryIso: "US", lat: 36.0840, lon: -115.1537, timezone: "America/Los_Angeles" },
  { iata: "PHX", name: "Phoenix Sky Harbor International Airport", city: "Phoenix", countryIso: "US", lat: 33.4373, lon: -112.0078, timezone: "America/Phoenix" },
  { iata: "IAD", name: "Washington Dulles International Airport", city: "Washington, D.C.", countryIso: "US", lat: 38.9531, lon: -77.4565, timezone: "America/New_York" },
  { iata: "YYZ", name: "Toronto Pearson International Airport", city: "Toronto", countryIso: "CA", lat: 43.6777, lon: -79.6248, timezone: "America/Toronto", isPrimary: true },
  { iata: "YUL", name: "Montréal–Trudeau International Airport", city: "Montreal", countryIso: "CA", lat: 45.4706, lon: -73.7408, timezone: "America/Toronto" },
  { iata: "YVR", name: "Vancouver International Airport", city: "Vancouver", countryIso: "CA", lat: 49.1967, lon: -123.1815, timezone: "America/Vancouver" },
  { iata: "MEX", name: "Mexico City International Airport", city: "Mexico City", countryIso: "MX", lat: 19.4363, lon: -99.0721, timezone: "America/Mexico_City", isPrimary: true },
  { iata: "CUN", name: "Cancún International Airport", city: "Cancún", countryIso: "MX", lat: 21.0365, lon: -86.8771, timezone: "America/Cancun" },

  // South America
  { iata: "GRU", name: "São Paulo–Guarulhos International Airport", city: "São Paulo", countryIso: "BR", lat: -23.4356, lon: -46.4731, timezone: "America/Sao_Paulo", isPrimary: true },
  { iata: "GIG", name: "Rio de Janeiro–Galeão International Airport", city: "Rio de Janeiro", countryIso: "BR", lat: -22.8090, lon: -43.2436, timezone: "America/Sao_Paulo" },
  { iata: "EZE", name: "Ministro Pistarini International Airport", city: "Buenos Aires", countryIso: "AR", lat: -34.8222, lon: -58.5358, timezone: "America/Argentina/Buenos_Aires", isPrimary: true },
  { iata: "SCL", name: "Arturo Merino Benítez International Airport", city: "Santiago", countryIso: "CL", lat: -33.3930, lon: -70.7858, timezone: "America/Santiago", isPrimary: true },
  { iata: "LIM", name: "Jorge Chávez International Airport", city: "Lima", countryIso: "PE", lat: -12.0219, lon: -77.1143, timezone: "America/Lima", isPrimary: true },
  { iata: "BOG", name: "El Dorado International Airport", city: "Bogotá", countryIso: "CO", lat: 4.7016, lon: -74.1469, timezone: "America/Bogota", isPrimary: true },

  // Africa
  { iata: "JNB", name: "O. R. Tambo International Airport", city: "Johannesburg", countryIso: "ZA", lat: -26.1392, lon: 28.2460, timezone: "Africa/Johannesburg", isPrimary: true },
  { iata: "CPT", name: "Cape Town International Airport", city: "Cape Town", countryIso: "ZA", lat: -33.9715, lon: 18.6021, timezone: "Africa/Johannesburg" },
  { iata: "NBO", name: "Jomo Kenyatta International Airport", city: "Nairobi", countryIso: "KE", lat: -1.3192, lon: 36.9278, timezone: "Africa/Nairobi", isPrimary: true },
  { iata: "ADD", name: "Bole International Airport", city: "Addis Ababa", countryIso: "ET", lat: 8.9779, lon: 38.7993, timezone: "Africa/Addis_Ababa", isPrimary: true },
  { iata: "CMN", name: "Mohammed V International Airport", city: "Casablanca", countryIso: "MA", lat: 33.3675, lon: -7.5900, timezone: "Africa/Casablanca", isPrimary: true },
  { iata: "RAK", name: "Marrakesh Menara Airport", city: "Marrakesh", countryIso: "MA", lat: 31.6069, lon: -8.0363, timezone: "Africa/Casablanca" },
  { iata: "TUN", name: "Tunis–Carthage International Airport", city: "Tunis", countryIso: "TN", lat: 36.8510, lon: 10.2272, timezone: "Africa/Tunis", isPrimary: true },
  { iata: "ZNZ", name: "Abeid Amani Karume International Airport", city: "Zanzibar", countryIso: "TZ", lat: -6.2220, lon: 39.2249, timezone: "Africa/Dar_es_Salaam", isPrimary: true },
  { iata: "MRU", name: "Sir Seewoosagur Ramgoolam International Airport", city: "Mauritius", countryIso: "MU", lat: -20.4302, lon: 57.6836, timezone: "Indian/Mauritius", isPrimary: true },

  // Oceania
  { iata: "SYD", name: "Sydney Kingsford Smith Airport", city: "Sydney", countryIso: "AU", lat: -33.9399, lon: 151.1753, timezone: "Australia/Sydney", isPrimary: true },
  { iata: "MEL", name: "Melbourne Airport", city: "Melbourne", countryIso: "AU", lat: -37.6690, lon: 144.8410, timezone: "Australia/Melbourne" },
  { iata: "BNE", name: "Brisbane Airport", city: "Brisbane", countryIso: "AU", lat: -27.3942, lon: 153.1218, timezone: "Australia/Brisbane" },
  { iata: "PER", name: "Perth Airport", city: "Perth", countryIso: "AU", lat: -31.9403, lon: 115.9669, timezone: "Australia/Perth" },
  { iata: "AKL", name: "Auckland Airport", city: "Auckland", countryIso: "NZ", lat: -37.0082, lon: 174.7850, timezone: "Pacific/Auckland", isPrimary: true },
];

const AIRPORTS_BY_IATA: Record<string, AirportInfo> = Object.fromEntries(
  AIRPORTS.map((airport) => [airport.iata, airport])
);

export function findAirportByIata(iata: string): AirportInfo | null {
  return AIRPORTS_BY_IATA[iata.trim().toUpperCase()] ?? null;
}

/**
 * Israel, as the fixed home country for every trip this app plans (see
 * flight-planning.ts's HOME_COUNTRY_ISO_A2 — same value, kept as its own
 * constant here rather than imported, to avoid a circular import between
 * the two modules: flight-planning.ts already imports findAirportByIata
 * from this file).
 */
export const HOME_COUNTRY_ISO = "IL";

/** First (typically the main international) airport listed for a country — a reasonable smart default (spec item 8), still freely changeable by the user. */
export function findDefaultAirportForCountry(countryIso: string): AirportInfo | null {
  const normalized = countryIso.toUpperCase();
  const primary = AIRPORTS.find((airport) => airport.countryIso === normalized && airport.isPrimary);
  return primary ?? AIRPORTS.find((airport) => airport.countryIso === normalized) ?? null;
}

/** All airports for a country, primary gateway first (spec item 5's grouped-results display). */
export function findAirportsForCountry(countryIso: string): AirportInfo[] {
  const normalized = countryIso.toUpperCase();
  return AIRPORTS.filter((airport) => airport.countryIso === normalized).sort(
    (a, b) => (b.isPrimary ? 1 : 0) - (a.isPrimary ? 1 : 0)
  );
}

/** Airports physically in Israel — the only valid choices for "leaving Israel" (outbound origin) or "landing back in Israel" (return destination). */
export function getIsraeliAirports(): AirportInfo[] {
  return findAirportsForCountry(HOME_COUNTRY_ISO);
}

/**
 * Airports valid for a connection stop — deliberately the ONLY airport
 * field allowed to show any country (spec item 6), so this is just the
 * full dataset minus whichever airports are already used as this same
 * leg's own origin/destination (no point offering "connect through TLV"
 * when TLV is already the departure airport).
 */
export function getConnectionAirports(exclude: Array<string | null | undefined> = []): AirportInfo[] {
  const excluded = new Set(exclude.filter((iata): iata is string => Boolean(iata)).map((iata) => iata.toUpperCase()));
  return AIRPORTS.filter((airport) => !excluded.has(airport.iata));
}

/**
 * Search by city, airport name, or IATA code (spec item 9) — case-insensitive
 * substring match, IATA-exact matches ranked first. `pool` restricts the
 * search to a specific already-filtered list of candidate airports (e.g.
 * getIsraeliAirports(), findAirportsForCountry(iso)) — a country-restricted
 * dropdown's search box must never fall through to the global list just
 * because the query matches something outside it (spec item 9's own
 * explicit example: searching "TBS" in an Israel-only field must return
 * nothing, not silently ignore the restriction).
 */
export function searchAirports(query: string, options: { limit?: number; pool?: AirportInfo[] } = {}): AirportInfo[] {
  const { limit = 8, pool = AIRPORTS } = options;
  const normalized = query.trim().toLowerCase();
  if (!normalized) return pool.slice(0, limit);

  const matches = pool.filter(
    (airport) =>
      airport.iata.toLowerCase().includes(normalized) ||
      airport.city.toLowerCase().includes(normalized) ||
      airport.name.toLowerCase().includes(normalized)
  );

  matches.sort((a, b) => {
    const aExact = a.iata.toLowerCase() === normalized ? 0 : 1;
    const bExact = b.iata.toLowerCase() === normalized ? 0 : 1;
    if (aExact !== bExact) return aExact - bExact;
    const aStarts = a.city.toLowerCase().startsWith(normalized) ? 0 : 1;
    const bStarts = b.city.toLowerCase().startsWith(normalized) ? 0 : 1;
    if (aStarts !== bStarts) return aStarts - bStarts;
    return (b.isPrimary ? 1 : 0) - (a.isPrimary ? 1 : 0);
  });

  return matches.slice(0, limit);
}

/**
 * Server-side backstop (spec item 19 — "do not rely only on frontend
 * filtering"). Only rejects an airport we actually recognize and can place
 * in the wrong country; an airport missing from this curated (not
 * exhaustive) dataset is never rejected on that basis alone. Returns a
 * readable Hebrew message for the first violation found, or null when the
 * flights are consistent with the trip direction.
 */
export function validateFlightAirportCountries(
  flights: {
    outbound?: { departureAirport?: string | null; arrivalAirport?: string | null } | null;
    return?: { departureAirport?: string | null; arrivalAirport?: string | null } | null;
  } | null | undefined,
  destinationCountryIso: string
): string | null {
  if (!flights) return null;
  const destIso = destinationCountryIso.trim().toUpperCase();

  function airportInWrongCountry(iata: string | null | undefined, expectedIso: string): AirportInfo | null {
    if (!iata) return null;
    const airport = findAirportByIata(iata);
    if (!airport || airport.countryIso === expectedIso) return null;
    return airport;
  }

  const outboundOrigin = airportInWrongCountry(flights.outbound?.departureAirport, HOME_COUNTRY_ISO);
  if (outboundOrigin) {
    return `שדה התעופה ליציאה בטיסת ההלוך (${outboundOrigin.iata}) נמצא ב${COUNTRY_NAMES_HE[outboundOrigin.countryIso] ?? outboundOrigin.countryIso}, אך על טיסת ההלוך לצאת מישראל.`;
  }
  const outboundDestination = airportInWrongCountry(flights.outbound?.arrivalAirport, destIso);
  if (outboundDestination) {
    return `שדה התעופה ביעד בטיסת ההלוך (${outboundDestination.iata}) נמצא ב${COUNTRY_NAMES_HE[outboundDestination.countryIso] ?? outboundDestination.countryIso}, אך על טיסת ההלוך לנחות במדינת היעד.`;
  }
  const returnOrigin = airportInWrongCountry(flights.return?.departureAirport, destIso);
  if (returnOrigin) {
    return `שדה התעופה ליציאה בטיסת החזור (${returnOrigin.iata}) נמצא ב${COUNTRY_NAMES_HE[returnOrigin.countryIso] ?? returnOrigin.countryIso}, אך על טיסת החזור לצאת ממדינת היעד.`;
  }
  const returnDestination = airportInWrongCountry(flights.return?.arrivalAirport, HOME_COUNTRY_ISO);
  if (returnDestination) {
    return `שדה התעופה בנחיתה בטיסת החזור (${returnDestination.iata}) נמצא ב${COUNTRY_NAMES_HE[returnDestination.countryIso] ?? returnDestination.countryIso}, אך על טיסת החזור לנחות בישראל.`;
  }

  return null;
}
