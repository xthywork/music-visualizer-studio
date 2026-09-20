## MODIFIED Requirements

### Requirement: 設定輸出格式

系統 SHALL 允許使用者選擇 16:9、9:16、1:1 其中一種比例，720p、1080p、4K preset，以及 30 或 60 fps。Capability check SHALL 依目前選定的伺服器或客戶端渲染模式判斷所選組合能否生成。

#### Scenario: 使用者選擇有效輸出

- **WHEN** 使用者選擇允許的比例、解析度與幀率，且選定模式支援該組合
- **THEN** 系統顯示 dimensions 與該模式的 capability status，且有效來源音訊就緒時啟用渲染

#### Scenario: 要求的輸出超過裝置能力

- **WHEN** 選定的伺服器 worker 或客戶端瀏覽器不支援目前解析度或幀率
- **THEN** 系統不開始 render、說明該模式的限制，且不自動 fallback 至另一模式

### Requirement: 不阻塞介面地渲染

系統 SHALL 依使用者選定模式，在伺服器背景工作或瀏覽器 Web Worker 中生成正式輸出，並 SHALL 提供 preparing、queued（適用時）、rendering、completed、cancelled、failed、interrupted（適用時）狀態及可量測的 progress。

#### Scenario: Render 完成

- **WHEN** 使用者以目前選定模式啟動有效 render 且成功完成
- **THEN** 系統標示 completed、提供 playable MP4 preview，並啟用 download

#### Scenario: Server render 完成

- **WHEN** 使用者以伺服器模式提交有效工作且 worker 成功完成
- **THEN** 系統標示 completed、提供伺服器 MP4 preview/download，並保存 server output reference

#### Scenario: Client render 完成

- **WHEN** 使用者以客戶端模式啟動有效工作且 Web Worker 成功完成
- **THEN** 系統標示 completed、提供本機 MP4 preview/download，並依 browser quota 保存 Blob

#### Scenario: 使用者取消 render

- **WHEN** 使用者取消任一模式的 active render
- **THEN** 系統只取消該次 session 所屬工作、清理其 temporary resources，並保留 project configuration

#### Scenario: Render 失敗

- **WHEN** 任一模式的 upload、decoding、drawing、encoding、muxing、storage、memory 或 device error 阻止完成
- **THEN** 系統標示 failed、顯示該模式的有用錯誤，且不將 partial file 呈現為 completed MP4

### Requirement: 產生可下載 MP4

系統 SHALL 由選定的伺服器或客戶端管線將 rendered video 與 source audio 結合為可播放 MP4，其 dimensions、aspect ratio、frame rate 與 duration在正常 encoder tolerance 內符合 project configuration。

#### Scenario: 使用者下載 completed output

- **WHEN** completed server output 或 local output 可用且使用者選擇 Download
- **THEN** 系統從該 render record 對應的來源下載 generated MP4，不要求再次提供 source audio

#### Scenario: 檢查 output metadata

- **WHEN** preview 或下載任一模式完成的 MP4
- **THEN** media metadata 顯示所選 dimensions、frame rate 與 audio/video tracks

#### Scenario: Output 已不存在

- **WHEN** server output 已移除，或 client Blob 因刪除、quota、eviction 或 reload 後不存在
- **THEN** 系統保留 project configuration、明確標示 output unavailable，且不以另一模式的舊輸出冒充最新結果
