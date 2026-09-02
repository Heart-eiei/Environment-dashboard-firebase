import type {Confidence} from "../firms/parseRow";
import {createCanonicalId} from "./canonicalId";

export const FIRMS_SOURCE = "VIIRS_NOAA21_NRT";

export interface NormalizableFirmsRow {
  latitude: number;
  longitude: number;
  acq_datetime_utc: string;
  acq_date_th: string;
  acq_time_th: string;
  confidence: Confidence;
  frp: number;
}

export interface NormalizedHotspot {
  latitude: number;
  longitude: number;
  acq_datetime_utc: string;
  acq_date_th: string;
  acq_time_th: string;
  confidence: Confidence;
  frp_mw: number;
  hotspot_id: string;
  canonical_id: string;
  source: typeof FIRMS_SOURCE;
}

export function normalizeHotspot(
  row: NormalizableFirmsRow,
): NormalizedHotspot {
  const canonicalId = createCanonicalId(
    row.latitude,
    row.longitude,
    row.acq_datetime_utc,
  );

  return {
    latitude: row.latitude,
    longitude: row.longitude,
    acq_datetime_utc: row.acq_datetime_utc,
    acq_date_th: row.acq_date_th,
    acq_time_th: row.acq_time_th,
    confidence: row.confidence,
    frp_mw: row.frp,
    hotspot_id: canonicalId,
    canonical_id: canonicalId,
    source: FIRMS_SOURCE,
  };
}
