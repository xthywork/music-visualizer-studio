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
- MP4 output retained in the browser's local storage for later download
- Audio is used for rendering but is not retained
- Desktop Chrome and Edge are the primary supported browsers for the MVP

## Environment

- Ubuntu Server 24.04
- Python backend using a `uv`-managed virtual environment
- FastAPI backend (planned)
- Service bind address: `0.0.0.0:34388`

From another machine, use `http://<server-ip>:34388`. `0.0.0.0` is a server bind address, not normally the address entered in a browser.

The server does not require a GPU for the MVP because rendering is performed in the user's browser. A future server-rendering fallback may use CPU workers and can later be deployed with GPU workers if scale requires it.

## Local development

The implementation is not yet started. Once the application scaffold is added, the expected backend setup will be:

```bash
uv venv
source .venv/bin/activate
uv sync
```

The development service should listen on:

```text
http://0.0.0.0:34388
```

See [docs/development.md](docs/development.md) for conventions and the planned local workflow.

## Architecture at a glance

```text
Browser
  |-- audio + template settings + image assets
  v
Web Worker -> Canvas/WebGL -> WebCodecs -> MP4 muxing
  |
  +--> IndexedDB/local browser storage: project metadata and generated MP4
  +--> audio source: discarded after rendering

FastAPI server
  |-- serves the application and future APIs
  +-- does not need a GPU for browser rendering
```

See [docs/architecture.md](docs/architecture.md) for the design rationale and the future server-rendering boundary.

## Privacy and data lifecycle

Audio files are not uploaded or retained by the application design. Project settings and generated MP4 files are stored locally in the browser and can be deleted by the user. Clearing site data, using private browsing, or exceeding browser storage quota can remove local projects.

See [docs/storage-and-privacy.md](docs/storage-and-privacy.md).

## Documentation

- [Product requirements](docs/product-requirements.md)
- [Architecture](docs/architecture.md)
- [Development](docs/development.md)
- [Deployment](docs/deployment.md)
- [Storage and privacy](docs/storage-and-privacy.md)

## Project status

This repository currently contains the product and technical planning baseline. Feature implementation will be tracked through OpenSpec changes before code is added.

