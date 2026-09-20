## Purpose

讓使用者能在同一套專案介面明確選擇伺服器或目前瀏覽器執行影片生成，並可靠理解每種模式的能力、資料位置與工作狀態。

## ADDED Requirements

### Requirement: 選擇渲染位置

系統 SHALL 在專案列表底部提供緊湊的渲染位置控制，允許選擇伺服器渲染或目前裝置渲染，並 SHALL 將有效選擇保存為該瀏覽器的全域偏好。首次使用、偏好不存在或值無效時 SHALL 預設為伺服器渲染。

#### Scenario: 首次開啟網站

- **WHEN** 瀏覽器尚未保存有效渲染位置偏好
- **THEN** 系統選擇伺服器渲染，並顯示伺服器能力狀態

#### Scenario: 使用者切換渲染位置

- **WHEN** 沒有 active render 且使用者選擇另一個渲染位置
- **THEN** 系統保存偏好、更新能力提示，且下一個 render 使用新模式

#### Scenario: 工作正在執行

- **WHEN** server 或 client render 已開始且尚未終止
- **THEN** 系統停用渲染位置控制，該工作繼續使用開始時固定的模式

### Requirement: 依選定模式檢查能力

系統 SHALL 只用目前選定模式的能力決定 Generate 是否可用，並 SHALL 分別呈現伺服器 worker/NVENC readiness 或瀏覽器 WebCodecs/MP4 codec capability。

#### Scenario: 選擇伺服器模式

- **WHEN** 使用者選擇伺服器渲染
- **THEN** 系統查詢伺服器 capability，且不要求客戶端 WebCodecs 支援

#### Scenario: 選擇客戶端模式

- **WHEN** 使用者選擇目前裝置渲染
- **THEN** 系統依目前輸出 preset 檢查瀏覽器的 canvas、video/audio encoder 與 MP4 muxing path

#### Scenario: 選定模式不可用

- **WHEN** 目前選定模式不支援 requested output 或暫時不可用
- **THEN** 系統停用 Generate、顯示可採取行動的原因，且不自動提交到另一模式

### Requirement: 以工作 identity 隔離兩種模式

系統 SHALL 將每個 render session 綁定 workspace、project、render、source audio 與 render mode identity，且 stale completion、error、cancel 或 capability response SHALL NOT 修改不同 workspace 或另一個 render session。

#### Scenario: Client 工作後切換至 Server

- **WHEN** client render 終止後使用者切換至 server 並建立新工作
- **THEN** 新工作只使用 server pipeline，舊 client terminal message 不得修改新工作

#### Scenario: Render 期間選取新音訊

- **WHEN** Audio A 的任一模式 render 執行中，使用者選取 Audio B
- **THEN** Audio A 終止時只釋放其 source identity，Audio B 仍可供下一次 render 使用
