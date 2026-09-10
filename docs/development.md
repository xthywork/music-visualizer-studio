# Development

## Required environment

- Ubuntu Server 24.04
- Python managed with `uv`
- Git and GitHub CLI (`gh`)
- A desktop Chrome or Edge browser for the primary MVP path

The server is expected to listen on `0.0.0.0:34388`.

## Backend environment

Create and activate the virtual environment with `uv`:

```bash
uv venv
source .venv/bin/activate
```

After backend dependencies are defined, install them with:

```bash
uv sync
```

The FastAPI application should bind explicitly to the configured host and port. Keep host and port configurable through environment variables while retaining `0.0.0.0` and `34388` as the internal defaults.

## Development principles

- Keep template definitions serializable and independent from browser UI components.
- Keep rendering off the main UI thread.
- Treat browser capability checks as runtime data, not user-agent guesses.
- Never persist source audio.
- Route all project persistence through a storage abstraction.
- Keep a clear boundary between browser rendering and the future server-rendering API.
- Test each output aspect ratio and a representative low/high resolution before adding new templates.

## Suggested validation matrix

- Chrome and Edge on a desktop with hardware acceleration enabled
- A browser with hardware acceleration disabled
- Unsupported WebCodecs or codec combinations
- 16:9, 9:16, and 1:1 outputs
- Short audio and the 10-minute input limit
- Storage quota exhaustion and deleted site data
- Cancellation, reload, and render failure recovery

