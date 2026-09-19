## Why

目前所有音訊分析、逐幀繪製與 MP4 編碼都在使用者瀏覽器中執行，長影片與 4K60 輸出會消耗客戶端 CPU、RAM 與硬體編碼能力，也使可用格式取決於瀏覽器。系統需要改為單機 Ubuntu 伺服器集中渲染，以 Ryzen 9 5900X 產生畫面並由 NVIDIA RTX 3060 NVENC 編碼，使客戶端只負責上傳、進度、預覽與下載。

## What Changes

- **BREAKING**：匯出流程由瀏覽器 Web Worker/WebCodecs 改為 FastAPI render-job API 與獨立伺服器 Render Worker；客戶端不再執行音訊分析、逐幀繪製、影音編碼或 MP4 封裝。
- 新增可取消、可查詢且能在服務重新啟動後校正狀態的伺服器 render job，並提供完成輸出的串流預覽與下載。
- 新增受限制的 multipart 素材上傳，包含音訊、封面、背景、字幕及具版本的模板／輸出設定；伺服器端再次驗證格式、大小、時長與設定。
- 新增單機持久工作佇列與獨立 worker process，預設每張 GPU 同時執行一個工作，避免渲染阻塞 FastAPI。
- 以伺服器 CPU 執行音訊解碼、分析及 Canvas-compatible 2D 場景逐幀繪製，使用 bounded frame pipeline 串流至 FFmpeg。
- 以 H.264 `h264_nvenc`、`yuv420p`、AAC、MP4 作為正式輸出基線；worker 啟動時執行實際 NVENC preflight，RTX 5070 Ti 與未來 RTX 3060 共用相同 contract。
- 來源音訊及其他上傳素材只保留於工作暫存區，並在完成、失敗或取消後可靠清除；完成 MP4 依伺服器輸出保存政策管理。
- 前端保留本機專案設定，但 render history 與下載狀態改為反映伺服器工作及伺服器輸出是否仍存在。
- 內部部署維持單機、無帳號模式與 `uv run music-visualizer` 入口；公開 SaaS 所需的帳號、租戶、計費與外部 object storage 不在本次範圍。

## Capabilities

### New Capabilities

- `server-render-jobs`：素材上傳、工作建立／查詢／取消、持久佇列、獨立 CPU/NVENC worker、進度、輸出下載與終止狀態清理。

### Modified Capabilities

- `visualizer-generation`：以伺服器能力取代瀏覽器 codec capability 與本機 Web Worker 匯出，且所有既有模板與輸出 preset 都必須透過伺服器產生相同語意的 MP4。
- `local-project-storage`：來源素材會暫時上傳至伺服器而不永久保存；專案仍保存在瀏覽器，但輸出可用性與 render history 必須對應伺服器工作及輸出生命週期。

## Impact

- FastAPI 新增 render-job、upload、progress/status、cancel 與 output endpoints，以及安全的檔案串流、範圍請求與錯誤模型。
- Python 專案新增持久 job repository、worker lifecycle、FFmpeg/NVENC preflight、暫存及輸出目錄設定；部署主機新增 FFmpeg 與 NVIDIA driver runtime 要求。
- 前端 render orchestration 從 Web Worker protocol 改為 HTTP job client；編輯階段只顯示靜態模板示意與素材排版，動態預覽使用伺服器生成的完成輸出，瀏覽器端 scene renderer 不再參與影片生成。
- 現有 TypeScript scene contract 需要建立對應的伺服器 scene contract 與 conformance fixtures，維持模板語意與構圖一致；影格必須串流處理，不可在 RAM 累積完整影片。
- 儲存與隱私文件需反映來源素材的短暫伺服器處理、完成輸出的伺服器保存與清理政策。
- 測試新增 API、queue/restart、cancel、cleanup、path traversal、invalid upload、NVENC preflight、FFmpeg failure、輸出 metadata 及端對端 server render 覆蓋；硬體測試以可選 integration marker 執行。
