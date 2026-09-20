# 部署

[English](deployment.en.md)

## 主機需求

- Ubuntu Server 24.04，Python 3.12+ 與 `uv`
- `ffmpeg` 與 `ffprobe`；預設 GPU 模式另需 NVIDIA GPU、driver 與 `h264_nvenc` encoder
- 足夠空間保存 SQLite job database、暫存素材與使用者尚未刪除的完成 MP4

目前 GPU 驗收主機為 Ryzen 9 5900X 與 RTX 5070 Ti。場景分析與逐幀 Pillow/NumPy 繪製使用 CPU；影片可由 NVIDIA NVENC 或 CPU `libx264` 編碼。

## 安裝與啟動

安裝 `uv` 與 FFmpeg 後，確認 binary 可用並 clone repository。只有 NVENC 模式需要 `nvidia-smi` 與 `h264_nvenc`：

```bash
nvidia-smi
ffmpeg -hide_banner -encoders | rg h264_nvenc
ffprobe -version
git clone <repo>
cd <repo>
```

Repository 已含 production frontend。一般使用者不需要 Node.js 或 npm；單一命令會同步 Python 環境、初始化 SQLite/storage、執行所選 encoder 的 readiness preflight，並啟動 API 與背景 worker：

```bash
uv run music-visualizer
```

Worker 的 preflight 會實際編碼短 H.264 `yuv420p` MP4，再由 `ffprobe` 確認輸出。若所選 encoder 不可用，HTTP service 仍可啟動，但 worker 顯示 unavailable，且不會接受無法完成的工作。

沒有 NVENC 的主機可選用 CPU encoder：

```bash
VISUALIZER_VIDEO_ENCODER=libx264 \
VISUALIZER_FRAME_WORKERS=24 \
VISUALIZER_ENCODER_THREADS=8 \
uv run music-visualizer
```

`VISUALIZER_ENCODER_THREADS` 只套用於 `libx264`。以上 24/8 配置適合 32 個單執行緒 CPU 核心；其他主機應保留足夠核心給 encoder 與作業系統。預設仍是 `h264_nvenc`，既有 GPU 部署不需修改設定。

介面預設選擇「伺服器」。使用者也可在專案列表底部改選「此裝置」，由瀏覽器以 AudioContext、Web Worker、WebCodecs 與 MP4 muxer 生成，不使用伺服器 CPU/GPU。客戶端模式需要支援 WebCodecs、module Worker 與所選 codec/解析度的現代瀏覽器；實際能力會隨輸出設定重新檢查。任一模式不可用時只會停用該模式的生成，不會自動切換。

預設服務位址為 `0.0.0.0:34388`。本機檢查健康與 render 能力：

```bash
curl -fsS http://127.0.0.1:34388/health
curl -fsS http://127.0.0.1:34388/api/render-capabilities
```

可設定 `VISUALIZER_HOST`、`VISUALIZER_PORT` 調整 bind。若由同一台主機上的 reverse proxy 代管，可讓應用程式只綁定 loopback：

```bash
VISUALIZER_HOST=127.0.0.1 VISUALIZER_PORT=34388 uv run music-visualizer
```

預設資料根目錄為 `~/.local/share/music-visualizer`，可用 `VISUALIZER_DATA_ROOT` 指定其他持久目錄。該目錄含 SQLite、暫存工作檔與完成輸出；容量限制可透過 `VISUALIZER_STORAGE_CEILING_BYTES` 與 `VISUALIZER_MINIMUM_FREE_BYTES` 調整。完成 MP4 不會自動過期，刪除輸出或工作前應先確認不再需要該檔案。

伺服器每個 render job 預設使用 12 個 CPU frame process，適合 Ryzen 9 5900X 的 12 個實體核心。可用 `VISUALIZER_FRAME_WORKERS` 調整，例如在較小主機設為 4：

```bash
VISUALIZER_FRAME_WORKERS=4 uv run music-visualizer
```

Frame pipeline 最多保留與 worker 數相同的在途 RGB frame；提高數量會增加 RAM 與 process/IPC 負擔，不應設成 5900X 的 24 個 SMT 執行緒。使用 systemd 時將變數放在 unit 的 `Environment=`，修改後執行 `daemon-reload` 與 restart。

前端修改者需在 `frontend/` 執行 `npm ci`、`npm run build`，並提交變更後的 `frontend/dist`。一般部署不安裝 Node.js/npm。

## 硬體驗收

在 NVIDIA GPU 主機上執行 opt-in 測試，驗證 720p30、1080p60 與 4K60 輸出的 H.264、`yuv420p`、解析度、幀率及 AAC 音軌：

```bash
VISUALIZER_RUN_NVENC_TESTS=1 uv run pytest tests/backend/test_nvenc_hardware.py -v
```

此為 5070 Ti 的目前驗收流程；日後改用 RTX 3060 時執行相同命令。一般軟體測試不需要 NVIDIA 硬體。

## 網路安全範圍

服務沒有帳號、登入或租戶隔離，僅適用 trusted network 或 VPN。防火牆只開放給受信任用戶；若透過其他網段提供服務，必須在 reverse proxy 實作 HTTPS 與 authentication，並將應用程式維持在內部介面。不要直接把服務公開到 Internet。公開 SaaS 的身份驗證、濫用防護、隔離、計費與營運需求不在此部署範圍。
