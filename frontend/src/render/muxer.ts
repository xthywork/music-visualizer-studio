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
  constructor(private readonly factory?: MuxerFactory) {}
  mux(input: MuxerInput): Blob {
    if (!this.factory) throw new Error("MP4 muxer is not configured. Install mp4-muxer and provide a MuxerFactory.");
    this.muxer = this.factory(input.metadata);
    for (const chunk of input.video) this.muxer.addVideoChunk(chunk);
    for (const chunk of input.audio) this.muxer.addAudioChunk(chunk);
    const result = this.muxer.finalize();
    return result instanceof Blob ? result : new Blob([result as BlobPart], { type: "video/mp4" });
  }
  close() { this.muxer = undefined; }
}

export function createMp4MuxerFactory(policy?: CodecPolicy, MuxerCtor: any = Muxer): MuxerFactory {
  return (metadata) => {
    const selected = policy ?? metadata.codecPolicy ?? codecPolicy({ aspectRatio: "16:9", resolution: "720p", frameRate: metadata.frameRate as FrameRate });
    const targetRef = new ArrayBufferTarget();
    const muxer = new MuxerCtor({ target: targetRef, video: { codec: selected.video.containerCodec, width: metadata.width, height: metadata.height, frameRate: metadata.frameRate }, ...(metadata.hasAudio ? { audio: { codec: selected.audio.containerCodec, sampleRate: selected.audio.sampleRate, numberOfChannels: selected.audio.numberOfChannels } } : {}), fastStart: "in-memory", firstTimestampBehavior: "offset" });
    return {
      addVideoChunk: (chunk) => muxer.addVideoChunkRaw(chunk.data, chunk.type, chunk.timestamp, chunk.duration ?? 1_000_000 / metadata.frameRate, chunk.metadata as any),
      addAudioChunk: (chunk) => muxer.addAudioChunkRaw(chunk.data, chunk.type, chunk.timestamp, chunk.duration ?? 1024 * 1_000_000 / 48_000, chunk.metadata as any),
      finalize: () => { muxer.finalize(); return new Blob([targetRef.buffer], { type: "video/mp4" }); },
    };
  };
}
