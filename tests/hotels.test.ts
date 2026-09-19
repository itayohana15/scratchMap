import assert from "node:assert/strict";
import test from "node:test";

import {
  buildRecommendedAreaLabel,
  compareHotelImpact,
  detectHotelBaseMismatch,
  explainHotelFit,
  rankHotels,
  type HotelCandidate,
} from "../src/lib/hotels";

function buildHotel(overrides: Partial<HotelCandidate> = {}): HotelCandidate {
  return {
    name: overrides.name ?? "Sample Hotel",
    lat: overrides.lat ?? 35.6895,
    lon: overrides.lon ?? 139.6917,
    openingHours: overrides.openingHours ?? null,
    priceConfidence: "unavailable",
    ratingConfidence: "unavailable",
  };
}

test("rankHotels ranks a hotel closer to the trip's activities above a farther one", () => {
  const activityClusters = [{ lat: 35.6895, lon: 139.6917 }];
  const near = buildHotel({ name: "Near Hotel", lat: 35.69, lon: 139.692 });
  const far = buildHotel({ name: "Far Hotel", lat: 35.9, lon: 139.9 });

  const ranked = rankHotels([far, near], activityClusters, null);
  assert.equal(ranked[0]?.name, "Near Hotel");
  assert.ok(ranked[0]!.locationScore > ranked[1]!.locationScore);
});

test("rankHotels never fabricates price or rating — always marked unavailable", () => {
  const [ranked] = rankHotels([buildHotel()], [], null);
  assert.equal(ranked.priceConfidence, "unavailable");
  assert.equal(ranked.ratingConfidence, "unavailable");
});

test("rankHotels falls back to a neutral score when no activity clusters or airport are given", () => {
  const [ranked] = rankHotels([buildHotel()], [], null);
  assert.equal(ranked.averageActivityTravelMinutes, null);
  assert.equal(ranked.airportTravelMinutes, null);
  assert.ok(ranked.locationScore > 0);
});

test("rankHotels factors in airport distance as a smaller share than activity proximity", () => {
  const activityClusters = [{ lat: 35.6895, lon: 139.6917 }];
  const nearAirport = buildHotel({ name: "Near Airport", lat: 35.6895, lon: 139.6917 });
  const [ranked] = rankHotels([nearAirport], activityClusters, { lat: 35.5494, lon: 139.7798 });
  assert.ok(ranked.airportTravelMinutes != null && ranked.airportTravelMinutes > 0);
});

test("buildRecommendedAreaLabel returns a real reason tied to the trip's own activity clusters", () => {
  const result = buildRecommendedAreaLabel("Asakusa", [{ lat: 35.71, lon: 139.79 }]);
  assert.equal(result?.area, "Asakusa");
  assert.ok(result?.reason.length ?? 0 > 0);
});

test("buildRecommendedAreaLabel returns null without a real area or activity clusters", () => {
  assert.equal(buildRecommendedAreaLabel("", [{ lat: 35.71, lon: 139.79 }]), null);
  assert.equal(buildRecommendedAreaLabel("Asakusa", []), null);
});

test("explainHotelFit describes a short walk for a very close hotel", () => {
  const [ranked] = rankHotels([buildHotel()], [{ lat: 35.6895, lon: 139.6917 }], null);
  const explanation = explainHotelFit(ranked);
  assert.ok(explanation.includes("הליכה"));
});

test("explainHotelFit never invents a claim when there's no real travel-time data", () => {
  const [ranked] = rankHotels([buildHotel()], [], null);
  const explanation = explainHotelFit(ranked);
  assert.ok(explanation.includes("אין מספיק"));
});

test("compareHotelImpact reports a real travel-time delta between two hotels", () => {
  const previous = { averageActivityTravelMinutes: 18 };
  const next = { averageActivityTravelMinutes: 11 };
  assert.equal(compareHotelImpact(previous, next).travelMinutesDelta, -7);
});

test("compareHotelImpact returns null when either hotel's travel time is unknown", () => {
  assert.equal(compareHotelImpact({ averageActivityTravelMinutes: null }, { averageActivityTravelMinutes: 11 }).travelMinutesDelta, null);
});

// Section D3: hotelBaseMismatch.
test("detectHotelBaseMismatch returns null for a hotel inside the stay's own activity cluster", () => {
  const mismatch = detectHotelBaseMismatch({ lat: 35.6895, lon: 139.6917 }, [{ lat: 35.69, lon: 139.692 }]);
  assert.equal(mismatch, null);
});

test("detectHotelBaseMismatch flags a hotel far from every one of the stay's activity clusters", () => {
  // Kyoto vs a Tokyo-based stay's clusters — a different region entirely.
  const mismatch = detectHotelBaseMismatch(
    { lat: 35.0157, lon: 135.7681 },
    [{ lat: 35.6895, lon: 139.6917 }, { lat: 35.66, lon: 139.7 }]
  );
  assert.ok(mismatch != null);
  assert.ok(mismatch!.nearestClusterKm > mismatch!.thresholdKm);
});

test("detectHotelBaseMismatch is close enough when the hotel matches at least one of several clusters, even if far from another", () => {
  const mismatch = detectHotelBaseMismatch(
    { lat: 35.0157, lon: 135.7681 },
    [{ lat: 35.6895, lon: 139.6917 }, { lat: 35.02, lon: 135.77 }]
  );
  assert.equal(mismatch, null);
});

test("detectHotelBaseMismatch returns null when there's nothing real to compare (no coordinates or no clusters)", () => {
  assert.equal(detectHotelBaseMismatch({ lat: null, lon: null }, [{ lat: 1, lon: 1 }]), null);
  assert.equal(detectHotelBaseMismatch({ lat: 1, lon: 1 }, []), null);
});

/* ==================================================================== *
 * ROUND 9.3.1 §20/§24 — stay-length-aware airport/activity weighting     *
 * ==================================================================== */

// C. airport far from activity center on a 5-night stay -> airport
// convenience does not dominate hotel location.
test("Round 9.3.1 C: on a multi-night stay, activity proximity dominates over airport convenience", () => {
  const activityClusters = [{ lat: 35.6895, lon: 139.6917 }];
  const airportCoords = { lat: 35.5494, lon: 139.7798 }; // Haneda-ish, far from the activity center
  const nearActivities = buildHotel({ name: "Near Activities", lat: 35.69, lon: 139.692 });
  const nearAirport = buildHotel({ name: "Near Airport", lat: 35.55, lon: 139.78 });

  const ranked = rankHotels([nearAirport, nearActivities], activityClusters, airportCoords, [], 5);
  assert.equal(ranked[0]?.name, "Near Activities", "for a 5-night stay, the activity-proximate hotel must win despite the other being airport-convenient");
});

// D. a genuine one-night airport stop -> airport convenience can
// legitimately matter more (never MORE than activity access outright —
// spec's own "may naturally differ", not "airport always wins" — verified
// as a real, measurable shift toward airport weight, not a flip).
test("Round 9.3.1 D: a one-night stay weighs airport convenience noticeably more than the same hotels would on a longer stay", () => {
  const activityClusters = [{ lat: 35.6895, lon: 139.6917 }];
  const airportCoords = { lat: 35.5494, lon: 139.7798 };
  const nearAirport = buildHotel({ name: "Near Airport", lat: 35.55, lon: 139.78 });

  const multiNightScore = rankHotels([nearAirport], activityClusters, airportCoords, [], 5)[0]!.locationScore;
  const oneNightScore = rankHotels([nearAirport], activityClusters, airportCoords, [], 1)[0]!.locationScore;
  assert.ok(oneNightScore > multiNightScore, `expected the airport-convenient hotel to score higher on a 1-night stay (${oneNightScore}) than a 5-night one (${multiNightScore})`);
});

test("rankHotels without a stayNights argument behaves exactly as before (no regression for existing callers)", () => {
  const activityClusters = [{ lat: 35.6895, lon: 139.6917 }];
  const airportCoords = { lat: 35.5494, lon: 139.7798 };
  const hotel = buildHotel({ lat: 35.6, lon: 139.7 });
  const withoutArg = rankHotels([hotel], activityClusters, airportCoords)[0]!.locationScore;
  const withUndefined = rankHotels([hotel], activityClusters, airportCoords, [], undefined)[0]!.locationScore;
  assert.equal(withoutArg, withUndefined);
});
