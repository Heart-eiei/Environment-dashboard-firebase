import { createWriteStream } from "node:fs";
import { mkdir, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SERVICE_URL =
  "https://gistdaportal.gistda.or.th/arcgis/rest/services/" +
  "%E0%B8%82%E0%B9%89%E0%B8%AD%E0%B8%A1%E0%B8%B9%E0%B8%A5%E0%B9%80%E0%B8%82%E0%B8%95%E0%B8%81%E0%B8%B2%E0%B8%A3%E0%B8%9B%E0%B8%81%E0%B8%84%E0%B8%A3%E0%B8%AD%E0%B8%87/MapServer";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const FUNCTIONS_DIR = path.resolve(SCRIPT_DIR, "..");
const OUTPUT_DIR = path.join(FUNCTIONS_DIR, "data", "boundaries");

const OBJECT_ID_CHUNK_SIZE = 50;
const MAX_ATTEMPTS = 3;
const REQUEST_TIMEOUT_MS = 120_000;

const layers = [
  {
    id: 2,
    fileName: "province.json",
    level: "province",
    nameField: "P_Name_T",
    outFields: "P_Name_T",
  },
  {
    id: 3,
    fileName: "district.json",
    level: "district",
    nameField: "A_Name_T",
    outFields: "A_Name_T",
  },
  {
    id: 4,
    fileName: "subdistrict.json",
    level: "subdistrict",
    nameField: "T_Name_T",
    outFields: "T_Name_T",
  },
];

function sleep(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function buildObjectIdsUrl(layer) {
  const url = new URL(`${SERVICE_URL}/${layer.id}/query`);

  url.search = new URLSearchParams({
    where: "1=1",
    returnIdsOnly: "true",
    returnGeometry: "false",
    f: "json",
  }).toString();

  return url.toString();
}

function buildFeaturesUrl(layer, objectIds) {
  const url = new URL(`${SERVICE_URL}/${layer.id}/query`);

  url.search = new URLSearchParams({
    objectIds: objectIds.join(","),
    outFields: layer.outFields,
    returnGeometry: "true",
    outSR: "4326",
    f: "geojson",
  }).toString();

  return url.toString();
}

async function requestJson(url, layer, description) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, REQUEST_TIMEOUT_MS);

    let response;
    let body = "";
    let networkError = null;

    try {
      response = await fetch(url, {
        signal: controller.signal,
        headers: {
          Accept: "application/geo+json, application/json",
          "User-Agent": "environment-project-boundary-downloader",
        },
      });

      body = await response.text();
    } catch (error) {
      networkError = new Error(
        `GISTDA layer ${layer.id} ${description} request failed.\n` +
          `URL: ${url}\n` +
          errorMessage(error),
      );
    } finally {
      clearTimeout(timeout);
    }

    if (networkError) {
      if (attempt === MAX_ATTEMPTS) {
        throw networkError;
      }

      console.log(
        `Retrying layer ${layer.id} ${description} ` +
          `(${attempt}/${MAX_ATTEMPTS})...`,
      );

      await sleep(attempt * 1500);
      continue;
    }

    const preview = body.replace(/\s+/g, " ").slice(0, 800);

    if (!response.ok) {
      const message =
        `GISTDA layer ${layer.id} ${description} failed: ` +
        `${response.status} ${response.statusText}\n` +
        `URL: ${url}\n` +
        preview;

      const retryable = response.status === 429 || response.status >= 500;

      if (!retryable || attempt === MAX_ATTEMPTS) {
        throw new Error(message);
      }

      console.log(
        `Retrying layer ${layer.id} ${description} ` +
          `(${attempt}/${MAX_ATTEMPTS})...`,
      );

      await sleep(attempt * 1500);
      continue;
    }

    let payload;

    try {
      payload = JSON.parse(body);
    } catch {
      throw new Error(
        `GISTDA layer ${layer.id} returned invalid JSON.\n` +
          `URL: ${url}\n` +
          preview,
      );
    }

    if (payload.error) {
      throw new Error(
        `GISTDA layer ${layer.id} returned an ArcGIS error.\n` +
          `URL: ${url}\n` +
          JSON.stringify(payload.error),
      );
    }

    return payload;
  }

  throw new Error(`Unable to download GISTDA layer ${layer.id}.`);
}

async function getObjectIds(layer) {
  console.log(`Downloading ${layer.level} object IDs...`);

  const url = buildObjectIdsUrl(layer);
  const payload = await requestJson(url, layer, "object IDs");

  if (!Array.isArray(payload.objectIds)) {
    throw new Error(
      `GISTDA layer ${layer.id} did not return object IDs.\n` +
        JSON.stringify(payload),
    );
  }

  return payload.objectIds
    .filter((objectId) => Number.isFinite(Number(objectId)))
    .sort((first, second) => Number(first) - Number(second));
}

function validateCoordinates(value, context) {
  if (
    Array.isArray(value) &&
    value.length >= 2 &&
    typeof value[0] === "number" &&
    typeof value[1] === "number"
  ) {
    const longitude = value[0];
    const latitude = value[1];

    if (
      !Number.isFinite(longitude) ||
      !Number.isFinite(latitude) ||
      longitude < -180 ||
      longitude > 180 ||
      latitude < -90 ||
      latitude > 90
    ) {
      throw new Error(
        `${context} contains invalid WGS84 coordinates: ` +
          `${longitude}, ${latitude}`,
      );
    }

    return true;
  }

  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${context} has empty or invalid coordinates.`);
  }

  let foundPosition = false;

  for (const child of value) {
    if (validateCoordinates(child, context)) {
      foundPosition = true;
    }
  }

  return foundPosition;
}

function validateGeometry(geometry, context) {
  if (!geometry || typeof geometry !== "object") {
    throw new Error(`${context} has no geometry.`);
  }

  if (geometry.type === "GeometryCollection") {
    if (!Array.isArray(geometry.geometries)) {
      throw new Error(`${context} has invalid geometries.`);
    }

    for (const childGeometry of geometry.geometries) {
      validateGeometry(childGeometry, context);
    }

    return;
  }

  validateCoordinates(geometry.coordinates, context);
}

function normalizeFeature(layer, feature, index) {
  if (!feature || feature.type !== "Feature") {
    throw new Error(`GISTDA layer ${layer.id} feature ${index} is invalid.`);
  }

  const properties = feature.properties ?? {};
  const name = properties[layer.nameField];

  if (typeof name !== "string" || name.trim() === "") {
    throw new Error(
      `GISTDA layer ${layer.id} feature ${index} has no ` +
        `${layer.nameField} value.`,
    );
  }

  validateGeometry(
    feature.geometry,
    `GISTDA layer ${layer.id} feature ${index}`,
  );

  return {
    type: "Feature",
    id: feature.id ?? `${layer.level}-${index + 1}`,
    properties: {
      level: layer.level,
      name_th: name.trim(),
    },
    geometry: feature.geometry,
  };
}

function writeChunk(stream, chunk) {
  return new Promise((resolve, reject) => {
    let settled = false;

    const onError = (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    };

    stream.once("error", onError);

    stream.write(chunk, (error) => {
      stream.off("error", onError);

      if (settled) {
        return;
      }

      settled = true;

      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

function endStream(stream) {
  return new Promise((resolve, reject) => {
    let settled = false;

    const onError = (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    };

    stream.once("error", onError);

    stream.end((error) => {
      stream.off("error", onError);

      if (settled) {
        return;
      }

      settled = true;

      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

async function removeIfExists(filePath) {
  try {
    await unlink(filePath);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
}

async function downloadLayer(layer) {
  const objectIds = await getObjectIds(layer);

  console.log(
    `Found ${objectIds.length} ${layer.level} boundaries. ` +
      "Downloading geometry...",
  );

  const outputPath = path.join(OUTPUT_DIR, layer.fileName);
  const temporaryPath = `${outputPath}.tmp`;
  await removeIfExists(temporaryPath);

  const output = createWriteStream(temporaryPath, {
    encoding: "utf8",
  });
  const metadata = {
    source: SERVICE_URL,
    layer_id: layer.id,
    coordinate_system: "EPSG:4326",
    downloaded_at_utc: new Date().toISOString(),
  };

  let featureCount = 0;
  let isFirstFeature = true;

  try {
    await writeChunk(
      output,
      "{\n" +
        '  "type": "FeatureCollection",\n' +
        `  "name": ${JSON.stringify(`thailand_${layer.level}_boundaries`)},\n` +
        `  "metadata": ${JSON.stringify(metadata)},\n` +
        '  "features": [',
    );

    for (
      let start = 0;
      start < objectIds.length;
      start += OBJECT_ID_CHUNK_SIZE
    ) {
      const chunk = objectIds.slice(start, start + OBJECT_ID_CHUNK_SIZE);
      const chunkNumber = Math.floor(start / OBJECT_ID_CHUNK_SIZE) + 1;
      const totalChunks = Math.ceil(
        objectIds.length / OBJECT_ID_CHUNK_SIZE,
      );

      console.log(
        `Downloading ${layer.level} geometry chunk ` +
          `${chunkNumber}/${totalChunks}...`,
      );

      const url = buildFeaturesUrl(layer, chunk);
      const payload = await requestJson(
        url,
        layer,
        `geometry chunk ${chunkNumber}`,
      );

      if (
        payload.type !== "FeatureCollection" ||
        !Array.isArray(payload.features)
      ) {
        throw new Error(
          `GISTDA layer ${layer.id} did not return a valid ` +
            "GeoJSON FeatureCollection.",
        );
      }

      for (const feature of payload.features) {
        const normalizedFeature = normalizeFeature(
          layer,
          feature,
          featureCount,
        );
        const separator = isFirstFeature ? "\n    " : ",\n    ";

        await writeChunk(
          output,
          separator + JSON.stringify(normalizedFeature),
        );

        isFirstFeature = false;
        featureCount += 1;
      }

      console.log(
        `Received ${payload.features.length} features ` +
          `(total ${featureCount}).`,
      );

      await sleep(250);
    }

    await writeChunk(output, "\n  ]\n}\n");
    await endStream(output);
    await rename(temporaryPath, outputPath);

    console.log(
      `Saved ${featureCount} ${layer.level} boundaries to ` +
        outputPath,
    );
  } catch (error) {
    output.destroy();
    await removeIfExists(temporaryPath);
    throw error;
  }
}

async function main() {
  await mkdir(OUTPUT_DIR, { recursive: true });

  for (const layer of layers) {
    await downloadLayer(layer);
  }

  console.log("Boundary download completed successfully.");
}

main().catch((error) => {
  console.error("\nBoundary download failed:");
  console.error(errorMessage(error));
  process.exitCode = 1;
});
