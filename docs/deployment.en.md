# Deployment

[繁體中文](deployment.md)

## Host requirements

- Ubuntu Server 24.04, Python 3.12+, and `uv`
- An NVIDIA GPU with a working NVIDIA driver
- An FFmpeg build that includes `ffmpeg`, `ffprobe`, and the `h264_nvenc` encoder
- Enough disk space for the SQLite job database, temporary assets, and completed MP4s users have not deleted

The current acceptance host uses a Ryzen 9 5900X and RTX 5070 Ti. After a future move to an RTX 3060, use the same startup preflight and hardware acceptance command. Audio analysis and frame-by-frame Pillow/NumPy scene drawing run on the CPU; the NVIDIA GPU is used for H.264 NVENC encoding.

## Install and start

Install `uv`, FFmpeg, and the NVIDIA driver, verify the binaries, and clone the repository:

```bash
nvidia-smi
ffmpeg -hide_banner -encoders | grep -F h264_nvenc
ffprobe -version
git clone <repo>
cd <repo>
```

The repository includes the production frontend. Normal users do not need Node.js or npm. One command synchronizes the Python environment, initializes SQLite/storage, runs the NVENC readiness preflight, and starts the API with its background worker:

```bash
uv run music-visualizer
```

The worker preflight encodes a short H.264 `yuv420p` MP4 and verifies it with `ffprobe`. If FFmpeg, the driver, or an NVENC session is unavailable, the HTTP service can still start, but the worker reports unavailable and does not accept jobs it cannot finish.

The UI defaults to Server. Users can select This Device at the bottom of the project list to generate with AudioContext, a Web Worker, WebCodecs, and an MP4 muxer without using server CPU/GPU. Client mode requires a modern browser with WebCodecs, module Workers, and support for the selected codec and dimensions; capability is rechecked when output settings change. An unavailable mode disables generation for that mode and never switches automatically.

The default service address is `0.0.0.0:34388`. Check health and render capability locally:

```bash
curl -fsS http://127.0.0.1:34388/health
curl -fsS http://127.0.0.1:34388/api/render-capabilities
```

Set `VISUALIZER_HOST` and `VISUALIZER_PORT` to change the bind address. When a reverse proxy runs on the same host, bind the application to loopback:

```bash
VISUALIZER_HOST=127.0.0.1 VISUALIZER_PORT=34388 uv run music-visualizer
```

The default data root is `~/.local/share/music-visualizer`; set `VISUALIZER_DATA_ROOT` to use another persistent directory. It contains SQLite, temporary job files, and completed outputs. Adjust capacity limits with `VISUALIZER_STORAGE_CEILING_BYTES` and `VISUALIZER_MINIMUM_FREE_BYTES`. Completed MP4s do not expire automatically; verify an output is no longer needed before deleting it.

Each server render job uses 12 CPU frame processes by default, matching the 12 physical cores of a Ryzen 9 5900X. Set `VISUALIZER_FRAME_WORKERS` for a smaller host, for example:

```bash
VISUALIZER_FRAME_WORKERS=4 uv run music-visualizer
```

The pipeline keeps at most one in-flight RGB frame per worker. Raising the count increases RAM and process/IPC overhead; do not treat the 5900X's 24 SMT threads as 24 physical cores. For systemd, place the variable in an `Environment=` line, then run `daemon-reload` and restart the service.

Frontend developers run `npm ci` and `npm run build` in `frontend/` and commit the updated `frontend/dist`. Normal deployments do not install Node.js/npm.

## Hardware acceptance

On an NVIDIA GPU host, run the opt-in test to verify H.264, `yuv420p`, dimensions, frame rate, and AAC audio for 720p30, 1080p60, and 4K60 output:

```bash
VISUALIZER_RUN_NVENC_TESTS=1 uv run pytest tests/backend/test_nvenc_hardware.py -v
```

This is the current RTX 5070 Ti acceptance procedure. Run the same command after a future move to an RTX 3060. The ordinary software test suite does not require NVIDIA hardware.

## Network security boundary

The service has no accounts, login, or tenant isolation. It is intended only for a trusted network or VPN. Restrict firewall access to trusted users. If serving across networks, require HTTPS and authentication at a reverse proxy, and keep the application on an internal interface. Do not expose the service directly to the Internet. Public SaaS identity, abuse prevention, isolation, billing, and operations are outside this deployment's scope.
