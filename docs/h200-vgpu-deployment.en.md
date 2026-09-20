# H200 vGPU Deployment and Performance Record

[繁體中文](h200-vgpu-deployment.md)

## Scope

This document records the NVIDIA H200-35C vGPU deployment, troubleshooting, and performance experiments completed on 2026-09-20 in `deploy/h200-cpu-rendering`. The branch is intentionally retained and not merged into `main`. It preserves the CPU H.264 fallback required by an H200 host without NVENC and the CUDA feasibility evidence.

Production status:

- Pillow/NumPy generates frames on the CPU.
- FFmpeg `libx264` encodes H.264 on the CPU and muxes AAC into MP4.
- An H200 CUDA production renderer is **not implemented**; the repository contains isolated benchmarks that do not affect the service.
- The browser can still select Server or This Device rendering.

## Accepted host

```text
GPU                 NVIDIA H200-35C vGPU
VRAM                35,840 MiB
Driver              580.126.09
Driver CUDA API     13.0
vGPU license        NVIDIA Virtual Compute Server
CPU                 Intel Xeon 6952P
Allocated CPU       32 cores, 1 thread per core
OS kernel           Linux 6.8.0-137-generic x86_64
Python              3.12.3
```

H200 provides CUDA, NVDEC, and JPEG engines but no usable NVENC. Listing `h264_nvenc` in an FFmpeg build does not prove that the device can open an encode session. The real probe failed with:

```text
OpenEncodeSessionEx failed: unsupported device (2)
No capable devices found
```

High VRAM, working CUDA, and an FFmpeg encoder listing therefore do not imply NVENC support.

## Branch history

```text
ec24852  main baseline: NVENC server renderer
6b46f3b  configurable libx264 server encoder
807ee14  configurable libx264 preset and thread count
5f8d85b  H200 CUDA 4K frame composite/download probe
fede00e  H200 frame-to-libx264 end-to-end benchmark
```

Retained remote branch:

```text
deploy/h200-cpu-rendering
```

## Deploy from GitHub

```bash
gh repo clone xthybot/music-visualizer-studio Music_Visualizer
cd Music_Visualizer
git fetch origin --prune
git switch -c deploy/h200-cpu-rendering \
  --track origin/deploy/h200-cpu-rendering
```

Install runtime packages. The WQY font is required by deterministic scene tests and is also the explicit production font:

```bash
sudo apt update
sudo apt install -y ffmpeg sqlite3 curl fontconfig fonts-wqy-zenhei
test -f /usr/share/fonts/truetype/wqy/wqy-zenhei.ttc
```

```bash
command -v uv || curl -LsSf https://astral.sh/uv/install.sh | sh
export PATH="$HOME/.local/bin:$PATH"
uv sync --frozen
uv run pytest tests/backend/test_ffmpeg_integration.py -v
uv run pytest tests/backend -q
```

Do not run `tests/backend/test_nvenc_hardware.py` on H200. If all server-scene tests report `No render font is available`, install `fonts-wqy-zenhei`; another font cannot satisfy the fixed golden hashes.

## Foreground verification

The accepted 32-core allocation uses 24 frame workers and 8 x264 threads:

```bash
VISUALIZER_VIDEO_ENCODER=libx264 \
VISUALIZER_FRAME_WORKERS=24 \
VISUALIZER_ENCODER_THREADS=8 \
VISUALIZER_ENCODER_PRESET=veryfast \
VISUALIZER_FONT_PATH=/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc \
VISUALIZER_HOST=0.0.0.0 \
VISUALIZER_PORT=34388 \
uv run --frozen music-visualizer
```

```bash
curl -sS http://127.0.0.1:34388/api/health
curl -sS http://127.0.0.1:34388/api/render-capabilities
```

Expect `renderWorkerReady: true`, `ready: true`, and `videoCodec: libx264`.

## systemd

The unit must be `/etc/systemd/system/music-visualizer.service`, not `/etc/systemd/music-visualizer.service`.

```ini
[Unit]
Description=Music Visualizer Server Rendering Service
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=xthy
Group=xthy
WorkingDirectory=/home/xthy/Music_Visualizer
Environment=HOME=/home/xthy
Environment=PATH=/home/xthy/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
Environment=VISUALIZER_HOST=0.0.0.0
Environment=VISUALIZER_PORT=34388
Environment=VISUALIZER_VIDEO_ENCODER=libx264
Environment=VISUALIZER_FRAME_WORKERS=24
Environment=VISUALIZER_ENCODER_THREADS=8
Environment=VISUALIZER_ENCODER_PRESET=veryfast
Environment=VISUALIZER_FONT_PATH=/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc
ExecStart=/home/xthy/.local/bin/uv run --frozen music-visualizer
Restart=on-failure
RestartSec=5
TimeoutStopSec=60

[Install]
WantedBy=multi-user.target
```

```bash
mkdir -p /home/xthy/.local/share/music-visualizer
sudo systemd-analyze verify /etc/systemd/system/music-visualizer.service
sudo systemctl daemon-reload
sudo systemctl enable --now music-visualizer
systemctl status music-visualizer --no-pager -l
```

If the unit was placed in the wrong directory:

```bash
sudo mv /etc/systemd/music-visualizer.service \
  /etc/systemd/system/music-visualizer.service
sudo systemctl daemon-reload
sudo systemctl enable --now music-visualizer
```

## Operations

```bash
sudo systemctl restart music-visualizer
sudo systemctl stop music-visualizer
sudo systemctl start music-visualizer
systemctl status music-visualizer --no-pager -l
sudo journalctl -u music-visualizer -f
```

Update this deployment branch with:

```bash
cd /home/xthy/Music_Visualizer
git switch deploy/h200-cpu-rendering
git pull --ff-only
uv sync --frozen
sudo systemctl restart music-visualizer
```

Do not switch the deployed working tree to `main`; `main` does not contain this H200 CPU fallback. A development checkout may return to `main`, while the H200 server stays on this branch.

Job dimensions and frame rate live in `config_json`, not standalone database columns:

```bash
sqlite3 ~/.local/share/music-visualizer/jobs.sqlite3 "
SELECT
  substr(id,1,8),
  json_extract(config_json, '\$.templateId'),
  json_extract(config_json, '\$.output.width') || 'x' ||
    json_extract(config_json, '\$.output.height'),
  json_extract(config_json, '\$.output.frameRate'),
  total_frames,
  round((julianday(completed_at)-julianday(started_at))*86400, 2),
  round(total_frames / NULLIF(
    (julianday(completed_at)-julianday(started_at))*86400, 0
  ), 2),
  output_available
FROM render_jobs
WHERE state='completed'
ORDER BY completed_at DESC
LIMIT 10;
"
```

## Production results

Quiet Editorial measurements:

| Encoder/configuration | Output | Frames | Seconds | Render FPS |
|---|---:|---:|---:|---:|
| libx264 veryfast, 24 frame/8 encode threads | 1080p30 | 1,801 | 32.17 | 55.98 |
| libx264 veryfast, 24 frame/8 encode threads | 1080p30 | 9,000 | 143.08 | 62.90 |
| libx264 veryfast, 24 frame/8 encode threads | 4K60 | 3,602 | 297.23 | 12.12 |
| libx264 ultrafast, 24 frame/8 encode threads | 4K60 | 3,602 | 292.61 | 12.31 |

`ultrafast` improved production 4K60 by only about 1.6%. The CPU pipeline was dominated by 4K frame generation, memory copies, and process IPC rather than the x264 preset. Production therefore stays on `veryfast`, avoiding lower compression efficiency for negligible speed.

## H200 CUDA experiments

### Isolated environment

Direct `uv run --with` placed NVIDIA wheels in a uv cache overlay where CuPy could not locate headers, `libcudart`, or NVRTC. Use a dedicated temporary venv instead:

```bash
probe_dir="$(mktemp -d /tmp/music-visualizer-h200-cuda.XXXXXX)"
uv venv "$probe_dir"
uv pip install --python "$probe_dir/bin/python" \
  'cupy-cuda13x[ctk]>=14,<15'

probe_site="$("$probe_dir/bin/python" -c \
  'import site; print(site.getsitepackages()[0])')"
probe_lib_path="$(find "$probe_site/nvidia" -type d -name lib -print | paste -sd:)"
export LD_LIBRARY_PATH="$probe_lib_path${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"

"$probe_dir/bin/python" -c \
  'import cupy as cp; print(cp.cuda.Device(0).compute_capability); print(cp.arange(8).sum().item())'
```

The accepted result was compute capability `90` and calculation result `28`.

### Composite/download

```bash
"$probe_dir/bin/python" scripts/h200_cuda_probe.py --frames 12000
```

```text
frame=3840x2160 rgb24 (23.73 MiB)
frames=12000
seconds=6.163
cuda_composite_and_download_fps=1947.13
effective_download_gib_s=45.12
```

The H200 and vGPU host transfer have ample headroom for 4K60.

### GPU frames into CPU libx264

```bash
"$probe_dir/bin/python" scripts/h200_cuda_probe.py \
  --frames 1200 --encode \
  --encoder-threads 24 --encoder-preset veryfast
```

```text
cuda_composite_and_download_fps=1948.99
encoder=libx264/veryfast
encoder_threads=24
gpu_to_libx264_seconds=61.417
gpu_to_libx264_fps=19.54
```

The GPU prepares 1,200 frames in about 0.6 seconds, while CPU encoding takes about 61 seconds. FFmpeg pipe backpressure leaves the GPU idle most of the time, so `nvidia-smi dmon` can report 0% during the encode benchmark. Buffering cannot raise final throughput because it only fills the queue faster.

## Final decision

- H200 CUDA frame composition is viable and extremely fast.
- H200 has no NVENC and cannot provide FFmpeg H.264 hardware encoding.
- A complete CUDA scene renderer would still be capped near the measured 19.54 FPS by `libx264`. That is better than 12.12 FPS but still unsuitable for fast 4K60.
- The expected gain does not justify implementing a full CUDA renderer now. Production remains CPU Pillow/NumPy plus `libx264 veryfast`.
- Fast server-side 4K60 requires an NVENC-capable RTX 3060, RTX 5070 Ti, L4, A10, or L40S.
- Keep this branch as the H200 CPU fallback, deployment procedure, and benchmark history. Do not merge it into `main` and do not delete it.

