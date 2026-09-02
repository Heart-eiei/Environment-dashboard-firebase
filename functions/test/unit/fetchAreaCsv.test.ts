import {describe, expect, it, vi} from "vitest";
import type {FirmsResponse} from "../../src/firms/fetchAreaCsv";
import {
  buildFirmsAreaUrl,
  fetchAreaCsv,
} from "../../src/firms/fetchAreaCsv";

function makeResponse(
  body: string,
  ok = true,
  status = 200,
  statusText = "OK",
): FirmsResponse {
  return {
    ok,
    status,
    statusText,
    text: async () => body,
  };
}

describe("FIRMS Area CSV downloader", () => {
  it("builds the NOAA-21 five-day URL", () => {
    expect(buildFirmsAreaUrl("abc123")).toBe(
      "https://firms.modaps.eosdis.nasa.gov/api/area/csv/" +
      "abc123/VIIRS_NOAA21_NRT/97.3,5.6,105.7,20.5/5",
    );
  });

  it("returns the CSV response", async () => {
    const csv = "latitude,longitude\n13.75,100.50";
    const fetchImpl = vi.fn(async () => makeResponse(csv));

    await expect(
      fetchAreaCsv({
        mapKey: "abc123",
        fetchImpl,
      }),
    ).resolves.toBe(csv);

    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("rejects failed API responses", async () => {
    const fetchImpl = vi.fn(async () =>
      makeResponse("Invalid MAP_KEY", false, 401, "Unauthorized"),
    );

    await expect(
      fetchAreaCsv({
        mapKey: "abc123",
        fetchImpl,
      }),
    ).rejects.toThrow("401 Unauthorized");
  });

  it("rejects invalid configuration", () => {
    expect(() => buildFirmsAreaUrl("")).toThrow(
      "FIRMS_MAP_KEY is required",
    );

    expect(() => buildFirmsAreaUrl("abc123", 6)).toThrow(
      "dayRange must be an integer from 1 to 5",
    );
  });
});
