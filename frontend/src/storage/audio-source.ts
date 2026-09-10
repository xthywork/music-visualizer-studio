import type { SourceAudioMetadata } from "../domain";
import type { FileSystemFileHandleLike } from "./types";

export interface AudioSourceSelection {
  readonly file: File;
  readonly metadata: SourceAudioMetadata;
  readonly handle?: FileSystemFileHandleLike;
}

export type ShowOpenFilePicker = (options?: {
  multiple?: boolean;
  types?: readonly { description?: string; accept: Record<string, readonly string[]> }[];
}) => Promise<readonly FileSystemFileHandleLike[]>;

export class FileSystemAccessUnavailableError extends Error {
  override readonly name = "FileSystemAccessUnavailableError";
}

export class AudioSourcePermissionError extends Error {
  override readonly name = "AudioSourcePermissionError";
}

/** Converts a File to safe identity metadata; bytes stay in the active session. */
export function sourceAudioMetadataFromFile(file: Pick<File, "name" | "size" | "lastModified" | "type">): SourceAudioMetadata {
  return {
    filename: file.name.replaceAll("\\", "/").split("/").pop() ?? file.name,
    size: file.size,
    lastModified: file.lastModified,
    type: file.type,
  };
}

/** Fallback path for the ordinary `<input type=file>` flow. */
export function selectionFromInput(file: File): AudioSourceSelection {
  return { file, metadata: sourceAudioMetadataFromFile(file) };
}

export function hasFileSystemAccessPicker(): boolean {
  return typeof getPicker() === "function";
}

/**
 * Opens a user-gesture file picker when supported. The returned handle is
 * optional and is stored separately from project JSON by ProjectStorage.
 */
export async function pickAudioSource(picker: ShowOpenFilePicker | undefined = getPicker()): Promise<AudioSourceSelection> {
  if (!picker) throw new FileSystemAccessUnavailableError("File System Access is unavailable; use the audio file input.");
  const handles = await picker({
    multiple: false,
    types: [{ description: "Audio", accept: { "audio/*": [".mp3", ".wav", ".m4a"] } }],
  });
  const handle = handles[0];
  if (!handle) throw new Error("No audio file was selected.");
  const file = await handle.getFile();
  return { file, metadata: sourceAudioMetadataFromFile(file), handle };
}

/** Reopens a stored handle after an explicit user gesture and permission check. */
export async function fileFromAudioHandle(handle: FileSystemFileHandleLike): Promise<File> {
  let permission = await handle.queryPermission?.({ mode: "read" });
  if (permission === "denied" && handle.requestPermission) {
    permission = await handle.requestPermission({ mode: "read" });
  } else if (permission === "prompt" && handle.requestPermission) {
    permission = await handle.requestPermission({ mode: "read" });
  }
  if (permission === "denied") {
    throw new AudioSourcePermissionError("Audio permission was denied; select the source file again.");
  }
  return handle.getFile();
}

function getPicker(): ShowOpenFilePicker | undefined {
  const global = globalThis as typeof globalThis & { showOpenFilePicker?: ShowOpenFilePicker };
  return global.showOpenFilePicker;
}
