## MODIFIED Requirements

### Requirement: 接受支援的音訊輸入

系統 SHALL 允許使用者為視覺化專案選擇 MP3、WAV 或 M4A，並 SHALL 在提交前與伺服器接收後，以可採取行動的訊息拒絕不支援格式或超過 10 分鐘的檔案。有效來源音訊 SHALL 只上傳至伺服器 render job，不在客戶端執行正式輸出所需的解碼或分析。

#### Scenario: 選取有效音訊

- **WHEN** 使用者選擇不超過 10 分鐘的支援音訊
- **THEN** 系統顯示檔案已就緒，並允許繼續設定模板及提交伺服器 render job

#### Scenario: 選取不支援或過長音訊

- **WHEN** 使用者選擇不支援格式或超過 10 分鐘的音訊
- **THEN** 系統拒絕檔案、說明限制，且不建立 render job

#### Scenario: 客戶端檢查與伺服器檢查結果不同

- **WHEN** 客戶端初步接受的音訊在伺服器解碼或驗證失敗
- **THEN** 系統拒絕建立或執行工作、顯示伺服器驗證錯誤，且清除已接收的部分資料

### Requirement: 設定輸出格式

系統 SHALL 允許使用者選擇 16:9、9:16、1:1 其中一種比例，720p、1080p、4K preset，以及 30 或 60 fps。Server capability check SHALL 判斷目前 render worker 能否接受所選組合。

#### Scenario: 使用者選擇有效輸出

- **WHEN** 使用者選擇允許的比例、解析度與幀率，且伺服器 worker ready
- **THEN** 系統顯示 dimensions 與 server capability status，且有效來源音訊就緒時啟用工作提交

#### Scenario: 要求的輸出超過裝置能力

- **WHEN** 目前 render worker、GPU、FFmpeg 或容量政策不支援所選解析度或幀率
- **THEN** 系統不建立無法完成的工作，並說明可用設定或 worker unavailable 原因

### Requirement: 不阻塞介面地渲染

系統 SHALL 將正式輸出提交至伺服器背景工作，並 SHALL 提供 uploading、queued、running、completed、cancelled、failed、interrupted 狀態，以及可量測時的 progress。客戶端導覽或重新載入不得中止已由伺服器接受的工作。

#### Scenario: Render 完成

- **WHEN** 使用者提交有效工作且伺服器渲染成功完成
- **THEN** 系統標示 completed、提供 playable MP4 preview，並啟用 download

#### Scenario: 使用者取消 render

- **WHEN** 使用者取消 uploading、queued 或 running job
- **THEN** 系統停止上傳或要求伺服器取消工作、標示 cancelled、釋放 temporary resources，並保留 project configuration

#### Scenario: Render 失敗

- **WHEN** upload、validation、decoding、drawing、encoding、muxing、storage 或 device error 阻止完成
- **THEN** 系統標示 failed、顯示有用錯誤，且不將 partial file 呈現為 completed MP4

#### Scenario: 使用者重新載入進行中的專案

- **WHEN** 專案保存有效 server job identity 且頁面重新載入
- **THEN** 系統向伺服器重新取得權威狀態，而不是把工作誤標為本機中斷

### Requirement: 產生可下載 MP4

系統 SHALL 由伺服器將 rendered video 與 source audio 結合為 H.264/AAC `yuv420p` MP4，其 dimensions、aspect ratio、frame rate 與 duration 在正常 encoder tolerance 內符合 project configuration。正式輸出 SHALL NOT 由客戶端 renderer 產生。

#### Scenario: 使用者下載 completed output

- **WHEN** completed server output 可用且使用者選擇 Download
- **THEN** 系統從伺服器下載 generated MP4，不要求再次上傳 source audio

#### Scenario: 檢查 output metadata

- **WHEN** preview 或下載 completed MP4
- **THEN** media metadata 顯示所選 dimensions、frame rate、H.264 video track 與 AAC audio track

#### Scenario: Server output 已過期或刪除

- **WHEN** 專案參照的 completed output 在伺服器已不存在
- **THEN** 系統保留 project configuration、標示 output unavailable，並要求選擇來源音訊後重新渲染

## REMOVED Requirements

### Requirement: 回報瀏覽器渲染能力

**Reason**: 正式輸出改由伺服器 CPU renderer 與 NVIDIA NVENC 完成，不再取決於客戶端瀏覽器的 WebCodecs、codec 或 muxing capability。

**Migration**: 前端改為顯示伺服器 worker、FFmpeg、NVENC 及容量狀態；既有 capability preflight 不得阻止使用可播放網站的客戶端提交工作。
