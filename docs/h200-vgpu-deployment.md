# H200 vGPU 部署與效能實驗紀錄

[English](h200-vgpu-deployment.en.md)

## 文件範圍

這份文件記錄 2026-09-20 在 `deploy/h200-cpu-rendering` 分支完成的 NVIDIA H200-35C vGPU 部署、故障排除與效能實驗。此分支刻意保留，不合併至 `main`，用途是保存沒有 NVENC 的 H200 主機所需的 CPU H.264 fallback 與 CUDA 可行性資料。

Production 實作狀態：

- Pillow/NumPy 在 CPU 產生 frame。
- FFmpeg `libx264` 在 CPU 編碼 H.264，AAC 音訊封裝為 MP4。
- H200 CUDA production renderer **尚未實作**；repository 只包含不影響服務的獨立 benchmark。
- 瀏覽器仍可選「伺服器」或「此裝置」渲染。

## 驗收主機

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

H200 規格提供 CUDA、NVDEC 與 JPEG engines，但沒有可用 NVENC。雖然 FFmpeg build 列出 `h264_nvenc`，實際 session probe 仍是唯一可信的判斷。

實際失敗結果：

```text
OpenEncodeSessionEx failed: unsupported device (2)
No capable devices found
```

因此這台主機不可使用 `h264_nvenc`。高 VRAM、CUDA 可用或 `ffmpeg -encoders` 列出 encoder，都不代表硬體具備 NVENC。

## 分支歷程

```text
ec24852  main 基準：NVENC server renderer
6b46f3b  新增可設定的 libx264 server encoder
807ee14  新增 libx264 preset 與 thread 設定
5f8d85b  新增 H200 CUDA 4K frame composite/download probe
fede00e  新增 H200 frame → libx264 端到端 benchmark
```

遠端保留分支：

```text
deploy/h200-cpu-rendering
```

## 從 GitHub 部署

```bash
gh repo clone xthybot/music-visualizer-studio Music_Visualizer
cd Music_Visualizer
git fetch origin --prune
git switch -c deploy/h200-cpu-rendering \
  --track origin/deploy/h200-cpu-rendering
git status -sb
```

安裝系統套件。`fonts-wqy-zenhei` 是 server scene golden tests 與正式部署指定的固定字型：

```bash
sudo apt update
sudo apt install -y ffmpeg sqlite3 curl fontconfig fonts-wqy-zenhei

test -f /usr/share/fonts/truetype/wqy/wqy-zenhei.ttc
```

安裝 `uv`、同步 lockfile 並測試：

```bash
command -v uv || curl -LsSf https://astral.sh/uv/install.sh | sh
export PATH="$HOME/.local/bin:$PATH"

uv sync --frozen
uv run pytest tests/backend/test_ffmpeg_integration.py -v
uv run pytest tests/backend -q
```

不要在 H200 上執行 `tests/backend/test_nvenc_hardware.py`；這張 GPU 沒有 NVENC。

若 scene tests 全部出現 `No render font is available`，安裝 `fonts-wqy-zenhei`。只設定其他字型不能通過固定 golden hash，因為測試明確使用上述 WQY 路徑。

## 前景啟動驗證

32-core 主機的已驗收配置為 24 個 frame workers 與 8 個 x264 threads：

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

另一個 shell 驗證：

```bash
curl -sS http://127.0.0.1:34388/api/health
echo
curl -sS http://127.0.0.1:34388/api/render-capabilities
echo
```

預期 `renderWorkerReady` 與 `ready` 都是 `true`，`videoCodec` 是 `libx264`。

## systemd

Unit 必須放在 `/etc/systemd/system/music-visualizer.service`，不是 `/etc/systemd/music-visualizer.service`。

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
journalctl -u music-visualizer -n 100 --no-pager -l
```

若 unit 曾誤放在 `/etc/systemd/`：

```bash
sudo mv /etc/systemd/music-visualizer.service \
  /etc/systemd/system/music-visualizer.service
sudo systemctl daemon-reload
sudo systemctl enable --now music-visualizer
```

## 日常操作

```bash
sudo systemctl restart music-visualizer
sudo systemctl stop music-visualizer
sudo systemctl start music-visualizer
systemctl status music-visualizer --no-pager -l
sudo journalctl -u music-visualizer -f
```

更新 H200 分支：

```bash
cd /home/xthy/Music_Visualizer
git switch deploy/h200-cpu-rendering
git pull --ff-only
uv sync --frozen
sudo systemctl restart music-visualizer
```

不要把部署 working tree 切到 `main`；`main` 沒有此分支的 H200 CPU fallback。開發工作區可以回到 `main`，H200 server 則維持在本分支。

查看最近工作：

```bash
sqlite3 ~/.local/share/music-visualizer/jobs.sqlite3 "
SELECT
  substr(id,1,8), state, frame, total_frames,
  error_code, error_message
FROM render_jobs
ORDER BY created_at DESC
LIMIT 10;
"
```

效能查詢需從 `config_json` 取解析度和幀率，資料表沒有獨立的 `width` 欄位：

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

## Production 效能

Quiet Editorial 實測：

| Encoder/設定 | 輸出 | Frames | 秒數 | Render FPS |
|---|---:|---:|---:|---:|
| libx264 veryfast，24 frame／8 encode threads | 1080p30 | 1,801 | 32.17 | 55.98 |
| libx264 veryfast，24 frame／8 encode threads | 1080p30 | 9,000 | 143.08 | 62.90 |
| libx264 veryfast，24 frame／8 encode threads | 4K60 | 3,602 | 297.23 | 12.12 |
| libx264 ultrafast，24 frame／8 encode threads | 4K60 | 3,602 | 292.61 | 12.31 |

`ultrafast` 對 production 4K60 只提升約 1.6%，證明原 CPU pipeline 的主要瓶頸不是 x264 preset，而是 4K frame generation、memory copy 與 process IPC。因為速度收益極小且相同 bitrate 下壓縮效率較差，正式設定維持 `veryfast`。

## H200 CUDA 實驗

### 隔離環境

直接使用 `uv run --with` 時，NVIDIA wheel 位於 uv cache overlay，CuPy 找不到 headers、`libcudart` 與 NVRTC。可重現錯誤為：

```text
RuntimeError: Failed to find CUDA headers
DynamicLibNotFoundError: Failure finding libcudart.so / libnvrtc.so
```

正確方式是建立 `/tmp` 專用 venv，不修改 production `.venv`、`pyproject.toml` 或 `uv.lock`：

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

驗收結果為 Compute Capability `90`、計算結果 `28`。

### GPU composite/download

```bash
"$probe_dir/bin/python" scripts/h200_cuda_probe.py --frames 12000
```

```text
device=NVIDIA H200-35C
frame=3840x2160 rgb24 (23.73 MiB)
frames=12000
seconds=6.163
cuda_composite_and_download_fps=1947.13
effective_download_gib_s=45.12
```

H200 產生並下載 4K RGB frame 遠高於 4K60 需求，GPU 與 vGPU host transfer 不是瓶頸。

### GPU frame → CPU libx264

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

GPU 在約 0.6 秒內即可準備 1,200 frames，但 CPU encoder 需要約 61 秒。FFmpeg pipe 的 backpressure 使 GPU 大多時間等待，因此 `nvidia-smi dmon` 在 encode benchmark 中可能顯示 0%：這不代表 GPU 沒執行，而是 GPU 工作約只占整體時間 1%。增加 buffer 只能更快填滿記憶體，不能提高最終輸出速度。

## 最終結論

- H200 CUDA frame composition 技術上可行且極快。
- H200 沒有 NVENC，不能讓 FFmpeg 使用 H.264 hardware encoding。
- 完整 CUDA scene renderer 的預估上限仍被 `libx264` 限制在約 19.54 FPS；相對目前 12.12 FPS 有改善，但仍不適合快速 4K60。
- 此結果不足以合理化目前投入完整 CUDA renderer，因此 production 維持 CPU Pillow/NumPy＋`libx264 veryfast`。
- 需要快速 4K60 時，使用具備 NVENC 的 RTX 3060、RTX 5070 Ti、L4、A10 或 L40S；H200 比較適合 AI/HPC，而非這個 H.264 encode workload。
- 本分支保留作為 H200 CPU fallback、部署程序與 benchmark 歷史，不合併至 `main`，也不刪除。

