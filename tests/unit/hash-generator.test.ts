import { webcrypto } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  bytesToHex,
  compareHashHex,
  getUtf8ByteLength,
  hashBlob,
  hashBytes,
  hashText,
  HashToolError,
  MAX_HASH_FILE_BYTES,
  type HashAlgorithm,
  type HashDigestSource,
} from "../../src/tools/hash-generator";

const digestSource = webcrypto.subtle as unknown as HashDigestSource;

// NIST/FIPS interoperability vectors for the empty message and "abc".
const OFFICIAL_TEXT_VECTORS = [
  [
    "SHA-256",
    "",
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  ],
  [
    "SHA-256",
    "abc",
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  ],
  [
    "SHA-256",
    "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq",
    "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
  ],
  [
    "SHA-512",
    "",
    "cf83e1357eefb8bdf1542850d66d8007d620e4050b5715dc83f4a921d36ce9ce47d0d13c5d85f2b0ff8318d2877eec2f63b931bd47417a81a538327af927da3e",
  ],
  [
    "SHA-512",
    "abc",
    "ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f",
  ],
] as const;

describe("hashText", () => {
  it.each(OFFICIAL_TEXT_VECTORS)(
    "matches the official %s vector for %j",
    async (algorithm, input, expected) => {
      await expect(hashText(input, algorithm, digestSource)).resolves.toBe(
        expected,
      );
    },
  );

  it("hashes Unicode as UTF-8 bytes", async () => {
    await expect(hashText("中文🙂", "SHA-256", digestSource)).resolves.toBe(
      "3f7e2b3029a16c844f54b308c8035842509a1a8d8a4f35a7548d2384f3b51901",
    );
    expect(getUtf8ByteLength("中文🙂")).toBe(10);
  });

  it("uses the current runtime Web Crypto source by default", async () => {
    await expect(hashText("abc", "SHA-256")).resolves.toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("rejects text before digest when it exceeds the supplied limit", async () => {
    const source: HashDigestSource = { digest: vi.fn() };

    await expect(hashText("四", "SHA-256", source, 2)).rejects.toMatchObject({
      name: "HashToolError",
      code: "input-too-large",
    });
    expect(source.digest).not.toHaveBeenCalled();
  });
});

describe("hashBytes and hashBlob", () => {
  it("copies only the selected ArrayBufferView bytes before digesting", async () => {
    const digest = vi.fn(
      async (_algorithm: HashAlgorithm, data: ArrayBuffer) => {
        expect([...new Uint8Array(data)]).toEqual([2, 3]);
        return new Uint8Array([0, 15, 16, 255]).buffer;
      },
    );
    const backing = new Uint8Array([1, 2, 3, 4]);

    await expect(
      hashBytes(backing.subarray(1, 3), "SHA-256", { digest }),
    ).resolves.toBe("000f10ff");
    expect(digest).toHaveBeenCalledWith("SHA-256", expect.any(ArrayBuffer));
  });

  it("copies ArrayBuffer input before passing it to Web Crypto", async () => {
    const input = new Uint8Array([7, 8]).buffer;
    const digest = vi.fn(
      async (_algorithm: HashAlgorithm, data: ArrayBuffer) => {
        expect(data).not.toBe(input);
        expect([...new Uint8Array(data)]).toEqual([7, 8]);
        return new Uint8Array([1]).buffer;
      },
    );

    await expect(hashBytes(input, "SHA-512", { digest })).resolves.toBe("01");
  });

  it("hashes a file/blob with the same bytes as text", async () => {
    const blob = new Blob([new TextEncoder().encode("abc")]);

    await expect(hashBlob(blob, "SHA-256", digestSource)).resolves.toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("rejects an oversized file before reading it into memory", async () => {
    const arrayBuffer = vi.fn();
    const oversized = {
      size: MAX_HASH_FILE_BYTES + 1,
      arrayBuffer,
    } as unknown as Blob;

    await expect(
      hashBlob(oversized, "SHA-256", digestSource),
    ).rejects.toMatchObject({ code: "input-too-large" });
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it("rejects an unavailable digest source before reading a file", async () => {
    const arrayBuffer = vi.fn();
    const file = { size: 3, arrayBuffer } as unknown as Blob;

    await expect(hashBlob(file, "SHA-256", null)).rejects.toMatchObject({
      code: "crypto-unavailable",
    });
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it("reports an unavailable Web Crypto implementation", async () => {
    await expect(
      hashBytes(new ArrayBuffer(0), "SHA-256", null),
    ).rejects.toEqual(
      new HashToolError(
        "crypto-unavailable",
        "当前浏览器没有可用的 Web Crypto 摘要 API。",
      ),
    );
  });

  it("maps Web Crypto failures to a stable local error", async () => {
    const source: HashDigestSource = {
      digest: vi.fn().mockRejectedValue(new Error("native detail")),
    };

    await expect(
      hashBytes(new ArrayBuffer(0), "SHA-256", source),
    ).rejects.toMatchObject({
      code: "digest-failed",
      message: "浏览器未能完成摘要计算，请重试。",
    });
  });

  it("rejects an invalid negative limit", async () => {
    await expect(
      hashText("abc", "SHA-256", digestSource, -1),
    ).rejects.toBeInstanceOf(RangeError);
  });
});

describe("bytesToHex", () => {
  it("emits lowercase zero-padded hexadecimal", () => {
    expect(bytesToHex(new Uint8Array([0, 1, 15, 16, 254, 255]))).toBe(
      "00010f10feff",
    );
  });
});

describe("compareHashHex", () => {
  const sha256 =
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
  const sha512 =
    "ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f";

  it("accepts surrounding whitespace and uppercase expected digests", () => {
    expect(
      compareHashHex(sha256, `  ${sha256.toUpperCase()}\n`, "SHA-256"),
    ).toEqual({
      ok: true,
      matches: true,
      normalizedExpected: sha256,
    });
    expect(compareHashHex(sha512, sha512, "SHA-512")).toMatchObject({
      ok: true,
      matches: true,
    });
  });

  it("checks all characters and reports a same-length mismatch", () => {
    const changedFirst = `0${sha256.slice(1)}`;
    const changedLast = `${sha256.slice(0, -1)}0`;

    expect(compareHashHex(sha256, changedFirst, "SHA-256")).toMatchObject({
      ok: true,
      matches: false,
    });
    expect(compareHashHex(sha256, changedLast, "SHA-256")).toMatchObject({
      ok: true,
      matches: false,
    });
  });

  it("rejects the wrong expected length", () => {
    expect(compareHashHex(sha256, "abc", "SHA-256")).toEqual({
      ok: false,
      error: {
        code: "invalid-length",
        message: "SHA-256 期望值必须正好包含 64 个十六进制字符。",
      },
    });
  });

  it("rejects non-hex expected characters", () => {
    expect(compareHashHex(sha256, "g".repeat(64), "SHA-256")).toMatchObject({
      ok: false,
      error: { code: "invalid-character" },
    });
  });

  it("refuses to compare a malformed generated digest", () => {
    expect(compareHashHex("not-a-digest", sha256, "SHA-256")).toMatchObject({
      ok: false,
      error: { code: "invalid-actual" },
    });
  });
});
