export const MAX_DATE_MILLISECONDS = 8_640_000_000_000_000;
export const AUTO_MILLISECONDS_THRESHOLD = 100_000_000_000;

export type TimestampUnit = "auto" | "seconds" | "milliseconds";
export type ResolvedTimestampUnit = Exclude<TimestampUnit, "auto">;
export type DateTimeInterpretation = "local" | "utc";

export interface TimestampFormatOptions {
  /** IANA time zone used for the local-time display. Defaults to this browser's time zone. */
  timeZone?: string;
  /** Locale passed to Intl. Numbering stays Latin/Gregorian for a stable machine-readable display. */
  locale?: string;
}

export interface TimestampDetails {
  seconds: number;
  milliseconds: number;
  resolvedUnit: ResolvedTimestampUnit;
  iso: string;
  utc: string;
  local: string;
  timeZone: string;
}

export type TimestampErrorCode =
  | "empty-input"
  | "invalid-number"
  | "invalid-date-time"
  | "out-of-range"
  | "invalid-time-zone";

export interface TimestampError {
  code: TimestampErrorCode;
  message: string;
}

export type TimestampConversionResult =
  { ok: true; value: TimestampDetails } | { ok: false; error: TimestampError };

const NUMBER_PATTERN = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;
const DATE_TIME_PATTERN =
  /^(\d{4,6})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/;

/** Returns the browser's IANA time-zone identifier without persisting it. */
export function getLocalTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "本地时区";
  } catch {
    return "本地时区";
  }
}

/**
 * Converts a Unix timestamp to local, UTC, and ISO representations.
 *
 * Auto mode treats values whose absolute magnitude is at least 100 billion as
 * milliseconds. This correctly recognizes contemporary 10-digit seconds and
 * 13-digit milliseconds while leaving an explicit override for historic or
 * far-future values.
 */
export function convertTimestamp(
  input: string | number,
  unit: TimestampUnit = "auto",
  options: TimestampFormatOptions = {},
): TimestampConversionResult {
  const parsed = parseNumericInput(input);
  if (!parsed.ok) return parsed;

  const resolvedUnit =
    unit === "auto" ? detectTimestampUnit(parsed.value) : unit;
  const rawMilliseconds =
    resolvedUnit === "seconds" ? parsed.value * 1_000 : parsed.value;

  return createTimestampDetails(rawMilliseconds, resolvedUnit, options);
}

/** Converts a calendar date/time back to Unix seconds and milliseconds. */
export function convertDateTime(
  input: string,
  interpretation: DateTimeInterpretation = "local",
  options: TimestampFormatOptions = {},
): TimestampConversionResult {
  const trimmed = input.trim();
  const match = DATE_TIME_PATTERN.exec(trimmed);

  if (!match) {
    return failure(
      "invalid-date-time",
      "请输入 YYYY-MM-DDTHH:mm，可选秒和 1–3 位毫秒。",
    );
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6] ?? "0");
  const millisecond = Number((match[7] ?? "").padEnd(3, "0") || "0");

  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return failure("invalid-date-time", "日期或时间字段超出有效范围。");
  }

  const date = new Date(0);
  if (interpretation === "utc") {
    date.setUTCFullYear(year, month - 1, day);
    date.setUTCHours(hour, minute, second, millisecond);
  } else {
    date.setFullYear(year, month - 1, day);
    date.setHours(hour, minute, second, millisecond);
  }

  const milliseconds = date.getTime();
  if (!Number.isFinite(milliseconds)) {
    return failure("out-of-range", "日期超出 JavaScript Date 可表示的范围。");
  }

  const getters =
    interpretation === "utc"
      ? [
          date.getUTCFullYear(),
          date.getUTCMonth() + 1,
          date.getUTCDate(),
          date.getUTCHours(),
          date.getUTCMinutes(),
          date.getUTCSeconds(),
          date.getUTCMilliseconds(),
        ]
      : [
          date.getFullYear(),
          date.getMonth() + 1,
          date.getDate(),
          date.getHours(),
          date.getMinutes(),
          date.getSeconds(),
          date.getMilliseconds(),
        ];

  if (
    getters[0] !== year ||
    getters[1] !== month ||
    getters[2] !== day ||
    getters[3] !== hour ||
    getters[4] !== minute ||
    getters[5] !== second ||
    getters[6] !== millisecond
  ) {
    return failure(
      "invalid-date-time",
      "日期不存在，或该本地时间受夏令时切换影响而不存在。",
    );
  }

  return createTimestampDetails(milliseconds, "milliseconds", options);
}

/** Formats a Date for a datetime-local input without introducing UTC shifts. */
export function toDateTimeLocalValue(
  date: Date,
  interpretation: DateTimeInterpretation = "local",
): string {
  if (Number.isNaN(date.getTime())) return "";

  const read = (local: () => number, utc: () => number) =>
    interpretation === "utc" ? utc() : local();
  const year = read(
    () => date.getFullYear(),
    () => date.getUTCFullYear(),
  );
  const month = read(
    () => date.getMonth() + 1,
    () => date.getUTCMonth() + 1,
  );
  const day = read(
    () => date.getDate(),
    () => date.getUTCDate(),
  );
  const hour = read(
    () => date.getHours(),
    () => date.getUTCHours(),
  );
  const minute = read(
    () => date.getMinutes(),
    () => date.getUTCMinutes(),
  );
  const second = read(
    () => date.getSeconds(),
    () => date.getUTCSeconds(),
  );

  if (year < 1 || year > 9_999) return "";

  return `${padYear(year)}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:${pad(second)}`;
}

export function detectTimestampUnit(value: number): ResolvedTimestampUnit {
  return Math.abs(value) >= AUTO_MILLISECONDS_THRESHOLD
    ? "milliseconds"
    : "seconds";
}

function parseNumericInput(
  input: string | number,
): { ok: true; value: number } | { ok: false; error: TimestampError } {
  if (typeof input === "string") {
    const trimmed = input.trim();
    if (!trimmed) return failure("empty-input", "请先输入 Unix 时间戳。");
    if (!NUMBER_PATTERN.test(trimmed)) {
      return failure("invalid-number", "时间戳必须是有限的十进制数字。");
    }
    input = Number(trimmed);
  }

  if (!Number.isFinite(input)) {
    return failure("invalid-number", "时间戳必须是有限的十进制数字。");
  }

  return { ok: true, value: input };
}

function createTimestampDetails(
  rawMilliseconds: number,
  resolvedUnit: ResolvedTimestampUnit,
  options: TimestampFormatOptions,
): TimestampConversionResult {
  if (
    !Number.isFinite(rawMilliseconds) ||
    Math.abs(rawMilliseconds) > MAX_DATE_MILLISECONDS
  ) {
    return failure("out-of-range", "时间戳超出 JavaScript Date 可表示的范围。");
  }

  const date = new Date(rawMilliseconds);
  const milliseconds = date.getTime();
  if (!Number.isFinite(milliseconds)) {
    return failure("out-of-range", "时间戳超出 JavaScript Date 可表示的范围。");
  }

  const timeZone = options.timeZone ?? getLocalTimeZone();
  let local: string;
  try {
    local = formatInTimeZone(
      date,
      timeZone === "本地时区" ? undefined : timeZone,
      options.locale,
    );
  } catch {
    return failure("invalid-time-zone", "无法识别指定的 IANA 时区。");
  }

  return {
    ok: true,
    value: {
      seconds: milliseconds / 1_000,
      milliseconds,
      resolvedUnit,
      iso: date.toISOString(),
      utc: date.toUTCString(),
      local,
      timeZone,
    },
  };
}

function formatInTimeZone(
  date: Date,
  timeZone?: string,
  locale = "zh-CN",
): string {
  const formatter = new Intl.DateTimeFormat(locale, {
    timeZone,
    calendar: "gregory",
    numberingSystem: "latn",
    era: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
    hourCycle: "h23",
    timeZoneName: "longOffset",
  });
  const parts = formatter.formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  const rawZone = value("timeZoneName");
  const rawYear = value("year");
  const numericYear = Number(rawYear.replaceAll(",", ""));
  const displayYear = Number.isFinite(numericYear)
    ? String(numericYear).padStart(4, "0")
    : rawYear;
  const era = value("era");
  const eraPrefix = era && !/^(?:AD|CE|公元)$/iu.test(era) ? `${era} ` : "";
  const zone =
    /^GMT(?:[+-]00(?::?00)?)?$/.test(rawZone) || rawZone === "UTC"
      ? "UTC"
      : rawZone.replace(/^GMT/, "UTC") || "本地时间";

  return `${eraPrefix}${displayYear}-${value("month")}-${value("day")} ${value("hour")}:${value("minute")}:${value("second")}.${value("fractionalSecond")} ${zone}`;
}

function failure(
  code: TimestampErrorCode,
  message: string,
): { ok: false; error: TimestampError } {
  return { ok: false, error: { code, message } };
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function padYear(value: number): string {
  const sign = value < 0 ? "-" : "";
  return `${sign}${String(Math.abs(value)).padStart(4, "0")}`;
}
