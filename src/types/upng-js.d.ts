declare module "@upng/upng-js" {
  export interface UPNGImage {
    width: number;
    height: number;
    depth: number;
    ctype: number;
    frames: unknown[];
    tabs: Record<string, unknown>;
    data: Uint8Array;
  }

  export interface UPNGApi {
    encode(
      frames: ArrayBuffer[],
      width: number,
      height: number,
      colorCount: number,
      delays?: number[],
      metadata?: unknown,
      forbidPalette?: boolean,
    ): ArrayBuffer;
    decode(data: ArrayBuffer): UPNGImage;
    toRGBA8(image: UPNGImage): ArrayBuffer[];
  }

  const UPNG: UPNGApi;
  export default UPNG;
}
