# Architecture

[繁體中文](architecture.md)

## Dual render flow

The browser stores project settings and parsed subtitle text. A control at the bottom of the project list selects Server or This Device. This is a browser-wide preference that defaults to Server. Each job keeps the mode selected at start, and an unavailable mode never falls back automatically.

```text
Browser
  |-- local project settings, subtitle text, and mixed render history
  |
  |-- Server: upload assets/config -> FastAPI -> SQLite queue
  |                                      |
  |                                      v
  |                              background render worker
  |                              CPU analysis and scene drawing
  |                              NVENC or libx264 + AAC -> MP4
  |
  +-- This Device: AudioContext -> Web Worker scene drawing
                                   WebCodecs + MP4 muxer -> MP4
```

The server target is Ubuntu Server 24.04. One job worker starts 12 frame processes by default to produce RGB frames concurrently with Python, Pillow, and NumPy. The parent keeps at most 12 frames in flight, restores frame-number order, and streams them to one FFmpeg encoder for H.264 `yuv420p` video with AAC. The default encoder is `h264_nvenc`; `libx264` can instead encode entirely on the server CPU. Read-only images and analysis data use Linux fork copy-on-write sharing. Memory remains bounded and does not grow with total video length. Each Quiet Editorial process caches the fixed background, cover, typography, and layout; later frames copy that base and draw only audio-reactive content.

This Device mode reuses the same serialized scene configuration. The main thread decodes audio through AudioContext; a module Worker draws frames and uses WebCodecs, then an MP4 muxer produces the Blob. Capability is checked for the selected resolution and frame rate. Client-side 4K60 availability depends on the browser, codecs, and device hardware.

## Queue and process boundary

SQLite with WAL stores job configuration snapshots, status, progress, cancellation flags, and output references. HTTP handlers do not render. One background worker atomically claims the next queued job, avoiding multiple simultaneous encode sessions by default. `uv run music-visualizer` starts the API and worker supervisor. Worker readiness runs a real short encode with the selected encoder followed by ffprobe verification.

Main job states are queued, running, completed, failed, cancelled, interrupted, and unavailable. After a browser reload, the client uses the job identity to fetch authoritative server status. On server restart, orphaned work is recovered and temporary inputs and partial outputs are cleaned. Cancellation stops the worker-owned FFmpeg process, and a late completion cannot overwrite a terminal state.

## Asset and output lifecycle

Each job has an isolated UUID-derived directory with input, work, and output areas. The server streams audio, images, and subtitles to disk, validates size, format, content, and configuration, then enqueues the job in SQLite. Source assets and intermediate files are idempotently removed when a job completes, fails, is cancelled, or is confirmed interrupted. A partial MP4 is never exposed as a completed output. Completed MP4s have no default TTL and remain until the user explicitly deletes the job/output or an administrator performs explicit cleanup.

Project configuration and render history stay in browser-local storage. A server reference does not prove that the output still exists; reopening a project refreshes it with the server. Client output Blobs are stored in IndexedDB when quota permits. If persistence fails, the new Blob remains available only in the current tab and is marked unsaved after leaving the project or reloading. Source audio is not part of the project record and must be selected again for a new render.

## Network boundary

This is a single-host application for a trusted network and has no accounts or tenant isolation. Restrict access to a trusted network or VPN. For access across networks, add HTTPS and authentication at a reverse proxy. Do not expose the application directly to the public Internet or treat this deployment as a public SaaS.
