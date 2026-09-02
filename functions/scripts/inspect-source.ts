import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { google } from "googleapis";

const SPREADSHEET_ID =
  process.env.HOTSPOTS_SPREADSHEET_ID ??
  "1bRYUX8kYYRl7vCGB1Azatb6zR-z_G22qgg5S5onJGtM";
const SHEET_NAME = "hotspots";
const EXPECTED_DATA_ROWS = 156_333;
const EXPECTED_COLUMN_COUNT = 11;
const MAX_REPORTED_ERRORS = 100;
const THAILAND_TIME_ZONE = "Asia/Bangkok";

const EXPECTED_HEADERS = [
  "latitude",
  "longitude",
  "acq_datetime_utc",
  "acq_date_th",
  "acq_time_th",
  "confidence",
  "frp_mw",
  "hotspot_id",
  "province_th",
  "district_th",
  "subdistrict_th",
];

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const FUNCTIONS_DIR = path.resolve(SCRIPT_DIR, "..");
const REPORT_DIR = path.join(FUNCTIONS_DIR, "data", "inspection");
const REPORT_PATH = path.join(REPORT_DIR, "historical-hotspots-report.json");

const thaiDateTimeFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: THAILAND_TIME_ZONE,
  calendar: "gregory",
  numberingSystem: "latn",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function textValue(value: unknown) {
  return value == null ? "" : String(value).trim();
}

function addError(errors: string[], message: string) {
  if (errors.length < MAX_REPORTED_ERRORS) {
    errors.push(message);
  }
}

function parseFiniteNumber(
  value: unknown,
  fieldName: string,
  rowNumber: number,
  errors: string[],
) {
  const text = textValue(value);

  if (text === "") {
    addError(errors, `Row ${rowNumber}: ${fieldName} is missing.`);
    return null;
  }

  const number = Number(text);

  if (!Number.isFinite(number)) {
    addError(errors, `Row ${rowNumber}: ${fieldName} is not finite.`);
    return null;
  }

  return number;
}

function parseUtcDate(value: unknown, rowNumber: number, errors: string[]) {
  const text = textValue(value);

  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(text)
  ) {
    addError(
      errors,
      `Row ${rowNumber}: acq_datetime_utc is not a UTC ISO timestamp: ${text}`,
    );
    return null;
  }

  const date = new Date(text);

  if (Number.isNaN(date.getTime())) {
    addError(
      errors,
      `Row ${rowNumber}: acq_datetime_utc is invalid: ${text}`,
    );
    return null;
  }

  return { text, date };
}

function getThaiDateTime(date: Date) {
  const parts = thaiDateTimeFormatter.formatToParts(date);
  const values = Object.fromEntries(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );

  return {
    date: `${values.year}-${values.month}-${values.day}`,
    time: `${values.hour}:${values.minute}`,
  };
}

function coordinateForCanonicalId(value: number) {
  const rounded = Number(value.toFixed(5));
  return rounded.toFixed(5);
}

function createCanonicalId(
  latitude: number,
  longitude: number,
  acqDatetimeUtc: string,
) {
  const canonicalInput = [
    "N21",
    coordinateForCanonicalId(latitude),
    coordinateForCanonicalId(longitude),
    acqDatetimeUtc,
  ].join("|");

  const digest = createHash("sha256")
    .update(canonicalInput, "utf8")
    .digest("hex");

  return {
    canonicalInput,
    canonicalId: `N21_${digest.slice(0, 32)}`,
  };
}

function validateCoordinateRange(
  latitude: number | null,
  longitude: number | null,
  rowNumber: number,
  errors: string[],
) {
  if (latitude !== null && (latitude < -90 || latitude > 90)) {
    addError(errors, `Row ${rowNumber}: latitude is outside -90..90.`);
  }

  if (longitude !== null && (longitude < -180 || longitude > 180)) {
    addError(errors, `Row ${rowNumber}: longitude is outside -180..180.`);
  }
}

function validateRequiredValues(
  row: unknown[],
  rowNumber: number,
  errors: string[],
) {
  for (let index = 0; index < EXPECTED_COLUMN_COUNT; index += 1) {
    if (textValue(row[index]) === "") {
      addError(
        errors,
        `Row ${rowNumber}: ${EXPECTED_HEADERS[index]} is missing.`,
      );
    }
  }
}

async function readSourceRows() {
  const auth = new google.auth.GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });
  const sheets = google.sheets({ version: "v4", auth });
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A1:K`,
    majorDimension: "ROWS",
    valueRenderOption: "UNFORMATTED_VALUE",
  });

  return (response.data.values ?? []) as unknown[][];
}

async function main() {
  console.log(`Reading ${SHEET_NAME} from ${SPREADSHEET_ID}...`);
  const rows = await readSourceRows();

  if (rows.length === 0) {
    throw new Error("The source sheet returned no rows.");
  }

  const header = rows[0].map(textValue);
  const headerErrors: string[] = [];

  if (header.length !== EXPECTED_COLUMN_COUNT) {
    headerErrors.push(
      `Expected ${EXPECTED_COLUMN_COUNT} columns but received ${header.length}.`,
    );
  }

  for (let index = 0; index < EXPECTED_HEADERS.length; index += 1) {
    if (header[index] !== EXPECTED_HEADERS[index]) {
      headerErrors.push(
        `Column ${index + 1}: expected ${EXPECTED_HEADERS[index]} ` +
          `but received ${header[index] ?? "<missing>"}.`,
      );
    }
  }

  const errors = [...headerErrors];
  const seenCanonicalIds = new Set<string>();
  const seenHotspotIds = new Set<string>();
  const seenCoordinateKeys = new Set<string>();
  const canonicalSamples: Array<{
    row: number;
    hotspot_id: string;
    canonical_id: string;
    canonical_input: string;
  }> = [];

  const stats = {
    inputRows: Math.max(rows.length - 1, 0),
    validRows: 0,
    invalidRows: 0,
    uniqueCanonicalIds: 0,
    duplicateCanonicalIds: 0,
    uniqueHotspotIds: 0,
    duplicateHotspotIds: 0,
    uniqueCoordinateKeys: 0,
    duplicateCoordinateKeys: 0,
    missingRequiredValues: 0,
    invalidThaiDateTime: 0,
  };

  for (let index = 1; index < rows.length; index += 1) {
    const rowNumber = index + 1;
    const row = rows[index] ?? [];
    const rowErrors: string[] = [];

    if (row.length !== EXPECTED_COLUMN_COUNT) {
      addError(
        rowErrors,
        `Row ${rowNumber}: expected ${EXPECTED_COLUMN_COUNT} columns ` +
          `but received ${row.length}.`,
      );
    }

    validateRequiredValues(row, rowNumber, rowErrors);

    const latitude = parseFiniteNumber(
      row[0],
      "latitude",
      rowNumber,
      rowErrors,
    );
    const longitude = parseFiniteNumber(
      row[1],
      "longitude",
      rowNumber,
      rowErrors,
    );
    const utc = parseUtcDate(row[2], rowNumber, rowErrors);
    const frp = parseFiniteNumber(row[6], "frp_mw", rowNumber, rowErrors);

    validateCoordinateRange(latitude, longitude, rowNumber, rowErrors);

    if (frp !== null && frp < 0) {
      addError(rowErrors, `Row ${rowNumber}: frp_mw is negative.`);
    }

    const confidence = textValue(row[5]);
    if (!["low", "nominal", "high"].includes(confidence)) {
      addError(
        rowErrors,
        `Row ${rowNumber}: confidence is invalid: ${confidence}`,
      );
    }

    let canonical: ReturnType<typeof createCanonicalId> | null = null;

    if (latitude !== null && longitude !== null && utc !== null) {
      canonical = createCanonicalId(latitude, longitude, utc.text);

      const thaiDateTime = getThaiDateTime(utc.date);
      const sourceThaiDate = textValue(row[3]);
      const sourceThaiTime = textValue(row[4]);

      if (
        sourceThaiDate !== thaiDateTime.date ||
        sourceThaiTime !== thaiDateTime.time
      ) {
        stats.invalidThaiDateTime += 1;
        addError(
          rowErrors,
          `Row ${rowNumber}: Thai date/time does not match UTC ` +
            `(${sourceThaiDate} ${sourceThaiTime} vs ` +
            `${thaiDateTime.date} ${thaiDateTime.time}).`,
        );
      }

      const coordinateKey = [
        coordinateForCanonicalId(latitude),
        coordinateForCanonicalId(longitude),
        utc.text,
      ].join("|");

      if (seenCoordinateKeys.has(coordinateKey)) {
        stats.duplicateCoordinateKeys += 1;
      } else {
        seenCoordinateKeys.add(coordinateKey);
      }

      if (seenCanonicalIds.has(canonical.canonicalId)) {
        stats.duplicateCanonicalIds += 1;
      } else {
        seenCanonicalIds.add(canonical.canonicalId);
      }

      if (canonicalSamples.length < 5) {
        canonicalSamples.push({
          row: rowNumber,
          hotspot_id: textValue(row[7]),
          canonical_id: canonical.canonicalId,
          canonical_input: canonical.canonicalInput,
        });
      }
    }

    const hotspotId = textValue(row[7]);
    if (hotspotId !== "") {
      if (seenHotspotIds.has(hotspotId)) {
        stats.duplicateHotspotIds += 1;
      } else {
        seenHotspotIds.add(hotspotId);
      }
    }

    if (rowErrors.length > 0) {
      stats.invalidRows += 1;

      if (
        Array.from({ length: EXPECTED_COLUMN_COUNT }, (_, columnIndex) =>
          textValue(row[columnIndex]),
        ).some((value) => value === "")
      ) {
        stats.missingRequiredValues += 1;
      }

      for (const error of rowErrors) {
        addError(errors, error);
      }
    } else {
      stats.validRows += 1;
    }
  }

  stats.uniqueCanonicalIds = seenCanonicalIds.size;
  stats.uniqueHotspotIds = seenHotspotIds.size;
  stats.uniqueCoordinateKeys = seenCoordinateKeys.size;

  const report = {
    source: {
      spreadsheet_id: SPREADSHEET_ID,
      sheet_name: SHEET_NAME,
      range: `${SHEET_NAME}!A1:K`,
      expected_data_rows: EXPECTED_DATA_ROWS,
      expected_headers: EXPECTED_HEADERS,
    },
    generated_at_utc: new Date().toISOString(),
    stats,
    canonical_id_rule:
      "N21_ + first 32 hex characters of SHA-256(N21|latitude_5dp|longitude_5dp|acq_datetime_utc)",
    canonical_samples: canonicalSamples,
    errors,
  };

  await mkdir(REPORT_DIR, { recursive: true });
  await writeFile(REPORT_PATH, JSON.stringify(report, null, 2), "utf8");

  console.log("\nHistorical hotspot dry run results:");
  console.log(JSON.stringify(stats, null, 2));
  console.log(`\nReport saved to ${REPORT_PATH}`);

  const passed =
    stats.inputRows === EXPECTED_DATA_ROWS &&
    stats.validRows === EXPECTED_DATA_ROWS &&
    stats.uniqueCanonicalIds === EXPECTED_DATA_ROWS &&
    stats.duplicateCanonicalIds === 0 &&
    stats.missingRequiredValues === 0 &&
    stats.invalidThaiDateTime === 0;

  if (!passed) {
    throw new Error(
      "Historical hotspot dry run failed. Review the report before importing.",
    );
  }

  console.log("\nDRY RUN PASSED. No Firestore writes were performed.");
}

main().catch((error) => {
  console.error("\nHistorical hotspot inspection failed:");
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
