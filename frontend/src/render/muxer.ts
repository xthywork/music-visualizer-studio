import type { EncodedChunk } from "./encoder";
import { codecPolicy, type CodecPolicy } from "./capabilities";
import type { FrameRate } from "./types";
import { ArrayBufferTarget, Muxer } from "mp4-muxer";

export interface MuxMetadata { width: number; height: number; frameRate: number; duration: number; hasAudio: boolean; hasVideo: boolean; codecPolicy?: CodecPolicy; }
export interface MuxerInput { video: EncodedChunk[]; audio: EncodedChunk[]; metadata: MuxMetadata; }
export interface Mp4MuxerLike { addVideoChunk(chunk: EncodedChunk): void; addAudioChunk(chunk: EncodedChunk): void; finalize(): Blob | ArrayBuffer | Uint8Array; }
export type MuxerFactory = (metadata: MuxMetadata) => Mp4MuxerLike;

/** Adapter boundary for mp4-muxer. Inject `new Muxer({...})` from the app when the package is installed. */
export class Mp4MuxerAdapter {
  private muxer?: Mp4MuxerLike;
  elapsedMs = 0;
  private timed<T>(operation: () => T): T {
    const start = performance.now();
    try { return operation(); } finally { this.elapsedMs += performance.now() - start; }
  }
  constructor(private readonly factory?: MuxerFactory) {}

  /** Start a streaming mux session before encoders begin producing chunks. */
  begin(metadata: MuxMetadata): void {
    if (!this.factory) throw new Error("MP4 muxer is not configured. Install mp4-muxer and provide a MuxerFactory.");
    this.close();
    this.elapsedMs = 0;
    this.muxer = this.timed(() => this.factory!(metadata));
  }
  addVideoChunk(chunk: EncodedChunk): void {
    if (!this.muxer) throw new Error("MP4 muxer session has not started.");
    this.timed(() => this.muxer!.addVideoChunk(chunk));
  }
  addAudioChunk(chunk: EncodedChunk): void {
    if (!this.muxer) throw new Error("MP4 muxer session has not started.");
    this.timed(() => this.muxer!.addAudioChunk(chunk));
  }
  finalize(): Blob {
    if (!this.muxer) throw new Error("MP4 muxer session has not started.");
    return this.timed(() => toMp4Blob(this.muxer!.finalize()));
  }
  mux(input: MuxerInput): Blob {
    this.begin(input.metadata);
    try {
      for (const chunk of input.video) this.addVideoChunk(chunk);
      for (const chunk of input.audio) this.addAudioChunk(chunk);
      return this.finalize();
    } catch (error) {
      this.close();
      throw error;
    }
  }
  close() { this.muxer = undefined; }
}

function toMp4Blob(result: Blob | ArrayBuffer | Uint8Array): Blob {
  return result instanceof Blob ? result : new Blob([result as BlobPart], { type: "video/mp4" });
}

export function createMp4MuxerFactory(policy?: CodecPolicy, MuxerCtor: any = Muxer): MuxerFactory {
  return (metadata) => {
    const selected = policy ?? metadata.codecPolicy ?? codecPolicy({ aspectRatio: "16:9", resolution: "720p", frameRate: metadata.frameRate as FrameRate });
    const targetRef = new ArrayBufferTarget();
    // Fast-start in-memory keeps every media chunk again for a second pass.
    // Metadata-at-end is still a regular playable MP4 and lets ArrayBufferTarget
    // append chunks without the extra fast-start bookkeeping peak.
    const muxer = new MuxerCtor({ target: targetRef, video: { codec: selected.video.containerCodec, width: metadata.width, height: metadata.height, frameRate: metadata.frameRate }, ...(metadata.hasAudio ? { audio: { codec: selected.audio.containerCodec, sampleRate: selected.audio.sampleRate, numberOfChannels: selected.audio.numberOfChannels } } : {}), fastStart: false, firstTimestampBehavior: "offset" });
    return {
      addVideoChunk: (chunk) => muxer.addVideoChunkRaw(chunk.data, chunk.type, chunk.timestamp, chunk.duration ?? 1_000_000 / metadata.frameRate, chunk.metadata as any),
      addAudioChunk: (chunk) => muxer.addAudioChunkRaw(chunk.data, chunk.type, chunk.timestamp, chunk.duration ?? 1024 * 1_000_000 / 48_000, chunk.metadata as any),
      finalize: () => { muxer.finalize(); return new Blob([targetRef.buffer], { type: "video/mp4" }); },
    };
  };
}
