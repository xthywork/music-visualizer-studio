# Storage and Privacy

## Data lifecycle

```text
Audio selected / explicitly reconnected
    |
    v
Used in memory for analysis/rendering
    |
    v
Decoded bytes released after render; never persisted

Project settings + optional permission-controlled file handle + generated MP4
    |
    v
Saved only in the local browser store
```

## Persisted locally

- Project metadata and template settings
- Title, artist, and output configuration
- Cover/background image data or references needed by the project
- Safe audio identity metadata (filename, MIME type, size, and modified time)
- On supported Chromium browsers, a File System Access handle stored separately
  from project JSON; opening it still requires browser permission
- Generated MP4 Blob and its metadata

## Not persisted

- Original audio file
- Audio bytes or the file's absolute filesystem path
- Audio upload on the FastAPI server
- Any cloud copy in the MVP

## User controls

The UI should provide project deletion, generated-output deletion, and a way to show approximate local storage usage. When storage is unavailable or full, explain that the user can delete old outputs or export/download them before retrying.

Browsers deliberately do not reveal a selected file's absolute path. When File
System Access is unavailable, or when permission is revoked, the saved filename
acts only as a reminder and the user must select the file again. Local browser
storage is not a backup. Clearing site data, private browsing sessions, browser
policies, or quota eviction can remove projects, handles, and MP4 files. A
future SaaS mode may add durable cloud storage as an explicit user choice.
