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
| decode/analyse audio |
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

1. Read the selected audio file without persisting it.
2. Decode or analyse the audio for spectrum, waveform, and beat-reactive data.
3. Render each frame from a serializable template configuration.
4. Use Canvas/WebGL (and later WebGPU where useful) for visual work.
5. Encode frames with WebCodecs when the browser supports a suitable encoder and hardware path.
6. Mux encoded video and audio into a playable MP4.
7. Write the completed MP4 and project metadata to local browser storage.
8. Release audio buffers and temporary render data.

Rendering belongs in a Web Worker so progress updates and navigation remain responsive. GPU acceleration is an implementation opportunity, not a guarantee; capability checks must determine the available codec, resolution, and frame-rate choices.

## MP4 compatibility boundary

Browser video encoding and MP4 container muxing are separate concerns. The renderer therefore needs a dedicated muxing layer and a tested codec/container policy. If a browser cannot produce a valid target MP4, the UI should explain the limitation rather than silently offer an unusable download.

## Storage boundary

Use a browser-local persistence abstraction rather than calling IndexedDB throughout the UI. The initial adapter may use IndexedDB for project metadata and MP4 Blobs; large-file handling can move to OPFS or another browser-backed store if quota or performance requires it.

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

