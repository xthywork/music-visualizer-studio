# 開發指南

[English](development.en.md)

## 開發環境

- Python 3.12+ 與 `uv`
- Ubuntu Server 24.04 為主要部署目標
- FFmpeg/`ffprobe`；NVIDIA driver 與 `h264_nvenc` 用於可選的 GPU 硬體驗收
- Node.js 與 npm 僅供修改前端 source 的開發者使用

正式輸出有兩條 production path。伺服器模式由 FFmpeg 解碼、NumPy 分析，預設 12 個有界 process 以 Pillow 平行繪製 frame，再依序送入設定的 `h264_nvenc` 或 `libx264` encoder，搭配 AAC 輸出 MP4；SQLite 保存單機佇列，單一背景 job worker 依序處理工作。此裝置模式復用 scene configuration，以 AudioContext、module Worker、WebCodecs 與 MP4 muxer 在瀏覽器生成。

## Python 開發與軟體測試

```bash
uv sync --frozen
uv run pytest tests/backend
uv run music-visualizer
```

Worker 啟動時會以所選 encoder 執行實際短片 preflight，並在 `/health` 與 `/api/render-capabilities` 回報 readiness。preflight 成功代表 FFmpeg 與該編碼器可用，不代表特定解析度的效能保證。預設為 `h264_nvenc`；軟體模式使用 `VISUALIZER_VIDEO_ENCODER=libx264`，並可由 `VISUALIZER_ENCODER_THREADS` 限制編碼執行緒。

## NVIDIA 硬體驗收

在目標 GPU 主機上執行 opt-in acceptance test：

```bash
VISUALIZER_RUN_NVENC_TESTS=1 uv run pytest tests/backend/test_nvenc_hardware.py -v
```

測試輸出為 720p30、1080p60 與 4K60，並檢查 H.264、`yuv420p`、尺寸、幀率及 AAC 音軌。先在目前 RTX 5070 Ti 驗收；未來換成 RTX 3060 時，執行相同命令。未設定環境變數時，這組硬體測試會略過。

## 前端開發

一般使用者啟動提交的 production bundle 不需要 Node.js/npm。修改 `frontend/src` 時，開發者才需要安裝相依套件、執行測試與 build，並把更新後的 `frontend/dist` 一起提交：

```bash
cd frontend
npm ci
npm test
npm run build
git status --short dist
```

## 隱私與儲存不變條件

- 專案設定、模板外觀、解析後的字幕 cue，以及 client output metadata／server job reference 留在瀏覽器本機。
- Server render 建立時，來源音訊、所需圖片與字幕上傳至隔離的伺服器暫存區；在完成、失敗、取消或確認中斷後清除。Client render 不建立 server job。
- Server MP4 保留於伺服器直到明確刪除；client MP4 在 quota 允許時保存於 IndexedDB，quota 失敗的 Blob 只在目前分頁暫存。
- Job 使用 UUID 衍生目錄與 SQLite 單機 queue；不要把 client filename 或絕對路徑當成 server path。
- 此無帳號服務僅限可信任網路/VPN；跨網路存取需透過具有驗證的 reverse proxy，不可直接作為 public SaaS 暴露。
