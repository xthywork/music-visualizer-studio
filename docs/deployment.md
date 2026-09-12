# Deployment

## Internal deployment

The initial deployment targets an Ubuntu Server 24.04 host. The application service binds to:

```text
0.0.0.0:34388
```

Users connect through the server's reachable IP address:

```text
http://<server-ip>:34388
```

## Start the service

On a clean Ubuntu Server 24.04 host, install `uv` and clone the repository:

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh
git clone <repo>
cd <repo>
```

The repository includes the current production files under `frontend/dist`.
Start FastAPI with the documented defaults; `uv` creates or synchronizes the
Python environment from `uv.lock` automatically:

```bash
uv run music-visualizer
```

Node.js and npm are not required on a host that only runs the application.
Developers who change frontend source must run `npm ci` and `npm run build`
from `frontend/`, then commit the updated `frontend/dist` files.

The host and port can be overridden for a proxy or local deployment:

```bash
VISUALIZER_HOST=127.0.0.1 VISUALIZER_PORT=34388 uv run music-visualizer
```

Verify the process from the host or a trusted client:

```bash
curl -f http://127.0.0.1:34388/health
curl -f http://127.0.0.1:34388/
```

The application's MVP routes are the static frontend and health endpoints;
FastAPI also exposes its API schema/docs under `/api/openapi.json`, `/api/docs`,
and `/api/redoc`. There is no audio-upload endpoint, and source audio is never
written to the server filesystem.

The server does not need a GPU for browser-first rendering. CPU capacity is still relevant for serving the application and any future fallback jobs.

## Network and exposure

For internal use, restrict port `34388` to the trusted network or VPN. Do not treat binding to `0.0.0.0` as an authentication or security control.

For public SaaS deployment, place a reverse proxy such as Nginx or Caddy in front of FastAPI, terminate HTTPS there, and keep the application process on an internal interface. Add authentication, rate limits, storage quotas, and observability before public exposure.

## Future render workers

The future fallback can run as a separate CPU worker. It should consume the same versioned template configuration as the browser renderer and report queued, running, completed, cancelled, and failed states. A GPU worker can be introduced later without changing the API contract.
