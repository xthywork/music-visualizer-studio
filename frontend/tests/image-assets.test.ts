import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ACCEPTED_IMAGE_TYPES,
  MAX_DECODE_HEIGHT,
  MAX_DECODE_PIXELS,
  MAX_DECODE_WIDTH,
  MAX_IMAGE_FILE_BYTES,
  MAX_IMAGE_HEIGHT,
  MAX_IMAGE_PIXELS,
  MAX_IMAGE_WIDTH,
  ImageInputError,
  normalizeImageFile,
  validateImageFile,
} from "../src/ui/image-assets";

function pngHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  bytes.set([73, 72, 68, 82], 12);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

function webpHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(30);
  bytes.set([82, 73, 70, 70, 22, 0, 0, 0, 87, 69, 66, 80, 86, 80, 56, 88], 0);
  bytes.set([10, 0, 0, 0], 16);
  bytes[24] = (width - 1) & 0xff;
  bytes[25] = ((width - 1) >> 8) & 0xff;
  bytes[26] = ((width - 1) >> 16) & 0xff;
  bytes[27] = (height - 1) & 0xff;
  bytes[28] = ((height - 1) >> 8) & 0xff;
  bytes[29] = ((height - 1) >> 16) & 0xff;
  return bytes;
}

function vp8lHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(26);
  bytes.set([82, 73, 70, 70], 0);
  new DataView(bytes.buffer).setUint32(4, bytes.length - 8, true);
  bytes.set([87, 69, 66, 80, 86, 80, 56, 76], 8);
  new DataView(bytes.buffer).setUint32(16, 5, true);
  bytes[20] = 0x2f;
  const packed = ((((height - 1) & 0x3fff) << 14) | ((width - 1) & 0x3fff)) >>> 0;
  new DataView(bytes.buffer).setUint32(21, packed, true);
  return bytes;
}

function jpegSegment(marker: number, payload: Uint8Array): Uint8Array {
  const segment = new Uint8Array(payload.length + 4);
  segment.set([0xff, marker], 0);
  new DataView(segment.buffer).setUint16(2, payload.length + 2);
  segment.set(payload, 4);
  return segment;
}

function jpegFixture(width: number, height: number, metadata: Uint8Array[] = []): Uint8Array {
  const sof = jpegSegment(0xc0, Uint8Array.from([
    8, height >> 8, height & 0xff, width >> 8, width & 0xff, 3,
    1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0,
  ]));
  const parts = [Uint8Array.from([0xff, 0xd8]), ...metadata, sof, Uint8Array.from([0xff, 0xd9])];
  const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}

function exifOrientationSegment(orientation: number): Uint8Array {
  const payload = new Uint8Array(32);
  payload.set([69, 120, 105, 102, 0, 0, 73, 73, 42, 0, 8, 0, 0, 0], 0);
  const view = new DataView(payload.buffer);
  view.setUint16(14, 1, true);
  view.setUint16(16, 0x0112, true);
  view.setUint16(18, 3, true);
  view.setUint32(20, 1, true);
  view.setUint16(24, orientation, true);
  return jpegSegment(0xe1, payload);
}

function stubLoadedImage(width: number, height: number): void {
  class MockImage {
    naturalWidth = width;
    naturalHeight = height;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    set src(value: string) { if (value) queueMicrotask(() => this.onload?.()); }
  }
  vi.stubGlobal("Image", MockImage);
}

function blobBytes(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

describe("image input guardrails", () => {
  it("accepts only the three renderer-supported image MIME types", () => {
    for (const type of ACCEPTED_IMAGE_TYPES) {
      expect(validateImageFile({ type, size: 1 })).toBeNull();
    }
  });

  it("rejects SVG and image MIME types that are not explicitly supported", () => {
    expect(validateImageFile({ type: "image/svg+xml", size: 1 })?.code).toBe("invalid-type");
    expect(validateImageFile({ type: "image/gif", size: 1 })?.code).toBe("invalid-type");
    expect(validateImageFile({ type: "", size: 1 })?.code).toBe("invalid-type");
  });

  it("rejects empty and over-sized files before decoding", () => {
    expect(validateImageFile({ type: "image/png", size: 0 })?.code).toBe("empty-file");
    expect(validateImageFile({ type: "image/png", size: MAX_IMAGE_FILE_BYTES + 1 })?.code).toBe("file-too-large");
  });

  it("derives file and decode limits from the largest output preset", () => {
    expect(MAX_IMAGE_FILE_BYTES).toBe(MAX_IMAGE_PIXELS);
    expect(MAX_DECODE_WIDTH).toBe(MAX_IMAGE_WIDTH * 2);
    expect(MAX_DECODE_HEIGHT).toBe(MAX_IMAGE_HEIGHT * 2);
    expect(MAX_DECODE_PIXELS).toBe(MAX_IMAGE_PIXELS * 2);
  });
});

describe("normalizeImageFile", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("rejects a decoded image beyond the bounded decode envelope", async () => {
    const close = vi.fn();
    const createImageBitmap = vi.fn().mockResolvedValue({
      width: MAX_DECODE_WIDTH + 1,
      height: 100,
      close,
    });
    vi.stubGlobal("createImageBitmap", createImageBitmap);
    const file = new File([blobBytes(pngHeader(MAX_DECODE_WIDTH + 1, 100))], "huge.png", { type: "image/png" });

    await expect(normalizeImageFile(file)).rejects.toMatchObject({ code: "image-too-large" });
    expect(createImageBitmap).not.toHaveBeenCalled();
  });

  it("parses real VP8L packed dimensions", async () => {
    const width = 321;
    const height = 213;
    vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue({ width, height, close: vi.fn() }));
    stubLoadedImage(width, height);
    const result = await normalizeImageFile(new File([blobBytes(vp8lHeader(width, height))], "lossless.webp", { type: "image/webp" }));
    expect(result).toMatchObject({ width, height, resized: false });
  });

  it("rejects oversized VP8L dimensions before decode", async () => {
    const createImageBitmap = vi.fn();
    vi.stubGlobal("createImageBitmap", createImageBitmap);
    const file = new File([blobBytes(vp8lHeader(MAX_DECODE_WIDTH + 1, 1))], "huge-lossless.webp", { type: "image/webp" });
    await expect(normalizeImageFile(file)).rejects.toMatchObject({ code: "image-too-large" });
    expect(createImageBitmap).not.toHaveBeenCalled();
  });

  it("accepts EXIF-oriented JPEG when browser decode swaps width and height", async () => {
    const encodedWidth = 1200;
    const encodedHeight = 800;
    vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue({ width: encodedHeight, height: encodedWidth, close: vi.fn() }));
    stubLoadedImage(encodedHeight, encodedWidth);
    const file = new File([blobBytes(jpegFixture(encodedWidth, encodedHeight, [exifOrientationSegment(6)]))], "oriented.jpg", { type: "image/jpeg" });
    const result = await normalizeImageFile(file);
    expect(result).toMatchObject({ width: encodedHeight, height: encodedWidth, resized: false });
  });

  it("finds JPEG dimensions after metadata larger than the initial 64 KiB probe", async () => {
    const width = 640;
    const height = 480;
    const iccPayload = new Uint8Array(65_533);
    iccPayload.set(new TextEncoder().encode("ICC_PROFILE\0"), 0);
    vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue({ width, height, close: vi.fn() }));
    stubLoadedImage(width, height);
    const file = new File([blobBytes(jpegFixture(width, height, [jpegSegment(0xe2, iccPayload)]))], "large-icc.jpg", { type: "image/jpeg" });
    const result = await normalizeImageFile(file);
    expect(result).toMatchObject({ width, height, resized: false });
  });

  it("scales a large but decodable image before producing the project data URL", async () => {
    const close = vi.fn();
    vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue({
      width: MAX_IMAGE_WIDTH + 100,
      height: 100,
      close,
    }));

    class MockImage {
      naturalWidth = MAX_IMAGE_WIDTH;
      naturalHeight = 100;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(value: string) {
        if (value) queueMicrotask(() => this.onload?.());
      }
    }
    vi.stubGlobal("Image", MockImage);
    const canvas = {
      width: 0,
      height: 0,
      getContext: vi.fn(() => ({ drawImage: vi.fn() })),
      toDataURL: vi.fn(() => "data:image/png;base64,normalized"),
    };
    vi.spyOn(document, "createElement").mockReturnValue(canvas as unknown as HTMLElement);

    const result = await normalizeImageFile(new File([blobBytes(pngHeader(MAX_IMAGE_WIDTH + 100, 100))], "large.png", { type: "image/png" }));
    expect(result.resized).toBe(true);
    expect(result.width).toBe(MAX_IMAGE_WIDTH);
    expect(result.height).toBe(Math.floor((100 * MAX_IMAGE_WIDTH) / (MAX_IMAGE_WIDTH + 100)));
    expect(result.dataUrl).toMatch(/^data:image\/png/);
    expect(close).toHaveBeenCalledOnce();
  });

  it("reports decode failures as typed input errors", async () => {
    vi.stubGlobal("createImageBitmap", vi.fn().mockRejectedValue(new Error("bad bytes")));
    vi.stubGlobal("URL", {
      createObjectURL: vi.fn(() => "blob:test"),
      revokeObjectURL: vi.fn(),
    });
    class BrokenImage {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_value: string) {
        queueMicrotask(() => this.onerror?.());
      }
    }
    vi.stubGlobal("Image", BrokenImage);
    await expect(normalizeImageFile(new File([blobBytes(webpHeader(10, 10))], "bad.webp", { type: "image/webp" }))).rejects.toBeInstanceOf(ImageInputError);
  });
});
