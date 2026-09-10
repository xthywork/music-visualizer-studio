## 1. Application and service foundation

- [x] 1.1 Create the `uv`-managed Python project and FastAPI application skeleton, then verify dependency installation with `uv sync` and a passing health-endpoint test.
- [x] 1.2 Create the TypeScript browser application shell and production build configuration, then verify the frontend type-checks and produces a distributable build.
- [x] 1.3 Configure host and port defaults for `0.0.0.0:34388`, serve the built frontend from FastAPI, and verify `curl http://127.0.0.1:34388` returns the application and health endpoint responses.
- [x] 1.4 Add a versioned render-configuration and project-state domain model shared by UI, worker, and storage layers, then verify serialization round-trips preserve all required fields.

## 2. Browser workspace and input configuration

- [x] 2.1 Implement audio file selection and validation for MP3, WAV, and M4A plus the 10-minute duration limit, and verify accepted and rejected fixtures show the required messages without starting a render.
- [x] 2.2 Implement title, artist, cover-image, and background-image inputs with local preview handling, and verify template configuration updates without another audio selection.
- [x] 2.3 Implement the template registry and selectable cards for Spectrum Cover, Vinyl Particle, and Abstract Pulse, and verify each template exposes a preview and stable identifier.
- [x] 2.4 Implement aspect-ratio, resolution, and frame-rate selectors for 16:9, 9:16, and 1:1, and verify selected dimensions are displayed and invalid combinations cannot be submitted.

## 3. Capability detection and render orchestration

- [x] 3.1 Implement runtime capability detection for the requested canvas, video encoder, audio encoder, and MP4 path, and verify supported and unsupported matrices produce the specified enabled or blocked states.
- [x] 3.2 Define the Web Worker message protocol and immutable render-job snapshot, and verify start, progress, complete, cancel, and error messages update the corresponding UI state.
- [x] 3.3 Implement in-memory audio decoding and waveform/spectrum/beat analysis with bounded buffers, and verify analysis completes for a short fixture and releases resources on terminal states.
- [x] 3.4 Implement render cancellation and failure cleanup, and verify a cancelled or failed job leaves no downloadable partial output while preserving project configuration.

## 4. Visual templates and frame rendering

- [x] 4.1 Implement the renderer-independent scene interface and frame timing for the selected aspect ratio, resolution, and frame rate, and verify deterministic frames for a fixed configuration fixture.
- [x] 4.2 Implement Spectrum Cover with reactive spectrum/waveform, title, artist, and image treatment, and verify representative frames at all three aspect ratios.
- [x] 4.3 Implement Vinyl Particle with rotating-record and audio-reactive particle behavior, and verify representative frames at all three aspect ratios.
- [x] 4.4 Implement Abstract Pulse with animated background, waveform, and beat-reactive effects, and verify representative frames at all three aspect ratios.
- [x] 4.5 Add visual regression or golden-frame coverage for each initial template at a low-resolution test preset, and verify changes are detected without requiring 4K rendering.

## 5. Video encoding and MP4 output

- [x] 5.1 Implement the WebCodecs video/audio encoder adapter and codec configuration policy, and verify the adapter rejects unsupported configurations before queuing frames.
- [x] 5.2 Implement the MP4 muxing adapter for encoded audio/video chunks, and verify a generated fixture opens as a playable MP4 with both tracks and expected metadata.
- [x] 5.3 Connect worker frame production, encoding, and muxing into the completed render path, and verify duration, dimensions, frame rate, and audio/video track metadata for each aspect ratio.
- [x] 5.4 Add progress estimation, long-render status messaging, and user cancellation controls, and verify the interface remains responsive while a representative worker render runs.

## 6. Local project and output storage

- [x] 6.1 Implement the browser-local storage adapter for project metadata, render records, generated MP4 Blobs, deletion, and quota estimation, and verify CRUD and schema-version round-trips.
- [x] 6.2 Ensure source audio is excluded from the persistence model and released after every render terminal state, and verify storage inspection contains no audio bytes or audio-file reference.
- [x] 6.3 Persist completed MP4 output and handle quota failures while retaining unsaved project metadata, and verify the UI offers output deletion and a retry path.
- [x] 6.4 Reconcile active render records on application startup as interrupted/unknown, and verify interrupted projects never appear to have a completed downloadable output.
- [x] 6.5 Implement project listing, reopen, project deletion, and output-only deletion, and verify metadata remains available after output deletion and disappears after confirmed project deletion.

## 7. Preview, download, and integration quality

- [x] 7.1 Implement completed-output preview and download from local storage, and verify downloading does not request the source audio again.
- [x] 7.2 Add an end-to-end happy-path test from audio selection through template/output configuration, render completion, local persistence, reopen, preview, and download.
- [x] 7.3 Add failure-path tests for invalid audio, unsupported codec/device, cancellation, muxing failure, memory failure, browser reload, and local quota exhaustion, and verify each produces an actionable state.
- [x] 7.4 Validate the primary desktop Chrome/Edge matrix with hardware acceleration enabled and disabled, and document observed supported presets and limitations.
- [x] 7.5 Add deployment and run documentation for Ubuntu Server 24.04, `uv`, and `0.0.0.0:34388`, and verify a clean host can start the service and serve the built application.
- [x] 7.6 Verify the MVP has no audio-upload API or server-side audio persistence, and verify repository checks pass without requiring a server GPU.
