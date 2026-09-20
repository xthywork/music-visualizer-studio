# Development Guide

[繁體中文](development.md)

## Development environment

- Python 3.12+ and `uv`
- Ubuntu Server 24.04 as the primary deployment target
- An NVIDIA driver and FFmpeg/`ffprobe` with `h264_nvenc` for hardware acceptance
- Node.js and npm only for developers changing frontend source

There are two production output paths. Server mode uses FFmpeg decoding and NumPy analysis, then 12 bounded processes draw Pillow frames concurrently and feed them in order to NVIDIA `h264_nvenc` with AAC. SQLite stores the single-host queue and one background job worker processes jobs in order. This Device mode reuses the scene configuration and generates in the browser with AudioContext, a module Worker, WebCodecs, and an MP4 muxer.

## Python development and software checks

```bash
uv sync --frozen
uv run pytest tests/backend
uv run music-visualizer
```

At startup, the worker runs a real short NVENC preflight and reports readiness through `/health` and `/api/render-capabilities`. A successful preflight confirms that the driver, FFmpeg, and an encode session are available; it does not guarantee performance at a particular resolution.

## NVIDIA hardware acceptance

Run the opt-in acceptance test on the target GPU host:

```bash
VISUALIZER_RUN_NVENC_TESTS=1 uv run pytest tests/backend/test_nvenc_hardware.py -v
```

It encodes 720p30, 1080p60, and 4K60 outputs and verifies H.264, `yuv420p`, dimensions, frame rate, and the AAC audio stream. Run this first on the current RTX 5070 Ti; after a future move to an RTX 3060, run the same command. The hardware test is skipped when the environment variable is not set.

## Frontend development

Normal users do not need Node.js/npm to run the committed production bundle. Developers changing `frontend/src` install dependencies, run tests and build, then commit the updated `frontend/dist`:

```bash
cd frontend
npm ci
npm test
npm run build
git status --short dist
```

## Privacy and storage invariants

- Project settings, template appearance, parsed subtitle cues, client output metadata, and server job references stay in browser-local storage.
- When a server render is created, source audio, required images, and subtitles are uploaded to an isolated temporary area and removed after completion, failure, cancellation, or confirmed interruption. A client render creates no server job.
- Server MP4s remain until explicitly deleted. Client MP4s are saved in IndexedDB when quota permits; quota-failed Blobs exist only in the current tab.
- Jobs use UUID-derived directories and a single-host SQLite queue. Never use a client filename or absolute path as a server path.
- This account-free service is for a trusted network/VPN only. Access across networks requires an authenticated reverse proxy; do not expose it as a public SaaS.
