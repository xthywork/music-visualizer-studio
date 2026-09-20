# Music Visualizer Studio

[繁體中文](README.md)

Music Visualizer Studio turns audio and a visual template into a downloadable MP4. At the bottom of the project list, users can choose server rendering or rendering on the current browser with WebCodecs. Server rendering is the default for first-time use.

```text
Choose audio and template -> Configure output and render location -> Generate -> Preview/download MP4
```

## Current features

- Six visual templates: Night Orbit, Dawn Spectrum, Paper Resonance, Quiet Editorial, Panorama Lyrics, and Poetry Lyrics
- 16:9, 9:16, and 1:1 aspect ratios; 720p, 1080p, and 4K output; 30 or 60 fps
- MP3, WAV, and M4A audio up to 10 minutes; PNG, JPEG, and WebP images; UTF-8 SRT for lyric templates
- Project settings and parsed subtitle text stay in browser-local storage; source audio is never written to a project record
- The server uses Pillow and NumPy on the CPU for audio analysis and frame-by-frame scene drawing, then NVIDIA NVENC encodes H.264 `yuv420p` video with AAC audio into MP4
- This Device mode uses AudioContext, a Web Worker, WebCodecs, and an MP4 muxer for browser-side analysis, drawing, and packaging. Availability is checked for the browser and selected output, with no automatic mode fallback
- SQLite stores the single-host job queue and status. One background job worker processes jobs in order; each job uses 12 bounded frame processes and feeds their ordered output into one NVENC encoder
- Server source assets are temporary and completed server MP4s remain until explicitly deleted. Client MP4s are stored in browser IndexedDB when quota permits

## Server requirements

The primary deployment target is Ubuntu Server 24.04. The host needs Python 3.12+, `uv`, an NVIDIA driver, and FFmpeg with the `h264_nvenc` encoder plus `ffprobe`. The current acceptance host uses a Ryzen 9 5900X and RTX 5070 Ti. After a future move to an RTX 3060, use the same startup preflight and hardware acceptance command.

The production frontend is included in a clean clone. Start the application with:

```bash
uv run music-visualizer
```

Normal users do not need Node.js or npm. Developers changing `frontend/src` install the frontend dependencies, run `npm ci` and `npm run build` in `frontend/`, and commit the updated `frontend/dist` files.

The service listens on `0.0.0.0:34388` by default. Restrict access to a trusted network or VPN. For access from another network, put an authenticated HTTPS reverse proxy in front. This account-free, single-host service is not a public SaaS deployment.

See the [deployment guide](docs/deployment.en.md) for installation and network configuration.

## Development and checks

Set up the Python environment and run the backend checks:

```bash
uv sync --frozen
uv run pytest tests/backend
```

On a host with an NVIDIA driver and NVENC-enabled FFmpeg, run the optional hardware acceptance test. It covers 720p, 1080p60, and 4K60:

```bash
VISUALIZER_RUN_NVENC_TESTS=1 uv run pytest tests/backend/test_nvenc_hardware.py -v
```

Run this on the RTX 5070 Ti for current acceptance, then run the same command after a future move to an RTX 3060. The worker also runs a short `h264_nvenc` startup preflight. Check readiness through the health and capability endpoints:

```bash
curl -fsS http://127.0.0.1:34388/health
curl -fsS http://127.0.0.1:34388/api/render-capabilities
```

Frontend developers install Node.js/npm, rebuild, and commit the production bundle:

```bash
cd frontend
npm ci
npm test
npm run build
```

## Documentation

- [Product requirements](docs/product-requirements.en.md)
- [Architecture](docs/architecture.en.md)
- [Development](docs/development.en.md)
- [Deployment](docs/deployment.en.md)
- [Storage and privacy](docs/storage-and-privacy.en.md)
- [Quiet Editorial visual and motion design](docs/quiet-editorial.en.md)
- [Paper Resonance visual and motion design](docs/paper-resonance.en.md)
- [Subtitle templates and editor controls](docs/subtitle-templates.en.md)
