## Context

目前 production UI 只會呼叫 `RenderJobHttpClient`／`RenderJobPoller`，但既有 client renderer 並未刪除：`render/*` 仍包含 capability detection、場景、WebCodecs encoder 與 mp4-muxer，`workers/*` 仍包含 protocol、controller 與 render worker，相關 unit tests 也持續通過。IndexedDB domain 已能以 `render.server` 是否存在區分 server reference 與具有 `render.output`/StoredOutput 的本機輸出；因此雙模式不需要 database schema migration。

Sidebar 目前包含新增專案、專案列表與 storage usage，適合在最底部放置全域渲染位置控制。現有 active session、取消與導覽則以 server job 為中心，需要在重新啟用 client path 前建立明確 mode boundary。

## Goals / Non-Goals

**Goals:**

- 讓兩條既有管線在同一 production build 中可明確選擇、獨立檢查能力並完成輸出。
- 保持 server 為安全預設，且不因 client capability 失敗自動改變使用者選擇。
- 復用已驗證的 client renderer、quota fallback、volatile Blob cleanup 與 audio identity 行為。
- 讓 server/client render history、預覽、下載、刪除及專案導覽可混合共存。

**Non-Goals:**

- 不讓 server 與 client 同時渲染同一工作，也不新增自動 benchmark 或逐幀視覺比對 UI。
- 不改 Python renderer、NVENC policy、server API、IndexedDB schema 或既有模板設計。
- 不讓 client active render 在 reload/navigation 後繼續；只有 server job 具持久 identity。
- 不承諾所有瀏覽器都能 client render，尤其 4K60 仍由 capability probe 決定。

## Decisions

### 使用 browser preference，而非 project configuration

新增 `RenderMode = "server" | "client"`，以版本化／命名明確的 localStorage key 保存，讀取時只接受兩個合法值，其他情況回到 `server`。這是執行環境偏好而非影片內容，不能放入 project configuration，否則同一專案移到另一台裝置會攜帶不適用的硬體決策。

替代方案是每專案保存模式；它會讓比較多個專案時反覆切換，也會把部署能力混入可攜 configuration，因此不採用。

### Active render session 使用固定 mode discriminator

`ActiveRenderSession` 加入 readonly `mode`。共同欄位維持 workspace token、project/render identity、source audio identity、finalized/update queue/finished promise；client session 額外持有 `RenderController`，server session持有 `serverJobId`。Generate 在建立 session 時 snapshot 目前模式，之後所有 start/cancel/finish/navigation 分派都讀 session mode，而不是讀可變的 UI preference。

模式控制在 active session 期間 disabled，終止 cleanup 後才重新開放。終止時只在目前 `state.audioFile` 仍等於 session source 時釋放音訊，保留 render 途中選取的新檔案。

替代方案是維持一個充滿 optional server/client 欄位的 session 並以欄位存在與否推論；這正是 stale message 容易跨管線誤判的來源，因此採用 discriminator。

### 以單一 mode-aware capability gate 控制 Generate

保留一個 `LatestRequestGate`，每次模式或 output preset 改變都開始新 request。Server 呼叫 capability endpoint；client 對 `renderConfigFromDomain(...).output` 執行既有 `detectCapabilities`。只有 token 仍 current 且 mode/output identity 未改變時可更新 capability 狀態。

Generate availability 由音訊、字幕需求、active session 與「目前模式 capability ready」共同決定。提示文字同時指出 `伺服器 NVENC` 或 `此裝置 WebCodecs`，避免使用者誤判算力位置。

### 復用 client worker，不複製 renderer

Client start path 復用先前 production flow：保存 project snapshot、queue local render record、以 AudioContext 解碼、再次針對 snapshot output 驗證 capability、建立 module Worker 與 `RenderController`，最後把 completed Blob 交給 `ProjectService.recordCompletedRender`。不建立第二套場景或 encoder。

Worker output 先放入 `volatileOutputs` 並立即建立 preview/download，接著嘗試 IndexedDB；成功後移除 volatile entry，quota 或 persistence error 時保留當前分頁 Blob。離開專案、刪除或被新輸出取代時沿用既有 revoke/cleanup。

Server start path保持現狀。`RenderRecord.server` 存在即為 server output；無 server 且有 output metadata/StoredOutput 即為 client output，因此不需要新增持久欄位或 migration。

### 導覽與取消維持兩種模式原有語意

Client render 無 durable worker identity，離開 workspace 時送 cancel、等待 terminal cleanup，再導覽。Server job 已被接受後可在離開 workspace 時繼續，poller detach，重新開啟專案後再查詢；上傳尚未完成時仍 abort。Cancel button 則兩種模式都只取消 session identity 對應的工作。

刪除混合專案時，既有 server deletion coordinator 先處理所有 server job；成功後 IndexedDB project deletion 會一併移除 client outputs。單筆 output deletion 仍依 output source 分派。

### UI 採小型 segmented control

Sidebar 改為 flex column，project list 使用剩餘高度並可在需要時捲動。Storage usage 下方放置帶標籤的兩段式 radio control：「伺服器」與「此裝置」，使用原生 radio keyboard semantics，視覺上維持小型 bar。窄螢幕現行 sidebar 會隱藏，本次不新增另一份 mobile control，因目前產品桌面版 editor 才支援完整工作流。

## Risks / Trade-offs

- **[重新啟用 client path 暴露先前只由 unit test 覆蓋的整合退化]** → 加入真實 UI orchestration tests 與 Playwright fake Worker flow，並在 GPU 主機以支援 WebCodecs 的 Chrome 實測。
- **[Client 4K60 造成瀏覽器高 RAM 或失敗]** → 保留既有 capability gate、bounded analysis、單一 active render 與明確 error；不自動降低解析度或改走 server。
- **[兩種 async terminal message 互相污染]** → session mode + workspace/project/render identity、LatestRequestGate、terminal claim 與 serialized project writes 必須有 regression tests。
- **[localStorage 在隱私模式可能 throw]** → preference read/write 以窄範圍 error handling fallback 至 server，不影響 project storage 或 render。
- **[舊 server-only E2E selectors/文字改變]** → 保留既有 DOM ids，新增 mode-specific assertions，不改 server API fake contract。

## Migration Plan

1. 先加入 mode preference helper、segmented control 與 mode-aware capability gate，預設仍 server，確認 server path 無行為變更。
2. 以 discriminated session 接回既有 client start/update/cancel/finish path，補 race、quota、audio identity 與混合 history unit tests。
3. 新增 server/client UI E2E，重跑 production build 並提交更新的 `frontend/dist`。
4. 在 GPU 主機 pull 同一 feature branch，分別以 server 與 client 模式產生短 720p/1080p MP4，再測目標 4K60；比較 metadata、播放與下載。

Rollback 可回到本 change 前的 commit；project schema 未變，期間建立的 client Blob 與 server references 都能由既有 reader 辨識。
