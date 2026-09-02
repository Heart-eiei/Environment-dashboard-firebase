import {describe, expect, it} from "vitest";
import {
  buildCanonicalInput,
  createCanonicalId,
} from "../../src/transform/canonicalId";

describe("canonical hotspot IDs", () => {
  it("normalizes coordinates to five decimals", () => {
    expect(
      buildCanonicalInput(
        "18.123456",
        98.123454,
        "2026-09-02T18:30:00Z",
      ),
    ).toBe("N21|18.12346|98.12345|2026-09-02T18:30:00Z");
  });

  it("creates stable IDs", () => {
    const first = createCanonicalId(
      18.123456,
      98.123454,
      "2026-09-02T18:30:00Z",
    );

    const second = createCanonicalId(
      "18.123456",
      "98.123454",
      "2026-09-02T18:30:00Z",
    );

    expect(first).toBe(second);
    expect(first).toMatch(/^N21_[0-9a-f]{32}$/);
  });

  it("rejects invalid values", () => {
    expect(() =>
      buildCanonicalInput(
        "invalid",
        98,
        "2026-09-02T18:30:00Z",
      ),
    ).toThrow();

    expect(() =>
      buildCanonicalInput(
        18,
        98,
        "2026-09-02T18:30Z",
      ),
    ).toThrow();
  });
});
