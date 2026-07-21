import { validateImageDimensions } from "../../tools/image-compressor";
import { encodeRgbaToPng } from "../../tools/image-compressor/png-encoder";
import { IMAGE_OPERATION_MANIFEST } from "../catalog";
import type { OperationDefinition } from "../contract";
import {
  assertAllowedOptions,
  checkpoint,
  expectInputKind,
  failFromCore,
  mapThrownError,
  optionalInteger,
} from "./_shared";

export const imageOperationDefinition: OperationDefinition = {
  manifest: IMAGE_OPERATION_MANIFEST,
  async execute(input, options, context) {
    const operationId = IMAGE_OPERATION_MANIFEST.id;
    assertAllowedOptions(operationId, options, ["paletteColors"]);
    const paletteColors = optionalInteger(
      operationId,
      options,
      "paletteColors",
      256,
      2,
      256,
    );
    const image = expectInputKind(operationId, input, "rgba-image");
    const dimensions = validateImageDimensions(image.width, image.height);
    if (!dimensions.ok) failFromCore(operationId, dimensions.error);

    const expectedBytes = dimensions.value.pixels * 4;
    if (image.data.byteLength !== expectedBytes) {
      failFromCore(operationId, {
        code: "invalid-rgba-length",
        message: `RGBA 数据应为 ${expectedBytes} 字节，实际为 ${image.data.byteLength} 字节。`,
      });
    }

    // UPNG needs source, quantization and encoded buffers concurrently.
    context.assertWorkingMemory(expectedBytes * 3);
    checkpoint(context);

    const png = await mapThrownError(operationId, () => {
      const rgba = new Uint8Array(expectedBytes);
      rgba.set(image.data);
      return encodeRgbaToPng(
        rgba.buffer,
        image.width,
        image.height,
        paletteColors,
      );
    });

    checkpoint(context);
    return { kind: "binary", data: png, mimeType: "image/png" };
  },
};
