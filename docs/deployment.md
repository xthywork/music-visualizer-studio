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

The server does not need a GPU for browser-first rendering. CPU capacity is still relevant for serving the application and any future fallback jobs.

## Network and exposure

For internal use, restrict port `34388` to the trusted network or VPN. Do not treat binding to `0.0.0.0` as an authentication or security control.

For public SaaS deployment, place a reverse proxy such as Nginx or Caddy in front of FastAPI, terminate HTTPS there, and keep the application process on an internal interface. Add authentication, rate limits, storage quotas, and observability before public exposure.

## Future render workers

The future fallback can run as a separate CPU worker. It should consume the same versioned template configuration as the browser renderer and report queued, running, completed, cancelled, and failed states. A GPU worker can be introduced later without changing the API contract.

