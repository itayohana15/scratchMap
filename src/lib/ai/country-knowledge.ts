export interface CountryTimelineEntry {
  year: string;
  event: string;
}

export interface CountryNamedNote {
  name: string;
  note: string;
}

export interface CountryLocationPoint {
  label: string;
  lat: number | null;
  lon: number | null;
}

export interface CountryOverviewHub {
  shortSummary: string;
  longOverview: string[];
  whyFamous: string;
  whatMakesItUnique: string;
  bestReasonsToVisit: string[];
  firstImpressions: string[];
}

export interface CountryHistoryHub {
  ancientHistory: string;
  majorHistoricalEvents: string[];
  timeline: CountryTimelineEntry[];
  kingdomsAndEmpires: string[];
  independence: string;
  modernHistory: string;
  shapingWars: string[];
  historicalFigures: CountryNamedNote[];
}

export interface CountryGeographyHub {
  totalArea: string;
  borders: string[];
  highestMountain: string;
  longestRiver: string;
  largestLakes: string[];
  islands: string[];
  deserts: string[];
  forests: string[];
  nationalParks: string[];
  climateZones: string[];
  earthquakesAndVolcanoes: string;
}

export interface CountryPeopleCultureHub {
  population: string;
  ethnicGroups: string[];
  languages: string[];
  religions: string[];
  traditions: string[];
  customs: string[];
  nationalValues: string[];
  hospitality: string;
  dailyLife: string;
  familyCulture: string;
  festivals: string[];
  nationalHolidays: string[];
  traditionalClothing: string;
}

export interface CountryMealPriceGuide {
  streetFood: string;
  casualMeal: string;
  dinnerForTwo: string;
}

export interface CountryFoodHub {
  nationalDishes: string[];
  streetFood: string[];
  famousDesserts: string[];
  drinks: string[];
  localSpecialties: string[];
  foodEtiquette: string[];
  typicalMealPrices: CountryMealPriceGuide;
  vegetarianVeganFriendliness: string;
}

export interface CountryDestination {
  name: string;
  photoQuery: string;
  shortDescription: string;
  whyVisit: string;
  estimatedVisitDuration: string;
  bestSeason: string;
  entryPrice: string;
  location: CountryLocationPoint;
}

export interface CountryAttraction {
  name: string;
  shortDescription: string;
  rating: number | null;
  popularity: string;
  estimatedDuration: string;
  openingHours: string;
  averageTicketPrice: string;
  coordinates: CountryLocationPoint;
  familyFriendly: string;
  wheelchairAccessibility: string;
  officialWebsite: string | null;
}

export interface CountryAttractionCategory {
  category: string;
  attractions: CountryAttraction[];
}

export interface CountryCityGuide {
  name: string;
  population: string;
  knownFor: string;
  recommendedStay: string;
  highlights: string[];
  nearbyAttractions: string[];
}

export interface CountryItineraryIdea {
  days: number;
  title: string;
  route: string[];
  attractions: string[];
  estimatedTravelTime: string;
  suggestedHotels: string[];
  restaurants: string[];
  dailyBudget: string;
}

export interface CountryMonthlyGuide {
  month: string;
  weather: string;
  averageTemperature: string;
  rainfall: string;
  tourismLevel: string;
  prices: string;
  recommendedActivities: string[];
}

export interface CountryBestTimeHub {
  summary: string;
  bestSeason: string;
  cheapestSeason: string;
  avoidSeason: string;
  months: CountryMonthlyGuide[];
}

export interface CountryAirportInfo {
  name: string;
  city: string;
  notes: string;
}

export interface CountryTransportationHub {
  airports: CountryAirportInfo[];
  domesticFlights: string;
  trains: string;
  metro: string;
  buses: string;
  taxis: string;
  rideHailing: string;
  carRental: string;
  drivingRules: string;
  fuelPrices: string;
  roadQuality: string;
}

export interface CountryBudgetTier {
  hotel: string;
  food: string;
  attractions: string;
  transportation: string;
  totalPerDay: string;
}

export interface CountryBudgetGuide {
  backpacker: CountryBudgetTier;
  midRange: CountryBudgetTier;
  luxury: CountryBudgetTier;
}

export interface CountrySafetyHub {
  overallSafetyScore: number | null;
  crimeLevel: string;
  touristScams: string[];
  dangerousNeighborhoods: string[];
  safeNeighborhoods: string[];
  naturalHazards: string[];
  emergencyNumbers: string[];
  healthRecommendations: string[];
  soloTravelSafety: string;
  womenSafety: string;
  nightSafety: string;
}

export interface CountryPracticalInformationHub {
  visaRequirements: string;
  passportValidity: string;
  currency: string;
  exchangeTips: string[];
  simCards: string;
  internetQuality: string;
  electricalPlugs: string;
  timeZone: string;
  emergencyNumbers: string[];
  waterSafety: string;
  tapWater: string;
  healthcare: string;
  tippingCulture: string;
  smokingLaws: string;
  alcoholLaws: string;
}

export interface CountryAiRecommendation {
  about: string;
  summary: string;
  highlights: string[];
  food: string[];
  bestTimeToVisit: string;
  tips: string[];
  overview: CountryOverviewHub;
  history: CountryHistoryHub;
  geography: CountryGeographyHub;
  peopleCulture: CountryPeopleCultureHub;
  foodGuide: CountryFoodHub;
  topDestinations: CountryDestination[];
  topAttractions: CountryAttractionCategory[];
  cities: CountryCityGuide[];
  itineraryIdeas: CountryItineraryIdea[];
  bestTime: CountryBestTimeHub;
  transportation: CountryTransportationHub;
  budgetGuide: CountryBudgetGuide;
  safety: CountrySafetyHub;
  practicalInformation: CountryPracticalInformationHub;
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function toTextArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(toText).filter(Boolean);
}

function toRecordArray(value: unknown): JsonRecord[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord);
}

function emptyLocation(): CountryLocationPoint {
  return { label: "", lat: null, lon: null };
}

function normalizeTimelineEntry(value: unknown): CountryTimelineEntry {
  const record = isRecord(value) ? value : {};
  return {
    year: toText(record.year),
    event: toText(record.event),
  };
}

function normalizeNamedNote(value: unknown): CountryNamedNote {
  const record = isRecord(value) ? value : {};
  return {
    name: toText(record.name),
    note: toText(record.note) || toText(record.description),
  };
}

function normalizeLocation(value: unknown): CountryLocationPoint {
  const record = isRecord(value) ? value : {};
  return {
    label: toText(record.label) || toText(record.name) || toText(record.city),
    lat: toNumber(record.lat),
    lon: toNumber(record.lon),
  };
}

function normalizeMealPrices(value: unknown): CountryMealPriceGuide {
  const record = isRecord(value) ? value : {};
  return {
    streetFood: toText(record.streetFood),
    casualMeal: toText(record.casualMeal),
    dinnerForTwo: toText(record.dinnerForTwo),
  };
}

function normalizeDestination(value: unknown, countryName: string): CountryDestination {
  const record = isRecord(value) ? value : {};
  const name = toText(record.name);
  const location = normalizeLocation(record.location);

  return {
    name,
    photoQuery: toText(record.photoQuery) || [name, countryName].filter(Boolean).join(" "),
    shortDescription: toText(record.shortDescription),
    whyVisit: toText(record.whyVisit),
    estimatedVisitDuration: toText(record.estimatedVisitDuration),
    bestSeason: toText(record.bestSeason),
    entryPrice: toText(record.entryPrice),
    location: {
      ...emptyLocation(),
      ...location,
      label: location.label || name,
    },
  };
}

function normalizeAttraction(value: unknown): CountryAttraction {
  const record = isRecord(value) ? value : {};
  return {
    name: toText(record.name),
    shortDescription: toText(record.shortDescription),
    rating: toNumber(record.rating),
    popularity: toText(record.popularity),
    estimatedDuration: toText(record.estimatedDuration),
    openingHours: toText(record.openingHours),
    averageTicketPrice: toText(record.averageTicketPrice),
    coordinates: {
      ...emptyLocation(),
      ...normalizeLocation(record.coordinates),
    },
    familyFriendly: toText(record.familyFriendly),
    wheelchairAccessibility: toText(record.wheelchairAccessibility),
    officialWebsite: toText(record.officialWebsite) || null,
  };
}

function normalizeAttractionCategory(value: unknown): CountryAttractionCategory {
  const record = isRecord(value) ? value : {};
  return {
    category: toText(record.category),
    attractions: toRecordArray(record.attractions)
      .map(normalizeAttraction)
      .filter((item) => item.name),
  };
}

function normalizeCity(value: unknown): CountryCityGuide {
  const record = isRecord(value) ? value : {};
  return {
    name: toText(record.name),
    population: toText(record.population),
    knownFor: toText(record.knownFor),
    recommendedStay: toText(record.recommendedStay),
    highlights: toTextArray(record.highlights),
    nearbyAttractions: toTextArray(record.nearbyAttractions),
  };
}

function normalizeItinerary(value: unknown): CountryItineraryIdea {
  const record = isRecord(value) ? value : {};
  return {
    days: toNumber(record.days) ?? 0,
    title: toText(record.title),
    route: toTextArray(record.route),
    attractions: toTextArray(record.attractions),
    estimatedTravelTime: toText(record.estimatedTravelTime),
    suggestedHotels: toTextArray(record.suggestedHotels),
    restaurants: toTextArray(record.restaurants),
    dailyBudget: toText(record.dailyBudget),
  };
}

function normalizeMonth(value: unknown): CountryMonthlyGuide {
  const record = isRecord(value) ? value : {};
  return {
    month: toText(record.month),
    weather: toText(record.weather),
    averageTemperature: toText(record.averageTemperature),
    rainfall: toText(record.rainfall),
    tourismLevel: toText(record.tourismLevel),
    prices: toText(record.prices),
    recommendedActivities: toTextArray(record.recommendedActivities),
  };
}

function normalizeAirport(value: unknown): CountryAirportInfo {
  const record = isRecord(value) ? value : {};
  return {
    name: toText(record.name),
    city: toText(record.city),
    notes: toText(record.notes),
  };
}

function normalizeOverview(value: unknown): CountryOverviewHub {
  const record = isRecord(value) ? value : {};
  return {
    shortSummary: toText(record.shortSummary),
    longOverview: toTextArray(record.longOverview),
    whyFamous: toText(record.whyFamous),
    whatMakesItUnique: toText(record.whatMakesItUnique),
    bestReasonsToVisit: toTextArray(record.bestReasonsToVisit),
    firstImpressions: toTextArray(record.firstImpressions),
  };
}

function normalizeHistory(value: unknown): CountryHistoryHub {
  const record = isRecord(value) ? value : {};
  return {
    ancientHistory: toText(record.ancientHistory),
    majorHistoricalEvents: toTextArray(record.majorHistoricalEvents),
    timeline: toRecordArray(record.timeline)
      .map(normalizeTimelineEntry)
      .filter((item) => item.year || item.event),
    kingdomsAndEmpires: toTextArray(record.kingdomsAndEmpires),
    independence: toText(record.independence),
    modernHistory: toText(record.modernHistory),
    shapingWars: toTextArray(record.shapingWars),
    historicalFigures: toRecordArray(record.historicalFigures)
      .map(normalizeNamedNote)
      .filter((item) => item.name),
  };
}

function normalizeGeography(value: unknown): CountryGeographyHub {
  const record = isRecord(value) ? value : {};
  return {
    totalArea: toText(record.totalArea),
    borders: toTextArray(record.borders),
    highestMountain: toText(record.highestMountain),
    longestRiver: toText(record.longestRiver),
    largestLakes: toTextArray(record.largestLakes),
    islands: toTextArray(record.islands),
    deserts: toTextArray(record.deserts),
    forests: toTextArray(record.forests),
    nationalParks: toTextArray(record.nationalParks),
    climateZones: toTextArray(record.climateZones),
    earthquakesAndVolcanoes: toText(record.earthquakesAndVolcanoes),
  };
}

function normalizePeopleCulture(value: unknown): CountryPeopleCultureHub {
  const record = isRecord(value) ? value : {};
  return {
    population: toText(record.population),
    ethnicGroups: toTextArray(record.ethnicGroups),
    languages: toTextArray(record.languages),
    religions: toTextArray(record.religions),
    traditions: toTextArray(record.traditions),
    customs: toTextArray(record.customs),
    nationalValues: toTextArray(record.nationalValues),
    hospitality: toText(record.hospitality),
    dailyLife: toText(record.dailyLife),
    familyCulture: toText(record.familyCulture),
    festivals: toTextArray(record.festivals),
    nationalHolidays: toTextArray(record.nationalHolidays),
    traditionalClothing: toText(record.traditionalClothing),
  };
}

function normalizeFoodGuide(value: unknown): CountryFoodHub {
  const record = isRecord(value) ? value : {};
  return {
    nationalDishes: toTextArray(record.nationalDishes),
    streetFood: toTextArray(record.streetFood),
    famousDesserts: toTextArray(record.famousDesserts),
    drinks: toTextArray(record.drinks),
    localSpecialties: toTextArray(record.localSpecialties),
    foodEtiquette: toTextArray(record.foodEtiquette),
    typicalMealPrices: normalizeMealPrices(record.typicalMealPrices),
    vegetarianVeganFriendliness: toText(record.vegetarianVeganFriendliness),
  };
}

function normalizeBestTime(value: unknown): CountryBestTimeHub {
  const record = isRecord(value) ? value : {};
  return {
    summary: toText(record.summary),
    bestSeason: toText(record.bestSeason),
    cheapestSeason: toText(record.cheapestSeason),
    avoidSeason: toText(record.avoidSeason),
    months: toRecordArray(record.months)
      .map(normalizeMonth)
      .filter((item) => item.month),
  };
}

function normalizeTransportation(value: unknown): CountryTransportationHub {
  const record = isRecord(value) ? value : {};
  return {
    airports: toRecordArray(record.airports)
      .map(normalizeAirport)
      .filter((item) => item.name),
    domesticFlights: toText(record.domesticFlights),
    trains: toText(record.trains),
    metro: toText(record.metro),
    buses: toText(record.buses),
    taxis: toText(record.taxis),
    rideHailing: toText(record.rideHailing),
    carRental: toText(record.carRental),
    drivingRules: toText(record.drivingRules),
    fuelPrices: toText(record.fuelPrices),
    roadQuality: toText(record.roadQuality),
  };
}

function normalizeBudgetTier(value: unknown): CountryBudgetTier {
  const record = isRecord(value) ? value : {};
  return {
    hotel: toText(record.hotel),
    food: toText(record.food),
    attractions: toText(record.attractions),
    transportation: toText(record.transportation),
    totalPerDay: toText(record.totalPerDay),
  };
}

function normalizeBudgetGuide(value: unknown): CountryBudgetGuide {
  const record = isRecord(value) ? value : {};
  return {
    backpacker: normalizeBudgetTier(record.backpacker),
    midRange: normalizeBudgetTier(record.midRange),
    luxury: normalizeBudgetTier(record.luxury),
  };
}

function normalizeSafety(value: unknown): CountrySafetyHub {
  const record = isRecord(value) ? value : {};
  return {
    overallSafetyScore: toNumber(record.overallSafetyScore),
    crimeLevel: toText(record.crimeLevel),
    touristScams: toTextArray(record.touristScams),
    dangerousNeighborhoods: toTextArray(record.dangerousNeighborhoods),
    safeNeighborhoods: toTextArray(record.safeNeighborhoods),
    naturalHazards: toTextArray(record.naturalHazards),
    emergencyNumbers: toTextArray(record.emergencyNumbers),
    healthRecommendations: toTextArray(record.healthRecommendations),
    soloTravelSafety: toText(record.soloTravelSafety),
    womenSafety: toText(record.womenSafety),
    nightSafety: toText(record.nightSafety),
  };
}

function normalizePracticalInformation(value: unknown): CountryPracticalInformationHub {
  const record = isRecord(value) ? value : {};
  return {
    visaRequirements: toText(record.visaRequirements),
    passportValidity: toText(record.passportValidity),
    currency: toText(record.currency),
    exchangeTips: toTextArray(record.exchangeTips),
    simCards: toText(record.simCards),
    internetQuality: toText(record.internetQuality),
    electricalPlugs: toText(record.electricalPlugs),
    timeZone: toText(record.timeZone),
    emergencyNumbers: toTextArray(record.emergencyNumbers),
    waterSafety: toText(record.waterSafety),
    tapWater: toText(record.tapWater),
    healthcare: toText(record.healthcare),
    tippingCulture: toText(record.tippingCulture),
    smokingLaws: toText(record.smokingLaws),
    alcoholLaws: toText(record.alcoholLaws),
  };
}

export function hasRichCountryAiRecommendation(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    isRecord(value.overview) &&
    isRecord(value.history) &&
    isRecord(value.geography) &&
    isRecord(value.peopleCulture) &&
    isRecord(value.foodGuide) &&
    Array.isArray(value.topDestinations) &&
    Array.isArray(value.topAttractions) &&
    isRecord(value.bestTime) &&
    isRecord(value.transportation) &&
    isRecord(value.budgetGuide) &&
    isRecord(value.safety) &&
    isRecord(value.practicalInformation)
  );
}

export function normalizeCountryAiRecommendation(
  value: unknown,
  countryName = ""
): CountryAiRecommendation {
  const record = isRecord(value) ? value : {};
  const overview = normalizeOverview(record.overview);
  const history = normalizeHistory(record.history);
  const geography = normalizeGeography(record.geography);
  const peopleCulture = normalizePeopleCulture(record.peopleCulture);
  const foodGuide = normalizeFoodGuide(record.foodGuide);
  const topDestinations = toRecordArray(record.topDestinations)
    .map((item) => normalizeDestination(item, countryName))
    .filter((item) => item.name);
  const topAttractions = toRecordArray(record.topAttractions)
    .map(normalizeAttractionCategory)
    .filter((item) => item.category || item.attractions.length > 0);
  const cities = toRecordArray(record.cities)
    .map(normalizeCity)
    .filter((item) => item.name);
  const itineraryIdeas = toRecordArray(record.itineraryIdeas)
    .map(normalizeItinerary)
    .filter((item) => item.days > 0 || item.title);
  const bestTime = normalizeBestTime(record.bestTime);
  const transportation = normalizeTransportation(record.transportation);
  const budgetGuide = normalizeBudgetGuide(record.budgetGuide);
  const safety = normalizeSafety(record.safety);
  const practicalInformation = normalizePracticalInformation(record.practicalInformation);

  const summary = toText(record.summary) || overview.shortSummary;
  const about =
    toText(record.about) ||
    [overview.shortSummary, overview.longOverview[0]].filter(Boolean).join(" ").trim();
  const highlights = toTextArray(record.highlights);
  const derivedHighlights =
    highlights.length > 0
      ? highlights
      : topDestinations.slice(0, 5).map((destination) => destination.name);
  const food = toTextArray(record.food);
  const derivedFood =
    food.length > 0
      ? food
      : [
          ...foodGuide.nationalDishes.slice(0, 3),
          ...foodGuide.streetFood.slice(0, 2),
          ...foodGuide.famousDesserts.slice(0, 1),
        ].filter(Boolean);
  const bestTimeToVisit =
    toText(record.bestTimeToVisit) ||
    bestTime.summary ||
    [bestTime.bestSeason, bestTime.cheapestSeason ? `עונה זולה: ${bestTime.cheapestSeason}` : ""]
      .filter(Boolean)
      .join(" · ");
  const tips = toTextArray(record.tips);
  const derivedTips =
    tips.length > 0
      ? tips
      : [
          practicalInformation.visaRequirements,
          practicalInformation.simCards,
          transportation.rideHailing,
          safety.soloTravelSafety,
          safety.nightSafety,
        ].filter(Boolean);

  return {
    about,
    summary,
    highlights: derivedHighlights,
    food: derivedFood,
    bestTimeToVisit,
    tips: derivedTips,
    overview,
    history,
    geography,
    peopleCulture,
    foodGuide,
    topDestinations,
    topAttractions,
    cities,
    itineraryIdeas,
    bestTime,
    transportation,
    budgetGuide,
    safety,
    practicalInformation,
  };
}
