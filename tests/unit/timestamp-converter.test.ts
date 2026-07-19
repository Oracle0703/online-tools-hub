import { describe, expect, it } from "vitest";

import {
  AUTO_MILLISECONDS_THRESHOLD,
  convertDateTime,
  convertTimestamp,
  detectTimestampUnit,
  getLocalTimeZone,
  MAX_DATE_MILLISECONDS,
  toDateTimeLocalValue,
} from "../../src/tools/timestamp-converter";

const UTC_OPTIONS = { timeZone: "UTC", locale: "en-CA" } as const;

describe("detectTimestampUnit", () => {
  it.each([
    [0, "seconds"],
    [1_710_000_000, "seconds"],
    [-1_710_000_000, "seconds"],
    [AUTO_MILLISECONDS_THRESHOLD - 1, "seconds"],
    [-(AUTO_MILLISECONDS_THRESHOLD - 1), "seconds"],
    [AUTO_MILLISECONDS_THRESHOLD, "milliseconds"],
    [-AUTO_MILLISECONDS_THRESHOLD, "milliseconds"],
    [1_710_000_000_000, "milliseconds"],
  ] as const)("detects %s as %s", (input, expected) => {
    expect(detectTimestampUnit(input)).toBe(expected);
  });
});

describe("convertTimestamp", () => {
  it("uses the runtime zone only when no display zone is supplied", () => {
    const result = convertTimestamp(0, "seconds");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.timeZone).toBe(getLocalTimeZone());
      expect(result.value.local).toMatch(
        /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} /,
      );
    }
  });

  it("converts the Unix epoch without depending on the runtime time zone", () => {
    expect(convertTimestamp("0", "auto", UTC_OPTIONS)).toEqual({
      ok: true,
      value: {
        seconds: 0,
        milliseconds: 0,
        resolvedUnit: "seconds",
        iso: "1970-01-01T00:00:00.000Z",
        utc: "Thu, 01 Jan 1970 00:00:00 GMT",
        local: "1970-01-01 00:00:00.000 UTC",
        timeZone: "UTC",
      },
    });
  });

  it("handles a negative timestamp before 1970", () => {
    const result = convertTimestamp(-1, "seconds", UTC_OPTIONS);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toMatchObject({
        milliseconds: -1_000,
        seconds: -1,
        iso: "1969-12-31T23:59:59.000Z",
      });
    }
  });

  it("pads early common-era years and labels BCE local output", () => {
    const early = convertTimestamp(
      -59_042_995_200_000,
      "milliseconds",
      UTC_OPTIONS,
    );
    const yearZero = convertTimestamp(
      -62_167_219_200_000,
      "milliseconds",
      UTC_OPTIONS,
    );

    expect(early.ok && early.value.local).toBe("0099-01-01 00:00:00.000 UTC");
    expect(yearZero.ok && yearZero.value.local).toBe(
      "BC 0001-01-01 00:00:00.000 UTC",
    );
  });

  it("preserves millisecond precision for fractional seconds", () => {
    const result = convertTimestamp("1.234", "seconds", UTC_OPTIONS);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toMatchObject({
        milliseconds: 1_234,
        seconds: 1.234,
        iso: "1970-01-01T00:00:01.234Z",
      });
    }
  });

  it("applies Date TimeClip to sub-millisecond input", () => {
    const result = convertTimestamp("1.9", "milliseconds", UTC_OPTIONS);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.milliseconds).toBe(1);
  });

  it("allows an explicit seconds override beyond the auto threshold", () => {
    const result = convertTimestamp(
      AUTO_MILLISECONDS_THRESHOLD,
      "seconds",
      UTC_OPTIONS,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.resolvedUnit).toBe("seconds");
      expect(result.value.milliseconds).toBe(
        AUTO_MILLISECONDS_THRESHOLD * 1_000,
      );
    }
  });

  it("allows an explicit milliseconds override below the auto threshold", () => {
    const result = convertTimestamp(1_000, "milliseconds", UTC_OPTIONS);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toMatchObject({
        resolvedUnit: "milliseconds",
        seconds: 1,
        iso: "1970-01-01T00:00:01.000Z",
      });
    }
  });

  it("formats a fixed positive-offset time zone deterministically", () => {
    const result = convertTimestamp(0, "seconds", {
      timeZone: "Asia/Shanghai",
      locale: "en-CA",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.local).toBe("1970-01-01 08:00:00.000 UTC+08:00");
      expect(result.value.timeZone).toBe("Asia/Shanghai");
    }
  });

  it("formats daylight-saving offsets for an explicit IANA zone", () => {
    const winter = convertTimestamp(1_704_067_200, "seconds", {
      timeZone: "America/New_York",
      locale: "en-CA",
    });
    const summer = convertTimestamp(1_719_792_000, "seconds", {
      timeZone: "America/New_York",
      locale: "en-CA",
    });
    expect(winter.ok && winter.value.local).toContain("UTC-05:00");
    expect(summer.ok && summer.value.local).toContain("UTC-04:00");
  });

  it.each(["", "   ", "hello", "1 2", "0x10", "NaN", "Infinity", "--1"])(
    "rejects invalid numeric input %j",
    (input) => {
      expect(convertTimestamp(input, "auto", UTC_OPTIONS)).toMatchObject({
        ok: false,
      });
    },
  );

  it("rejects a numeric Infinity value", () => {
    expect(convertTimestamp(Infinity, "seconds", UTC_OPTIONS)).toMatchObject({
      ok: false,
      error: { code: "invalid-number" },
    });
  });

  it("accepts the maximum Date millisecond boundary", () => {
    const result = convertTimestamp(
      MAX_DATE_MILLISECONDS,
      "milliseconds",
      UTC_OPTIONS,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.iso).toBe("+275760-09-13T00:00:00.000Z");
    }
  });

  it.each([
    [MAX_DATE_MILLISECONDS + 1, "milliseconds"],
    [-(MAX_DATE_MILLISECONDS + 1), "milliseconds"],
    [MAX_DATE_MILLISECONDS / 1_000 + 1, "seconds"],
  ] as const)("rejects out-of-range value %s %s", (input, unit) => {
    expect(convertTimestamp(input, unit, UTC_OPTIONS)).toMatchObject({
      ok: false,
      error: { code: "out-of-range" },
    });
  });

  it("reports an invalid IANA time zone", () => {
    expect(
      convertTimestamp(0, "seconds", { timeZone: "Mars/Olympus_Mons" }),
    ).toMatchObject({
      ok: false,
      error: { code: "invalid-time-zone" },
    });
  });
});

describe("convertDateTime", () => {
  it.each([
    ["1970-01-01T00:00", 0, "1970-01-01T00:00:00.000Z"],
    ["1969-12-31T23:59:59", -1_000, "1969-12-31T23:59:59.000Z"],
    ["2000-02-29T12:34:56.7", 951_827_696_700, "2000-02-29T12:34:56.700Z"],
    ["2024-02-29 00:00:00.042", 1_709_164_800_042, "2024-02-29T00:00:00.042Z"],
    ["0099-01-01T00:00:00", -59_042_995_200_000, "0099-01-01T00:00:00.000Z"],
  ] as const)(
    "converts UTC date-time %s deterministically",
    (input, milliseconds, iso) => {
      const result = convertDateTime(input, "utc", UTC_OPTIONS);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.milliseconds).toBe(milliseconds);
        expect(result.value.iso).toBe(iso);
      }
    },
  );

  it.each([
    "",
    "2024-01-01",
    "2024/01/01 00:00",
    "2023-02-29T00:00",
    "2024-02-30T00:00",
    "2024-13-01T00:00",
    "2024-00-01T00:00",
    "2024-01-00T00:00",
    "2024-01-01T24:00",
    "2024-01-01T23:60",
    "2024-01-01T23:59:60",
    "2024-01-01T00:00:00.1234",
  ])("rejects invalid calendar input %j", (input) => {
    expect(convertDateTime(input, "utc", UTC_OPTIONS)).toMatchObject({
      ok: false,
    });
  });

  it("rejects a syntactically valid but out-of-range year", () => {
    expect(
      convertDateTime("999999-01-01T00:00", "utc", UTC_OPTIONS),
    ).toMatchObject({
      ok: false,
      error: { code: "out-of-range" },
    });
  });
});

describe("toDateTimeLocalValue", () => {
  it("formats UTC fields for a datetime-local control deterministically", () => {
    expect(
      toDateTimeLocalValue(new Date("2024-03-04T05:06:07.890Z"), "utc"),
    ).toBe("2024-03-04T05:06:07");
  });

  it("returns an empty value for an invalid Date", () => {
    expect(toDateTimeLocalValue(new Date(Number.NaN), "utc")).toBe("");
  });

  it("returns an empty value for years unsupported by datetime-local", () => {
    const yearZero = new Date(0);
    yearZero.setUTCFullYear(0, 0, 1);
    yearZero.setUTCHours(0, 0, 0, 0);

    expect(toDateTimeLocalValue(yearZero, "utc")).toBe("");
    expect(
      toDateTimeLocalValue(new Date("+010000-01-01T00:00:00.000Z"), "utc"),
    ).toBe("");
  });

  it("round-trips an ordinary local wall time in any runtime zone", () => {
    const date = new Date(2024, 0, 15, 12, 34, 56, 0);
    const input = toDateTimeLocalValue(date, "local");
    const result = convertDateTime(input, "local", UTC_OPTIONS);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.milliseconds).toBe(date.getTime());
  });
});
