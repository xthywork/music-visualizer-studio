## 1. Server foundation and durable job model

- [x] 1.1 Extend Python dependencies and runtime settings for Pillow, NumPy, multipart uploads, storage roots, FFmpeg paths, capacity limits, worker enablement and polling; verify `uv lock`, clean `uv sync --frozen` and configuration tests pass.
- [x] 1.2 Define versioned render request/response DTOs, stable job states and error codes matching the current frontend configuration schema; verify valid current templates/presets round-trip and invalid/unknown fields are rejected in backend tests.
- [x] 1.3 Implement the SQLite schema, migrations and repository with WAL, atomic queued-job claim, conditional terminal transitions, progress and cancellation flags; verify concurrency tests prevent double claim, stale terminal overwrite and invalid transitions.
- [x] 1.4 Implement startup recovery for orphaned running jobs and missing completed outputs; verify restart tests produce interrupted/unavailable states without exposing partial files.

## 2. Isolated uploads and storage lifecycle

- [x] 2.1 Implement UUID-derived job directories and safe relative-path helpers for input/work/output data; verify traversal, hostile filenames, symlink escape and cross-job deletion tests are rejected.
- [x] 2.2 Implement streaming multipart upload to `.part` files with byte limits, queue/disk-capacity admission and atomic publish; verify rejected/disconnected uploads leave no job or orphan files.
- [x] 2.3 Add server-side audio `ffprobe` validation, image content/decode/dimension validation and SRT/config validation using the project limits; verify spoofed MIME, corrupt, oversized and over-duration fixtures are rejected.
- [x] 2.4 Implement idempotent terminal cleanup and explicit output/job deletion while preserving completed output by default; verify completed, failed, cancelled, interrupted and repeated-cleanup paths remove exactly the intended files.

## 3. Render-job HTTP API

- [x] 3.1 Add capability, create, status, cancel, output-delete and job-delete endpoints with versioned JSON/error responses; verify API tests cover every state and unavailable-worker/capacity responses.
- [x] 3.2 Add completed MP4 preview/download responses with content type, safe filename, content length and range requests; verify seek/range tests and non-completed/missing-output rejection.
- [x] 3.3 Extend health reporting with database, storage and worker/NVENC readiness without leaking command output or filesystem paths; verify healthy and degraded responses.
- [x] 3.4 Add API cancellation/terminal race tests covering queued cancel, running cancel, duplicate cancel and late worker completion; verify each job reaches one correct terminal state.

## 4. Audio analysis and server scene contract

- [x] 4.1 Implement bounded FFmpeg PCM decoding and NumPy audio analysis compatible with current waveform, low/mid/high, spectrum and beat semantics; verify bounded-memory unit fixtures and timestamp lookups against shared frontend analysis fixtures.
- [ ] 4.2 Add committed deterministic font assets, image placement helpers, color/palette utilities and the Python scene protocol; verify font loading, crop/contain, pan/zoom and all aspect-ratio placement tests on a clean environment.
- [x] 4.3 Port Night Orbit and Dawn Spectrum to the server renderer; verify shared config fixtures and golden frames for 16:9, 9:16 and 1:1.
- [x] 4.4 Port Quiet Editorial and Paper Resonance to the server renderer; verify shared config fixtures, audio reactivity and golden frames for all aspect ratios.
- [x] 4.5 Port Panorama Lyrics and Poetry Lyrics with start-time-only cue activation and current appearance settings; verify gap/overlap/final-cue behavior and golden frames for all aspect ratios.
- [x] 4.6 Add cross-runtime conformance fixtures for template IDs, defaults, dimensions, placement, lyrics and selected frame timestamps; verify frontend and backend test suites consume and agree on the same fixtures.

## 5. FFmpeg/NVENC worker pipeline

- [x] 5.1 Implement argument-array-only FFmpeg/ffprobe adapters, sanitized stderr capture and process-group ownership; verify command construction cannot inject shell/path arguments and child failures produce stable error codes.
- [x] 5.2 Implement real H.264 NVENC startup probe followed by ffprobe verification and injectable fake/software probes for tests; verify worker readiness blocks jobs when binaries, driver or encode session are unavailable.
- [x] 5.3 Implement one-frame-at-a-time RGB rawvideo streaming to FFmpeg with original audio, AAC, `yuv420p`, preset bitrates and atomic final output publication; verify low-resolution integration output has expected H.264/AAC streams, dimensions, fps and duration.
- [x] 5.4 Implement progress, ETA, cancellation checks, FFmpeg terminate/kill and bounded stderr handling; verify cancellation under pipe backpressure exits all child processes and removes partial output.
- [x] 5.5 Implement the independent worker loop and single-worker supervisor used by `uv run music-visualizer`; verify HTTP stays responsive during a fake long render and graceful shutdown leaves no orphan process.
- [x] 5.6 Add optional hardware integration tests and operator smoke commands for 720p, 1080p and 4K60 NVENC; verify the target 5070 Ti run and document the same acceptance procedure for the future RTX 3060.

## 6. Frontend server-job migration

- [x] 6.1 Add a typed abortable render-job HTTP client and a single identity-bound poller; verify stale create/status/cancel responses cannot update a new workspace or newer job.
- [x] 6.2 Extend project serialization with optional server job/output fields while preserving all existing IndexedDB records and old local MP4 access; verify old and new project fixtures round-trip without schema data loss.
- [x] 6.3 Replace Generate/Cancel orchestration with upload, queued/running progress, cancellation and server error handling; verify audio selected during an active job remains available for the next job and page reload resumes authoritative status.
- [x] 6.4 Replace new-output IndexedDB Blob persistence with server preview/download URLs while retaining legacy local output preview/delete; verify server output unavailable and offline states are clearly distinguished from completed output.
- [x] 6.5 Remove browser capability gating and all production-use paths to AudioContext decode, Web Worker rendering, WebCodecs encoding and client MP4 muxing; verify an end-to-end render uses no client render worker and works in a browser without WebCodecs.
- [x] 6.6 Replace continuous client scene animation with static editor/template presentation and completed server video preview; verify the editor performs no frame-generation loop before a server output exists.
- [x] 6.7 Implement coordinated local-project/server-job deletion with retryable partial failure UI; verify server deletion failure does not falsely remove the local project or hide a still-existing output.

## 7. Regression, deployment and documentation

- [x] 7.1 Add backend regression coverage for upload limits, validation, queue ordering, restart recovery, disk-full handling, traversal, cleanup idempotency and output ranges; verify the complete backend suite passes without NVIDIA hardware using injected adapters.
- [x] 7.2 Update Playwright flows for upload, queued/running progress, reload, cancel, completed preview/download, unavailable output and deletion; verify E2E runs against deterministic fake worker mode.
- [x] 7.3 Rebuild and commit `frontend/dist`, then verify a clean clone starts the full API/frontend/worker supervisor with `uv run music-visualizer` and requires no Node.js, npm, Redis or external database.
- [x] 7.4 Update README, architecture, deployment, development, storage/privacy and OpenSpec-facing documentation in Chinese primary plus English companion form; verify docs consistently describe temporary server uploads, CPU scene rendering, NVENC, prerequisites and trusted-network restriction.
- [x] 7.5 Run frontend unit tests, production build, Playwright E2E, backend tests, OpenSpec strict validation and `git diff --check`; verify every command passes and record hardware-only tests separately.
