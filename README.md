# Music Visualizer Studio

Music Visualizer Studio is a browser-first web application for turning an audio track into a downloadable MP4 music visualizer:

```text
Upload audio -> Choose a visual template -> Configure output -> Render -> Download MP4
```

The first release is designed for personal and internal use. The boundaries between the browser UI, render pipeline, project metadata, and storage are intentionally kept portable so the application can become a public SaaS later without replacing its visual templates.

## Current scope

- Three initial visual directions:
  - Minimal cover art with an audio spectrum
  - Rotating record with animated particles
  - Full-screen abstract motion background with waveform and beat effects
- Output aspect ratios: 16:9, 9:16, and 1:1
- Selectable output resolution, up to 4K
- Selectable frame rate, up to 60 fps
- Audio input: MP3, WAV, and M4A, initially limited to 10 minutes per track
- Cover/background image, title, and artist fields
- Browser-first rendering in a Web Worker, with GPU or hardware encoding when available
- MP4 output retained in browser-local IndexedDB for later preview/download
- Audio is used for rendering but is not retained
- Desktop Chrome and Edge are the primary supported browsers for the MVP

## Environment

- Ubuntu Server 24.04
- Python backend using a `uv`-managed virtual environment
- FastAPI backend serving the built frontend and health endpoints
- Service bind address: `0.0.0.0:34388`

From another machine, use `http://<server-ip>:34388`. `0.0.0.0` is a server bind address, not normally the address entered in a browser.

The server does not require a GPU for the MVP because rendering is performed in the user's browser. A future server-rendering fallback may use CPU workers and can later be deployed with GPU workers if scale requires it.

## Local development

Install the locked backend environment with `uv`:

```bash
uv sync --frozen
```

Install and build the TypeScript frontend:

```bash
cd frontend
npm ci
npm run build
cd ..
```

Start the FastAPI service (which serves `frontend/dist`):

```bash
uv run music-visualizer
```

It listens on `0.0.0.0:34388` by default. Use `http://127.0.0.1:34388` locally
or `http://<server-ip>:34388` from a trusted machine. `VISUALIZER_HOST` and
`VISUALIZER_PORT` can override the defaults. For frontend-only hot reload:

```bash
cd frontend
npm run dev
```

See [docs/development.md](docs/development.md) for browser codec strategy and
the validated Chrome/Edge matrix, and [docs/deployment.md](docs/deployment.md)
for Ubuntu Server deployment.

## Tests

Backend checks:

```bash
uv sync --frozen
uv run pytest tests/backend
```

Frontend unit tests, type-check, and production build:

```bash
cd frontend
npm ci
npm test
npm run build
```

Optional Playwright browser checks:

```bash
npx playwright install chromium
npm run test:e2e
```

## Architecture at a glance

```text
Browser
  |-- audio + template settings + image assets
  v
Web Worker -> Canvas/WebGL -> WebCodecs -> MP4 muxing
  |
  +--> IndexedDB/local browser storage: project metadata and generated MP4
  +--> audio bytes: released after rendering and never copied into project storage

FastAPI server
  |-- serves the application and future APIs
  +-- does not need a GPU for browser rendering
```

See [docs/architecture.md](docs/architecture.md) for the design rationale and the future server-rendering boundary.

## Privacy and MVP limitations

Source audio is decoded in memory for the active render only. It is never sent
to FastAPI or written to the server filesystem. Projects do not retain the
source filename, metadata, absolute path, or file handle. The browser releases
decoded audio after completion, cancellation, or failure. Project metadata,
render history, and generated MP4 Blobs remain local to the browser.
Users can delete an output while keeping its project configuration, or delete a
project completely. Browser eviction, cleared site data, private browsing, or
quota limits can remove local projects and outputs, so local storage is not a
backup.

Rendering is capability-gated and device-dependent. A successful preflight
does not guarantee real-time performance for long videos or 4K60: available
RAM, browser limits, local storage, and device performance still apply. The
MVP has no accounts, cloud sync, public sharing, authentication, or server-side
render fallback. H.264/AAC is preferred for broad playback compatibility, with
additional browser codec fallbacks documented in
[docs/development.md](docs/development.md).

See [docs/storage-and-privacy.md](docs/storage-and-privacy.md) for the full
local-data lifecycle.

## Documentation

- [Product requirements](docs/product-requirements.md)
- [Architecture](docs/architecture.md)
- [Development](docs/development.md)
- [Deployment](docs/deployment.md)
- [Storage and privacy](docs/storage-and-privacy.md)

## Project status

The MVP implementation is complete. Future work may add authenticated SaaS
accounts, cloud synchronization, sharing, and a server-side CPU/GPU rendering
fallback without changing the browser template configuration boundary.
