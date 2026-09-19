## ADDED Requirements

### Requirement: 保存伺服器工作與輸出參照

系統 SHALL 在瀏覽器本機專案中保存 server job identity、權威狀態摘要與 output availability，但 SHALL NOT 將該參照本身視為輸出仍存在的證明。

#### Scenario: 重新開啟具有伺服器工作的專案

- **WHEN** 使用者重新開啟保存有效 server job identity 的專案
- **THEN** 系統向伺服器更新工作及輸出狀態，並清楚呈現 queued、running、completed、failed、cancelled、interrupted 或 unavailable

#### Scenario: 伺服器無法連線

- **WHEN** 重新開啟專案時暫時無法取得 server job 狀態
- **THEN** 系統保留專案設定與上次已知狀態、標示尚未確認，且不錯誤宣稱輸出目前可下載

## MODIFIED Requirements

### Requirement: 在本機保存專案歷史

系統 SHALL 將每個專案 configuration 與 render history 保存於 browser-local storage，包括各模板設定、解析後字幕文字與 start time、文字與圖片設定、畫面比例、解析度、幀率、timestamp、server job identity 與最後已知 render status。系統 SHALL NOT 保留原始字幕檔、end timestamp、來源音訊或伺服器暫存路徑。

#### Scenario: 重新開啟已完成專案

- **WHEN** 使用者在同一瀏覽器回到應用程式並開啟已保存專案
- **THEN** 系統顯示 configuration，並向伺服器確認 completed output status，不要求重建專案

#### Scenario: 關閉頁面時專案仍在渲染

- **WHEN** server render 執行期間頁面關閉或 reload
- **THEN** 本機專案保留 job identity，重新開啟時取得伺服器權威狀態，且不把頁面關閉本身視為 render 中斷

#### Scenario: 重新開啟使用 retired template 的專案

- **WHEN** 已保存 identifier 為 Spectrum Cover、Vinyl Particle 或 legacy Abstract Pulse
- **THEN** configuration migrate 至 Quiet Editorial，同時保留 project identity、文字、圖片、render history 與既有 output reference

#### Scenario: 重新開啟 retired Geometry Lyrics 專案

- **WHEN** 已保存 configuration 使用 `geometry-lyrics` identifier
- **THEN** migrate 至 Poetry Lyrics，同時保留文字、圖片、字幕、render history、output reference 與 template settings
- **AND** 既有 Poetry Lyrics settings 優先於 migrated settings

#### Scenario: 使用者切換模板或重新開啟字幕設定

- **WHEN** 使用者在現行模板間切換，或重新開啟已保存專案
- **THEN** 每個模板保留各自 appearance settings，已匯入 subtitle cues 不需重新匯入 SRT 即可繼續使用

### Requirement: 絕不永久保存來源音訊

系統 SHALL 只在目前 browser workspace 保留所選 source-audio `File`，並 SHALL 僅為建立 server render job 將其上傳至隔離的伺服器暫存區。系統 SHALL NOT 將來源音訊存入 browser project record 或伺服器長期儲存，且伺服器 SHALL 在所有工作終止路徑清除來源音訊。

#### Scenario: Render session 結束

- **WHEN** server render 完成、失敗、取消或確認中斷
- **THEN** 伺服器冪等清除該工作來源音訊，browser project record 不含音訊；上傳期間選取的較新音訊仍保持可用

#### Scenario: 專案重新開啟但沒有來源音訊

- **WHEN** 使用者開啟已保存專案並要求建立新 render job
- **THEN** 系統在上傳及建立工作前要求重新選擇來源音訊

### Requirement: 提供本機資料控制

系統 SHALL 允許使用者刪除本機專案、要求刪除其伺服器輸出並保留 configuration，以及查看伺服器輸出 unavailable 或容量錯誤。刪除本機 project record 與刪除 server job/output SHALL 有明確且可測試的順序，部分失敗不得虛假顯示資料已全部移除。

#### Scenario: 使用者刪除專案

- **WHEN** 使用者確認刪除具有 server job/output 的專案
- **THEN** 系統要求取消 active job 並刪除可移除的 server output，再移除本機 metadata；若伺服器操作失敗，UI 顯示未完成狀態並允許重試

#### Scenario: 使用者只刪除 generated output

- **WHEN** 使用者刪除專案的 server generated MP4
- **THEN** 系統保留 project configuration，並在伺服器確認後將 output 標示為不可下載

#### Scenario: 伺服器容量不足

- **WHEN** server job 因上傳、暫存或輸出容量限制無法建立或完成
- **THEN** 系統保留本機 project configuration、顯示可採取行動的容量錯誤，且不宣稱 MP4 已保存

#### Scenario: Completed MP4 Blob 超過 browser storage quota

- **WHEN** 相容模式處理既有本機 output，而 completed MP4 Blob 超過 browser 可用 storage quota
- **THEN** 系統維持既有行為，只在目前分頁記憶體保留該 legacy MP4 供立即預覽與下載，且 reload 後標示為未保存

#### Scenario: 使用者離開具有未保存記憶體輸出的專案

- **WHEN** 使用者離開仍具有 legacy volatile MP4 的專案
- **THEN** 系統釋放該 Blob 與 object URL；新的 server output reference 不建立 volatile browser MP4

## REMOVED Requirements

### Requirement: 在本機保留產生的 MP4

**Reason**: 正式輸出由伺服器 worker 生成及保存，瀏覽器 IndexedDB 不再作為大型 MP4 的權威儲存位置。

**Migration**: 既有 IndexedDB MP4 在相容版本中仍可預覽、下載或由使用者刪除，但新的 server render 只保存 job/output reference；新輸出不寫入本機 MP4 Blob storage。
