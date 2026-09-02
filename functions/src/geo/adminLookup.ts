import {booleanPointInPolygon} from "@turf/boolean-point-in-polygon";
import {point} from "@turf/helpers";
import type {
  Feature,
  FeatureCollection,
  MultiPolygon,
  Polygon,
} from "geojson";

export type AdminLevel =
  | "province"
  | "district"
  | "subdistrict";

export interface AdminProperties {
  level: AdminLevel;
  name_th: string;
}

type BoundaryGeometry = Polygon | MultiPolygon;

export type AdminBoundaryFeature = Feature<
  BoundaryGeometry,
  AdminProperties
>;

export type AdminBoundaryCollection = FeatureCollection<
  BoundaryGeometry,
  AdminProperties
>;

export interface AdminBoundaryData {
  province: AdminBoundaryCollection;
  district: AdminBoundaryCollection;
  subdistrict: AdminBoundaryCollection;
}

export interface AdministrativeNames {
  province_th: string;
  district_th: string;
  subdistrict_th: string;
}

function findBoundaryName(
  collection: AdminBoundaryCollection,
  level: AdminLevel,
  latitude: number,
  longitude: number,
): string | null {
  const location = point([longitude, latitude]);

  const match = collection.features.find((feature) => {
    const properties = feature.properties;

    return (
      properties?.level === level &&
      booleanPointInPolygon(location, feature)
    );
  });

  return match?.properties?.name_th ?? null;
}

export function lookupAdministrativeNames(
  data: AdminBoundaryData,
  latitude: number,
  longitude: number,
): AdministrativeNames | null {
  if (
    !Number.isFinite(latitude) ||
    latitude < -90 ||
    latitude > 90
  ) {
    throw new Error("latitude is invalid");
  }

  if (
    !Number.isFinite(longitude) ||
    longitude < -180 ||
    longitude > 180
  ) {
    throw new Error("longitude is invalid");
  }

  const province = findBoundaryName(
    data.province,
    "province",
    latitude,
    longitude,
  );

  const district = findBoundaryName(
    data.district,
    "district",
    latitude,
    longitude,
  );

  const subdistrict = findBoundaryName(
    data.subdistrict,
    "subdistrict",
    latitude,
    longitude,
  );

  if (!province || !district || !subdistrict) {
    return null;
  }

  return {
    province_th: province,
    district_th: district,
    subdistrict_th: subdistrict,
  };
}
