## Why

Creating a polished music visualizer currently requires separate creative, animation, and video-export tools. This change establishes a focused internal web workflow that turns an audio track into a configurable MP4 in a few steps, while keeping source audio private and preserving a clean path to a future SaaS product.

## What Changes

- Add a web workspace for selecting an audio file, visual template, output format, and optional title, artist, cover, or background assets.
- Add three initial visual templates: Spectrum Cover, Vinyl Particle, and Abstract Pulse.
- Support 16:9, 9:16, and 1:1 output with selectable resolutions and frame rates up to 4K at 60 fps.
- Add browser capability detection and browser-first rendering in a background worker, using GPU or hardware encoding when available.
- Encode and mux a playable MP4, provide progress/error/cancellation feedback, and allow download and preview.
- Persist project metadata and generated MP4 output in local browser storage; never persist or upload the source audio in the MVP.
- Add a FastAPI service foundation using a `uv` virtual environment on Ubuntu Server 24.04, listening on `0.0.0.0:34388`.
- Define a stable render configuration boundary so a future CPU/GPU server worker, authentication, and cloud storage can be added without replacing templates.

## Capabilities

### New Capabilities

- `visualizer-generation`: Audio-to-MP4 workflow, template selection, output configuration, browser rendering, capability handling, and downloads.
- `local-project-storage`: Local project history, generated-output retention, source-audio non-retention, quota handling, and deletion controls.

### Modified Capabilities

None. The project has no existing capability specifications.

## Impact

- New frontend application and render pipeline using Web Worker, Canvas/WebGL, WebCodecs, and an MP4 muxing layer.
- New FastAPI backend service and `uv` project configuration for serving the application and reserving future API boundaries.
- Browser-local persistence adapter, initially backed by IndexedDB or an equivalent browser store for metadata and MP4 Blobs.
- New test coverage for templates, output ratios, codec capability failures, storage quota failures, and render lifecycle states.
- No server GPU is required for the MVP; server-side rendering remains a future fallback boundary.

