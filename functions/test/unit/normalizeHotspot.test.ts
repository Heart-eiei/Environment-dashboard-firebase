import {describe, expect, it} from "vitest";
import {
  createCanonicalId,
} from "../../src/transform/canonicalId";
import {
  normalizeHotspot,
} from "../../src/transform/normalizeHotspot";

describe("hotspot normalization", () => {
  const row = {
    latitude: 13.756331,
    longitude: 100.501765,
    acq_datetime_utc: "2026-08-23T17:00:00Z",
    acq_date_th: "2026-08-24",
    acq_time_th: "00:00",
    confidence: "nominal" as const,
    frp: 4.5,
  };

  it("converts FIRMS fields to Firestore fields", () => {
    const result = normalizeHotspot(row);

    expect(result.latitude).toBe(13.756331);
    expect(result.longitude).toBe(100.501765);
    expect(result.acq_date_th).toBe("2026-08-24");
    expect(result.acq_time_th).toBe("00:00");
    expect(result.confidence).toBe("nominal");
    expect(result.frp_mw).toBe(4.5);
    expect(result.source).toBe("VIIRS_NOAA21_NRT");
  });

  it("uses the canonical ID for both ID fields", () => {
    const result = normalizeHotspot(row);
    const expectedId = createCanonicalId(
      row.latitude,
      row.longitude,
      row.acq_datetime_utc,
    );

    expect(result.canonical_id).toBe(expectedId);
    expect(result.hotspot_id).toBe(expectedId);
  });

  it("creates stable results for the same row", () => {
    const first = normalizeHotspot(row);
    const second = normalizeHotspot(row);

    expect(first).toEqual(second);
  });
});
