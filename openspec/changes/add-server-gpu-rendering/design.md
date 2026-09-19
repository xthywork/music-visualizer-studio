## Context

目前 FastAPI 只提供已建置前端與 health endpoint；音訊解碼、分析、Canvas 2D scene、WebCodecs encoding 與 MP4 muxing 全部位於瀏覽器。專案已將具版本的 template/output configuration 與 UI 分離，但 scene implementation 使用 browser Canvas types、ImageBitmap、AudioContext、OffscreenCanvas 與 WebCodecs，無法直接在 Python process 執行。

目標部署是單一 Ubuntu Server 24.04 主機、Ryzen 9 5900X、目前 RTX 5070 Ti 並預計更換 RTX 3060。一般使用者仍須能在含 production frontend 的 clone 中只執行 `uv run music-visualizer`；因此 runtime 不得要求 Node.js、npm、Redis、Docker 或外部 database。FFmpeg 與 NVIDIA driver 是明確的主機 prerequisite。

工作區目前含尚未提交的新模板與字幕功能，server renderer 必須以現行 configuration schema、所有 current template identifiers 及 output presets 為準，不能從舊的兩模板狀態重新設計。

## Goals / Non-Goals

**Goals:**

- 讓所有正式影片生成運算位於伺服器；瀏覽器只上傳、查詢、取消、播放及下載。
- 保留 `uv run music-visualizer` 單一入口，同時讓 HTTP service 與 renderer 位於不同 process。
- 使用持久 queue 與明確 job identity，使 reload、process restart、cancel 與 late completion 都有確定行為。
- 將來源與 frame memory 維持在固定上限，讓 4K60 長影片不因時長線性增加 RAM。
- 以 H.264/AAC MP4 作為 RTX 5070 Ti 與 RTX 3060 的共同輸出基線。
- 以 conformance/golden fixtures 保持瀏覽器既有構圖與 server output 的模板語意一致。

**Non-Goals:**

- 多主機 distributed queue、多 GPU scheduling、Kubernetes 或 horizontal scaling。
- 帳號、租戶、計費、公開分享、object storage 或 public SaaS security boundary。
- AV1/HEVC 輸出、GPU scene drawing、即時 4K60 或 render-time SLA。
- 在 server renderer 完成後繼續提供 browser-side export fallback。

## Decisions

### Python raster renderer 與 committed production frontend

Server scene engine 使用 Python、Pillow 與 NumPy，依既有 versioned configuration 實作相同 template identifiers、placement、lyrics timing、palette 與 audio-reactive behavior。字型以 repository asset 明確指定，避免依賴主機字型。共用 JSON fixtures 描述 config、analysis samples、timestamp 與預期 placement；frontend 與 server 各自讀取相同 fixtures，並以 golden frames 防止語意漂移。

這項選擇維持 Python/`uv` 單一 runtime，Pillow/NumPy 有 Ubuntu x86-64 wheel，也適合 5900X 上不要求即時完成的 2D raster 工作。缺點是 scene drawing 有兩份實作，因此 conformance tests 是必要交付條件，而非後續改善。

替代方案是 server headless Chromium 執行現有 worker。它能重用 TypeScript，但 production 會需要安裝及管理 Chromium，Linux headless WebCodecs/NVENC/AAC 支援不穩定，也難以保證換成 RTX 3060 後仍走相同硬體路徑，因此不採用。另一方案是 Node native canvas；它會破壞 clone 後只需 `uv run` 的部署契約，因此不採用。

### FFmpeg streaming pipeline

Worker 先用 `ffprobe` 驗證音訊時長、streams 與 format，再以 FFmpeg 解碼為 bounded PCM stream供 NumPy 分析。Renderer 每次只建立一張 RGB frame，透過 pipe 將 `rawvideo` 傳給另一個 FFmpeg process；該 process 以原始音訊作第二輸入、`h264_nvenc` 編碼 video、AAC 編碼 audio，並輸出暫存 MP4。成功後以 atomic rename 發布 final output。

Frame pipe 與 OS backpressure 自然限制 in-flight frames；應用程式不建立完整影片 frame list，也不將 raw frames 寫入磁碟。FFmpeg command 使用 argument array、固定 codec/filter policy 與由 server 推導的安全路徑，不經 shell interpolation。

替代方案是先寫 PNG sequence，實作較容易但 4K60 會產生大量 inode、磁碟寫入與清理負擔，因此不採用。

### SQLite durable queue 與單一 GPU worker

使用 Python stdlib SQLite 作 job repository，啟用 WAL、foreign keys 與 busy timeout。Job row 保存 immutable config snapshot、狀態、進度、timestamps、cancel flag、錯誤碼及相對 output identity；不保存任意 client filesystem path。Worker 以短 transaction 原子 claim 最早 queued job，預設單一 worker process，因此 RTX 3060 同時最多一個 NVENC session。

`music-visualizer` launcher 建立 storage、執行 migration/preflight、啟動 renderer child process，再啟動 Uvicorn；shutdown 時先停止接受新工作，通知 worker 取消/退出，最後清理 child process。測試及明確外部 worker 部署可用設定停用 embedded worker。HTTP request handler 從不直接渲染。

替代方案 Redis/Celery 對單機一張 GPU 增加服務依賴，且破壞單一命令啟動，因此不採用。純記憶體 queue 無法處理 restart，也不採用。

### Job directory 與發佈邊界

每個 UUID job 使用 storage root 下的固定衍生目錄，內部分為 `input/`、`work/`、`output/`。Client filename 只作顯示 metadata，不參與路徑。Upload 先寫入同一 filesystem 的 `.part`，通過 byte limit、content sniffing 與 decode probe 後 atomic rename；任一失敗都刪除 `.part`。

Completed output 預設保留，直到使用者刪除或 administrator 執行明確 cleanup；不設定隱含 TTL，避免本機專案在沒有提示時失去影片。建立工作前檢查 configurable storage ceiling 與 filesystem free space。來源、圖片、字幕及 work files 在每個 terminal path 清除；cleanup 只允許操作由 validated job UUID 推導的目錄，且具冪等性。

### REST job contract 與 polling

第一版 API 使用：

- `GET /api/render-capabilities`
- `POST /api/render-jobs`（multipart config + assets）
- `GET /api/render-jobs/{job_id}`
- `POST /api/render-jobs/{job_id}/cancel`
- `DELETE /api/render-jobs/{job_id}/output`
- `DELETE /api/render-jobs/{job_id}`
- `GET /api/render-jobs/{job_id}/output`

前端以 abortable HTTP upload 建立工作，之後以單一 active poller 查詢。所有 response 使用 versioned JSON DTO 與穩定 error code。FileResponse/ASGI range support 提供影片 seek 與下載；只有 completed 且檔案存在的 job 回傳 MP4。

第一版不加入 WebSocket/SSE，因為單一工作 polling 足夠且 restart/reconnect 更簡單。未來可在不改變 job resource contract 的情況下新增事件串流。

### 狀態機、取消與 restart recovery

允許的主要轉換為：

```text
uploading -> queued -> running -> completed
    |          |          |
    +----------+----------+-> cancelled
               +-----------> failed
               +-----------> interrupted
```

Repository 以 conditional update 實作 terminal compare-and-set；completed/cancelled/failed/interrupted 不能被遲到訊息覆寫。取消 queued job 直接 terminalize；取消 running job 設定 flag，worker 停止 frame loop、terminate/kill 其所擁有的 FFmpeg process，await exit 後 terminalize。Cleanup 有獨立 idempotent guard。

啟動 recovery 將 owner process 不存在的 running job 標為 interrupted，刪除 partial output 與 source assets。第一版不自動重試，避免在使用者未知情況下重複昂貴工作；使用者可重新提交。

### NVENC readiness 與 health

Worker readiness 不能只依賴 `ffmpeg -encoders`。啟動時執行短小、具 timeout 的 synthetic H.264 NVENC encode，接著以 ffprobe 驗證 video stream。Preflight 失敗時 HTTP service 仍啟動、health 回報 degraded、capability endpoint 禁止新工作並顯示安全化原因。每個實際工作仍獨立處理 runtime NVENC failure。

正式 policy 固定為 H.264 high profile、`yuv420p`、30/60 fps、AAC 48 kHz stereo與 MP4 faststart；bitrate 依輸出 preset 決定。AV1 與 HEVC 即使在 5070 Ti 可用也不暴露，確保日後 RTX 3060 行為不變。

### 前端遷移與舊本機輸出

正式 Generate action 改呼叫 server API，移除 capability gate、AudioContext decode、Worker encode/mux 與 volatile MP4 流程的使用路徑。編輯器可保留靜態 template swatch 與圖片排版顯示，但不執行連續 scene animation；只有 server output video 是動態預覽。

既有 IndexedDB project/schema 不做破壞性 migration。舊專案既有 local output 仍可播放、下載或刪除；首次 server render 後記錄 server job reference，新輸出不再寫入 IndexedDB Blob。Serialization 以 optional server fields 維持 backward compatibility。

## Risks / Trade-offs

- **[Python 與 TypeScript scene 產生視覺差異]** → 使用共用 config fixtures、固定字型、placement unit tests 與每模板/比例 golden frames；完成 conformance 前不得移除 browser export path，但 UI 切換只能在整條 server path 通過後發生。
- **[Pillow 4K60 逐幀繪製很慢]** → 接受離線渲染、限制每 GPU 一個工作、使用 NumPy 預計算 audio envelopes、重用靜態 layer；不以高 RAM frame batching 換速度。
- **[FFmpeg pipe 卡住或 child process 遺留]** → worker 持有 process group、監控 stderr、取消時 terminate 後 bounded kill、所有 terminal path await child exit。
- **[磁碟被輸出耗盡]** → 建立工作前檢查 free space 與 configurable ceiling、atomic publish、提供明確 output/project delete；不暗中刪除 completed output。
- **[單一 worker 是 throughput bottleneck]** → queued 狀態及進度明確呈現；此限制符合單張 GPU 與無 SLA 範圍，未來可在 repository claim contract 上增加 worker。
- **[無帳號 API 不適合公開網路]** → 文件要求 VPN/可信任網路或 reverse-proxy access control；公開 SaaS 前不得將 endpoints 直接暴露於 Internet。
- **[來源素材現在會離開瀏覽器]** → UI 在首次提交前明示短暫上傳，server terminal cleanup、restart recovery 與 privacy tests 成為 release gate。

## Migration Plan

1. 在不切換 UI 的情況下加入 storage/config、SQLite repository、API schema 與 mock worker tests。
2. 加入 FFmpeg/NVENC preflight、音訊分析、server scene contract、逐模板 renderer 與 golden fixtures。
3. 串接 bounded rawvideo pipeline、progress、cancel、cleanup、restart recovery 與真實低解析度 software test；NVENC 測試以硬體 integration marker 執行。
4. 加入 frontend HTTP orchestrator 與 server job persistence，保留舊 local output 相容讀取。
5. 所有模板、比例、錯誤路徑及 clean-clone deployment 通過後，將 Generate 正式切至 server-only 並移除 browser export 使用路徑。
6. 更新 production frontend、README、部署、架構、隱私與操作文件；在目標主機以 5070 Ti 跑 4K60 smoke test，換卡後以 RTX 3060 重跑相同 preflight/benchmark。

Rollback 時部署切換前的 commit；既有 IndexedDB 資料不變。伺服器 job database 與 outputs 保留供人工下載或清理，rollback 不嘗試把 server MP4 自動搬回 IndexedDB。
