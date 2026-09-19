# Architecture

[繁體中文](architecture.md)

## Official render flow

All official MP4s are generated on the server. The browser stores project settings and parsed subtitle text, uploads the assets and configuration for a job, then checks status, cancels work, plays the completed video, or downloads the output. The browser does not perform official audio analysis, frame drawing, video encoding, or MP4 muxing.

```text
Browser
  |-- local project settings, subtitle text, and server job/output reference
  |-- uploads audio, images, subtitles, and render configuration
  |-- checks status / cancels / previews / downloads
  v
FastAPI service ─── SQLite single-host queue
                         |
                         v
                 One background render worker
                 CPU: FFmpeg decode, NumPy analysis, Pillow scene drawing
                 NVIDIA NVENC: H.264 yuv420p + AAC -> MP4
                         |
                         +-- temporary sources and work files: cleaned at termination
                         +-- completed output: retained until explicit deletion
```

The server target is Ubuntu Server 24.04, a Ryzen 9 5900X, and an NVIDIA GPU. The Python worker uses Pillow and NumPy on the CPU to produce RGB frames one at a time. FFmpeg streams those frames to `h264_nvenc`, encodes H.264 `yuv420p` video, encodes the source audio as AAC, and muxes an MP4. The frame pipeline is bounded, so memory use does not grow with the video's total frame count.

## Queue and process boundary

SQLite with WAL stores job configuration snapshots, status, progress, cancellation flags, and output references. HTTP handlers do not render. One background worker atomically claims the next queued job, avoiding multiple simultaneous GPU encode sessions by default. `uv run music-visualizer` starts the API and worker supervisor. Worker readiness runs a real short NVENC encode followed by ffprobe verification.

Main job states are queued, running, completed, failed, cancelled, interrupted, and unavailable. After a browser reload, the client uses the job identity to fetch authoritative server status. On server restart, orphaned work is recovered and temporary inputs and partial outputs are cleaned. Cancellation stops the worker-owned FFmpeg process, and a late completion cannot overwrite a terminal state.

## Asset and output lifecycle

Each job has an isolated UUID-derived directory with input, work, and output areas. The server streams audio, images, and subtitles to disk, validates size, format, content, and configuration, then enqueues the job in SQLite. Source assets and intermediate files are idempotently removed when a job completes, fails, is cancelled, or is confirmed interrupted. A partial MP4 is never exposed as a completed output. Completed MP4s have no default TTL and remain until the user explicitly deletes the job/output or an administrator performs explicit cleanup.

Project configuration and the last known job/output reference stay in browser-local storage. A reference does not prove that the server output still exists; reopening a project refreshes its status and can show it as unavailable. Source audio is not part of the project record, so it must be selected and uploaded again for a new render.

## Network boundary

This is a single-host application for a trusted network and has no accounts or tenant isolation. Restrict access to a trusted network or VPN. For access across networks, add HTTPS and authentication at a reverse proxy. Do not expose the application directly to the public Internet or treat this deployment as a public SaaS.
