# AI Agent API

[繁體中文](agent-api.md)

This API lets an AI agent or another program create server render jobs directly, without opening the web UI. It neither accepts nor provides client-side rendering: audio analysis, scene drawing, and MP4 encoding all run on the Music Visualizer server.

The service has no accounts, tenant isolation, or API keys. Keep it on a trusted network or VPN. If it must be reachable across networks, put authenticated HTTPS in a reverse proxy in front of it.

## Create a job

Send `POST /api/agent/render` as `multipart/form-data`.

- `request`: required JSON string.
- `audio`: required uploaded MP3, WAV, or M4A file.
- `cover`: optional PNG, JPEG, or WebP cover image.
- `background`: optional PNG, JPEG, or WebP background image.

The server intentionally does not accept `audioUrl` and will not download an arbitrary URL on a caller's behalf. The agent must acquire the audio file and upload it as multipart data, avoiding SSRF and uncontrolled remote downloads.

```json
{
  "template": "quiet-editorial",
  "title": "Night Drive",
  "artist": "Example Artist",
  "aspectRatio": "16:9",
  "resolution": "4k",
  "frameRate": 60
}
```

- `template`: `quiet-editorial`, `paper-resonance`, `night-orbit`, `dawn-spectrum`, `panorama-lyrics`, or `poetry-lyrics`.
- `title`: required; 1–300 characters.
- `artist`: optional; up to 300 characters.
- `aspectRatio`: optional; `16:9` (default), `9:16`, or `1:1`.
- `resolution`: optional; `720p`, `1080p` (default), or `4k`.
- `frameRate`: optional; `30` (default) or `60`.
- `lyrics`: required for lyric templates; each item is `{ "start": 0, "text": "First line" }`.
- `templateSettings`: optional website-compatible template settings.

`renderMode`, `audioUrl`, and every unlisted field are rejected. This endpoint always uses and returns `server` mode.

```bash
curl -fsS -X POST http://127.0.0.1:34388/api/agent/render \
  --form-string 'request={"template":"quiet-editorial","title":"Night Drive","artist":"Example Artist","aspectRatio":"16:9","resolution":"4k","frameRate":60}' \
  -F 'audio=@./song.m4a;type=audio/mp4' \
  -F 'cover=@./cover.jpg;type=image/jpeg'
```

The successful `201` response includes `renderMode: "server"`, a nested `job`, and `statusUrl`, `cancelUrl`, `outputUrl`, and `deleteUrl` links.

## Poll, cancel, download, and delete

```text
GET    /api/agent/render/{job_id}         Read status
POST   /api/agent/render/{job_id}/cancel  Request cancellation
GET    /api/render-jobs/{job_id}/output   Download the completed MP4
DELETE /api/agent/render/{job_id}         Delete the job and output
```

Poll `job.state` until it is `completed`, then download only when `job.outputAvailable` is `true`. Valid states are `queued`, `running`, `completed`, `failed`, `cancelled`, and `interrupted`. Input and output cleanup use the same lifecycle as website server rendering.

Call `GET /api/render-capabilities` before creating a job and require `ready: true`; a worker that is not ready causes job creation to return `503`.
