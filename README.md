# Music Visualizer Studio

[English](README.en.md)

Music Visualizer Studio 將音訊與視覺模板製作成可下載的 MP4。使用者可在專案列表底部選擇由伺服器生成，或由目前瀏覽器使用 WebCodecs 生成；首次使用預設為伺服器模式。

```text
選擇音訊與模板 → 設定輸出與渲染位置 → 生成 → 預覽／下載 MP4
```

## 目前功能

- 六種視覺模板：Night Orbit、Dawn Spectrum、Paper Resonance、Quiet Editorial、Panorama Lyrics 與 Poetry Lyrics
- 16:9、9:16、1:1 畫面比例，720p、1080p、4K 輸出，以及 30 或 60 fps
- MP3、WAV、M4A 音訊，單首最長 10 分鐘；PNG、JPEG、WebP 圖片；歌詞模板支援 UTF-8 SRT
- 專案設定與字幕文字保存在瀏覽器本機；來源音訊不寫入專案紀錄
- 伺服器以 Pillow 與 NumPy 在 CPU 上分析音訊並逐幀繪製場景，再由 NVIDIA NVENC 編碼 H.264 `yuv420p` 影片，搭配 AAC 音訊封裝成 MP4
- 此裝置模式以 AudioContext、Web Worker、WebCodecs 與 MP4 muxer 在瀏覽器完成分析、繪製與封裝；是否可用依瀏覽器和所選輸出即時檢查，不會自動切換模式
- SQLite 保存單機工作佇列與狀態，預設由一個背景 job worker 依序處理工作；每個工作使用 12 個有界 frame process 平行繪圖，再依序送入單一 NVENC encoder
- 伺服器暫存來源素材會在工作終止後清除，完成 MP4 留存至明確刪除；客戶端 MP4 在容量允許時保存於瀏覽器 IndexedDB

## 伺服器需求

主要部署目標為 Ubuntu Server 24.04。主機需要 Python 3.12+、`uv`、NVIDIA driver，以及包含 `h264_nvenc` 編碼器的 FFmpeg 和 `ffprobe`。目前驗收主機使用 Ryzen 9 5900X 與 RTX 5070 Ti；日後換成 RTX 3060 時沿用相同的啟動預檢與硬體驗收命令。

以全新 clone 啟動時，production 前端已包含在 repository，執行：

```bash
uv run music-visualizer
```

一般使用者不需要 Node.js 或 npm。只有修改 `frontend/src` 的開發者才需在 `frontend/` 執行 `npm ci`、`npm run build`，並提交更新後的 `frontend/dist`。

服務預設監聽 `0.0.0.0:34388`。僅供可信任網路或 VPN 使用；若需由其他網段存取，請在前方的 reverse proxy 加上驗證與 HTTPS。這個無帳號、單機服務不是可直接公開的 SaaS。

完整安裝與網路設定請參閱[部署指南](docs/deployment.md)。

## 開發與檢查

Python 環境及一般後端檢查：

```bash
uv sync --frozen
uv run pytest tests/backend
```

在具備 NVIDIA driver 與 NVENC FFmpeg 的主機上，可選擇執行硬體驗收測試。測試涵蓋 720p、1080p60 與 4K60：

```bash
VISUALIZER_RUN_NVENC_TESTS=1 uv run pytest tests/backend/test_nvenc_hardware.py -v
```

此命令先在 RTX 5070 Ti 驗收；將來更換 RTX 3060 後，使用相同命令重跑。工作者啟動時也會執行短片 `h264_nvenc` 預檢，並可從健康與能力端點確認狀態：

```bash
curl -fsS http://127.0.0.1:34388/health
curl -fsS http://127.0.0.1:34388/api/render-capabilities
```

修改前端 source 的開發者需安裝 Node.js/npm，並重建、提交 production bundle：

```bash
cd frontend
npm ci
npm test
npm run build
```

## 文件

- [產品需求](docs/product-requirements.md)
- [架構](docs/architecture.md)
- [開發指南](docs/development.md)
- [部署指南](docs/deployment.md)
- [AI Agent API](docs/agent-api.md)
- [儲存與隱私](docs/storage-and-privacy.md)
- [Quiet Editorial 視覺與動態設計](docs/quiet-editorial.md)
- [Paper Resonance 視覺與動態設計](docs/paper-resonance.md)
- [字幕模板與編輯器控制](docs/subtitle-templates.md)
