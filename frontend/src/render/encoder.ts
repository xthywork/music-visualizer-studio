import { codecPolicy, type CapabilityEnvironment, type CodecPolicy } from "./capabilities";
import type { PcmAudioSnapshot } from "./audio-analysis";
import type { OutputConfig } from "./types";

export interface EncodedChunk { type: "key" | "delta"; timestamp: number; duration?: number; data: Uint8Array; metadata?: unknown; }
export interface EncoderOutput { video: EncodedChunk[]; audio: EncodedChunk[]; }

type EncoderCtor = new (init: { output: (chunk: unknown, metadata?: unknown) => void; error: (error: DOMException) => void }) => { configure(config: unknown): void; encode(frame: unknown, options?: unknown): void; flush(): Promise<void>; close(): void };
type EncoderInstance = { configure(config: unknown): void; encode(frame: unknown, options?: unknown): void; flush(): Promise<void>; close(): void };

export class WebCodecsEncoderAdapter {
  private videoEncoder?: EncoderInstance;
  private audioEncoder?: EncoderInstance;
  private readonly output: EncoderOutput = { video: [], audio: [] };
  private videoError?: Error;
  private audioError?: Error;

  private readonly policy: CodecPolicy;
  constructor(outputConfig: OutputConfig, private readonly env: CapabilityEnvironment = {}, policy?: CodecPolicy) { this.policy = policy ?? codecPolicy(outputConfig); }

  async configure(): Promise<void> {
    const videoCtor = this.env.videoEncoder ?? globalThis.VideoEncoder as unknown as EncoderCtor | undefined;
    const audioCtor = this.env.audioEncoder ?? globalThis.AudioEncoder as unknown as EncoderCtor | undefined;
    if (!videoCtor || !audioCtor) throw new Error("WebCodecs video and audio encoders are unavailable.");
    const policy = this.policy;
    this.videoEncoder = new videoCtor({ output: (chunk: any, metadata?: unknown) => this.output.video.push(readChunk(chunk, metadata)), error: (error) => { this.videoError = error; } });
    this.audioEncoder = new audioCtor({ output: (chunk: any, metadata?: unknown) => this.output.audio.push(readChunk(chunk, metadata)), error: (error) => { this.audioError = error; } });
    this.videoEncoder.configure(policy.video); this.audioEncoder.configure(policy.audio);
  }

  encodeVideo(frame: unknown, keyFrame = false) {
    if (this.videoError) throw this.videoError;
    if (!this.videoEncoder) throw new Error("Encoder has not been configured.");
    this.videoEncoder.encode(frame, { keyFrame });
  }

  encodeAudio(audio: unknown) {
    if (this.audioError) throw this.audioError;
    if (!this.audioEncoder) throw new Error("Encoder has not been configured.");
    this.audioEncoder.encode(audio);
  }

  /** Encode transient PCM blocks into AAC. AudioData is never returned or persisted. */
  encodeAudioBuffer(buffer: AudioBuffer, blockFrames = 1024) {
    const AudioDataCtor = (globalThis as any).AudioData;
    if (!AudioDataCtor) throw new Error("AudioData is unavailable in this browser.");
    if (!this.audioEncoder) throw new Error("Encoder has not been configured.");
    const channels = buffer.numberOfChannels; const sampleRate = buffer.sampleRate;
    for (let offset = 0; offset < buffer.length; offset += blockFrames) {
      const frames = Math.min(blockFrames, buffer.length - offset); const samples = new Float32Array(frames * channels);
      for (let channel = 0; channel < channels; channel++) samples.set(buffer.getChannelData(channel).subarray(offset, offset + frames), channel * frames);
      const audioData = new AudioDataCtor({ format: "f32-planar", sampleRate, numberOfFrames: frames, numberOfChannels: channels, timestamp: offset * 1_000_000 / sampleRate, data: samples });
      try { this.encodeAudio(audioData); } finally { audioData.close?.(); }
    }
  }

  /**
   * Encodes transfer-friendly PCM directly in the worker. The codec policy is
   * stereo AAC at 48 kHz; mono input is duplicated and other channel layouts
   * are downmixed by selecting their first two channels. Linear interpolation
   * keeps source sample rates compatible without retaining a second PCM copy.
   */
  async encodePcmSnapshot(
    snapshot: PcmAudioSnapshot,
    blockFrames = 1024,
    targetRate = this.policy.audio.sampleRate,
    shouldCancel: () => boolean = () => false,
  ): Promise<boolean> {
    const AudioDataCtor = (globalThis as any).AudioData;
    if (!AudioDataCtor) throw new Error("AudioData is unavailable in this browser.");
    if (!this.audioEncoder) throw new Error("Encoder has not been configured.");
    const sourceLength = snapshot.channels.reduce((max, channel) => Math.max(max, channel.length), 0);
    const sourceChannels = Math.max(1, Math.min(2, snapshot.channels.length));
    const outputFrames = Math.max(1, Math.round(snapshot.duration * targetRate));
    for (let offset = 0; offset < outputFrames; offset += blockFrames) {
      if (shouldCancel()) return false;
      const frames = Math.min(blockFrames, outputFrames - offset); const samples = new Float32Array(frames * 2);
      for (let frame = 0; frame < frames; frame++) {
        const sourcePosition = Math.min(Math.max(0, sourceLength - 1), (offset + frame) * snapshot.sampleRate / targetRate);
        const before = Math.floor(sourcePosition); const after = Math.min(sourceLength - 1, before + 1); const mix = sourcePosition - before;
        for (let channel = 0; channel < 2; channel++) {
          const source = snapshot.channels[channel < sourceChannels ? channel : 0];
          samples[channel * frames + frame] = (source?.[before] ?? 0) * (1 - mix) + (source?.[after] ?? 0) * mix;
        }
      }
      const audioData = new AudioDataCtor({ format: "f32-planar", sampleRate: targetRate, numberOfFrames: frames, numberOfChannels: 2, timestamp: offset * 1_000_000 / targetRate, data: samples });
      try { this.encodeAudio(audioData); } finally { audioData.close?.(); }
      if ((offset / blockFrames) % 32 === 31) await yieldToEventLoop();
    }
    return true;
  }

  async flush(): Promise<EncoderOutput> {
    if (this.videoEncoder) await this.videoEncoder.flush();
    if (this.audioEncoder) await this.audioEncoder.flush();
    if (this.videoError || this.audioError) throw this.videoError ?? this.audioError;
    return { video: this.output.video.slice(), audio: this.output.audio.slice() };
  }

  close() { try { this.videoEncoder?.close(); } finally { this.audioEncoder?.close(); this.videoEncoder = undefined; this.audioEncoder = undefined; } }
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function readChunk(chunk: any, metadata?: unknown): EncodedChunk {
  const data = new Uint8Array(chunk.byteLength); chunk.copyTo(data);
  return { type: chunk.type === "key" ? "key" : "delta", timestamp: Number(chunk.timestamp ?? 0), duration: chunk.duration == null ? undefined : Number(chunk.duration), data, metadata };
}
