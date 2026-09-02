import {describe, expect, it} from "vitest";
import {convertFirmsTime} from "../../src/transform/thailandTime";

describe("FIRMS UTC to Thailand time", () => {
  it("converts acq_time 30 to 00:30 UTC", () => {
    expect(convertFirmsTime("2026-09-02", "30")).toEqual({
      acqDatetimeUtc: "2026-09-02T00:30:00Z",
      acqDateTh: "2026-09-02",
      acqTimeTh: "07:30",
    });
  });

  it("moves to the next Thai date at 17:00 UTC", () => {
    expect(convertFirmsTime("2026-09-02", "1700")).toEqual({
      acqDatetimeUtc: "2026-09-02T17:00:00Z",
      acqDateTh: "2026-09-03",
      acqTimeTh: "00:00",
    });
  });

  it("keeps 16:59 UTC on the same Thai date", () => {
    expect(convertFirmsTime("2026-09-02", 1659)).toEqual({
      acqDatetimeUtc: "2026-09-02T16:59:00Z",
      acqDateTh: "2026-09-02",
      acqTimeTh: "23:59",
    });
  });

  it("rejects invalid dates and times", () => {
    expect(() =>
      convertFirmsTime("2026-02-30", "1200"),
    ).toThrow();

    expect(() =>
      convertFirmsTime("2026-09-02", "2460"),
    ).toThrow();
  });
});
