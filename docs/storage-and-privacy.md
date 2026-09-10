# Storage and Privacy

## Data lifecycle

```text
Audio selected
    |
    v
Used in memory for analysis/rendering
    |
    v
Released after render; never persisted

Project settings + generated MP4
    |
    v
Saved only in the local browser store
```

## Persisted locally

- Project metadata and template settings
- Title, artist, and output configuration
- Cover/background image data or references needed by the project
- Generated MP4 Blob and its metadata

## Not persisted

- Original audio file
- Audio upload on the FastAPI server
- Any cloud copy in the MVP

## User controls

The UI should provide project deletion, generated-output deletion, and a way to show approximate local storage usage. When storage is unavailable or full, explain that the user can delete old outputs or export/download them before retrying.

Local browser storage is not a backup. Clearing site data, private browsing sessions, browser policies, or quota eviction can remove projects and MP4 files. A future SaaS mode may add durable cloud storage as an explicit user choice.

