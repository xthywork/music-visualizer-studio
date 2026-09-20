## MODIFIED Requirements

### Requirement: 在本機保存專案歷史

系統 SHALL 將每個專案 configuration 與 render history 保存於 browser-local storage，包括各模板設定、解析後字幕文字與 start time、文字與圖片設定、畫面比例、解析度、幀率、timestamp、render status，以及用於區分本機輸出或 server job/output 的 identity。系統 SHALL NOT 保存來源音訊、原始字幕檔、end timestamp 或伺服器暫存路徑。

#### Scenario: 重新開啟已完成專案

- **WHEN** 使用者在同一瀏覽器回到應用程式並開啟已保存專案
- **THEN** 系統顯示 configuration，並依 render source 恢復本機 output 或向伺服器確認 output status

#### Scenario: 重新開啟具有混合輸出的專案

- **WHEN** 專案歷史同時包含 client output 與 server output reference
- **THEN** 系統依各 render record 的來源恢復正確預覽、下載與 availability，不混淆兩種輸出

#### Scenario: 關閉頁面時專案仍在渲染

- **WHEN** client render 執行期間頁面關閉或 reload
- **THEN** 系統將該 client render 校正為 interrupted 或 unknown，且不宣稱未完成 Blob 可下載
- **AND** server render 仍以其 job identity 向伺服器取得權威狀態

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

### Requirement: 在本機保留產生的 MP4

在 browser storage 可用容量允許時，系統 SHALL 保存 client render 成功產生的 MP4；server render SHALL 只保存 job/output reference，不將伺服器 MP4 複製至 IndexedDB。

#### Scenario: 使用者稍後下載已保存輸出

- **WHEN** 已保存專案具有仍存在的本機 completed MP4
- **THEN** 系統允許使用者預覽或下載該 MP4

#### Scenario: 本機輸出不存在

- **WHEN** client MP4 已由使用者移除、遭 browser eviction，或 storage 不可用
- **THEN** 系統顯示 project metadata，並指出必須重新渲染輸出

#### Scenario: Client MP4 超過 quota

- **WHEN** client render 已完成但 MP4 Blob 無法寫入 browser storage
- **THEN** 系統在目前分頁記憶體保留該 Blob 供立即預覽與下載，並在 reload 後標示未保存

#### Scenario: Server render 完成

- **WHEN** server job 完成且輸出可用
- **THEN** 系統保存可重新確認的 server reference，不建立重複的本機 MP4 Blob

### Requirement: 絕不永久保存來源音訊

系統 SHALL 只在目前 browser workspace 保留所選 source-audio `File`。Client mode SHALL 只建立該次 Web Worker 所需的 transient decoded PCM；server mode SHALL 只將音訊上傳至隔離的工作暫存區。兩種模式皆 SHALL NOT 將來源音訊存入 project record，且 terminal path SHALL 清理該次 render 的 transient source data。

#### Scenario: Render session 結束

- **WHEN** client 或 server render 完成、失敗、取消或確認中斷
- **THEN** 系統清理該次 render 使用的來源資料且不加入 saved project record；render 期間選取的較新音訊仍保持可用

#### Scenario: 任一模式的 Render session 結束

- **WHEN** render 完成、失敗、取消或確認中斷
- **THEN** 系統釋放該次 render 使用的來源資料且不加入 saved project record；render 期間選取的較新音訊仍保持可用

#### Scenario: 專案重新開啟但沒有來源音訊

- **WHEN** 使用者開啟已保存專案並要求建立新 client 或 server render
- **THEN** 系統在允許 render 前要求重新選擇來源音訊
