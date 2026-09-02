export const FIRMS_SOURCE = "VIIRS_NOAA21_NRT";
export const FIRMS_BBOX = "97.3,5.6,105.7,20.5";
export const FIRMS_DAY_RANGE = 5;

const FIRMS_AREA_CSV_URL =
  "https://firms.modaps.eosdis.nasa.gov/api/area/csv";

export interface FirmsResponse {
  ok: boolean;
  status: number;
  statusText: string;
  text(): Promise<string>;
}

export type FetchImplementation =
  (input: string) => Promise<FirmsResponse>;

export interface FetchAreaCsvOptions {
  mapKey: string;
  dayRange?: number;
  fetchImpl?: FetchImplementation;
}

export function buildFirmsAreaUrl(
  mapKey: string,
  dayRange = FIRMS_DAY_RANGE,
): string {
  const normalizedKey = mapKey.trim();

  if (normalizedKey.length === 0) {
    throw new Error("FIRMS_MAP_KEY is required");
  }

  if (
    !Number.isInteger(dayRange) ||
    dayRange < 1 ||
    dayRange > 5
  ) {
    throw new Error("dayRange must be an integer from 1 to 5");
  }

  return [
    FIRMS_AREA_CSV_URL,
    encodeURIComponent(normalizedKey),
    FIRMS_SOURCE,
    FIRMS_BBOX,
    dayRange,
  ].join("/");
}

export async function fetchAreaCsv(
  options: FetchAreaCsvOptions,
): Promise<string> {
  const url = buildFirmsAreaUrl(
    options.mapKey,
    options.dayRange,
  );

  const fetchImpl: FetchImplementation =
    options.fetchImpl ?? ((input: string) => fetch(input));

  const response = await fetchImpl(url);
  const body = await response.text();

  if (!response.ok) {
    const detail = body.trim().slice(0, 500);
    const statusText = response.statusText ?
      ` ${response.statusText}` :
      "";

    throw new Error(
      "FIRMS Area API request failed " +
      `(${response.status}${statusText})` +
      `${detail ? `: ${detail}` : ""}`,
    );
  }

  if (body.trim().length === 0) {
    throw new Error("FIRMS Area API returned an empty response");
  }

  return body;
}
