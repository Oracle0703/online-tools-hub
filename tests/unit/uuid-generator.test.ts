import { describe, expect, it } from "vitest";

import {
  generateUuidV4,
  isUuidV4,
  MAX_UUID_COUNT,
  uuidV4FromBytes,
  type UuidCryptoSource,
} from "../../src/tools/uuid-generator";

const UUIDS = [
  "123e4567-e89b-42d3-a456-426614174000",
  "550e8400-e29b-41d4-a716-446655440000",
  "6ba7b810-9dad-41d1-80b4-00c04fd430c8",
] as const;

function sequenceSource(values: readonly string[]): UuidCryptoSource {
  let index = 0;
  return {
    randomUUID: () => values[Math.min(index++, values.length - 1)]!,
  };
}

describe("isUuidV4", () => {
  it.each(UUIDS)("accepts valid UUID v4 %s", (uuid) => {
    expect(isUuidV4(uuid)).toBe(true);
  });

  it("accepts uppercase hexadecimal", () => {
    expect(isUuidV4(UUIDS[0].toUpperCase())).toBe(true);
  });

  it.each([
    "",
    "not-a-uuid",
    "123e4567-e89b-32d3-a456-426614174000",
    "123e4567-e89b-42d3-7456-426614174000",
    "123e4567e89b42d3a456426614174000",
    "123e4567-e89b-42d3-a456-42661417400z",
  ])("rejects invalid or non-v4 value %s", (uuid) => {
    expect(isUuidV4(uuid)).toBe(false);
  });
});

describe("uuidV4FromBytes", () => {
  it("sets the RFC 4122 version and variant bits", () => {
    expect(uuidV4FromBytes(new Uint8Array(16))).toBe(
      "00000000-0000-4000-8000-000000000000",
    );
  });

  it("does not mutate the caller's byte array", () => {
    const bytes = Uint8Array.from({ length: 16 }, (_, index) => index * 17);
    const before = Uint8Array.from(bytes);
    uuidV4FromBytes(bytes);
    expect(bytes).toEqual(before);
  });

  it.each([0, 15, 17, 32])("rejects a %i-byte input", (length) => {
    expect(() => uuidV4FromBytes(new Uint8Array(length))).toThrow(RangeError);
  });
});

describe("generateUuidV4", () => {
  it("uses the runtime browser-compatible crypto source by default", () => {
    const result = generateUuidV4();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.every(isUuidV4)).toBe(true);
  });

  it("generates one UUID by default", () => {
    expect(generateUuidV4(undefined, sequenceSource([UUIDS[0]]))).toEqual({
      ok: true,
      value: [UUIDS[0]],
    });
  });

  it("generates a requested batch in source order", () => {
    expect(generateUuidV4(3, sequenceSource(UUIDS))).toEqual({
      ok: true,
      value: [...UUIDS],
    });
  });

  it("normalizes valid uppercase results to lowercase", () => {
    expect(generateUuidV4(1, sequenceSource([UUIDS[0].toUpperCase()]))).toEqual(
      { ok: true, value: [UUIDS[0]] },
    );
  });

  it("retries a duplicate and returns unique values", () => {
    const result = generateUuidV4(
      3,
      sequenceSource([UUIDS[0], UUIDS[0], UUIDS[1], UUIDS[2]]),
    );
    expect(result).toEqual({ ok: true, value: [...UUIDS] });
  });

  it("stops when a source continuously returns duplicates", () => {
    expect(generateUuidV4(2, sequenceSource([UUIDS[0]]))).toMatchObject({
      ok: false,
      error: { code: "duplicate-exhausted" },
    });
  });

  it.each([0, -1, MAX_UUID_COUNT + 1, 1.5, Number.NaN, Infinity])(
    "rejects invalid count %s",
    (count) => {
      expect(generateUuidV4(count, sequenceSource(UUIDS))).toMatchObject({
        ok: false,
        error: { code: "invalid-count" },
      });
    },
  );

  it("reports when no secure source is available", () => {
    expect(generateUuidV4(1, {})).toMatchObject({
      ok: false,
      error: { code: "crypto-unavailable" },
    });
  });

  it("uses getRandomValues when randomUUID is unavailable", () => {
    const source: UuidCryptoSource = {
      getRandomValues(array) {
        array.fill(0xff);
        return array;
      },
    };
    const result = generateUuidV4(1, source);
    expect(result).toEqual({
      ok: true,
      value: ["ffffffff-ffff-4fff-bfff-ffffffffffff"],
    });
  });

  it("falls back to getRandomValues when randomUUID throws", () => {
    const source: UuidCryptoSource = {
      randomUUID: () => {
        throw new Error("blocked");
      },
      getRandomValues: (array) => array,
    };
    expect(generateUuidV4(1, source)).toEqual({
      ok: true,
      value: ["00000000-0000-4000-8000-000000000000"],
    });
  });

  it("falls back when randomUUID returns a malformed value", () => {
    const source: UuidCryptoSource = {
      randomUUID: () => "not-a-uuid",
      getRandomValues: (array) => array,
    };
    expect(generateUuidV4(1, source)).toMatchObject({ ok: true });
  });

  it("reports a randomUUID failure when there is no fallback", () => {
    expect(
      generateUuidV4(1, {
        randomUUID: () => {
          throw new Error("failure");
        },
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "generation-failed" },
    });
  });

  it("rejects a malformed randomUUID result without a fallback", () => {
    expect(generateUuidV4(1, { randomUUID: () => "uuid-ish" })).toMatchObject({
      ok: false,
      error: { code: "invalid-result" },
    });
  });

  it("reports a getRandomValues exception", () => {
    expect(
      generateUuidV4(1, {
        getRandomValues: () => {
          throw new Error("entropy unavailable");
        },
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "generation-failed" },
    });
  });

  it("rejects a random byte array with the wrong length", () => {
    expect(
      generateUuidV4(1, {
        getRandomValues: () => new Uint8Array(8),
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "invalid-result" },
    });
  });

  it("generates the maximum batch with no duplicates", () => {
    let counter = 0;
    const source: UuidCryptoSource = {
      getRandomValues(array) {
        const value = counter++;
        array[12] = (value >>> 24) & 0xff;
        array[13] = (value >>> 16) & 0xff;
        array[14] = (value >>> 8) & 0xff;
        array[15] = value & 0xff;
        return array;
      },
    };
    const result = generateUuidV4(MAX_UUID_COUNT, source);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(MAX_UUID_COUNT);
      expect(new Set(result.value).size).toBe(MAX_UUID_COUNT);
      expect(result.value.every(isUuidV4)).toBe(true);
    }
  });
});
