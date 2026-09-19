# 本機專案儲存規格

[English](spec.en.md)

## Purpose

在使用者瀏覽器中保留專案歷史、模板設定與產生的影片，讓使用者能重新開啟、預覽、下載或刪除本機內容；同時確保來源音訊不被永久保存、不會上傳，也不會在未告知的情況下複製到任何遠端服務。

## Requirements

### Requirement: 在本機保存專案歷史

系統 SHALL 將每個專案 configuration 與 render history 保存於 browser-local storage，包括各模板設定、解析後字幕文字與 start time、文字與圖片設定、畫面比例、解析度、幀率、timestamp 與 render status。系統 SHALL NOT 保留原始字幕檔與 end timestamp。

#### Scenario: 重新開啟已完成專案

- **WHEN** 使用者在同一瀏覽器回到應用程式並開啟已保存專案
- **THEN** 系統顯示 configuration 與 completed output status，不要求重建專案

#### Scenario: 關閉頁面時專案仍在渲染

- **WHEN** render 執行期間頁面關閉或 reload
- **THEN** 專案將該 render 記錄為 interrupted 或 unknown，且不宣稱未完成 output 可供下載

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

在 browser storage 可用容量允許時，系統 SHALL 保存成功產生的 MP4，使使用者不需重新渲染即可再次預覽或下載。

#### Scenario: 使用者稍後下載已保存輸出

- **WHEN** 已保存專案具有本機保留的 completed MP4
- **THEN** 系統允許使用者預覽或下載該 MP4

#### Scenario: 本機輸出不存在

- **WHEN** generated MP4 已由使用者移除、遭 browser eviction，或 storage 不可用
- **THEN** 系統顯示 project metadata，並指出必須重新渲染輸出

### Requirement: 絕不永久保存來源音訊

系統 SHALL 只在目前 browser workspace 保留所選 source-audio `File`，並在不永久保存的前提下解碼供渲染使用；MVP SHALL NOT 將其存入 project record 或上傳至 FastAPI service。

#### Scenario: Render session 結束

- **WHEN** render 完成、失敗或取消
- **THEN** 系統釋放該次 render 使用的音訊，且不將其加入 saved project record；render 期間選取的較新音訊仍保持可用

#### Scenario: 專案重新開啟但沒有來源音訊

- **WHEN** 使用者開啟已保存專案並要求重新渲染
- **THEN** 系統在允許 render 前要求重新選擇來源音訊

### Requirement: 提供本機資料控制

系統 SHALL 允許使用者刪除專案、只刪除 generated MP4 並保留 configuration，以及在無法保存時查看約略 local storage usage 或 quota error。

#### Scenario: 使用者刪除專案

- **WHEN** 使用者確認刪除專案
- **THEN** 系統移除 metadata 與本機保留的 MP4，並從 project list 排除該專案

#### Scenario: 使用者只刪除 generated output

- **WHEN** 使用者刪除專案的 generated MP4
- **THEN** 系統保留 project configuration，並將 output 標示為不可下載

#### Scenario: Completed MP4 Blob 超過 browser storage quota

- **WHEN** completed render metadata 已記錄，但保存 MP4 Blob 超過 browser 可用 storage
- **THEN** 系統在記憶體保留 completed MP4 供立即預覽與下載，reload 後則標示為未保存

#### Scenario: 使用者離開具有未保存記憶體輸出的專案

- **WHEN** 使用者開啟其他專案、建立新專案、刪除專案，或以新輸出取代 quota-rejected output
- **THEN** 系統釋放 volatile MP4 與其 object URL，避免大型輸出持續累積於記憶體
