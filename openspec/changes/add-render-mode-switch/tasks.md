## 1. Mode preference and sidebar control

- [x] 1.1 Add a validated browser-local render-mode preference helper with server default and storage-failure fallback; verify unit tests cover missing, valid, invalid and throwing storage cases.
- [x] 1.2 Add the compact accessible Server／This Device segmented control below the project list, keep it visible at the sidebar bottom, and disable it during active work; verify DOM/style tests and Playwright keyboard/click behavior.

## 2. Mode-aware capability and session lifecycle

- [x] 2.1 Replace the server-only availability flag with a latest-request-safe mode-aware capability gate; verify stale server/client capability responses cannot update a newer mode or output selection and unsupported client mode does not auto-fallback.
- [x] 2.2 Make active render sessions explicitly mode-bound and route finish, cancel, navigation and source-audio cleanup by that identity; verify terminal messages cannot cross modes and Audio B survives completion of an Audio A render in both modes.

## 3. Restore client production rendering

- [x] 3.1 Reconnect the existing AudioContext decode, RenderController, module Worker, current scene configuration and WebCodecs/mp4-muxer pipeline for client mode while leaving the server upload path unchanged; verify focused orchestration tests cover start, progress, cancel, worker error and completion.
- [x] 3.2 Persist completed client MP4 through the existing ProjectService and preserve the immediate volatile Blob on quota/persistence failure; verify preview/download remain usable, reload availability is honest, and navigation/replacement revokes memory-only output.
- [x] 3.3 Verify mixed client/server render history, preview, download, single-output deletion and project deletion dispatch to the correct storage/API source without IndexedDB schema changes.

## 4. Integration and delivery

- [x] 4.1 Add Playwright coverage for default server mode, persisted mode switching, unsupported client capability, successful fake client render, cancellation and switching back to server without stale updates.
- [x] 4.2 Update Chinese-primary and English companion architecture/deployment/privacy documentation to describe both compute paths, browser requirements and source-data handling; verify documentation contains no server-only production claims.
- [x] 4.3 Run frontend unit tests, production build, Playwright E2E, backend tests, OpenSpec strict validation and `git diff --check`; commit updated `frontend/dist` and provide separate GPU-host smoke steps for both modes.
