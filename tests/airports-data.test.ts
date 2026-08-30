import assert from "node:assert/strict";
import test from "node:test";

import {
  findAirportByIata,
  findAirportsForCountry,
  findDefaultAirportForCountry,
  getAvailableConnectionCountries,
  getIsraeliAirports,
  searchAirports,
  validateFlightAirportCountries,
} from "../src/lib/facts/airports-data";

test("findAirportByIata is case-insensitive and trims whitespace", () => {
  assert.equal(findAirportByIata("tlv")?.name, "Ben Gurion Airport");
  assert.equal(findAirportByIata(" TLV ")?.name, "Ben Gurion Airport");
});

test("findAirportByIata returns null for an unrecognized code", () => {
  assert.equal(findAirportByIata("ZZZ"), null);
});

// Search by city, airport name, or IATA code (spec item 9).
test("searchAirports matches by city, airport name, or IATA code", () => {
  assert.ok(searchAirports("Tbilisi").some((airport) => airport.iata === "TBS"));
  assert.ok(searchAirports("TBS").some((airport) => airport.iata === "TBS"));
  assert.ok(searchAirports("International Airport").some((airport) => airport.iata === "TBS"));
});

test("searchAirports ranks an exact IATA match first", () => {
  const results = searchAirports("TBS");
  assert.equal(results[0]?.iata, "TBS");
});

test("searchAirports returns an empty result for a query matching nothing", () => {
  assert.deepEqual(searchAirports("this matches no airport at all"), []);
});

test("findDefaultAirportForCountry returns a real airport for a known country", () => {
  assert.equal(findDefaultAirportForCountry("GE")?.iata, "TBS");
  assert.equal(findDefaultAirportForCountry("il")?.iata, "TLV");
});

test("findDefaultAirportForCountry returns null for a country with no listed airport", () => {
  assert.equal(findDefaultAirportForCountry("XX"), null);
});

test("getIsraeliAirports returns only Israeli airports", () => {
  const airports = getIsraeliAirports();
  assert.ok(airports.length > 0);
  assert.ok(airports.every((airport) => airport.countryIso === "IL"));
  assert.ok(airports.some((airport) => airport.iata === "TLV"));
});

// The exact reported bug: an Israel-only dropdown showed Georgian/Turkish
// airports too (TBS, BUS, KUT, IST, SAW, AYT alongside TLV/ETH).
test("searchAirports restricted to a pool never returns airports outside that pool", () => {
  const israeliPool = getIsraeliAirports();
  assert.equal(searchAirports("", { pool: israeliPool }).some((airport) => airport.iata === "TBS"), false);
  assert.equal(searchAirports("TBS", { pool: israeliPool }).length, 0, 'searching "TBS" in an Israel-only pool must return nothing, not fall back to the global list');

  const georgianPool = findAirportsForCountry("GE");
  assert.equal(searchAirports("", { pool: georgianPool }).some((airport) => airport.iata === "TLV"), false);
  assert.equal(searchAirports("TLV", { pool: georgianPool }).length, 0);
});

// A connection can be routed through ANY country (spec item 14), unlike the
// fixed outbound/return endpoints — but only countries this dataset
// actually has airports for, so the following airport combobox is never
// left with an empty pool.
test("getAvailableConnectionCountries returns only countries with at least one listed airport", () => {
  const countries = getAvailableConnectionCountries();
  assert.ok(countries.some((country) => country.iso === "TH"));
  assert.ok(countries.every((country) => findAirportsForCountry(country.iso).length > 0));
  // No duplicates.
  assert.equal(new Set(countries.map((country) => country.iso)).size, countries.length);
});

test("getAvailableConnectionCountries carries a real Hebrew display name for each entry", () => {
  const countries = getAvailableConnectionCountries();
  const thailand = countries.find((country) => country.iso === "TH");
  assert.equal(thailand?.nameHe, "תאילנד");
});

test("validateFlightAirportCountries accepts a correct Israel<->Georgia round trip", () => {
  const flights = {
    outbound: { departureAirport: "TLV", arrivalAirport: "TBS" },
    return: { departureAirport: "TBS", arrivalAirport: "TLV" },
  };
  assert.equal(validateFlightAirportCountries(flights, "GE"), null);
});

test("validateFlightAirportCountries rejects an outbound flight that doesn't leave Israel", () => {
  const flights = { outbound: { departureAirport: "IST", arrivalAirport: "TBS" }, return: null };
  const message = validateFlightAirportCountries(flights, "GE");
  assert.ok(message && /ישראל/.test(message));
});

test("validateFlightAirportCountries rejects an outbound destination outside the trip country", () => {
  const flights = { outbound: { departureAirport: "TLV", arrivalAirport: "TLV" }, return: null };
  const message = validateFlightAirportCountries(flights, "GE");
  assert.ok(message != null);
});

test("validateFlightAirportCountries never rejects an airport missing from the curated dataset", () => {
  const flights = { outbound: { departureAirport: "TLV", arrivalAirport: "ZZZ" }, return: null };
  assert.equal(validateFlightAirportCountries(flights, "GE"), null);
});

test("validateFlightAirportCountries accepts a connection whose airport actually matches its own claimed country", () => {
  const flights = {
    outbound: {
      departureAirport: "TLV",
      arrivalAirport: "NRT",
      connections: [{ countryIso: "TH", arrivalAirport: "BKK", departureAirport: "BKK", layoverMinutes: 100 }],
    },
    return: null,
  };
  assert.equal(validateFlightAirportCountries(flights, "JP"), null);
});

// The server-side backstop for the reported bug's underlying class of
// error — a connection claiming one country while its airport actually
// resolves to another must never pass silently (spec items 19-21).
test("validateFlightAirportCountries rejects a connection whose airport is actually in a different country than it claims", () => {
  const flights = {
    outbound: {
      departureAirport: "TLV",
      arrivalAirport: "NRT",
      connections: [{ countryIso: "TH", arrivalAirport: "IST", departureAirport: "IST", layoverMinutes: 100 }],
    },
    return: null,
  };
  const message = validateFlightAirportCountries(flights, "JP");
  assert.ok(message != null && message.includes("IST"));
});

test("validateFlightAirportCountries rejects a connection whose airport-change departure airport is in the wrong country", () => {
  const flights = {
    outbound: {
      departureAirport: "TLV",
      arrivalAirport: "NRT",
      connections: [{ countryIso: "TH", arrivalAirport: "BKK", departureAirport: "IST", layoverMinutes: 100 }],
    },
    return: null,
  };
  assert.ok(validateFlightAirportCountries(flights, "JP") != null);
});

test("validateFlightAirportCountries ignores a connection with no country chosen yet (still mid-selection)", () => {
  const flights = {
    outbound: {
      departureAirport: "TLV",
      arrivalAirport: "NRT",
      connections: [{ countryIso: "", arrivalAirport: "", departureAirport: "", layoverMinutes: 90 }],
    },
    return: null,
  };
  assert.equal(validateFlightAirportCountries(flights, "JP"), null);
});
