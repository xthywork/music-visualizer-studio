# 架構

[English](architecture.en.md)

## 雙渲染流程

瀏覽器保存專案設定與字幕文字，使用者在專案列表底部選擇「伺服器」或「此裝置」。選擇是該瀏覽器的全域偏好，預設為伺服器；每次工作開始後模式固定，能力不足時不會自動 fallback。

```text
瀏覽器
  |-- 本機專案設定、字幕文字與混合 render history
  |
  |-- 伺服器模式：上傳素材與設定 → FastAPI → SQLite 佇列
  |                                      |
  |                                      v
  |                              背景 render worker
  |                              CPU：分析與場景繪製
  |                              NVIDIA NVENC + AAC → MP4
  |
  +-- 此裝置模式：AudioContext → Web Worker 場景繪製
                                   WebCodecs + MP4 muxer → MP4
```

伺服器部署目標為 Ubuntu Server 24.04、Ryzen 9 5900X 與 NVIDIA GPU。單一 job worker 預設建立 12 個 frame process，以 Python、Pillow 與 NumPy 平行產生 RGB 畫面；父程序只保留最多 12 個在途 frame，依 frame number 排序後串流給單一 FFmpeg `h264_nvenc` encoder，以 H.264 `yuv420p` 與 AAC 封裝 MP4。唯讀圖片與分析資料以 Linux fork copy-on-write 共享，記憶體有界且不會隨影片總幀數累積。

此裝置模式復用相同的序列化 scene configuration。主執行緒以 AudioContext 解碼音訊，module Worker 執行逐幀場景與 WebCodecs 編碼，再由 MP4 muxer 產生 Blob。可用性依所選解析度與幀率檢查；4K60 是否可用取決於客戶端瀏覽器、codec 與硬體。

## 工作佇列與 process 邊界

SQLite 以 WAL 保存 job configuration snapshot、狀態、進度、取消旗標與輸出 reference。HTTP handler 不執行渲染；單一背景 worker 原子取得佇列中的下一個工作，避免預設同時開啟多個 GPU encode session。`uv run music-visualizer` 啟動 API 與 worker supervisor，worker readiness 在背景執行實際短片 NVENC encode 與 ffprobe 驗證。

主要工作狀態為 queued、running、completed、failed、cancelled、interrupted 與 unavailable。瀏覽器重載後以 job identity 向伺服器取得權威狀態；伺服器重啟時會回收失去 worker owner 的工作並清除暫存輸入與不完整輸出。取消會停止 worker 所屬 FFmpeg process，終止狀態不可被遲到的完成事件覆寫。

## 素材與輸出生命週期

每個 job 使用隔離的 UUID 目錄，含 input、work 與 output 區域。伺服器串流接收音訊、圖片與字幕，驗證大小、格式、內容與設定，再將工作加入 SQLite 佇列。來源素材和中間檔在工作完成、失敗、取消或確認中斷後冪等清除；partial MP4 不會當作完成輸出提供。完成 MP4 預設不設 TTL，會保留至使用者明確刪除工作／輸出或管理者執行明確清理。

專案 configuration 與 render history 保存在瀏覽器本機。Server reference 不代表伺服器輸出仍存在；重新開啟專案時會向伺服器確認。Client output 在 quota 允許時以 Blob 保存於 IndexedDB；若保存失敗，剛生成的 Blob 只在目前分頁提供預覽與下載，離開專案或 reload 後即標示未保存。來源音訊不會放入專案紀錄，建立新 render 時必須重新選取。

## Network boundary

本服務是受信任網路中的單機應用程式，沒有帳號或租戶隔離。限制服務連線於 trusted network 或 VPN；需要跨網路存取時，在 reverse proxy 增加 HTTPS 與驗證。不可把應用程式直接暴露於公用 Internet，也不應將此部署視為 public SaaS。
