import {createHash} from "node:crypto";

type NumericInput = string | number;

const UTC_MINUTE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z$/;

function toFiniteNumber(value: NumericInput, field: string): number {
  if (typeof value === "string" && value.trim() === "") {
    throw new Error(`${field} must not be empty`);
  }

  const parsed = typeof value === "number" ? value : Number(value.trim());

  if (!Number.isFinite(parsed)) {
    throw new Error(`${field} must be a finite number`);
  }

  return parsed;
}

function normalizeCoordinate(
  value: NumericInput,
  field: "latitude" | "longitude",
): string {
  const parsed = toFiniteNumber(value, field);

  if (field === "latitude" && (parsed < -90 || parsed > 90)) {
    throw new Error("latitude must be between -90 and 90");
  }

  if (field === "longitude" && (parsed < -180 || parsed > 180)) {
    throw new Error("longitude must be between -180 and 180");
  }

  return (Object.is(parsed, -0) ? 0 : parsed).toFixed(5);
}

function normalizeUtcMinute(value: string): string {
  const normalized = value.trim();

  if (!UTC_MINUTE_RE.test(normalized)) {
    throw new Error(
      "acq_datetime_utc must use YYYY-MM-DDTHH:mm:00Z format",
    );
  }

  const date = new Date(normalized);

  if (Number.isNaN(date.getTime())) {
    throw new Error("acq_datetime_utc is invalid");
  }

  const canonical = date.toISOString().replace(".000Z", "Z");

  if (canonical !== normalized) {
    throw new Error("acq_datetime_utc is invalid");
  }

  return normalized;
}

export function buildCanonicalInput(
  latitude: NumericInput,
  longitude: NumericInput,
  acqDatetimeUtc: string,
): string {
  return [
    "N21",
    normalizeCoordinate(latitude, "latitude"),
    normalizeCoordinate(longitude, "longitude"),
    normalizeUtcMinute(acqDatetimeUtc),
  ].join("|");
}

export function createCanonicalId(
  latitude: NumericInput,
  longitude: NumericInput,
  acqDatetimeUtc: string,
): string {
  const input = buildCanonicalInput(
    latitude,
    longitude,
    acqDatetimeUtc,
  );

  const digest = createHash("sha256")
    .update(input, "utf8")
    .digest("hex")
    .slice(0, 32);

  return `N21_${digest}`;
}
