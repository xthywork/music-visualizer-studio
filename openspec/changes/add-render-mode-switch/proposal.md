## Why

伺服器 CPU/NVENC 管線已能在 GPU 主機完成正式輸出，但部署驗收仍需要與既有瀏覽器 Web Worker/WebCodecs 管線在相同專案、模板及輸出設定下直接比較。系統需要讓操作人員明確選擇渲染位置，同時維持目前預設的伺服器模式與兩種輸出的正確生命週期。

## What Changes

- 在專案列表底部新增緊湊的「渲染位置」選擇列，提供「伺服器」與「此裝置」兩種模式。
- 將選擇保存為目前瀏覽器的全域偏好；首次與無效值皆使用伺服器渲染。
- 伺服器模式維持現有 multipart upload、持久 job、CPU scene rendering、NVENC、伺服器預覽與下載流程。
- 客戶端模式重新接回既有 AudioContext/Web Worker/WebCodecs/mp4-muxer 流程，依目前輸出設定檢查本機能力，並沿用既有 IndexedDB／volatile Blob quota 行為。
- 生成、取消、進度、完成、錯誤、導覽與音訊 identity 必須依該次 render session 的固定模式處理；工作進行時停用模式切換，避免改變已開始的工作。
- Render history 與輸出操作保留來源差異，重新開啟專案時不得把本機 Blob 誤認為伺服器輸出，或反之。
- 客戶端能力不足時顯示具體原因並停用生成，不自動 fallback；使用者可自行切回伺服器。

## Capabilities

### New Capabilities

- `render-mode-selection`: 定義渲染位置切換、偏好保存、模式固定、能力呈現與 fallback 行為。

### Modified Capabilities

- `visualizer-generation`: 正式輸出可由使用者選定的伺服器或客戶端背景管線生成，且兩者共用目前模板與輸出設定語意。
- `local-project-storage`: 新的客戶端輸出恢復使用既有本機 Blob／quota 生命週期，伺服器輸出仍只保存 server reference，兩種歷史必須相容共存。

## Impact

- `frontend/src/main.ts` 需要以 mode-aware orchestration 分派現有 server job poller 或既有 client render worker，並協調取消、完成與音訊清理。
- `frontend/src/render/*`、`frontend/src/workers/*` 重新成為客戶端模式的 production 使用路徑；伺服器 API 與 Python worker 不改變。
- Sidebar UI、能力狀態、project/render serialization、IndexedDB output persistence 與 E2E fake worker 覆蓋會擴充。
- Production frontend 必須重建並提交；部署仍維持 `uv run music-visualizer`，一般使用者不需 Node.js。
