# Architecture

## Design direction

The MVP is local-first: the browser owns the media-processing work and the server provides the application shell and future API boundary. This avoids requiring a GPU on the Ubuntu server and keeps the uploaded audio private.

```text
+---------------------+       +-------------------------+
| Browser UI           |       | FastAPI server           |
| upload/configure     |<----->| static app + future API  |
+----------+----------+       | 0.0.0.0:34388           |
           |                  +-------------------------+
           v
+---------------------+
| Web Worker           |
| analyse PCM snapshot |
| render scene         |
| encode video         |
+----------+----------+
           v
+---------------------+
| Local browser store  |
| project metadata     |
| generated MP4 Blob   |
+---------------------+
```

## Browser render pipeline

1. Read and decode the selected audio file on the UI thread without persisting it.
2. Transfer a transient planar PCM snapshot to the worker, then analyse it for spectrum, waveform, and beat-reactive data.
3. Render each frame from a serializable template configuration.
4. Use Canvas/WebGL (and later WebGPU where useful) for visual work.
5. Encode frames with WebCodecs when the browser supports a suitable encoder and hardware path.
6. Mux encoded video and audio into a playable MP4.
7. Present the completed Blob immediately, then write the MP4 and project metadata to local browser storage.
8. Release audio buffers and temporary render data.

Rendering belongs in a Web Worker so progress updates and navigation remain responsive. GPU acceleration is an implementation opportunity, not a guarantee; capability checks must determine the available codec, resolution, and frame-rate choices.

Render events are serialized per session and guarded by a terminal identity.
Completion, cancellation, Worker failure, and storage failure can therefore
clean up only once, and a late event cannot mutate a newer render. A successful
encode is distinct from successful persistence: quota failure retains one
in-memory output for the current tab instead of discarding the download.

## MP4 compatibility boundary

Browser video encoding and MP4 container muxing are separate concerns. The renderer therefore needs a dedicated muxing layer and a tested codec/container policy. If a browser cannot produce a valid target MP4, the UI should explain the limitation rather than silently offer an unusable download.

## Storage boundary

Use a browser-local persistence abstraction rather than calling IndexedDB throughout the UI. The initial adapter may use IndexedDB for project metadata and MP4 Blobs; large-file handling can move to OPFS or another browser-backed store if quota or performance requires it.

Autosave captures an immutable configuration and project/workspace identity at
the time it is scheduled. Autosave and explicit saves use one serialized queue.
Switching projects flushes the pending snapshot. Starting a new draft flushes
edits to an existing project, but abandons a not-yet-created draft so it does
not become a ghost project. Deletion invalidates and waits for in-flight writes
before removing the project.

The application should expose storage operations such as:

- list projects
- load project metadata
- save project metadata
- save/load/delete generated output
- delete a project
- estimate storage usage

## Future SaaS path

The server-rendering contract should accept the same scene configuration and asset references used by the browser renderer:

```text
Browser UI -> API -> job queue -> CPU/GPU render worker -> object storage -> download URL
```

This future path adds authentication, durable storage, quotas, and job scheduling without changing the user-facing template model.
