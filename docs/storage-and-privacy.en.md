# Storage and Privacy

[繁體中文](storage-and-privacy.md)

## Data flow

```text
Browser-local: project/template settings, subtitle cues, mixed render history
  |-- Server: upload audio, images, and subtitles for this job
  |      +-- isolated temporary data is cleaned at termination;
  |          completed MP4 retained until explicit deletion
  |
  +-- This Device: sources used only by the current render
         +-- completed MP4 stored in IndexedDB when quota permits
```

Users can render on the server or on the current device. Server mode uploads only the assets needed for that job and stores job status in SQLite; completed MP4s remain in the server output directory with no automatic deletion. This Device mode does not send assets to a server render job and processes them in browser memory and a Worker.

## Browser-local data

A project record can contain its name, template and output settings, title/artist, image data, parsed subtitle cues, per-template appearance, render history, client output metadata, or server job identity with the last known status/output availability. A server reference is used to refresh status; it does not prove that an output still exists. Reopening a project checks with the server.

Raw SRT bytes, filename, and cue end times are not saved; parsed subtitle text and start times can remain in project settings. Source audio is not saved in a project, so reopening a project and starting another job requires selecting audio again. Browser-local data can be removed by clearing site data, browser policy, or quota eviction and is not a backup.

Client MP4 Blobs are saved in IndexedDB when space permits. If a completed render cannot be persisted, its Blob remains available for immediate preview and download only in the current tab and project. It is released after switching or deleting the project, creating a new project, replacing the output, or reloading; the project must not claim that it remains downloadable.

## Server temporary files and completed outputs

When a job is created, audio, any required cover/background images, and SRT are uploaded to an isolated temporary directory. After validation, the server uses those assets for rendering. When the job reaches completed, failed, cancelled, or confirmed interrupted, uploaded source assets and intermediate files are removed. Cancellation or failure does not leave a partial MP4 available for download.

Successfully completed MP4s are retained on the single-host server until the user explicitly deletes the output/job or an administrator explicitly cleans it up. Deleting a server output does not delete browser-local project settings. If an output no longer exists, the UI marks it unavailable; a new job can be created after selecting source audio again. Operators should monitor storage and explicitly delete outputs that are no longer needed.

## Access boundary

The service has no login, accounts, or tenant isolation. Serve it only on a trusted network or VPN. For cross-network access, use a reverse proxy with HTTPS and authentication. Do not expose the service directly to the Internet; it is not a public SaaS.
