# 視覺化影片生成規格

[English](spec.en.md)

## Purpose

提供聚焦的工作流程，將支援的音訊與視覺模板轉為可預覽、可下載，且輸出選項可預期的 MP4 音樂視覺化影片。

## Requirements

### Requirement: 接受支援的音訊輸入

系統 SHALL 允許使用者為視覺化專案選擇 MP3、WAV 或 M4A，並 SHALL 在 render 前以可採取行動的訊息拒絕不支援格式或超過 10 分鐘的檔案。

#### Scenario: 選取有效音訊

- **WHEN** 使用者選擇不超過 10 分鐘的支援音訊
- **THEN** 系統顯示檔案已就緒，並允許繼續設定模板

#### Scenario: 選取不支援或過長音訊

- **WHEN** 使用者選擇不支援格式或超過 10 分鐘的音訊
- **THEN** 系統拒絕檔案、說明限制，且不開始渲染

### Requirement: 選擇並設定視覺模板

系統 SHALL 以緊湊雙欄三列 grid 提供 Quiet Editorial（靜謐唱片誌）、Paper Resonance（紙上聲景）、Panorama Lyrics（全景映像）、Poetry Lyrics（留白詩頁）、Night Orbit（夜航聲環）、Dawn Spectrum（晨光頻譜）。每個模板 SHALL 提供明／暗模式、accent、motion、background visibility 與 cover size editor。歌詞模板 SHALL 另外提供 font size、line spacing 與 surrounding-line opacity。

#### Scenario: User exports new instrumental templates without subtitles

- **WHEN** 使用者選擇 Night Orbit 或 Dawn Spectrum 並匯入音訊
- **THEN** 系統不要求 SRT，且預覽與輸出均不顯示歌詞
- **AND** Night Orbit 使用環狀頻率輪廓，Dawn Spectrum 使用水平聲浪；兩者皆回應音訊、使用封面及底圖，支援三種輸出比例

#### Scenario: 使用者選擇模板

- **WHEN** 使用者選擇任一可用模板
- **THEN** 系統顯示 preview 與該模板相關的設定欄位

#### Scenario: 使用者變更模板設定

- **WHEN** 使用者變更文字或圖片輸入
- **THEN** preview 與 pending render configuration 反映新值，不要求重新上傳音訊

#### Scenario: 使用者為 Quiet Editorial 提供兩張圖片

- **WHEN** 使用者選擇 Quiet Editorial 並提供封面與背景圖片
- **THEN** 模板完整顯示封面且不扭曲比例，以 full-frame crop 使用背景，並依選定比例調整構圖
- **AND** 封面與文字保持靜止，以克制背景動態和平滑 audio-reactive frequency marks 提供動畫
- **AND** editor 將 synthetic motion preview 標示為示範，exported MP4 frame 則使用上傳音訊的分析

#### Scenario: 使用者選擇 Paper Resonance

- **WHEN** 使用者選擇 Paper Resonance，並可選擇提供封面與背景圖片
- **THEN** 模板組成暖紙海報，包含等比例 crop 的攝影帶、完整靜止 album sleeve，以及依比例調整的粗體 title block
- **AND** 三條流動墨線分別回應 low、mid、high audio energy，且不侵入標題與 progress line
- **AND** 缺圖時使用設計過的 fallback artwork，並區分 demonstration preview 與 audio-driven MP4 export

### Requirement: 提供可捲動 editor 與固定 render controls

系統 SHALL 將 import controls 排成緊湊 2×2 grid、templates 排成雙欄三列 grid，並將 render progress 與 Generate/Cancel controls 放在 scrolling settings body 之外。

#### Scenario: 使用者自訂 artwork placement 與 wave styling

- **WHEN** 使用者開啟 template editor
- **THEN** 每個模板提供 cover X/Y displacement 百分比與 0–5 motion strength
- **AND** Paper Resonance 與 Poetry Lyrics 提供靠右 photographic region width、crop zoom、X/Y pan、1–8 wave lines 與 curated palette selection
- **AND** 設定依模板獨立保存，preview 與 MP4 rendering 使用完全相同值
- **AND** Panorama Lyrics spectrum 約佔 frame width 一半

#### Scenario: 使用者捲動 editor

- **WHEN** editor settings 超過可用高度
- **THEN** settings body 可捲動，render progress 與 Generate/Cancel 保留在獨立固定底列
- **AND** import controls 排成 2×2：audio/SRT 位於 cover/background 上方

### Requirement: 依 start time 渲染捲動字幕

歌詞模板 SHALL 接受最大 1 MiB、5000 cues 的有效 UTF-8 SRT，依 start time 排序、合併同時 start，並在選擇或捲動歌詞時忽略 end time。最新開始的 cue SHALL 持續 active 至下一個 start，包括 gap 與最後 cue。文字 SHALL 向上捲至中央，並依與中央距離連續 fade。

#### Scenario: 使用者匯入確認字幕

- **WHEN** 匯入有效 SRT
- **THEN** lyric preview 使用其 start time，MP4 export 使用相同 cue timing 與實際 audio analysis
- **AND** preview 保持無聲，不播放音訊，也沒有 scrubber

#### Scenario: Subtitle timing 存在 gap 或 overlap

- **WHEN** cue end time 通過或與其他 cue overlap
- **THEN** 只有下一 cue start 會改變 active lyric；end timestamp 不會清除歌詞

#### Scenario: 沒有字幕檔

- **WHEN** lyric template 沒有 imported cues
- **THEN** preview 可顯示明確標為範例的 lyrics，但 UI 與 worker 在提供真實字幕前拒絕 lyric export

#### Scenario: Replacement subtitle 無效或 stale

- **WHEN** replacement 無效，或其 read 在 project navigation／subtitle removal 後才完成
- **THEN** 無效 import 保留之前有效 cue，stale read 不修改目前 workspace

### Requirement: 設定輸出格式

系統 SHALL 允許使用者選擇 16:9、9:16、1:1 其中一種比例，720p、1080p、4K preset，以及 30 或 60 fps。Device capability check SHALL 判斷所選組合能否渲染。

#### Scenario: 使用者選擇有效輸出

- **WHEN** 使用者選擇允許的比例、解析度與幀率
- **THEN** 系統顯示 dimensions 與 capability status，且有效來源音訊就緒時啟用渲染

#### Scenario: 要求的輸出超過裝置能力

- **WHEN** 目前瀏覽器或裝置不支援所選解析度或幀率
- **THEN** 系統停用該選項的渲染，並說明 encoding path 不支援

### Requirement: 回報瀏覽器渲染能力

系統 SHALL 在 render 前檢查目前瀏覽器與裝置，並指出 requested video/audio encoding path 是否能產生可播放 MP4。

#### Scenario: Capability check 成功

- **WHEN** 瀏覽器支援 requested rendering/encoding combination
- **THEN** 系統允許渲染，並指出使用本機 browser rendering

#### Scenario: Capability check 失敗

- **WHEN** 瀏覽器不支援 requested combination
- **THEN** 系統阻止無效 render，說明缺少的 playable MP4 codec 或 muxing capability，讓使用者可改選 preset 或 browser

### Requirement: 不阻塞介面地渲染

系統 SHALL 在 background execution context 渲染，並 SHALL 提供 queued、rendering、completed、cancelled、failed 狀態，以及可量測時的 progress。

#### Scenario: Render 完成

- **WHEN** 使用者啟動有效 render 且成功完成
- **THEN** 系統標示 completed、提供 playable MP4 preview，並啟用 download

#### Scenario: 使用者取消 render

- **WHEN** 使用者取消進行中的 render
- **THEN** 系統停止渲染、標示 cancelled、釋放 temporary render resources，並保留 project configuration

#### Scenario: Render 失敗

- **WHEN** decoding、encoding、muxing、memory 或 device error 阻止完成
- **THEN** 系統標示 failed、顯示有用錯誤，且不將 partial file 呈現為 completed MP4

### Requirement: 產生可下載 MP4

系統 SHALL 將 rendered video 與 source audio 結合為可播放 MP4，其 dimensions、aspect ratio、frame rate 與 duration 在正常 encoder tolerance 內符合 project configuration。

#### Scenario: 使用者下載 completed output

- **WHEN** completed render 可用且使用者選擇 Download
- **THEN** 系統下載 generated MP4，不要求再次上傳 source audio

#### Scenario: 檢查 output metadata

- **WHEN** preview 或下載 completed MP4
- **THEN** media metadata 顯示所選 dimensions、frame rate 與 audio/video tracks
