## Context

This is a greenfield repository with product and deployment documentation but no application code or existing capability specs. The runtime target is Ubuntu Server 24.04 with a FastAPI service managed by `uv`, bound to `0.0.0.0:34388`; the server must not require a GPU for the MVP. See `proposal.md` and the capability specs for the user-visible contract.

## Goals / Non-Goals

**Goals:**

- Establish a browser-first render pipeline that can produce a valid MP4 without uploading source audio.
- Keep the template and render configuration portable between browser rendering and a future server worker.
- Keep project metadata and generated outputs available locally with explicit deletion and quota behavior.
- Make browser/device capability limits visible before expensive 4K60 work starts.
- Keep the FastAPI service small and ready to host the UI and future API boundaries.

**Non-Goals:**

- A cloud account, team workspace, public sharing, or synchronized project database.
- Server-side rendering in the MVP.
- Guaranteeing 4K60 output on hardware that cannot encode it.
- Word-level lyric timing or a general-purpose visual editor.

## Decisions

### Browser application structure

Use a TypeScript browser application (React with Vite is the recommended shell) with a domain model separated from UI components. Templates implement a common scene interface and consume a versioned, serializable render configuration. This keeps a template independent from React and makes it possible to run the same scene model in a future worker service.

Alternative considered: place template logic directly in page components. This is simpler initially but makes preview, export, testing, and future server rendering diverge, so it is rejected.

### Render pipeline and thread boundary

Use a dedicated Web Worker for audio analysis, frame scheduling, rendering, and encoding. Use OffscreenCanvas/WebGL2 where available for frame production, with a capability-gated fallback for preview or lower output settings. The main thread owns controls, progress display, cancellation requests, and downloads.

The worker communicates through a small message protocol: `start`, `progress`, `complete`, `cancel`, and `error`. Render jobs use immutable input snapshots so edits made after starting a job cannot alter its output.

Alternative considered: render and encode on the main thread. It risks freezing the interface during 4K60 work and makes cancellation unreliable, so it is rejected for export.

### Encoding and MP4 assembly

Use WebCodecs capability checks for the requested video and audio encoders, then send encoded chunks through an MP4 muxing adapter. The adapter is responsible for producing a playable MP4 and is tested independently of template rendering. The codec policy should prefer broadly playable H.264/AAC combinations when supported and reject unsupported combinations before starting a long render.

Alternative considered: rely only on `MediaRecorder`. Browser container and codec choices vary, and it does not provide the control needed for deterministic frame output and MP4 guarantees, so it is limited to a possible fallback experiment rather than the primary export path.

### Audio analysis

Decode the selected file in memory using browser media/audio primitives, derive reusable waveform, spectrum, and beat-reactive data, and pass analysis data to templates. Enforce the 10-minute limit before allocating the full render pipeline. Release decoded audio and analysis buffers when a job reaches completed, cancelled, or failed state.

### Local persistence

Create a storage adapter with operations for project metadata, render records, generated output, deletion, and quota estimation. Use IndexedDB as the initial browser-local database and store the generated MP4 as a Blob associated with a project. Keep audio out of the adapter's data model entirely. If large-Blob performance or quota behavior proves inadequate, the adapter can move output storage to OPFS without changing the UI contract.

### Project and render state

Represent project state and render state separately. A project contains the serializable configuration and references to local assets; a render record contains status, timestamps, output metadata, and error details. On application startup, any render left in an active state is reconciled to `interrupted`/`unknown` and never exposed as a completed download.

### FastAPI boundary

The FastAPI service serves the built frontend, exposes a health endpoint, and owns configuration for host and port. The MVP does not expose an audio-upload endpoint. A future server-render API will accept a versioned render configuration and asset references, enqueue work, and return a job status; it will not require changes to template semantics.

### Capability and output selection

Define an output capability matrix keyed by aspect ratio, dimensions, frame rate, and codec configuration. Populate it at runtime from browser support checks and conservative memory/size limits, then use it to constrain the resolution selector. Presets include 16:9, 9:16, and 1:1 and can expose 4K only when the selected combination is supported.

## Risks / Trade-offs

- **[4K60 varies widely by device]** -> Run a preflight check, show estimated workload and supported alternatives, and allow cancellation; never promise a speed or hardware encoder.
- **[MP4 support differs by browser and codec]** -> Validate the complete encode-plus-mux path before rendering and test representative Chrome/Edge configurations.
- **[Local browser quota may be smaller than a generated MP4]** -> Estimate usage, surface quota failures, allow output-only deletion, and keep metadata visible when an output cannot be saved.
- **[A browser reload can interrupt a worker]** -> Persist render intent/status transitions and reconcile active jobs on startup; only completed, verified outputs are downloadable.
- **[Audio decoding and analysis can consume substantial memory]** -> Enforce the duration and file constraints early, process analysis in bounded buffers, and release resources on every terminal state.
- **[Browser and server renderers could drift]** -> Version the scene configuration and keep template logic behind a renderer-independent interface with conformance fixtures.

## Migration Plan

This is a greenfield rollout. Deploy the FastAPI service and static frontend on the Ubuntu host, verify access through `http://<server-ip>:34388`, then enable the browser render path for the primary desktop Chrome/Edge support matrix. Use a versioned local-storage schema from the first release so future project-record changes can migrate or invalidate old records explicitly. No existing user data migration is required.

If the browser renderer is disabled or rolled back, the server can continue serving the UI while the generate action reports that local rendering is unavailable; no source audio is stranded on the server because the MVP never uploads it.

## Open Questions

- The exact named resolution presets and bitrate ladder can be selected during implementation without changing the user-visible aspect-ratio, selectable-resolution, or maximum-output requirements.
- The trigger and API shape for a future server CPU fallback can be finalized when server rendering is brought into scope.

