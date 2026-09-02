import {polygon} from "@turf/helpers";
import type {Position} from "geojson";
import {describe, expect, it} from "vitest";
import {
  lookupAdministrativeNames,
} from "../../src/geo/adminLookup";
import type {
  AdminBoundaryCollection,
  AdminBoundaryData,
  AdminLevel,
} from "../../src/geo/adminLookup";

const ring: Position[] = [
  [-1, -1],
  [1, -1],
  [1, 1],
  [-1, 1],
  [-1, -1],
];

function makeCollection(
  level: AdminLevel,
  name: string,
): AdminBoundaryCollection {
  const feature = polygon(
    [ring],
    {
      level,
      name_th: name,
    },
  );

  return {
    type: "FeatureCollection",
    features: [feature],
  };
}

const boundaries: AdminBoundaryData = {
  province: makeCollection("province", "Test Province"),
  district: makeCollection("district", "Test District"),
  subdistrict: makeCollection(
    "subdistrict",
    "Test Subdistrict",
  ),
};

describe("administrative boundary lookup", () => {
  it("finds all administrative names for a point", () => {
    expect(
      lookupAdministrativeNames(boundaries, 0, 0),
    ).toEqual({
      province_th: "Test Province",
      district_th: "Test District",
      subdistrict_th: "Test Subdistrict",
    });
  });

  it("returns null for a point outside the boundaries", () => {
    expect(
      lookupAdministrativeNames(boundaries, 5, 5),
    ).toBeNull();
  });

  it("rejects invalid coordinates", () => {
    expect(() =>
      lookupAdministrativeNames(boundaries, 100, 0),
    ).toThrow("latitude is invalid");

    expect(() =>
      lookupAdministrativeNames(boundaries, 0, 200),
    ).toThrow("longitude is invalid");
  });
});
