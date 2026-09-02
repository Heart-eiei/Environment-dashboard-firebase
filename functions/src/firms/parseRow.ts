import {parse} from "csv-parse/sync";
import {convertFirmsTime} from "../transform/thailandTime";

export type Confidence = "low" | "nominal" | "high";

export type FirmsCsvRecord = Record<string, string>;

export type ParsedFirmsRow = {
  latitude: number;
  longitude: number;
  acqDatetimeUtc: string;
  acqDateTh: string;
  acqTimeTh: string;
  confidence: Confidence;
  frpMw: number;
};

const REQUIRED_COLUMNS = [
  "latitude",
  "longitude",
  "acq_date",
  "acq_time",
  "confidence",
  "frp",
] as const;

function requiredValue(
  row: FirmsCsvRecord,
  column: string,
  rowNumber: number,
): string {
  const value = row[column]?.trim();

  if (!value) {
    throw new Error(`row ${rowNumber}: missing ${column}`);
  }

  return value;
}

function finiteNumber(
  value: string,
  field: string,
  rowNumber: number,
): number {
  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    throw new Error(`row ${rowNumber}: ${field} must be a finite number`);
  }

  return parsed;
}

export function parseFirmsCsv(csvText: string): FirmsCsvRecord[] {
  if (!csvText.trim()) {
    throw new Error("FIRMS CSV is empty");
  }

  const records = parse(csvText, {
    bom: true,
    columns: true,
    relax_column_count: false,
    skip_empty_lines: true,
    trim: true,
  }) as FirmsCsvRecord[];

  if (records.length === 0) {
    throw new Error("FIRMS CSV contains no data rows");
  }

  const availableColumns = new Set(Object.keys(records[0]));
  const missingColumns = REQUIRED_COLUMNS.filter(
    (column) => !availableColumns.has(column),
  );

  if (missingColumns.length > 0) {
    throw new Error(
      `FIRMS CSV is missing required columns: ${missingColumns.join(", ")}`,
    );
  }

  return records;
}

export function parseFirmsRow(
  row: FirmsCsvRecord,
  rowNumber = 1,
): ParsedFirmsRow {
  const latitude = finiteNumber(
    requiredValue(row, "latitude", rowNumber),
    "latitude",
    rowNumber,
  );

  const longitude = finiteNumber(
    requiredValue(row, "longitude", rowNumber),
    "longitude",
    rowNumber,
  );

  if (latitude < -90 || latitude > 90) {
    throw new Error(`row ${rowNumber}: latitude is out of range`);
  }

  if (longitude < -180 || longitude > 180) {
    throw new Error(`row ${rowNumber}: longitude is out of range`);
  }

  const acqDate = requiredValue(row, "acq_date", rowNumber);
  const acqTime = requiredValue(row, "acq_time", rowNumber);
  const confidenceCode = requiredValue(row, "confidence", rowNumber);

  const confidenceByCode: Record<string, Confidence> = {
    l: "low",
    n: "nominal",
    h: "high",
  };

  const confidence = confidenceByCode[confidenceCode];

  if (!confidence) {
    throw new Error(
      `row ${rowNumber}: confidence must be l, n, or h`,
    );
  }

  const frpMw = finiteNumber(
    requiredValue(row, "frp", rowNumber),
    "frp",
    rowNumber,
  );

  if (frpMw < 0) {
    throw new Error(`row ${rowNumber}: frp cannot be negative`);
  }

  const thailandTime = convertFirmsTime(acqDate, acqTime);

  return {
    latitude,
    longitude,
    acqDatetimeUtc: thailandTime.acqDatetimeUtc,
    acqDateTh: thailandTime.acqDateTh,
    acqTimeTh: thailandTime.acqTimeTh,
    confidence,
    frpMw,
  };
}
