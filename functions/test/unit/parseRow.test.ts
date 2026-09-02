import {describe, expect, it} from "vitest";
import {
  parseFirmsCsv,
  parseFirmsRow,
  type FirmsCsvRecord,
} from "../../src/firms/parseRow";

function validRecord(
  overrides: Partial<FirmsCsvRecord> = {},
): FirmsCsvRecord {
  return {
    latitude: "18.123456",
    longitude: "98.123454",
    acq_date: "2026-09-02",
    acq_time: "30",
    confidence: "n",
    frp: "12.5",
    ...overrides,
  };
}

describe("FIRMS CSV parsing", () => {
  it("parses and validates a FIRMS CSV row", () => {
    const csv = [
      "latitude,longitude,acq_date,acq_time,confidence,frp",
      "18.123456,98.123454,2026-09-02,30,n,12.5",
    ].join("\n");

    const rows = parseFirmsCsv(csv);
    const result = parseFirmsRow(rows[0], 2);

    expect(result).toEqual({
      latitude: 18.123456,
      longitude: 98.123454,
      acqDatetimeUtc: "2026-09-02T00:30:00Z",
      acqDateTh: "2026-09-02",
      acqTimeTh: "07:30",
      confidence: "nominal",
      frpMw: 12.5,
    });
  });

  it("maps low, nominal, and high confidence", () => {
    expect(parseFirmsRow(validRecord({confidence: "l"})).confidence)
      .toBe("low");

    expect(parseFirmsRow(validRecord({confidence: "n"})).confidence)
      .toBe("nominal");

    expect(parseFirmsRow(validRecord({confidence: "h"})).confidence)
      .toBe("high");
  });

  it("rejects missing CSV columns", () => {
    expect(() =>
      parseFirmsCsv("latitude,longitude\n18,98"),
    ).toThrow("missing required columns");
  });

  it("rejects invalid values", () => {
    expect(() =>
      parseFirmsRow(validRecord({latitude: "invalid"}), 2),
    ).toThrow("latitude must be a finite number");

    expect(() =>
      parseFirmsRow(validRecord({confidence: "x"}), 2),
    ).toThrow("confidence must be l, n, or h");

    expect(() =>
      parseFirmsRow(validRecord({frp: "-1"}), 2),
    ).toThrow("frp cannot be negative");
  });
});
