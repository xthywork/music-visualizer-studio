import { OUTPUT_PRESETS } from "../config";

/**
 * Image limits are derived from the largest frame that the renderer can
 * produce.  Keeping these values here (instead of in the input handlers)
 * means a new output preset automatically updates the image guardrails.
 */
const outputPresets = Object.values(OUTPUT_PRESETS).flat();
export const MAX_IMAGE_WIDTH = Math.max(...outputPresets.map((preset) => preset.width));
export const MAX_IMAGE_HEIGHT = Math.max(...outputPresets.map((preset) => preset.height));
export const MAX_IMAGE_PIXELS = Math.max(...outputPresets.map((preset) => preset.width * preset.height));

// Images up to twice the largest render dimensions/pixel count can be safely
// reduced to output size. Beyond that, decoding itself may allocate an
// unbounded bitmap before a canvas can resize it, so reject the input.
export const MAX_DECODE_WIDTH = MAX_IMAGE_WIDTH * 2;
export const MAX_DECODE_HEIGHT = MAX_IMAGE_HEIGHT * 2;
export const MAX_DECODE_PIXELS = MAX_IMAGE_PIXELS * 2;

// A compressed image larger than one byte per possible output pixel is
// unusually large and would expand to at least a full 4-byte RGBA buffer.
// This cap is therefore tied to the output catalogue rather than a guessed
// upload size, while still allowing ordinary 4K PNG/JPEG/WebP artwork.
export const MAX_IMAGE_FILE_BYTES = MAX_IMAGE_PIXELS;

export const ACCEPTED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
export type AcceptedImageType = (typeof ACCEPTED_IMAGE_TYPES)[number];

export type ImageInputErrorCode =
  | "invalid-type"
  | "empty-file"
  | "file-too-large"
  | "invalid-image"
  | "image-too-large"
  | "decode-failed"
  | "encode-failed";

export class ImageInputError extends Error {
  readonly name = "ImageInputError";

  constructor(readonly code: ImageInputErrorCode, message: string) {
    super(message);
  }
}

export interface ImageFileLike {
  readonly type: string;
  readonly size: number;
}

/** Validate cheap file properties before asking the browser to decode bytes. */
export function validateImageFile(file: ImageFileLike): ImageInputError | null {
  if (!ACCEPTED_IMAGE_TYPES.includes(file.type as AcceptedImageType)) {
    return new ImageInputError("invalid-type", "請選擇 PNG、JPEG 或 WebP 圖片。");
  }
  if (!Number.isFinite(file.size) || file.size <= 0) {
    return new ImageInputError("empty-file", "圖片檔案是空的。");
  }
  if (file.size > MAX_IMAGE_FILE_BYTES) {
    return new ImageInputError(
      "file-too-large",
      `圖片檔案不可超過 ${Math.round(MAX_IMAGE_FILE_BYTES / 1024 / 1024)} MB。`,
    );
  }
  return null;
}

export interface NormalizedImageAsset {
  /** Existing project schema-compatible value; no IndexedDB migration needed. */
  readonly dataUrl: string;
  readonly width: number;
  readonly height: number;
  readonly resized: boolean;
  /** Decoded normalized image, suitable for the live preview. */
  readonly image: HTMLImageElement;
}

export interface NormalizeImageOptions {
  readonly isCurrent?: () => boolean;
}

type DecodedImage = ImageBitmap | HTMLImageElement;
const releasedDecodedImages = new WeakSet<object>();

interface HeaderDimensions {
  readonly width: number;
  readonly height: number;
}

const HEADER_PROBE_BYTES = 64 * 1024;

function readUint24LE(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function parsePngHeader(bytes: Uint8Array): HeaderDimensions {
  if (
    bytes.length < 24 ||
    ![137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value) ||
    bytes[12] !== 73 || bytes[13] !== 72 || bytes[14] !== 68 || bytes[15] !== 82
  ) {
    throw new ImageInputError("invalid-image", "圖片格式與檔案內容不符。");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  if (!width || !height) throw new ImageInputError("invalid-image", "圖片尺寸無效。");
  return { width, height };
}

function parseJpegHeader(bytes: Uint8Array): HeaderDimensions {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    throw new ImageInputError("invalid-image", "圖片格式與檔案內容不符。");
  }
  // SOF markers carry dimensions. APP/COM/DQT segments are skipped without
  // decoding entropy-coded data, keeping this probe bounded.
  let offset = 2;
  while (offset + 3 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset++];
    if (marker === 0xd8 || marker === 0xd9) continue;
    if (marker === 0xda) break;
    if (offset + 1 >= bytes.length) break;
    const segmentLength = (bytes[offset] << 8) | bytes[offset + 1];
    if (segmentLength < 2 || offset + segmentLength > bytes.length) break;
    const isSof = (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker));
    if (isSof) {
      if (segmentLength < 7) break;
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const height = view.getUint16(offset + 3);
      const width = view.getUint16(offset + 5);
      if (!width || !height) break;
      return { width, height };
    }
    offset += segmentLength;
  }
  throw new ImageInputError("invalid-image", "無法讀取 JPEG 圖片尺寸。");
}

function parseWebpHeader(bytes: Uint8Array): HeaderDimensions {
  if (
    bytes.length < 16 ||
    bytes[0] !== 82 || bytes[1] !== 73 || bytes[2] !== 70 || bytes[3] !== 70 ||
    bytes[8] !== 87 || bytes[9] !== 69 || bytes[10] !== 66 || bytes[11] !== 80
  ) {
    throw new ImageInputError("invalid-image", "圖片格式與檔案內容不符。");
  }
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const chunkType = String.fromCharCode(...bytes.subarray(offset, offset + 4));
    const chunkSize = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset + 4, true);
    const payload = offset + 8;
    if (chunkType === "VP8X" && chunkSize >= 10 && payload + 10 <= bytes.length) {
      return { width: readUint24LE(bytes, payload + 4) + 1, height: readUint24LE(bytes, payload + 7) + 1 };
    }
    if (chunkType === "VP8L" && chunkSize >= 5 && payload + 5 <= bytes.length && bytes[payload] === 0x2f) {
      const packed = (
        bytes[payload + 1] |
        (bytes[payload + 2] << 8) |
        (bytes[payload + 3] << 16) |
        (bytes[payload + 4] << 24)
      ) >>> 0;
      return { width: (packed & 0x3fff) + 1, height: ((packed >>> 14) & 0x3fff) + 1 };
    }
    if (chunkType === "VP8 " && chunkSize >= 10 && payload + 10 <= bytes.length) {
      const frame = payload + 3;
      if (bytes[frame] === 0x9d && bytes[frame + 1] === 0x01 && bytes[frame + 2] === 0x2a) {
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        return { width: view.getUint16(frame + 3, true) & 0x3fff, height: view.getUint16(frame + 5, true) & 0x3fff };
      }
    }
    // RIFF chunks are padded to an even boundary.
    offset = payload + chunkSize + (chunkSize % 2);
  }
  throw new ImageInputError("invalid-image", "無法讀取 WebP 圖片尺寸。");
}

function parseImageHeader(bytes: Uint8Array, type: AcceptedImageType): HeaderDimensions {
  if (type === "image/png") return parsePngHeader(bytes);
  if (type === "image/jpeg") return parseJpegHeader(bytes);
  return parseWebpHeader(bytes);
}

async function readHeaderBytes(file: File, byteLength: number): Promise<Uint8Array> {
  try {
    const probe = file.slice(0, byteLength);
    const buffer = await new Promise<ArrayBuffer>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => reader.result instanceof ArrayBuffer
        ? resolve(reader.result)
        : reject(new Error("Image header is not an ArrayBuffer"));
      reader.onerror = () => reject(reader.error ?? new Error("Image header could not be read"));
      reader.readAsArrayBuffer(probe);
    });
    return new Uint8Array(buffer);
  } catch {
    throw new ImageInputError("invalid-image", "無法讀取圖片檔案。");
  }
}

async function probeImageHeader(file: File): Promise<HeaderDimensions> {
  const type = file.type as AcceptedImageType;
  let probeLength = Math.min(HEADER_PROBE_BYTES, file.size);
  let bytes = await readHeaderBytes(file, probeLength);
  if (type === "image/jpeg") {
    if (bytes.length < 2 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
      throw new ImageInputError("invalid-image", "圖片格式與檔案內容不符。");
    }
    let dimensions: HeaderDimensions;
    while (true) {
      try {
        dimensions = parseJpegHeader(bytes);
        break;
      } catch (error) {
        if (!(error instanceof ImageInputError) || probeLength >= file.size) throw error;
        probeLength = Math.min(file.size, probeLength * 2);
        bytes = await readHeaderBytes(file, probeLength);
      }
    }
    return validateHeaderDimensions(dimensions);
  }
  return validateHeaderDimensions(parseImageHeader(bytes, type));
}

function validateHeaderDimensions(dimensions: HeaderDimensions): HeaderDimensions {
  if (
    dimensions.width > MAX_DECODE_WIDTH ||
    dimensions.height > MAX_DECODE_HEIGHT ||
    dimensions.width * dimensions.height > MAX_DECODE_PIXELS
  ) {
    throw new ImageInputError("image-too-large", "圖片尺寸過大，請使用較小的圖片。");
  }
  return dimensions;
}

function imageDimensions(image: DecodedImage): { width: number; height: number } {
  const width = "naturalWidth" in image ? image.naturalWidth : image.width;
  const height = "naturalHeight" in image ? image.naturalHeight : image.height;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new ImageInputError("invalid-image", "無法讀取圖片尺寸。");
  }
  return { width, height };
}

function releaseDecodedImage(image: DecodedImage): void {
  if (releasedDecodedImages.has(image)) return;
  releasedDecodedImages.add(image);
  if ("close" in image && typeof image.close === "function") {
    image.close();
    return;
  }
  // Drop the browser's decoded resource as soon as the normalized copy exists.
  (image as HTMLImageElement).src = "";
}

function loadHtmlImage(source: string, revokeObjectUrl = false): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    let settled = false;
    const finish = (error?: unknown): void => {
      if (settled) return;
      settled = true;
      if (revokeObjectUrl) URL.revokeObjectURL(source);
      if (error) reject(error);
      else resolve(image);
    };
    image.onload = () => finish();
    image.onerror = () => finish(new ImageInputError("decode-failed", "無法解碼圖片。"));
    image.src = source;
  });
}

function readDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === "string"
      ? resolve(reader.result)
      : reject(new ImageInputError("encode-failed", "無法讀取圖片。"));
    reader.onerror = () => reject(new ImageInputError("encode-failed", "無法讀取圖片。"));
    reader.readAsDataURL(file);
  });
}

async function decodeImage(file: File): Promise<DecodedImage> {
  if (typeof globalThis.createImageBitmap === "function") {
    try {
      return await globalThis.createImageBitmap(file);
    } catch {
      // Some browsers expose createImageBitmap but do not support every image
      // type. Fall through to the broadly supported HTMLImageElement path.
    }
  }

  let objectUrl: string;
  try {
    objectUrl = URL.createObjectURL(file);
  } catch {
    throw new ImageInputError("decode-failed", "無法讀取圖片。");
  }
  return loadHtmlImage(objectUrl, true);
}

function normalizedDimensions(width: number, height: number): { width: number; height: number } {
  const scale = Math.min(
    1,
    MAX_IMAGE_WIDTH / width,
    MAX_IMAGE_HEIGHT / height,
    Math.sqrt(MAX_IMAGE_PIXELS / (width * height)),
  );
  return {
    width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale)),
  };
}

/**
 * Decode and normalize a user image into a bounded data URL.
 *
 * The original decoder and canvas are released in `finally`; only the bounded
 * data URL and its decoded preview image remain. The project format continues
 * to use `ImageReference.kind = "data-url"`, so old projects remain readable.
 */
export async function normalizeImageFile(file: File, options: NormalizeImageOptions = {}): Promise<NormalizedImageAsset> {
  const assertCurrent = (): void => {
    if (options.isCurrent && !options.isCurrent()) {
      throw new ImageInputError("decode-failed", "圖片請求已失效。");
    }
  };
  const validationError = validateImageFile(file);
  if (validationError) throw validationError;

  const headerSize = await probeImageHeader(file);
  assertCurrent();
  let decoded: DecodedImage | undefined;
  let canvas: HTMLCanvasElement | undefined;
  try {
    decoded = await decodeImage(file);
    assertCurrent();
    const sourceSize = imageDimensions(decoded);
    if (
      sourceSize.width > MAX_DECODE_WIDTH ||
      sourceSize.height > MAX_DECODE_HEIGHT ||
      sourceSize.width * sourceSize.height > MAX_DECODE_PIXELS
    ) {
      throw new ImageInputError("image-too-large", "圖片尺寸過大，請使用較小的圖片。");
    }
    const headerMatchesDecoded = sourceSize.width === headerSize.width && sourceSize.height === headerSize.height;
    const jpegOrientationSwapped = file.type === "image/jpeg"
      && sourceSize.width === headerSize.height
      && sourceSize.height === headerSize.width;
    if (!headerMatchesDecoded && !jpegOrientationSwapped) {
      throw new ImageInputError("invalid-image", "圖片尺寸資訊不一致。");
    }
    const size = normalizedDimensions(sourceSize.width, sourceSize.height);
    const resized = size.width !== sourceSize.width || size.height !== sourceSize.height;

    let dataUrl: string;
    if (!resized) {
      // Header validation and decoder verification are already complete, so an
      // in-range image can retain its original bytes without an extra canvas.
      dataUrl = await readDataUrl(file);
      assertCurrent();
    } else {
      canvas = document.createElement("canvas");
      canvas.width = size.width;
      canvas.height = size.height;
      const context = canvas.getContext("2d");
      if (!context) throw new ImageInputError("encode-failed", "瀏覽器不支援圖片處理。");
      context.drawImage(decoded, 0, 0, size.width, size.height);
      try {
        dataUrl = canvas.toDataURL(file.type);
      } catch {
        throw new ImageInputError("encode-failed", "無法處理圖片。");
      }
    }

    assertCurrent();
    // Do not keep the source bitmap/canvas alive while decoding the preview.
    releaseDecodedImage(decoded);
    decoded = undefined;
    if (canvas) {
      canvas.width = 1;
      canvas.height = 1;
      canvas = undefined;
    }
    const image = await loadHtmlImage(dataUrl);
    if (options.isCurrent && !options.isCurrent()) {
      releaseDecodedImage(image);
      throw new ImageInputError("decode-failed", "圖片請求已失效。");
    }
    return { dataUrl, width: size.width, height: size.height, resized, image };
  } catch (error) {
    if (error instanceof ImageInputError) throw error;
    throw new ImageInputError("decode-failed", "無法解碼圖片。");
  } finally {
    if (decoded) releaseDecodedImage(decoded);
    if (canvas) {
      canvas.width = 1;
      canvas.height = 1;
    }
  }
}
