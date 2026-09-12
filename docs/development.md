# Development

## Required environment

- Ubuntu Server 24.04
- Python managed with `uv`
- Git and GitHub CLI (`gh`)
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
serves `frontend/dist/index.html` (with an SPA fallback for client-side routes)
when a frontend build exists; before a build it returns a small service-status
response so deployment checks remain actionable.

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
`no-preference`, and finally `prefer-software`. A setting is offered only when
the requested dimensions, frame rate, encoder path, and MP4 muxing check
succeed. This is a runtime capability decision, not a user-agent assumption.

## Validated browser matrix (2026-09-10)

On Ubuntu Server 24.04, the desktop browser matrix was checked with official
Chrome 153 and Edge 152 builds. With both the default GPU configuration and
the `--disable-gpu` launch flag, WebCodecs preflight was available for all of:

| Aspect ratio | Presets | Frame rates | Default GPU | `--disable-gpu` |
| --- | --- | --- | --- | --- |
| 16:9 | 720p, 1080p, 4K | 30, 60 fps | available | available |
| 9:16 | 720p, 1080p, 4K | 30, 60 fps | available | available |
| 1:1 | 720p, 1080p, 4K | 30, 60 fps | available | available |

The end-to-end render path was also run successfully at 720p for both
aspect ratios. These results confirm that the capability checks and tested
presets work in this environment; they do not promise that a device can render
a long video in real time or complete a 4K60 export reliably. RAM, local
storage quota, browser memory limits, encoder throughput, and overall device
performance can still constrain a render.

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
