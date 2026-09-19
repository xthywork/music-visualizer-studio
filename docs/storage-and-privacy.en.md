# Storage and Privacy

[繁體中文](storage-and-privacy.md)

## Data flow

```text
Saved in the browser: project settings, template settings, parsed subtitle cues, job/output reference
                                  |
                 Upload audio, required images, and subtitles for a job
                                  v
Isolated server job directory
  |-- used during audio analysis and CPU scene rendering
  |-- source assets and intermediate files removed after completion, failure, cancellation, or confirmed interruption
  +-- completed MP4 retained on the server until explicit deletion
```

Official rendering happens on the server. The browser uploads only the assets needed for a job when the user submits it, and handles project settings, status checks, cancellation, preview, and download. The server stores job status in SQLite. Completed MP4s remain in the server output directory and have no automatic expiry or deletion.

## Browser-local data

A project record can contain its name, template and output settings, title/artist, image data, parsed subtitle cues, per-template appearance, render history, and server job identity with the last known status/output availability. A server reference is used to refresh status; it does not prove that an output still exists. Reopening a project checks with the server.

Raw SRT bytes, filename, and cue end times are not saved; parsed subtitle text and start times can remain in project settings. Source audio is not saved in a project, so reopening a project and starting another job requires selecting audio again. Browser-local data can be removed by clearing site data, browser policy, or quota eviction and is not a backup.

## Server temporary files and completed outputs

When a job is created, audio, any required cover/background images, and SRT are uploaded to an isolated temporary directory. After validation, the server uses those assets for rendering. When the job reaches completed, failed, cancelled, or confirmed interrupted, uploaded source assets and intermediate files are removed. Cancellation or failure does not leave a partial MP4 available for download.

Successfully completed MP4s are retained on the single-host server until the user explicitly deletes the output/job or an administrator explicitly cleans it up. Deleting a server output does not delete browser-local project settings. If an output no longer exists, the UI marks it unavailable; a new job can be created after selecting source audio again. Operators should monitor storage and explicitly delete outputs that are no longer needed.

## Access boundary

The service has no login, accounts, or tenant isolation. Serve it only on a trusted network or VPN. For cross-network access, use a reverse proxy with HTTPS and authentication. Do not expose the service directly to the Internet; it is not a public SaaS.
