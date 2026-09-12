# Storage and Privacy

## Data lifecycle

```text
Audio selected
    |
    v
Used in memory for analysis/rendering
    |
    v
Decoded bytes released after render; never persisted

Project settings + generated MP4 (when quota allows)
    |
    v
Saved only in the local browser store
```

## Persisted locally

- Project metadata and template settings
- Title, artist, and output configuration
- Cover/background image data or references needed by the project
- Generated MP4 Blob and its metadata

If MP4 Blob persistence fails after generation, the Blob remains available in
memory in the current tab for preview and download. It is not durable and is
released when the page closes. On reopen, if the latest completed metadata has
no Blob but an older saved output exists, the UI identifies that it is showing
an older version.

## Not persisted

- Original audio file
- Audio bytes or the file's absolute filesystem path
- Audio upload on the FastAPI server
- Any cloud copy in the MVP

## User controls

The UI should provide project deletion, generated-output deletion, and a way to show approximate local storage usage. When storage is unavailable or full, explain that the user can delete old outputs or export/download them before retrying.

Autosave writes are serialized with manual/render-triggered saves. Project
switch flushes the scheduled snapshot for the project being left. Creating a
new blank draft flushes edits when the current project already exists, while a
not-yet-created draft is cancelled to avoid a ghost record. Project deletion
waits for in-flight writes so a late save cannot recreate the deleted record.

Browsers deliberately do not reveal a selected file's absolute path. The source
audio is intentionally not remembered, so reopening a project always requires
selecting the audio file again. Local browser storage is not a backup. Clearing
site data, private browsing sessions, browser policies, or quota eviction can
remove projects and MP4 files. A future SaaS mode may add durable cloud storage
as an explicit user choice.
