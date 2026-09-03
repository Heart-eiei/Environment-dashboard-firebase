import {createHash} from "node:crypto";
import {mkdir, readFile, writeFile} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";

import {applicationDefault, getApps, initializeApp} from "firebase-admin/app";
import {getFirestore, Timestamp} from "firebase-admin/firestore";
import {google} from "googleapis";

const PROJECT_ID = "environment-project-a72bd";
const SPREADSHEET_ID = process.env.HOTSPOTS_SPREADSHEET_ID ??
  "1bRYUX8kYYRl7vCGB1Azatb6zR-z_G22qgg5S5onJGtM";
const SHEET_NAME = process.env.HOTSPOTS_SHEET_NAME ?? "hotspots";
const SOURCE_RANGE = `${SHEET_NAME}!A1:K`;
const EXPECTED_ROWS = 156_333;
const EXPECTED_PROVINCES = 77;
const SOURCE = "VIIRS_NOAA21_NRT";
const SOURCE_MODE = "historical";
const BOUNDARY_VERSION = process.env.BOUNDARY_VERSION ?? "historical-workbook";
const FLUSH_SIZE = 2_000;
const MAX_RETRIES = 5;
const HEADERS = [
  "latitude", "longitude", "acq_datetime_utc", "acq_date_th",
  "acq_time_th", "confidence", "frp_mw", "hotspot_id", "province_th",
  "district_th", "subdistrict_th",
];

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const functionsDir = path.resolve(scriptDir, "..");
const reportPath = path.join(
  functionsDir, "data", "inspection", "historical-hotspots-report.json",
);
const failureDir = path.join(functionsDir, "data", "migration");
const thaiFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Bangkok", calendar: "gregory", numberingSystem: "latn",
  year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit",
  minute: "2-digit", hourCycle: "h23",
});

const text = (value) => value == null ? "" : String(value).trim();

function getMode() {
  const args = new Set(process.argv.slice(2));
  if (args.has("--help")) {
    console.log("Use --canary, or use --import --confirm for the full import.");
    process.exit(0);
  }
  if (args.has("--canary") && !args.has("--import") && !args.has("--confirm")) {
    return "canary";
  }
  if (args.has("--import") && args.has("--confirm") && !args.has("--canary")) {
    return "import";
  }
  throw new Error(
    "Choose --canary, or provide both --import and --confirm.",
  );
}

async function readApprovedReport() {
  let report;
  try {
    report = JSON.parse(await readFile(reportPath, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read approved dry-run report: ${error.message}`);
  }

  const expected = {
    inputRows: EXPECTED_ROWS, validRows: EXPECTED_ROWS, invalidRows: 0,
    uniqueCanonicalIds: EXPECTED_ROWS, duplicateCanonicalIds: 0,
    uniqueHotspotIds: EXPECTED_ROWS, duplicateHotspotIds: 0,
    uniqueCoordinateKeys: EXPECTED_ROWS, duplicateCoordinateKeys: 0,
    missingRequiredValues: 0, invalidThaiDateTime: 0,
  };
  for (const [key, value] of Object.entries(expected)) {
    if (report?.stats?.[key] !== value) {
      throw new Error(`Dry-run report is not approved: stats.${key} must be ${value}.`);
    }
  }
  if (JSON.stringify(report.source?.expected_headers) !== JSON.stringify(HEADERS)) {
    throw new Error("Dry-run report schema does not match the importer.");
  }
  return report;
}

async function readSheet() {
  const auth = new google.auth.GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });
  const sheets = google.sheets({version: "v4", auth});
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID, range: SOURCE_RANGE, majorDimension: "ROWS",
    valueRenderOption: "UNFORMATTED_VALUE",
  });
  return response.data.values ?? [];
}

function finite(value, field, rowNumber) {
  const raw = text(value);
  const number = Number(raw);
  if (!raw || !Number.isFinite(number)) {
    throw new Error(`Row ${rowNumber}: ${field} must be a finite number.`);
  }
  return number;
}

function utcMinute(value, rowNumber) {
  const raw = text(value);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z$/.test(raw)) {
    throw new Error(`Row ${rowNumber}: acq_datetime_utc has an invalid format.`);
  }
  const date = new Date(raw);
  if (Number.isNaN(date.getTime()) || date.toISOString() !== raw) {
    throw new Error(`Row ${rowNumber}: acq_datetime_utc is invalid.`);
  }
  return {raw, date};
}

function thaiDateTime(date) {
  const parts = thaiFormatter.formatToParts(date);
  const values = Object.fromEntries(
    parts.filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return {
    date: `${values.year}-${values.month}-${values.day}`,
    time: `${values.hour}:${values.minute}`,
  };
}

function coordinate(value) {
  const rounded = Number(value.toFixed(5));
  return (Object.is(rounded, -0) ? 0 : rounded).toFixed(5);
}

function identity(latitude, longitude, utc) {
  const canonicalInput = ["N21", coordinate(latitude), coordinate(longitude), utc]
    .join("|");
  const digest = createHash("sha256").update(canonicalInput, "utf8")
    .digest("hex").slice(0, 32);
  return {canonicalInput, canonicalId: `N21_${digest}`};
}

function addDaily(daily, dateTh, province, confidence, frp) {
  const id = `${dateTh}__${encodeURIComponent(province)}`;
  const stat = daily.get(id) ?? {
    date_th: dateTh, province_th: province, hotspot_count: 0,
    confidence_counts: {low: 0, nominal: 0, high: 0},
    frp_total_mw: 0, frp_avg_mw: 0, frp_max_mw: 0,
  };
  stat.hotspot_count += 1;
  stat.confidence_counts[confidence] += 1;
  stat.frp_total_mw += frp;
  stat.frp_avg_mw = stat.frp_total_mw / stat.hotspot_count;
  stat.frp_max_mw = Math.max(stat.frp_max_mw, frp);
  daily.set(id, stat);
}

function prepare(rows, report, importedAt) {
  if (rows.length === 0) throw new Error("The source sheet is empty.");
  if (JSON.stringify(rows[0].map(text)) !== JSON.stringify(HEADERS)) {
    throw new Error("The source header does not match the validated schema.");
  }
  if (rows.length - 1 !== EXPECTED_ROWS) {
    throw new Error(`The source has ${rows.length - 1} rows; expected ${EXPECTED_ROWS}.`);
  }

  const records = [];
  const daily = new Map();
  const seenCanonical = new Set();
  const seenHotspot = new Set();
  const seenCoordinate = new Set();
  const provinces = new Set();

  for (let index = 1; index < rows.length; index += 1) {
    const rowNumber = index + 1;
    const row = rows[index] ?? [];
    if (row.length !== HEADERS.length) {
      throw new Error(`Row ${rowNumber}: expected ${HEADERS.length} columns.`);
    }
    const values = row.map(text);
    const missing = HEADERS.findIndex((_, i) => !values[i]);
    if (missing !== -1) throw new Error(`Row ${rowNumber}: ${HEADERS[missing]} is missing.`);

    const latitude = finite(row[0], "latitude", rowNumber);
    const longitude = finite(row[1], "longitude", rowNumber);
    const utc = utcMinute(row[2], rowNumber);
    const thai = thaiDateTime(utc.date);
    const confidence = values[5];
    const frp = finite(row[6], "frp_mw", rowNumber);
    const hotspotId = values[7];
    const province = values[8];
    if (latitude < -90 || latitude > 90) throw new Error(`Row ${rowNumber}: latitude is out of range.`);
    if (longitude < -180 || longitude > 180) throw new Error(`Row ${rowNumber}: longitude is out of range.`);
    if (frp < 0) throw new Error(`Row ${rowNumber}: frp_mw cannot be negative.`);
    if (!["low", "nominal", "high"].includes(confidence)) {
      throw new Error(`Row ${rowNumber}: confidence is invalid.`);
    }
    if (values[3] !== thai.date || values[4] !== thai.time) {
      throw new Error(`Row ${rowNumber}: Thai date/time does not match UTC.`);
    }

    const key = [coordinate(latitude), coordinate(longitude), utc.raw].join("|");
    const {canonicalId, canonicalInput} = identity(latitude, longitude, utc.raw);
    if (seenCanonical.has(canonicalId)) throw new Error(`Row ${rowNumber}: duplicate canonical_id.`);
    if (seenHotspot.has(hotspotId)) throw new Error(`Row ${rowNumber}: duplicate hotspot_id.`);
    if (seenCoordinate.has(key)) throw new Error(`Row ${rowNumber}: duplicate coordinate/time key.`);
    seenCanonical.add(canonicalId);
    seenHotspot.add(hotspotId);
    seenCoordinate.add(key);
    provinces.add(province);

    records.push({
      rowNumber, canonicalId, hotspotId, utcRaw: utc.raw, canonicalInput,
      document: {
        latitude, longitude, acq_datetime_utc: Timestamp.fromDate(utc.date),
        acq_date_th: values[3], acq_time_th: values[4], confidence, frp_mw: frp,
        hotspot_id: hotspotId, province_th: values[8], district_th: values[9],
        subdistrict_th: values[10], canonical_id: canonicalId, source: SOURCE,
        source_mode: SOURCE_MODE, boundary_version: BOUNDARY_VERSION,
        imported_at: importedAt,
      },
    });
    addDaily(daily, values[3], province, confidence, frp);
  }

  if (seenCanonical.size !== report.stats.uniqueCanonicalIds) {
    throw new Error("The source canonical ID count no longer matches the report.");
  }
  if (provinces.size !== EXPECTED_PROVINCES) {
    throw new Error(`The source contains ${provinces.size} provinces; expected ${EXPECTED_PROVINCES}.`);
  }
  for (const sample of report.canonical_samples ?? []) {
    const record = records[sample.row - 2];
    if (!record || record.hotspotId !== sample.hotspot_id || record.canonicalId !== sample.canonical_id) {
      throw new Error(`The canonical sample at row ${sample.row} changed.`);
    }
  }
  for (const stat of daily.values()) {
    stat.source = SOURCE; stat.source_mode = SOURCE_MODE;
    stat.boundary_version = BOUNDARY_VERSION; stat.updated_at = importedAt;
  }
  return {records, daily, provinces};
}

function firestore() {
  const projectId = process.env.GCLOUD_PROJECT ?? process.env.GCP_PROJECT ?? PROJECT_ID;
  const app = getApps()[0] ?? initializeApp({credential: applicationDefault(), projectId});
  return getFirestore(app);
}

async function count(db, collection) {
  return (await db.collection(collection).count().get()).data().count;
}

async function canary() {
  const db = firestore();
  const ref = db.collection("etl_canaries").doc(`historical-${Date.now()}`);
  let written = false;
  try {
    await ref.set({source: SOURCE, purpose: "historical-import-canary", created_at: Timestamp.now()});
    written = true;
    if (!(await ref.get()).exists) throw new Error("Canary document could not be read.");
    console.log(`Canary write/read succeeded: ${ref.path}`);
  } finally {
    if (written) { await ref.delete(); console.log("Canary document deleted."); }
  }
}

async function saveFailures(runId, failures) {
  if (failures.length === 0) return null;
  await mkdir(failureDir, {recursive: true});
  const file = path.join(failureDir, `historical-failed-${runId}.jsonl`);
  await writeFile(file, `${failures.map(JSON.stringify).join("\n")}\n`, "utf8");
  return file;
}

async function importData(db, prepared, report) {
  const run = db.collection("etl_runs").doc();
  const startedAt = Timestamp.now();
  const failures = [];
  await run.set({
    run_id: run.id, status: "running", source_name: SOURCE, source_mode: SOURCE_MODE,
    source: {spreadsheet_id: SPREADSHEET_ID, sheet_name: SHEET_NAME, range: SOURCE_RANGE, expected_data_rows: EXPECTED_ROWS},
    started_at: startedAt,
    metrics: {input_rows: prepared.records.length, daily_stat_documents: prepared.daily.size, provinces: prepared.provinces.size},
  });

  try {
    const writer = db.bulkWriter();
    writer.onWriteError((error) => {
      const retryable = new Set(["aborted", "deadline-exceeded", "internal", "resource-exhausted", "unavailable"]);
      const retry = retryable.has(String(error.code).toLowerCase()) && error.failedAttempts < MAX_RETRIES;
      if (!retry) failures.push({path: error.documentRef.path, code: error.code, failed_attempts: error.failedAttempts, message: error.message});
      return retry;
    });
    let pending = 0;
    const flush = async () => { if (pending >= FLUSH_SIZE) { await writer.flush(); pending = 0; } };
    for (const record of prepared.records) {
      writer.set(db.collection("hotspots").doc(record.canonicalId), record.document);
      pending += 1; await flush();
    }
    for (const [id, stat] of prepared.daily) {
      writer.set(db.collection("hotspot_daily_stats").doc(id), stat);
      pending += 1; await flush();
    }
    await writer.close();
    if (failures.length) throw new Error(`${failures.length} Firestore writes failed after retries.`);

    const rawCount = await count(db, "hotspots");
    const dailyCount = await count(db, "hotspot_daily_stats");
    const aggregateTotal = [...prepared.daily.values()].reduce((sum, stat) => sum + stat.hotspot_count, 0);
    if (rawCount !== EXPECTED_ROWS) throw new Error(`Raw count ${rawCount}; expected ${EXPECTED_ROWS}.`);
    if (dailyCount !== prepared.daily.size) throw new Error(`Daily-stat count ${dailyCount}; expected ${prepared.daily.size}.`);
    if (aggregateTotal !== EXPECTED_ROWS) throw new Error(`Daily aggregate total ${aggregateTotal}; expected ${EXPECTED_ROWS}.`);
    for (const record of prepared.records.slice(0, 5)) {
      const snapshot = await db.collection("hotspots").doc(record.canonicalId).get();
      const data = snapshot.data();
      if (!snapshot.exists || !data || data.hotspot_id !== record.hotspotId || data.canonical_id !== record.canonicalId || data.acq_datetime_utc?.toDate?.().toISOString() !== record.utcRaw) {
        throw new Error(`Verification sample failed: ${record.canonicalId}`);
      }
    }
    await run.set({
      status: "succeeded", finished_at: Timestamp.now(),
      metrics: {input_rows: prepared.records.length, imported_rows: rawCount, daily_stat_documents: dailyCount, aggregate_total: aggregateTotal, provinces: prepared.provinces.size, report_generated_at_utc: report.generated_at_utc},
    }, {merge: true});
    console.log(`Historical import succeeded. Run ID: ${run.id}`);
    console.log(`Raw documents: ${rawCount}; daily-stat documents: ${dailyCount}; provinces: ${prepared.provinces.size}`);
  } catch (error) {
    await run.set({status: "failed", finished_at: Timestamp.now(), error: error.message, failure_file: await saveFailures(run.id, failures)}, {merge: true});
    throw error;
  }
}

async function main() {
  const mode = getMode();
  if (mode === "canary") return canary();
  const report = await readApprovedReport();
  console.log("Reading the historical Google Sheet...");
  const prepared = prepare(await readSheet(), report, Timestamp.now());
  console.log(`Validated ${prepared.records.length} rows and ${prepared.daily.size} daily-stat documents before writes.`);
  await importData(firestore(), prepared, report);
}

main().catch((error) => {
  console.error("\nHistorical migration failed:");
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
