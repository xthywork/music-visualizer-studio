## Purpose

提供單機、持久且可觀測的伺服器渲染工作流程，安全接收專案素材，以 CPU 產生動畫畫面並使用 NVIDIA NVENC 生成可預覽及下載的 MP4，同時可靠清理來源素材與失敗輸出。

## ADDED Requirements

### Requirement: 建立並驗證伺服器渲染工作

系統 SHALL 接受具版本的專案設定及必要素材來建立 render job，並 SHALL 在排入佇列前於伺服器重新驗證音訊、圖片、字幕、模板與輸出限制。

#### Scenario: 有效工作成功建立

- **WHEN** 使用者提交有效設定、音訊及模板需要的素材
- **THEN** 系統建立具唯一識別碼的 queued job，並回傳可查詢狀態及取消的資源位置

#### Scenario: 上傳或設定無效

- **WHEN** 伺服器收到不支援、超限、解碼失敗、缺少必要素材或 schema version 不相容的輸入
- **THEN** 系統拒絕建立工作、提供可採取行動的錯誤，且不留下部分 job 或無主暫存檔

### Requirement: 持久化並循序執行工作

系統 SHALL 將 render job 與狀態轉換持久化，並 SHALL 由獨立於 HTTP request handling 的伺服器 worker 執行；預設每張 GPU 同時最多執行一個工作。

#### Scenario: Worker 取得下一個工作

- **WHEN** GPU worker 可用且佇列中存在 queued job
- **THEN** 系統以確定順序 claim 一個工作、將其標記為 running，且不讓其他 worker 重複執行

#### Scenario: 服務在工作期間重新啟動

- **WHEN** 應用程式或 worker 重新啟動時存在沒有存活 worker owner 的 running job
- **THEN** 系統將工作校正為 interrupted 或可安全重試的 queued 狀態，且不宣稱部分輸出已完成

### Requirement: 使用伺服器 CPU 與 NVIDIA NVENC 生成 MP4

系統 SHALL 在伺服器執行音訊分析及逐幀 2D 場景繪製，並 SHALL 以 bounded pipeline 將畫面串流至 H.264 NVENC，再與 AAC 音訊封裝為 `yuv420p` MP4；正式輸出不得使用客戶端 renderer。

#### Scenario: Worker 能力預檢成功

- **WHEN** worker 啟動且實際短片 encode probe 證明 `h264_nvenc` 可建立 session 並產生有效 MP4
- **THEN** 系統將 worker 標記為 ready 並開始接收工作

#### Scenario: NVENC 不可用

- **WHEN** FFmpeg、NVIDIA driver、`h264_nvenc` 或實際 encode probe 不可用
- **THEN** 系統不啟動無法完成的 render、將 worker 標記為 unavailable，並透過 health/capability 狀態回報原因

#### Scenario: 完成 4K60 工作

- **WHEN** 有效工作選擇 4K、60 fps 且 worker 能力允許
- **THEN** 系統逐幀串流處理而不在 RAM 累積完整原始影片，並產生尺寸、幀率、時長及影音軌符合設定的 MP4

### Requirement: 回報進度與終止狀態

系統 SHALL 提供 queued、running、completed、cancelled、failed、interrupted 狀態及可量測的進度，且每個工作只能完成一次終止轉換。

#### Scenario: 使用者查詢進度

- **WHEN** 使用者查詢 queued 或 running job
- **THEN** 系統回傳目前狀態、已處理影格、總影格、進度與可用時的估計剩餘時間

#### Scenario: 使用者取消工作

- **WHEN** 使用者取消 queued 或 running job
- **THEN** 系統停止後續工作、終止所屬 FFmpeg process、標記 cancelled，且遲到的 worker completion 不得覆寫該狀態

#### Scenario: 渲染失敗

- **WHEN** 解碼、場景繪製、FFmpeg、NVENC、封裝、磁碟或裝置錯誤阻止完成
- **THEN** 系統將工作標記 failed、保留安全的診斷訊息，且不提供部分輸出作為 completed MP4

### Requirement: 提供完成輸出並清理素材

系統 SHALL 只讓 completed job 的有效 MP4 可供預覽或下載，並 SHALL 在所有終止路徑清除來源音訊、圖片、字幕及部分輸出；完成 MP4 依設定的保存政策或明確刪除操作管理。

#### Scenario: 使用者預覽或下載完成輸出

- **WHEN** completed job 的輸出仍存在
- **THEN** 系統以正確 media type、檔名、content length 與 range request 支援提供 MP4

#### Scenario: 工作進入終止狀態

- **WHEN** 工作完成、失敗、取消或確認中斷
- **THEN** 系統冪等清除所有來源及暫存檔，且 cleanup 重試不會刪除其他工作或改變既有 completed output

#### Scenario: 完成輸出已不存在

- **WHEN** 工作紀錄存在但輸出已依保存政策、管理操作或磁碟清理移除
- **THEN** 系統明確回報 output unavailable，且不宣稱仍可下載

### Requirement: 限制檔案系統與資源使用

系統 SHALL 隔離每個工作目錄、阻止路徑穿越與任意檔名存取，並 SHALL 執行可設定的上傳、工作數、輸出空間及執行資源限制。

#### Scenario: 惡意檔名或路徑被提交

- **WHEN** 上傳檔名或 request path 嘗試離開指定工作目錄
- **THEN** 系統拒絕該路徑，且不讀寫工作儲存根目錄以外的內容

#### Scenario: 系統達到容量限制

- **WHEN** 上傳大小、佇列深度或可用磁碟空間超過設定限制
- **THEN** 系統在接受更多資料前拒絕新工作並回報容量問題，不影響既有工作及輸出
