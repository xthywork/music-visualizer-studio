# Development

## Required environment

- Ubuntu Server 24.04 as the deployment and primary validation target
- Python managed with `uv`
- Git
- Node.js and npm only when changing or testing frontend source
- A desktop Chrome or Edge browser for the primary MVP path

The server is expected to listen on `0.0.0.0:34388`.

## Backend environment

Create and activate the virtual environment with `uv`:

```bash
uv venv
source .venv/bin/activate
```

Backend dependencies are declared in `pyproject.toml`. Install them with:

```bash
uv sync
```

For a reproducible install in CI or on a clean host, use the lockfile:

```bash
uv sync --frozen
```

Run backend checks with:

```bash
uv run pytest tests/backend
```

Start the service locally with the same defaults used by deployment:

```bash
uv run music-visualizer
```

The health checks are available at `/health` and `/api/health`. The root route
serves the committed `frontend/dist/index.html`, with an SPA fallback for
client-side routes. If that distribution is missing, the root route returns a
small `frontend: "not-built"` service-status response instead of the website.

Missing `/assets/*` requests return HTTP 404 instead of the SPA HTML shell.

The FastAPI application binds explicitly to the configured host and port. Host
and port are configurable through environment variables while retaining
`0.0.0.0` and `34388` as the internal defaults.

## Browser codec strategy

The browser preflight checks the complete video/audio encode and MP4 mux path
before a render starts. Codec selection prefers broadly playable combinations
in this order:

1. H.264 video with AAC audio
2. H.264 video with Opus audio
3. VP9 video with AAC audio
4. VP9 video with Opus audio

For each supported codec combination, the capability check tries the
`prefer-hardware` WebCodecs acceleration preference first, then
`no-preference`, and finally `prefer-software`. Rendering is enabled only when
the requested dimensions, frame rate, encoder path, and MP4 muxing check
succeed. This is a runtime capability decision, not a user-agent assumption.

## Automated browser validation (2026-09-12)

The checked-in Playwright configuration runs one Chromium project. The current
local runner is Playwright 1.63 with Chrome for Testing 153. The E2E suite
creates and inspects playable 30 fps 720p MP4 files for all three aspect
ratios:

| Aspect ratio | E2E output | Frame rate |
| --- | --- | --- |
| 16:9 | 1280 × 720 | 30 fps |
| 9:16 | 720 × 1280 | 30 fps |
| 1:1 | 720 × 720 | 30 fps |

The suite also exercises cancellation at 9:16, 720p, and 60 fps. Unit tests
cover the codec-policy and unsupported-capability branches, but the automated
matrix does not currently render 1080p or 4K output and does not run Edge or a
dedicated `--disable-gpu` project. Those remain manual compatibility checks.
No result promises that a device can render a long video in real time or
complete a 4K60 export reliably. RAM, local storage quota, browser memory
limits, encoder throughput, and overall device performance can still constrain
a render.

The resolution and frame-rate selectors remain visible for every configured
preset. Capability detection evaluates the current selection asynchronously;
when its complete codec/mux path is unsupported, the Generate button is
disabled and the reason is shown. The UI does not automatically switch to a
lower preset.

## Frontend production bundle

`frontend/dist` is committed so runtime-only hosts do not need Node.js. After
changing frontend source, rebuild and include the resulting distribution in
the same change:

```bash
cd frontend
npm ci
npm run build
git status --short dist
```

Do not commit `frontend/node_modules` or Playwright output.

## Development principles

- Keep template definitions serializable and independent from browser UI components.
- Keep rendering off the main UI thread.
- Treat browser capability checks as runtime data, not user-agent guesses.
- Never persist source audio bytes, metadata, absolute paths, or file handles.
  Reopening a project requires selecting the source audio again.
- Route all project persistence through a storage abstraction.
- Keep a clear boundary between browser rendering and the future server-rendering API.
- Test each output aspect ratio and a representative low/high resolution before adding new templates.

## Image input limits

Artwork accepts only PNG, JPEG, and WebP. The browser validates MIME type,
compressed size, file signature, header dimensions, and decoded dimensions
before adding an image to project state. Limits are derived from the largest
entry in `OUTPUT_PRESETS`: inputs beyond twice the maximum output dimensions or
twice the maximum output pixel count are rejected before decode; accepted
images are normalized to the maximum output envelope when needed.

Images remain schema-compatible data URLs for this release. Moving them to a
separate Blob asset store is still the preferred long-term direction, but was
not combined with these safeguards because it requires a versioned IndexedDB
migration and backward-compatibility plan.

## Additional validation scenarios

- Chrome and Edge on a desktop with hardware acceleration enabled
- A browser with hardware acceleration disabled
- Unsupported WebCodecs or codec combinations
- 16:9, 9:16, and 1:1 outputs
- Short audio and the 10-minute input limit
- Storage quota exhaustion and deleted site data
- Cancellation, reload, and render failure recovery
- Autosave/new/switch/delete races and concurrent render saves
- IndexedDB quota failure with immediate in-memory MP4 download
- Invalid SVG, forged headers, oversized images, and decode failures
