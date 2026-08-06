import { GoogleGenAI, Type } from "@google/genai";
import { NextResponse } from "next/server";

import {
  hasRichCountryAiRecommendation,
  normalizeCountryAiRecommendation,
  type CountryAiRecommendation,
} from "@/lib/ai/country-knowledge";
import { createClient } from "@/lib/supabase/server";

const MODEL = "gemini-flash-lite-latest";

function stringField(description: string) {
  return { type: Type.STRING, description };
}

function numberField(description: string) {
  return { type: Type.NUMBER, description };
}

function stringArrayField(description: string, itemDescription: string) {
  return {
    type: Type.ARRAY,
    description,
    items: stringField(itemDescription),
  };
}

function objectArrayField(description: string, items: Record<string, unknown>) {
  return {
    type: Type.ARRAY,
    description,
    items,
  };
}

const LOCATION_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    label: stringField("Name of the city, region, or map label in Hebrew."),
    lat: numberField("Approximate latitude when known."),
    lon: numberField("Approximate longitude when known."),
  },
  required: ["label"],
};

const TIMELINE_ENTRY_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    year: stringField("Year or period in Hebrew numerals/text."),
    event: stringField("The event and why it mattered, in Hebrew."),
  },
  required: ["year", "event"],
};

const NAMED_NOTE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    name: stringField("Name in Hebrew or standard local transliteration as commonly used in Hebrew."),
    note: stringField("Short explanation in Hebrew."),
  },
  required: ["name", "note"],
};

const DESTINATION_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    name: stringField("Destination name in Hebrew."),
    photoQuery: stringField("A concise search query for finding a representative photo."),
    shortDescription: stringField("One sentence on what this place is."),
    whyVisit: stringField("Why it is worth visiting."),
    estimatedVisitDuration: stringField("Typical visit length."),
    bestSeason: stringField("Best season or months."),
    entryPrice: stringField("Entry price if relevant, or state that it is free/not applicable."),
    location: LOCATION_SCHEMA,
  },
  required: [
    "name",
    "photoQuery",
    "shortDescription",
    "whyVisit",
    "estimatedVisitDuration",
    "bestSeason",
    "entryPrice",
    "location",
  ],
};

const ATTRACTION_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    name: stringField("Attraction name in Hebrew."),
    shortDescription: stringField("One sentence describing the attraction."),
    rating: numberField("A realistic visitor score between 1 and 10."),
    popularity: stringField("High, medium, niche, or equivalent in Hebrew."),
    estimatedDuration: stringField("How long most visitors spend there."),
    openingHours: stringField("Typical opening hours or say that they vary."),
    averageTicketPrice: stringField("Average ticket price or state that it is free."),
    coordinates: LOCATION_SCHEMA,
    familyFriendly: stringField("How family-friendly it is."),
    wheelchairAccessibility: stringField("Accessibility level in Hebrew."),
    officialWebsite: stringField("Official website URL when available, otherwise empty string."),
  },
  required: [
    "name",
    "shortDescription",
    "rating",
    "popularity",
    "estimatedDuration",
    "openingHours",
    "averageTicketPrice",
    "coordinates",
    "familyFriendly",
    "wheelchairAccessibility",
    "officialWebsite",
  ],
};

const ATTRACTION_CATEGORY_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    category: stringField("One attraction category in Hebrew."),
    attractions: objectArrayField("Two or three strong examples in this category.", ATTRACTION_SCHEMA),
  },
  required: ["category", "attractions"],
};

const CITY_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    name: stringField("City name in Hebrew."),
    population: stringField("Approximate population."),
    knownFor: stringField("What the city is best known for."),
    recommendedStay: stringField("Suggested stay length."),
    highlights: stringArrayField("Top highlights in the city.", "One highlight in Hebrew."),
    nearbyAttractions: stringArrayField("Nearby attractions worth adding.", "One nearby attraction in Hebrew."),
  },
  required: ["name", "population", "knownFor", "recommendedStay", "highlights", "nearbyAttractions"],
};

const ITINERARY_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    days: numberField("Trip length in days."),
    title: stringField("A short itinerary name in Hebrew."),
    route: stringArrayField("Main route or base cities in order.", "One stop in Hebrew."),
    attractions: stringArrayField("Key places included in this plan.", "One attraction in Hebrew."),
    estimatedTravelTime: stringField("General travel-time note for this itinerary."),
    suggestedHotels: stringArrayField("Two or three hotel areas or hotel suggestions.", "One hotel or area in Hebrew."),
    restaurants: stringArrayField("Two or three restaurant ideas or food areas.", "One restaurant or area in Hebrew."),
    dailyBudget: stringField("Estimated daily budget."),
  },
  required: [
    "days",
    "title",
    "route",
    "attractions",
    "estimatedTravelTime",
    "suggestedHotels",
    "restaurants",
    "dailyBudget",
  ],
};

const MONTH_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    month: stringField("Month name in Hebrew."),
    weather: stringField("One sentence on typical weather."),
    averageTemperature: stringField("Typical temperature range."),
    rainfall: stringField("Typical rainfall or humidity note."),
    tourismLevel: stringField("Tourism level in Hebrew."),
    prices: stringField("Price level in Hebrew."),
    recommendedActivities: stringArrayField("Activities that fit this month.", "One activity in Hebrew."),
  },
  required: ["month", "weather", "averageTemperature", "rainfall", "tourismLevel", "prices", "recommendedActivities"],
};

const AIRPORT_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    name: stringField("Airport name in Hebrew."),
    city: stringField("Associated city."),
    notes: stringField("Short traveler note."),
  },
  required: ["name", "city", "notes"],
};

const BUDGET_TIER_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    hotel: stringField("Hotel spend per day."),
    food: stringField("Food spend per day."),
    attractions: stringField("Attractions spend per day."),
    transportation: stringField("Transportation spend per day."),
    totalPerDay: stringField("Total estimated spend per day."),
  },
  required: ["hotel", "food", "attractions", "transportation", "totalPerDay"],
};

const RECOMMENDATION_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    about: stringField("A short engaging paragraph on the country itself, in Hebrew."),
    summary: stringField("A crisp two-sentence traveler summary in Hebrew."),
    highlights: stringArrayField("Four to six top highlights.", "One highlight in Hebrew."),
    food: stringArrayField("Three to five food items worth trying.", "One dish or food experience in Hebrew."),
    bestTimeToVisit: stringField("One or two sentences on the best time to visit."),
    tips: stringArrayField("Three to five practical travel tips.", "One practical tip in Hebrew."),
    overview: {
      type: Type.OBJECT,
      properties: {
        shortSummary: stringField("A two- or three-sentence summary."),
        longOverview: stringArrayField(
          "Exactly five short paragraphs covering history, culture, geography, society, and travel appeal.",
          "One paragraph in Hebrew."
        ),
        whyFamous: stringField("Why the country is famous."),
        whatMakesItUnique: stringField("What makes the country stand out."),
        bestReasonsToVisit: stringArrayField("Top reasons to visit.", "One reason in Hebrew."),
        firstImpressions: stringArrayField("Interesting first impressions for new visitors.", "One impression in Hebrew."),
      },
      required: [
        "shortSummary",
        "longOverview",
        "whyFamous",
        "whatMakesItUnique",
        "bestReasonsToVisit",
        "firstImpressions",
      ],
    },
    history: {
      type: Type.OBJECT,
      properties: {
        ancientHistory: stringField("Ancient history summary."),
        majorHistoricalEvents: stringArrayField("Major historical events.", "One event in Hebrew."),
        timeline: objectArrayField("A timeline of key dates.", TIMELINE_ENTRY_SCHEMA),
        kingdomsAndEmpires: stringArrayField("Important kingdoms and empires.", "One kingdom or empire in Hebrew."),
        independence: stringField("How independence emerged."),
        modernHistory: stringField("Modern history overview."),
        shapingWars: stringArrayField("Wars or conflicts that shaped the country.", "One war or conflict in Hebrew."),
        historicalFigures: objectArrayField("Historical figures tied to the country.", NAMED_NOTE_SCHEMA),
      },
      required: [
        "ancientHistory",
        "majorHistoricalEvents",
        "timeline",
        "kingdomsAndEmpires",
        "independence",
        "modernHistory",
        "shapingWars",
        "historicalFigures",
      ],
    },
    geography: {
      type: Type.OBJECT,
      properties: {
        totalArea: stringField("Total area."),
        borders: stringArrayField("Neighboring countries or border notes.", "One border note in Hebrew."),
        highestMountain: stringField("Highest mountain."),
        longestRiver: stringField("Longest river."),
        largestLakes: stringArrayField("Largest lakes.", "One lake in Hebrew."),
        islands: stringArrayField("Important islands if relevant.", "One island in Hebrew."),
        deserts: stringArrayField("Deserts if relevant.", "One desert in Hebrew."),
        forests: stringArrayField("Important forests or forest regions.", "One forest area in Hebrew."),
        nationalParks: stringArrayField("Notable national parks.", "One park in Hebrew."),
        climateZones: stringArrayField("Climate zones.", "One climate zone in Hebrew."),
        earthquakesAndVolcanoes: stringField("Earthquakes, volcanoes, or geological notes when relevant."),
      },
      required: [
        "totalArea",
        "borders",
        "highestMountain",
        "longestRiver",
        "largestLakes",
        "islands",
        "deserts",
        "forests",
        "nationalParks",
        "climateZones",
        "earthquakesAndVolcanoes",
      ],
    },
    peopleCulture: {
      type: Type.OBJECT,
      properties: {
        population: stringField("Population."),
        ethnicGroups: stringArrayField("Major ethnic groups.", "One group in Hebrew."),
        languages: stringArrayField("Languages used in the country.", "One language in Hebrew."),
        religions: stringArrayField("Major religions or belief systems.", "One religion in Hebrew."),
        traditions: stringArrayField("Important traditions.", "One tradition in Hebrew."),
        customs: stringArrayField("Useful customs for visitors.", "One custom in Hebrew."),
        nationalValues: stringArrayField("Values associated with the country.", "One value in Hebrew."),
        hospitality: stringField("Hospitality style."),
        dailyLife: stringField("Daily life snapshot."),
        familyCulture: stringField("Family and social culture."),
        festivals: stringArrayField("Major festivals.", "One festival in Hebrew."),
        nationalHolidays: stringArrayField("National holidays.", "One holiday in Hebrew."),
        traditionalClothing: stringField("Traditional clothing overview."),
      },
      required: [
        "population",
        "ethnicGroups",
        "languages",
        "religions",
        "traditions",
        "customs",
        "nationalValues",
        "hospitality",
        "dailyLife",
        "familyCulture",
        "festivals",
        "nationalHolidays",
        "traditionalClothing",
      ],
    },
    foodGuide: {
      type: Type.OBJECT,
      properties: {
        nationalDishes: stringArrayField("Core national dishes.", "One dish in Hebrew."),
        streetFood: stringArrayField("Street food items.", "One item in Hebrew."),
        famousDesserts: stringArrayField("Famous desserts.", "One dessert in Hebrew."),
        drinks: stringArrayField("Drinks to try.", "One drink in Hebrew."),
        localSpecialties: stringArrayField("Regional specialties.", "One specialty in Hebrew."),
        foodEtiquette: stringArrayField("Food etiquette tips.", "One etiquette point in Hebrew."),
        typicalMealPrices: {
          type: Type.OBJECT,
          properties: {
            streetFood: stringField("Street-food price range."),
            casualMeal: stringField("Casual meal price range."),
            dinnerForTwo: stringField("Dinner for two price range."),
          },
          required: ["streetFood", "casualMeal", "dinnerForTwo"],
        },
        vegetarianVeganFriendliness: stringField("How easy it is for vegetarian and vegan travelers."),
      },
      required: [
        "nationalDishes",
        "streetFood",
        "famousDesserts",
        "drinks",
        "localSpecialties",
        "foodEtiquette",
        "typicalMealPrices",
        "vegetarianVeganFriendliness",
      ],
    },
    topDestinations: objectArrayField(
      "Exactly ten recommended destinations around the country.",
      DESTINATION_SCHEMA
    ),
    topAttractions: objectArrayField(
      "Six to eight attraction categories with two or three attractions each.",
      ATTRACTION_CATEGORY_SCHEMA
    ),
    cities: objectArrayField("Five to eight major cities.", CITY_SCHEMA),
    itineraryIdeas: objectArrayField(
      "Exactly six itinerary ideas for 2, 3, 5, 7, 10, and 14 days.",
      ITINERARY_SCHEMA
    ),
    bestTime: {
      type: Type.OBJECT,
      properties: {
        summary: stringField("General seasonality summary."),
        bestSeason: stringField("Best season."),
        cheapestSeason: stringField("Cheapest season."),
        avoidSeason: stringField("Season to avoid if relevant."),
        months: objectArrayField("Exactly twelve monthly entries.", MONTH_SCHEMA),
      },
      required: ["summary", "bestSeason", "cheapestSeason", "avoidSeason", "months"],
    },
    transportation: {
      type: Type.OBJECT,
      properties: {
        airports: objectArrayField("Key international or useful domestic airports.", AIRPORT_SCHEMA),
        domesticFlights: stringField("Domestic flight situation."),
        trains: stringField("Train network overview."),
        metro: stringField("Metro or urban rail availability."),
        buses: stringField("Bus network overview."),
        taxis: stringField("Taxi usage and pricing notes."),
        rideHailing: stringField("Uber, Bolt, or local alternatives."),
        carRental: stringField("Car-rental practicality."),
        drivingRules: stringField("Main driving rules a traveler should know."),
        fuelPrices: stringField("Typical fuel-price guidance."),
        roadQuality: stringField("Road quality overview."),
      },
      required: [
        "airports",
        "domesticFlights",
        "trains",
        "metro",
        "buses",
        "taxis",
        "rideHailing",
        "carRental",
        "drivingRules",
        "fuelPrices",
        "roadQuality",
      ],
    },
    budgetGuide: {
      type: Type.OBJECT,
      properties: {
        backpacker: BUDGET_TIER_SCHEMA,
        midRange: BUDGET_TIER_SCHEMA,
        luxury: BUDGET_TIER_SCHEMA,
      },
      required: ["backpacker", "midRange", "luxury"],
    },
    safety: {
      type: Type.OBJECT,
      properties: {
        overallSafetyScore: numberField("A realistic score from 1 to 10."),
        crimeLevel: stringField("Crime level in Hebrew."),
        touristScams: stringArrayField("Common tourist scams.", "One scam in Hebrew."),
        dangerousNeighborhoods: stringArrayField(
          "Areas travelers should be careful in; if none are well known, say so.",
          "One area or note in Hebrew."
        ),
        safeNeighborhoods: stringArrayField("Areas generally considered safer.", "One area or note in Hebrew."),
        naturalHazards: stringArrayField("Natural hazards travelers should know.", "One hazard in Hebrew."),
        emergencyNumbers: stringArrayField("Relevant emergency numbers.", "One number with label in Hebrew."),
        healthRecommendations: stringArrayField("Health recommendations.", "One health note in Hebrew."),
        soloTravelSafety: stringField("Solo-travel guidance."),
        womenSafety: stringField("Safety note for women travelers."),
        nightSafety: stringField("Night-safety guidance."),
      },
      required: [
        "overallSafetyScore",
        "crimeLevel",
        "touristScams",
        "dangerousNeighborhoods",
        "safeNeighborhoods",
        "naturalHazards",
        "emergencyNumbers",
        "healthRecommendations",
        "soloTravelSafety",
        "womenSafety",
        "nightSafety",
      ],
    },
    practicalInformation: {
      type: Type.OBJECT,
      properties: {
        visaRequirements: stringField("Short visa note for most travelers."),
        passportValidity: stringField("Passport validity guidance."),
        currency: stringField("Currency and symbol."),
        exchangeTips: stringArrayField("Useful exchange tips.", "One tip in Hebrew."),
        simCards: stringField("SIM and eSIM guidance."),
        internetQuality: stringField("Internet quality and coverage."),
        electricalPlugs: stringField("Plug types and voltage."),
        timeZone: stringField("Time-zone guidance."),
        emergencyNumbers: stringArrayField("Practical emergency numbers.", "One number with label in Hebrew."),
        waterSafety: stringField("General water safety."),
        tapWater: stringField("Tap-water note."),
        healthcare: stringField("Healthcare availability note."),
        tippingCulture: stringField("Tipping culture."),
        smokingLaws: stringField("Smoking-law summary."),
        alcoholLaws: stringField("Alcohol-law summary."),
      },
      required: [
        "visaRequirements",
        "passportValidity",
        "currency",
        "exchangeTips",
        "simCards",
        "internetQuality",
        "electricalPlugs",
        "timeZone",
        "emergencyNumbers",
        "waterSafety",
        "tapWater",
        "healthcare",
        "tippingCulture",
        "smokingLaws",
        "alcoholLaws",
      ],
    },
  },
  required: [
    "about",
    "summary",
    "highlights",
    "food",
    "bestTimeToVisit",
    "tips",
    "overview",
    "history",
    "geography",
    "peopleCulture",
    "foodGuide",
    "topDestinations",
    "topAttractions",
    "cities",
    "itineraryIdeas",
    "bestTime",
    "transportation",
    "budgetGuide",
    "safety",
    "practicalInformation",
  ],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function generateRecommendation(countryName: string): Promise<CountryAiRecommendation> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not configured");
  }

  const client = new GoogleGenAI({ apiKey });
  const response = await client.models.generateContent({
    model: MODEL,
    contents: `You are creating a structured country knowledge hub for ${countryName} for a Hebrew-speaking traveler.

Return JSON only.
Write all narrative text in natural Hebrew.
Numbers may stay numeric, and official website URLs may stay in Latin characters.
Be information-dense but concise: most fields should be one sentence or a short phrase, not long essays.
Avoid empty values unless something is genuinely unavailable.

Important output rules:
- "overview.longOverview" must contain exactly 5 short paragraphs.
- "topDestinations" must contain exactly 10 destinations.
- "itineraryIdeas" must contain exactly 6 entries for 2, 3, 5, 7, 10, and 14 days.
- "bestTime.months" must contain exactly 12 entries from ינואר through דצמבר.
- "topAttractions" should contain 6 to 8 relevant categories, each with 2 or 3 attractions.
- Keep descriptions grounded, realistic, and useful for travel planning and general learning.
- Include approximate coordinates when they are commonly known.
- If a category is not very relevant to the country, replace it with another strong category instead of forcing weak content.`,
    config: {
      responseMimeType: "application/json",
      responseSchema: RECOMMENDATION_SCHEMA,
    },
  });

  const raw = response.text;
  if (!raw) throw new Error("Empty response from Gemini");
  return normalizeCountryAiRecommendation(JSON.parse(raw), countryName);
}

const ARABIC_SCRIPT_PATTERN = /[؀-ۿ]/;

function collectStrings(value: unknown, output: string[]) {
  if (typeof value === "string") {
    output.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, output);
    return;
  }
  if (isRecord(value)) {
    for (const item of Object.values(value)) collectStrings(item, output);
  }
}

function hasStrayArabicScript(content: CountryAiRecommendation): boolean {
  const values: string[] = [];
  collectStrings(content, values);
  return values.some((value) => ARABIC_SCRIPT_PATTERN.test(value));
}

async function generateCleanRecommendation(countryName: string): Promise<CountryAiRecommendation> {
  const maxAttempts = 3;
  let content = await generateRecommendation(countryName);
  for (let attempt = 1; attempt < maxAttempts && hasStrayArabicScript(content); attempt += 1) {
    content = await generateRecommendation(countryName);
  }
  return content;
}

export async function POST(request: Request) {
  let body: { isoA2?: string; countryName?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const { countryName } = body;
  const isoA2 = body.isoA2?.toUpperCase();
  if (!isoA2 || !countryName) {
    return NextResponse.json({ error: "isoA2 and countryName are required" }, { status: 400 });
  }

  const supabase = await createClient();

  const { data: cached, error: cacheError } = await supabase
    .from("ai_recommendations")
    .select("*")
    .eq("iso_a2", isoA2)
    .maybeSingle();
  if (cacheError) {
    return NextResponse.json({ error: cacheError.message }, { status: 500 });
  }

  if (hasRichCountryAiRecommendation(cached?.content)) {
    return NextResponse.json({
      content: normalizeCountryAiRecommendation(cached?.content, countryName),
      cached: true,
    });
  }

  let content: CountryAiRecommendation;
  try {
    content = await generateCleanRecommendation(countryName);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to generate recommendation";
    return NextResponse.json({ error: message }, { status: 502 });
  }

  const { error: writeError } = await supabase
    .from("ai_recommendations")
    .upsert({ iso_a2: isoA2, content, model: MODEL }, { onConflict: "iso_a2" });
  if (writeError) {
    return NextResponse.json({ content, cached: false, cacheWriteFailed: true });
  }

  return NextResponse.json({ content, cached: false });
}
