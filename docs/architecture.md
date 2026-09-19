# 架構

[English](architecture.en.md)

## 正式渲染流程

所有正式 MP4 都由伺服器產生。瀏覽器保存專案設定與字幕文字，選取音訊後把本次工作需要的素材和設定上傳，接著查詢狀態、取消工作、播放完成影片或下載輸出。瀏覽器不執行正式音訊分析、逐幀繪製、影片編碼或 MP4 封裝。

```text
瀏覽器
  |-- 本機專案設定、字幕文字與 server job/output reference
  |-- 上傳音訊、圖片、字幕及 render configuration
  |-- 查詢狀態／取消／預覽／下載
  v
FastAPI service ─── SQLite 單機佇列
                         |
                         v
                 單一背景 render worker
                 CPU：FFmpeg 解碼、NumPy 分析、Pillow 場景繪製
                 NVIDIA NVENC：H.264 yuv420p + AAC → MP4
                         |
                         +-- 暫存來源與工作檔：終止後清除
                         +-- 完成輸出：留存至明確刪除
```

伺服器部署目標為 Ubuntu Server 24.04、Ryzen 9 5900X 與 NVIDIA GPU。Worker 以 Python、Pillow 與 NumPy 在 CPU 上逐幀產生 RGB 畫面；FFmpeg 將畫面串流給 `h264_nvenc`，以 H.264 `yuv420p` 編碼，並把來源音訊編碼為 AAC，封裝為 MP4。Frame pipeline 有界，記憶體不會隨影片總幀數累積。

## 工作佇列與 process 邊界

SQLite 以 WAL 保存 job configuration snapshot、狀態、進度、取消旗標與輸出 reference。HTTP handler 不執行渲染；單一背景 worker 原子取得佇列中的下一個工作，避免預設同時開啟多個 GPU encode session。`uv run music-visualizer` 啟動 API 與 worker supervisor，worker readiness 在背景執行實際短片 NVENC encode 與 ffprobe 驗證。

主要工作狀態為 queued、running、completed、failed、cancelled、interrupted 與 unavailable。瀏覽器重載後以 job identity 向伺服器取得權威狀態；伺服器重啟時會回收失去 worker owner 的工作並清除暫存輸入與不完整輸出。取消會停止 worker 所屬 FFmpeg process，終止狀態不可被遲到的完成事件覆寫。

## 素材與輸出生命週期

每個 job 使用隔離的 UUID 目錄，含 input、work 與 output 區域。伺服器串流接收音訊、圖片與字幕，驗證大小、格式、內容與設定，再將工作加入 SQLite 佇列。來源素材和中間檔在工作完成、失敗、取消或確認中斷後冪等清除；partial MP4 不會當作完成輸出提供。完成 MP4 預設不設 TTL，會保留至使用者明確刪除工作／輸出或管理者執行明確清理。

專案 configuration 與 last-known job/output reference 保存在瀏覽器本機。Reference 不代表伺服器輸出仍存在；重新開啟專案時，前端會查詢狀態並顯示 unavailable。來源音訊不會放入專案紀錄，建立新 render 時必須重新選取並上傳。

## Network boundary

本服務是受信任網路中的單機應用程式，沒有帳號或租戶隔離。限制服務連線於 trusted network 或 VPN；需要跨網路存取時，在 reverse proxy 增加 HTTPS 與驗證。不可把應用程式直接暴露於公用 Internet，也不應將此部署視為 public SaaS。
