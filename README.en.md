# Music Visualizer Studio

[繁體中文](README.md)

Music Visualizer Studio turns audio and a visual template into a downloadable MP4. Official video generation always runs on the server. The browser edits and stores project settings, uploads the assets for a job, checks progress, cancels a job, and plays or downloads the completed video.

```text
Choose audio and template -> Configure output -> Upload and submit -> Server render -> Preview/download MP4
```

## Current features

- Six visual templates: Night Orbit, Dawn Spectrum, Paper Resonance, Quiet Editorial, Panorama Lyrics, and Poetry Lyrics
- 16:9, 9:16, and 1:1 aspect ratios; 720p, 1080p, and 4K output; 30 or 60 fps
- MP3, WAV, and M4A audio up to 10 minutes; PNG, JPEG, and WebP images; UTF-8 SRT for lyric templates
- Project settings and parsed subtitle text stay in browser-local storage; source audio, images, and subtitle files are temporary server job inputs
- The server uses Pillow and NumPy on the CPU for audio analysis and frame-by-frame scene drawing, then NVIDIA NVENC encodes H.264 `yuv420p` video with AAC audio into MP4
- SQLite stores the single-host job queue and status; one background worker renders jobs in order by default
- Temporary source assets are removed when a job completes, fails, is cancelled, or is confirmed interrupted. Completed MP4 files remain on the server until explicitly deleted

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
