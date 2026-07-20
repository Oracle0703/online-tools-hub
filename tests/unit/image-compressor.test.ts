import { describe, expect, it } from "vitest";

import {
  MAX_IMAGE_FILE_BYTES,
  MAX_IMAGE_FILES,
  MAX_IMAGE_PIXELS,
  MAX_IMAGE_TOTAL_BYTES,
  calculateContainSize,
  crc32,
  createOutputFileName,
  createStoreZip,
  detectImageFormat,
  formatBytes,
  formatSavings,
  getImageFormatDescriptor,
  inspectImageData,
  isAnimatedPng,
  isAnimatedWebP,
  qualityToPngPaletteColors,
  readImageDimensions,
  resolveOutputFormat,
  validateImageQueue,
  validateImageDimensions,
} from "../../src/tools/image-compressor";

const PNG_SIGNATURE = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

describe("image container inspection", () => {
  it.each([
    [Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]), "jpeg"],
    [PNG_SIGNATURE, "png"],
    [webpContainer(webpChunk("VP8 ", Uint8Array.from([1, 2, 3, 4]))), "webp"],
  ] as const)("detects image bytes as %s", (bytes, expected) => {
    expect(detectImageFormat(bytes)).toBe(expected);
  });

  it.each([
    new Uint8Array(),
    Uint8Array.from([0xff, 0xd8]),
    Uint8Array.from([0x89, 0x50, 0x4e, 0x47]),
    ascii("RIFF0000NOPE"),
    ascii("NOTWEBP.jpg"),
  ])("rejects truncated or spoofed bytes", (bytes) => {
    expect(detectImageFormat(bytes)).toBeNull();
    expect(inspectImageData(bytes)).toEqual({
      ok: false,
      error: {
        code: "unsupported-image",
        message: "无法识别图片格式，请选择有效的 JPEG、PNG 或 WebP 文件。",
      },
    });
  });

  it("reports the matching MIME type and extension", () => {
    expect(inspectImageData(Uint8Array.from([0xff, 0xd8, 0xff]))).toEqual({
      ok: true,
      value: {
        format: "jpeg",
        mimeType: "image/jpeg",
        extension: "jpg",
        animated: false,
      },
    });
  });

  it("detects a valid APNG acTL chunk before IDAT", () => {
    const animated = pngContainer(
      pngChunk("IHDR", new Uint8Array(13)),
      pngChunk("acTL", uint32PairBigEndian(2, 0)),
      pngChunk("IDAT", Uint8Array.from([1])),
      pngChunk("IEND", new Uint8Array()),
    );

    expect(isAnimatedPng(animated)).toBe(true);
    expect(inspectImageData(animated)).toMatchObject({
      ok: true,
      value: { format: "png", animated: true },
    });
  });

  it.each([
    pngContainer(
      pngChunk("IHDR", new Uint8Array(13)),
      pngChunk("IDAT", Uint8Array.from([1])),
      pngChunk("acTL", uint32PairBigEndian(2, 0)),
    ),
    pngContainer(pngChunk("acTL", uint32PairBigEndian(0, 0))),
    pngContainer(pngChunk("acTL", Uint8Array.from([0, 0, 0, 1]))),
    concatBytes(PNG_SIGNATURE, uint32BigEndian(0xffff_ffff), ascii("acTL")),
    Uint8Array.from([0xff, 0xd8, 0xff]),
  ])("does not misclassify a malformed or static PNG", (bytes) => {
    expect(isAnimatedPng(bytes)).toBe(false);
  });

  it("detects WebP animation through the VP8X feature flag", () => {
    const bytes = webpContainer(
      webpChunk("VP8X", Uint8Array.from([0x02, 0, 0, 0, 0, 0, 0, 0, 0, 0])),
    );

    expect(isAnimatedWebP(bytes)).toBe(true);
    expect(inspectImageData(bytes)).toMatchObject({
      ok: true,
      value: { format: "webp", animated: true },
    });
  });

  it.each(["ANIM", "ANMF"])(
    "detects the explicit %s WebP animation chunk",
    (chunkName) => {
      expect(
        isAnimatedWebP(
          webpContainer(webpChunk(chunkName, Uint8Array.from([1, 2]))),
        ),
      ).toBe(true);
    },
  );

  it.each([
    webpContainer(webpChunk("VP8 ", Uint8Array.from([1, 2]))),
    webpContainer(webpChunk("VP8X", new Uint8Array(10))),
    concatBytes(ascii("RIFF"), uint32LittleEndian(1), ascii("WEBP")),
    concatBytes(
      ascii("RIFF"),
      uint32LittleEndian(12),
      ascii("WEBPVP8X"),
      uint32LittleEndian(100),
    ),
    PNG_SIGNATURE,
  ])("does not misclassify a malformed or static WebP", (bytes) => {
    expect(isAnimatedWebP(bytes)).toBe(false);
  });
});

describe("readImageDimensions", () => {
  it("reads PNG IHDR dimensions at the pixel limit", () => {
    expect(readImageDimensions(pngWithDimensions(8000, 5000))).toEqual({
      ok: true,
      value: {
        format: "png",
        width: 8000,
        height: 5000,
        pixels: MAX_IMAGE_PIXELS,
      },
    });
  });

  it.each([
    PNG_SIGNATURE,
    concatBytes(PNG_SIGNATURE, uint32BigEndian(13), ascii("IHDR")),
    concatBytes(
      PNG_SIGNATURE,
      uint32BigEndian(12),
      ascii("IHDR"),
      new Uint8Array(16),
    ),
    concatBytes(
      PNG_SIGNATURE,
      uint32BigEndian(13),
      ascii("NOPE"),
      new Uint8Array(17),
    ),
    pngWithDimensions(0, 10),
    pngWithDimensions(10, 0),
  ])("rejects a truncated or malformed PNG IHDR", (bytes) => {
    expect(readImageDimensions(bytes, "png")).toMatchObject({
      ok: false,
      error: { code: "corrupt-image" },
    });
  });

  it.each([
    [0xc0, "baseline"],
    [0xc1, "extended sequential"],
    [0xc2, "progressive"],
    [0xc3, "lossless"],
    [0xc5, "differential sequential"],
    [0xc6, "differential progressive"],
    [0xc7, "differential lossless"],
    [0xc9, "arithmetic sequential"],
    [0xca, "arithmetic progressive"],
    [0xcb, "arithmetic lossless"],
    [0xcd, "differential arithmetic sequential"],
    [0xce, "differential arithmetic progressive"],
    [0xcf, "differential arithmetic lossless"],
  ] as const)("reads JPEG %s SOF marker (%s)", (marker, label) => {
    expect(label.length).toBeGreaterThan(0);
    const bytes = jpegWithDimensions(8000, 5000, marker, [
      jpegSegment(0xe0, Uint8Array.from([1, 2])),
    ]);

    expect(readImageDimensions(bytes)).toEqual({
      ok: true,
      value: {
        format: "jpeg",
        width: 8000,
        height: 5000,
        pixels: MAX_IMAGE_PIXELS,
      },
    });
  });

  it("skips JPEG fill bytes and standalone markers", () => {
    const sof = jpegSofSegment(320, 200, 0xc0, true);
    const bytes = concatBytes(
      Uint8Array.from([0xff, 0xd8, 0xff, 0xd8, 0xff, 0x01, 0xff, 0xd0]),
      sof,
      Uint8Array.from([0xff, 0xd9]),
    );

    expect(readImageDimensions(bytes)).toMatchObject({
      ok: true,
      value: { format: "jpeg", width: 320, height: 200 },
    });
  });

  it.each([
    Uint8Array.from([0xff, 0xd8, 0xff]),
    Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]),
    Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x01]),
    Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x0a, 0x01]),
    concatBytes(
      Uint8Array.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x07]),
      new Uint8Array(5),
    ),
    concatBytes(
      Uint8Array.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x08, 8]),
      uint16BigEndian(10),
      uint16BigEndian(10),
      Uint8Array.from([0]),
    ),
    concatBytes(
      Uint8Array.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x08, 8]),
      uint16BigEndian(10),
      uint16BigEndian(10),
      Uint8Array.from([1]),
    ),
    jpegWithDimensions(0, 10),
    jpegWithDimensions(10, 0),
    Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]),
    Uint8Array.from([0xff, 0xd8, 0xff, 0xda, 0, 2]),
    Uint8Array.from([0xff, 0xd8, 0xff, 0x00]),
    concatBytes(jpegSegment(0xe0, Uint8Array.from([1])), ascii("x")),
  ])("rejects a truncated or malformed JPEG header", (bytes) => {
    expect(readImageDimensions(bytes, "jpeg")).toMatchObject({
      ok: false,
      error: { code: "corrupt-image" },
    });
  });

  it.each([
    [webpVp8X(640, 480), "VP8X"],
    [webpVp8(640, 480, true), "VP8"],
    [webpVp8L(640, 480), "VP8L"],
    [
      webpContainer(
        webpChunk("EXIF", Uint8Array.from([1])),
        webpChunk("VP8X", vp8XData(640, 480)),
      ),
      "metadata before dimensions",
    ],
  ] as const)("reads WebP %s dimensions", (bytes, label) => {
    expect(label.length).toBeGreaterThan(0);
    expect(readImageDimensions(bytes)).toEqual({
      ok: true,
      value: {
        format: "webp",
        width: 640,
        height: 480,
        pixels: 307_200,
      },
    });
  });

  it("masks VP8 horizontal and vertical scale bits", () => {
    expect(readImageDimensions(webpVp8(320, 240, true))).toMatchObject({
      ok: true,
      value: { width: 320, height: 240 },
    });
  });

  it.each([
    concatBytes(ascii("RIFF"), uint32LittleEndian(3), ascii("WEBP")),
    concatBytes(ascii("RIFF"), uint32LittleEndian(100), ascii("WEBP")),
    webpContainer(),
    webpContainer(ascii("VP8")),
    webpContainer(
      concatBytes(ascii("VP8X"), uint32LittleEndian(100), new Uint8Array(10)),
    ),
    webpContainer(webpChunk("VP8X", new Uint8Array(9))),
    webpContainer(webpChunk("VP8X", new Uint8Array(11))),
    webpContainer(webpChunk("VP8 ", new Uint8Array(9))),
    webpContainer(
      webpChunk(
        "VP8 ",
        Uint8Array.from([1, 0, 0, 0x9d, 0x01, 0x2a, 1, 0, 1, 0]),
      ),
    ),
    webpContainer(
      webpChunk("VP8 ", Uint8Array.from([0, 0, 0, 0, 0x01, 0x2a, 1, 0, 1, 0])),
    ),
    webpContainer(
      webpChunk(
        "VP8 ",
        Uint8Array.from([0, 0, 0, 0x9d, 0x01, 0x2a, 0, 0, 1, 0]),
      ),
    ),
    webpContainer(webpChunk("VP8L", Uint8Array.from([0, 0, 0, 0, 0]))),
    webpContainer(webpChunk("VP8L", Uint8Array.from([0x2f, 0, 0, 0, 0xe0]))),
    webpContainer(webpChunk("EXIF", Uint8Array.from([1, 2]))),
  ])("rejects a truncated or malformed WebP container", (bytes) => {
    expect(readImageDimensions(bytes, "webp")).toMatchObject({
      ok: false,
      error: { code: "corrupt-image" },
    });
  });

  it.each([
    [pngWithDimensions(8001, 5000), "png", 8001, 5000],
    [jpegWithDimensions(8001, 5000), "jpeg", 8001, 5000],
    [webpVp8X(8001, 5000), "webp", 8001, 5000],
    [webpVp8L(16_384, 16_384), "webp", 16_384, 16_384],
  ] as const)(
    "rejects a %s image over 40 MP before decoding",
    (bytes, _format, width, height) => {
      expect(readImageDimensions(bytes)).toEqual({
        ok: false,
        error: {
          code: "too-many-pixels",
          message: `图片尺寸为 ${width} × ${height}，超过 40,000,000 像素的安全限制。`,
          width,
          height,
        },
      });
    },
  );

  it("distinguishes unsupported data, expected-format corruption and mismatch", () => {
    expect(readImageDimensions(ascii("not an image"))).toMatchObject({
      ok: false,
      error: { code: "unsupported-image" },
    });
    expect(readImageDimensions(ascii("not an image"), "png")).toMatchObject({
      ok: false,
      error: { code: "corrupt-image" },
    });
    expect(readImageDimensions(pngWithDimensions(1, 1), "jpeg")).toEqual({
      ok: false,
      error: {
        code: "corrupt-image",
        message: "文件内容与指定的 JPEG 格式不匹配。",
      },
    });
  });
});

describe("validateImageQueue", () => {
  it("accepts the documented limits exactly", () => {
    const files = Array.from({ length: 5 }, (_, index) => ({
      name: `${index}.png`,
      size: MAX_IMAGE_FILE_BYTES,
    }));

    expect(validateImageQueue(files)).toEqual({
      ok: true,
      value: { fileCount: 5, totalBytes: MAX_IMAGE_TOTAL_BYTES },
    });
  });

  it.each([
    [[], "empty-selection"],
    [
      Array.from({ length: MAX_IMAGE_FILES + 1 }, (_, index) => ({
        name: `${index}.jpg`,
        size: 1,
      })),
      "too-many-files",
    ],
    [[{ name: "negative.png", size: -1 }], "invalid-file-size"],
    [[{ name: "fraction.png", size: 1.5 }], "invalid-file-size"],
    [
      [{ name: "unsafe.png", size: Number.MAX_SAFE_INTEGER + 1 }],
      "invalid-file-size",
    ],
    [[{ name: "empty.png", size: 0 }], "empty-file"],
    [[{ name: "large.png", size: MAX_IMAGE_FILE_BYTES + 1 }], "file-too-large"],
    [
      [
        ...Array.from({ length: 5 }, (_, index) => ({
          name: `${index}.png`,
          size: MAX_IMAGE_FILE_BYTES,
        })),
        { name: "extra.png", size: 1 },
      ],
      "total-too-large",
    ],
  ] as const)("returns a readable %s queue error", (files, code) => {
    const result = validateImageQueue(files);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(code);
      expect(result.error.message.trim().length).toBeGreaterThan(0);
    }
  });

  it("includes the failing file's normalized display name and index", () => {
    expect(validateImageQueue([{ name: "\u0000bad?.png", size: 0 }])).toEqual({
      ok: false,
      error: {
        code: "empty-file",
        message: "“bad .png”是空文件，无法压缩。",
        fileIndex: 0,
        fileName: "bad .png",
      },
    });
  });
});

describe("calculateContainSize", () => {
  it.each([
    [4000, 2000, 1000, { width: 1000, height: 500 }],
    [2000, 4000, 1000, { width: 500, height: 1000 }],
    [3, 2, 2, { width: 2, height: 1 }],
    [1, 10_000, 1, { width: 1, height: 1 }],
  ] as const)(
    "fits %sx%s inside maximum edge %s",
    (width, height, maximumEdge, expected) => {
      expect(calculateContainSize(width, height, maximumEdge)).toMatchObject({
        ...expected,
        resized: true,
      });
    },
  );

  it("never enlarges an image", () => {
    expect(calculateContainSize(320, 200, 640)).toEqual({
      width: 320,
      height: 200,
      scale: 1,
      resized: false,
    });
  });

  it.each([
    [0, 100, 100],
    [100, -1, 100],
    [100, 100, 0],
    [1.5, 100, 100],
    [100, Number.NaN, 100],
    [100, 100, Number.MAX_SAFE_INTEGER + 1],
  ])("rejects invalid dimensions (%s, %s, %s)", (width, height, edge) => {
    expect(() => calculateContainSize(width, height, edge)).toThrow(
      /必须是大于 0 的安全整数/u,
    );
  });
});

describe("validateImageDimensions", () => {
  it("accepts an image at the decoded-pixel limit", () => {
    expect(validateImageDimensions(8000, 5000)).toEqual({
      ok: true,
      value: { width: 8000, height: 5000, pixels: MAX_IMAGE_PIXELS },
    });
  });

  it.each([
    [0, 100],
    [100, -1],
    [1.5, 100],
    [100, Number.NaN],
    [Number.MAX_SAFE_INTEGER + 1, 1],
  ])("rejects invalid decoded dimensions (%s, %s)", (width, height) => {
    expect(validateImageDimensions(width, height)).toMatchObject({
      ok: false,
      error: { code: "invalid-dimensions" },
    });
  });

  it.each([
    [8001, 5000],
    [MAX_IMAGE_PIXELS, 2],
    [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
  ])("rejects a %sx%s decompression bomb", (width, height) => {
    expect(validateImageDimensions(width, height)).toEqual({
      ok: false,
      error: {
        code: "too-many-pixels",
        message: "图片像素总数不能超过 40,000,000。",
      },
    });
  });
});

describe("output metadata and formatting", () => {
  it.each([
    ["jpeg", { mimeType: "image/jpeg", extension: "jpg" }],
    ["png", { mimeType: "image/png", extension: "png" }],
    ["webp", { mimeType: "image/webp", extension: "webp" }],
  ] as const)("maps %s to its MIME type and extension", (format, expected) => {
    expect(getImageFormatDescriptor(format)).toEqual(expected);
  });

  it("resolves preserve-format and explicit output selections", () => {
    expect(resolveOutputFormat("jpeg")).toBe("jpeg");
    expect(resolveOutputFormat("png", "original")).toBe("png");
    expect(resolveOutputFormat("png", "webp")).toBe("webp");
  });

  it.each([
    ["photo.jpeg", "jpeg", undefined, "photo-compressed.jpg"],
    ["../我的 图像.PNG", "webp", undefined, "我的 图像-compressed.webp"],
    ["C:\\fake\\CON.jpg", "jpeg", undefined, "image-CON-compressed.jpg"],
    [".hidden", "png", "small", "hidden-small.png"],
    ['a<>:"/\\|?*b.png', "png", "web / ready", "b-web ready.png"],
    ["\u0000\ud800", "webp", "\u0000", "image-compressed.webp"],
  ] as const)(
    "creates a safe output name for %j",
    (input, format, suffix, expected) => {
      expect(createOutputFileName(input, format, suffix)).toBe(expected);
    },
  );

  it("bounds the Unicode stem length", () => {
    const result = createOutputFileName(`${"图".repeat(200)}.png`, "png");
    expect(Array.from(result.replace(/-compressed\.png$/u, ""))).toHaveLength(
      120,
    );
  });

  it.each([
    [0, "0 B"],
    [1023, "1023 B"],
    [1024, "1 KiB"],
    [1536, "1.5 KiB"],
    [10 * 1024, "10 KiB"],
    [1.5 * 1024 * 1024, "1.5 MiB"],
    [100 * 1024 * 1024, "100 MiB"],
    [2 * 1024 * 1024 * 1024, "2 GiB"],
  ] as const)("formats %s bytes as %s", (bytes, expected) => {
    expect(formatBytes(bytes)).toBe(expected);
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid byte count %s",
    (bytes) => {
      expect(() => formatBytes(bytes)).toThrow("字节数必须是非负安全整数");
    },
  );

  it.each([
    [1000, 750, "节省 25%"],
    [1000, 999, "节省 0.1%"],
    [1000, 1000, "未节省"],
    [1000, 1100, "增大 10%"],
    [1, 0, "节省 100%"],
  ] as const)("formats savings from %s to %s", (original, output, expected) => {
    expect(formatSavings(original, output)).toBe(expected);
  });

  it.each([
    [0, 0],
    [-1, 0],
    [1.5, 1],
    [1, -1],
    [1, 1.5],
    [1, Number.NaN],
  ])("rejects invalid savings inputs (%s, %s)", (original, output) => {
    expect(() => formatSavings(original, output)).toThrow(/文件大小/u);
  });

  it.each([
    [0, 2],
    [25, 66],
    [50, 129],
    [75, 193],
    [100, 256],
    [33.3, 87],
  ] as const)("maps PNG quality %s to %s colors", (quality, colors) => {
    expect(qualityToPngPaletteColors(quality)).toBe(colors);
  });

  it("is monotonic over every integral PNG quality value", () => {
    const colors = Array.from({ length: 101 }, (_, quality) =>
      qualityToPngPaletteColors(quality),
    );
    expect(colors[0]).toBe(2);
    expect(colors.at(-1)).toBe(256);
    expect(
      colors.every(
        (value, index) => index === 0 || value >= colors[index - 1]!,
      ),
    ).toBe(true);
  });

  it.each([-1, 101, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects PNG quality %s",
    (quality) => {
      expect(() => qualityToPngPaletteColors(quality)).toThrow("0–100");
    },
  );
});

describe("ZIP Store archive", () => {
  it("matches the canonical CRC-32 check vector", () => {
    expect(crc32(ascii("123456789"))).toBe(0xcbf4_3926);
    expect(crc32(new Uint8Array())).toBe(0);
  });

  it("writes valid local, central and end records with UTF-8 names", () => {
    const firstData = Uint8Array.from([0, 1, 2, 255]);
    const secondData = new TextEncoder().encode("本地处理");
    const archive = createStoreZip([
      {
        name: "照片.webp",
        data: firstData,
        modifiedAt: new Date("2024-02-03T04:05:07.000Z"),
      },
      { name: "plain.jpg", data: secondData },
    ]);
    const view = new DataView(
      archive.buffer,
      archive.byteOffset,
      archive.byteLength,
    );
    const decoder = new TextDecoder();

    expect(view.getUint32(0, true)).toBe(0x0403_4b50);
    expect(view.getUint16(6, true)).toBe(0x0800);
    expect(view.getUint16(8, true)).toBe(0);
    expect(view.getUint32(14, true)).toBe(crc32(firstData));
    expect(view.getUint32(18, true)).toBe(firstData.length);
    expect(view.getUint32(22, true)).toBe(firstData.length);
    expect(view.getUint16(10, true)).toBe((4 << 11) | (5 << 5) | 3);
    expect(view.getUint16(12, true)).toBe((44 << 9) | (2 << 5) | 3);

    const firstNameLength = view.getUint16(26, true);
    const firstName = archive.subarray(30, 30 + firstNameLength);
    expect(decoder.decode(firstName)).toBe("照片.webp");
    expect(
      archive.subarray(
        30 + firstNameLength,
        30 + firstNameLength + firstData.length,
      ),
    ).toEqual(firstData);

    const secondLocalOffset = 30 + firstNameLength + firstData.length;
    expect(view.getUint32(secondLocalOffset, true)).toBe(0x0403_4b50);
    const secondNameLength = view.getUint16(secondLocalOffset + 26, true);
    expect(
      decoder.decode(
        archive.subarray(
          secondLocalOffset + 30,
          secondLocalOffset + 30 + secondNameLength,
        ),
      ),
    ).toBe("plain.jpg");

    const endOffset = archive.length - 22;
    expect(view.getUint32(endOffset, true)).toBe(0x0605_4b50);
    expect(view.getUint16(endOffset + 8, true)).toBe(2);
    expect(view.getUint16(endOffset + 10, true)).toBe(2);
    expect(view.getUint16(endOffset + 20, true)).toBe(0);

    const centralSize = view.getUint32(endOffset + 12, true);
    const centralOffset = view.getUint32(endOffset + 16, true);
    expect(centralOffset + centralSize).toBe(endOffset);
    expect(view.getUint32(centralOffset, true)).toBe(0x0201_4b50);
    expect(view.getUint16(centralOffset + 8, true)).toBe(0x0800);
    expect(view.getUint16(centralOffset + 10, true)).toBe(0);
    expect(view.getUint32(centralOffset + 42, true)).toBe(0);

    const secondCentralOffset = centralOffset + 46 + firstNameLength;
    expect(view.getUint32(secondCentralOffset, true)).toBe(0x0201_4b50);
    expect(view.getUint32(secondCentralOffset + 42, true)).toBe(
      secondLocalOffset,
    );
  });

  it("is deterministic by default and normalizes Unicode file names", () => {
    const decomposedName = "cafe\u0301.png";
    const entries = [
      { name: decomposedName, data: Uint8Array.from([1, 2, 3]) },
    ];

    const first = createStoreZip(entries);
    const second = createStoreZip(entries);
    expect(first).toEqual(second);

    const view = new DataView(first.buffer, first.byteOffset, first.byteLength);
    const nameLength = view.getUint16(26, true);
    expect(new TextDecoder().decode(first.subarray(30, 30 + nameLength))).toBe(
      "café.png",
    );
  });

  it("removes paths and control characters from archive entry names", () => {
    const archive = createStoreZip([
      { name: "../bad?\u0000name.png", data: Uint8Array.from([1]) },
      { name: "C:\\fake\\CON.jpg", data: Uint8Array.from([2]) },
      { name: ".../", data: Uint8Array.from([3]) },
    ]);

    expect(readLocalZipNames(archive, 3)).toEqual([
      "bad name.png",
      "file-CON.jpg",
      "file-3",
    ]);
  });

  it("clamps pre-1980 timestamps to the ZIP epoch", () => {
    const archive = createStoreZip([
      {
        name: "old.png",
        data: Uint8Array.from([1]),
        modifiedAt: new Date("1970-06-07T08:09:10.000Z"),
      },
    ]);
    const view = new DataView(archive.buffer);

    expect(view.getUint16(10, true)).toBe(0);
    expect(view.getUint16(12, true)).toBe((1 << 5) | 1);
  });

  it.each([
    [[], "至少需要一个文件"],
    [[{ name: "bad\ud800.png", data: new Uint8Array() }], "包含无效字符"],
    [
      [
        { name: "path/same.png", data: new Uint8Array() },
        { name: "same.png", data: new Uint8Array() },
      ],
      "重复文件名",
    ],
    [
      [
        {
          name: "bad-date.png",
          data: new Uint8Array(),
          modifiedAt: new Date(Number.NaN),
        },
      ],
      "修改时间无效",
    ],
    [
      [{ name: "bad-data.png", data: "not bytes" as unknown as Uint8Array }],
      "不是字节数组",
    ],
  ] as const)("rejects an invalid ZIP request: %s", (entries, message) => {
    expect(() => createStoreZip(entries)).toThrow(message);
  });

  it("rejects too many ZIP32 entries before inspecting them", () => {
    const entries = Array.from({ length: 65_536 }, () => ({
      name: "same.png",
      data: new Uint8Array(),
    }));
    expect(() => createStoreZip(entries)).toThrow("65535 个文件");
  });

  it("rejects a UTF-8 file name longer than ZIP32 can represent", () => {
    const tooLongName = `${"😀".repeat(16_384)}.png`;
    expect(() =>
      createStoreZip([{ name: tooLongName, data: new Uint8Array() }]),
    ).toThrow("UTF-8 文件名超过 ZIP32");
  });

  it.each([
    [0x1_0000_0000, "文件", "4 GiB 大小限制"],
    [0xffff_ffff, "布局", "本地区域大小超过 ZIP32"],
  ] as const)(
    "rejects a ZIP32 %s boundary without allocating huge data",
    (reportedByteLength, _label, message) => {
      const data = new Uint8Array();
      Object.defineProperty(data, "byteLength", { value: reportedByteLength });

      expect(() => createStoreZip([{ name: "large.bin", data }])).toThrow(
        message,
      );
    },
  );
});

function ascii(value: string): Uint8Array {
  return Uint8Array.from(value, (character) => character.charCodeAt(0));
}

function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(
    parts.reduce((total, part) => total + part.length, 0),
  );
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function uint32BigEndian(value: number): Uint8Array {
  return Uint8Array.from([
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ]);
}

function uint16BigEndian(value: number): Uint8Array {
  return Uint8Array.from([(value >>> 8) & 0xff, value & 0xff]);
}

function uint32LittleEndian(value: number): Uint8Array {
  return Uint8Array.from([
    value & 0xff,
    (value >>> 8) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 24) & 0xff,
  ]);
}

function uint32PairBigEndian(first: number, second: number): Uint8Array {
  return concatBytes(uint32BigEndian(first), uint32BigEndian(second));
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  return concatBytes(
    uint32BigEndian(data.length),
    ascii(type),
    data,
    new Uint8Array(4),
  );
}

function pngContainer(...chunks: readonly Uint8Array[]): Uint8Array {
  return concatBytes(PNG_SIGNATURE, ...chunks);
}

function pngWithDimensions(width: number, height: number): Uint8Array {
  return pngContainer(
    pngChunk(
      "IHDR",
      concatBytes(
        uint32BigEndian(width),
        uint32BigEndian(height),
        Uint8Array.from([8, 6, 0, 0, 0]),
      ),
    ),
    pngChunk("IEND", new Uint8Array()),
  );
}

function jpegSegment(marker: number, data: Uint8Array): Uint8Array {
  return concatBytes(
    Uint8Array.from([0xff, marker]),
    uint16BigEndian(data.length + 2),
    data,
  );
}

function jpegSofSegment(
  width: number,
  height: number,
  marker: number,
  fillMarker = false,
): Uint8Array {
  const segment = jpegSegment(
    marker,
    concatBytes(
      Uint8Array.from([8]),
      uint16BigEndian(height),
      uint16BigEndian(width),
      Uint8Array.from([1, 1, 0x11, 0]),
    ),
  );
  return fillMarker ? concatBytes(Uint8Array.from([0xff]), segment) : segment;
}

function jpegWithDimensions(
  width: number,
  height: number,
  marker = 0xc0,
  prefixSegments: readonly Uint8Array[] = [],
): Uint8Array {
  return concatBytes(
    Uint8Array.from([0xff, 0xd8]),
    ...prefixSegments,
    jpegSofSegment(width, height, marker),
    Uint8Array.from([0xff, 0xd9]),
  );
}

function webpChunk(type: string, data: Uint8Array): Uint8Array {
  return concatBytes(
    ascii(type),
    uint32LittleEndian(data.length),
    data,
    data.length % 2 === 0 ? new Uint8Array() : new Uint8Array(1),
  );
}

function webpContainer(...chunks: readonly Uint8Array[]): Uint8Array {
  const body = concatBytes(ascii("WEBP"), ...chunks);
  return concatBytes(ascii("RIFF"), uint32LittleEndian(body.length), body);
}

function vp8XData(width: number, height: number): Uint8Array {
  return concatBytes(
    new Uint8Array(4),
    uint24LittleEndian(width - 1),
    uint24LittleEndian(height - 1),
  );
}

function webpVp8X(width: number, height: number): Uint8Array {
  return webpContainer(webpChunk("VP8X", vp8XData(width, height)));
}

function webpVp8(
  width: number,
  height: number,
  includeScaleBits = false,
): Uint8Array {
  const rawWidth = width | (includeScaleBits ? 0xc000 : 0);
  const rawHeight = height | (includeScaleBits ? 0x8000 : 0);
  return webpContainer(
    webpChunk(
      "VP8 ",
      concatBytes(
        Uint8Array.from([0, 0, 0, 0x9d, 0x01, 0x2a]),
        uint16LittleEndian(rawWidth),
        uint16LittleEndian(rawHeight),
      ),
    ),
  );
}

function webpVp8L(width: number, height: number): Uint8Array {
  const packed = ((width - 1) | ((height - 1) << 14)) >>> 0;
  return webpContainer(
    webpChunk(
      "VP8L",
      concatBytes(Uint8Array.from([0x2f]), uint32LittleEndian(packed)),
    ),
  );
}

function uint16LittleEndian(value: number): Uint8Array {
  return Uint8Array.from([value & 0xff, (value >>> 8) & 0xff]);
}

function uint24LittleEndian(value: number): Uint8Array {
  return Uint8Array.from([
    value & 0xff,
    (value >>> 8) & 0xff,
    (value >>> 16) & 0xff,
  ]);
}

function readLocalZipNames(archive: Uint8Array, entryCount: number): string[] {
  const view = new DataView(
    archive.buffer,
    archive.byteOffset,
    archive.byteLength,
  );
  const decoder = new TextDecoder();
  const names: string[] = [];
  let offset = 0;

  for (let index = 0; index < entryCount; index += 1) {
    expect(view.getUint32(offset, true)).toBe(0x0403_4b50);
    const dataLength = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    names.push(
      decoder.decode(archive.subarray(offset + 30, offset + 30 + nameLength)),
    );
    offset += 30 + nameLength + dataLength;
  }

  return names;
}
