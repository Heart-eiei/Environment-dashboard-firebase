type AcqTimeInput = string | number;

export type ThailandTimeResult = {
  acqDatetimeUtc: string;
  acqDateTh: string;
  acqTimeTh: string;
};

const ACQ_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function parseAcqDate(value: string): {
  year: number;
  month: number;
  day: number;
} {
  const match = ACQ_DATE_RE.exec(value.trim());

  if (!match) {
    throw new Error("acq_date must use YYYY-MM-DD format");
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  const checkDate = new Date(Date.UTC(year, month - 1, day));

  if (
    Number.isNaN(checkDate.getTime()) ||
    checkDate.getUTCFullYear() !== year ||
    checkDate.getUTCMonth() !== month - 1 ||
    checkDate.getUTCDate() !== day
  ) {
    throw new Error("acq_date is invalid");
  }

  return {year, month, day};
}

function parseAcqTime(value: AcqTimeInput): {
  hour: number;
  minute: number;
} {
  const raw = String(value).trim();

  if (!/^\d+$/.test(raw)) {
    throw new Error("acq_time must contain only digits");
  }

  const padded = raw.padStart(4, "0");

  if (padded.length !== 4) {
    throw new Error("acq_time must be a maximum of four digits");
  }

  const hour = Number(padded.slice(0, 2));
  const minute = Number(padded.slice(2, 4));

  if (hour > 23 || minute > 59) {
    throw new Error("acq_time is invalid");
  }

  return {hour, minute};
}

function formatThailandTime(date: Date): {
  date: string;
  time: string;
} {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });

  const parts = formatter.formatToParts(date);
  const values = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  ) as Record<string, string>;

  return {
    date: `${values.year}-${values.month}-${values.day}`,
    time: `${values.hour}:${values.minute}`,
  };
}

export function convertFirmsTime(
  acqDate: string,
  acqTime: AcqTimeInput,
): ThailandTimeResult {
  const {year, month, day} = parseAcqDate(acqDate);
  const {hour, minute} = parseAcqTime(acqTime);

  const utcDate = new Date(
    Date.UTC(year, month - 1, day, hour, minute),
  );

  const acqDatetimeUtc = utcDate.toISOString().replace(".000Z", "Z");
  const thailand = formatThailandTime(utcDate);

  return {
    acqDatetimeUtc,
    acqDateTh: thailand.date,
    acqTimeTh: thailand.time,
  };
}
