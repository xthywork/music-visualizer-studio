# 字幕模板與編輯器控制

[English](subtitle-templates.en.md)

目前模板目錄包含 Quiet Editorial、Paper Resonance、Panorama Lyrics、Poetry Lyrics、Night Orbit、Dawn Spectrum。新增兩款為無字幕模板：夜航聲環採環狀音波，晨光頻譜採水平聲浪。兩個歌詞模板是獨立視覺方向，不是前兩個 scene 的修改版。

## 視覺方向

**Panorama Lyrics／全景映像** 以背景作為滿版攝影舞台，在 track identity 旁放置小型完整封套，中央為半透明歌詞區。置中構圖與克制的下方 spectrum 讓歌詞成為焦點。Dark mode 加深圖片；light mode 使用 ivory scrim。

**Poetry Lyrics／留白詩頁** 使用象牙或 charcoal 閱讀頁面與置中襯線歌詞。上傳背景填滿高直攝影側欄並幾乎不可察地漂移；完整封套與 track identity 固定於 header。歌詞下方有單條回應 low-frequency energy 的墨線，再以細 progress rule 與置中 monospace time 收尾。直式輸出會縮窄攝影側欄，保留閱讀空間。沒有旋轉形狀、particle 或 glow effect。

## 依起始時間捲動

Parser 每個 cue 只保留 `{ start, text }`。Start time 會排序，重複者合併，end timestamp 則刻意捨棄。Binary search 會選出指定 video timestamp 最近一次 start。歌詞不會因 SRT end time 清除，包括 instrumental gap 或最後一個 cue 之後。

每次 start 時，下一行以最長 450 ms 的 eased transition 向上移至中央；如果 start 很密集，duration 會縮短。前一 row 的 opacity 連續變化，不在 boundary 跳動。Opacity 在中央最高，距離越遠越低，並在 reading field 邊緣淡出。Multiline cue 使用固定 slot 並適配可用空間；line height 不會在 transition 中途改變 scroll distance。

Preview 與 worker 共用同一 scene 與 timeline function。Preview 無聲，使用 demonstration audio feature；匯入 SRT 後，會從第一個 cue 前不久開始並循環。沒有 music playback、editing timeline 或 scrubber。沒有 SRT 時，只有 preview 使用 sample lyrics，且會清楚標示為示範。UI 與 worker scene creation 都會拒絕沒有真實 cue 的 lyric export。

## 設定與 persistence

每個 project 會為各模板保存獨立 settings object。六個模板都支援 mode、accent、motion（0–5）、background visibility（20–100%）、sleeve size（65–100%），以及 sleeve X/Y displacement（canvas dimensions 的 −50–50%）。歌詞模板另支援 size（80–130%）、spacing（1.5–2.3）、surrounding-line opacity（15–65%）。Reset 只影響目前模板。設定會 validate、隨專案 serialize，並在 export 時 snapshot。

Poetry Lyrics 與 Paper Resonance 另支援 1–8 條 wave line、五種 curated multi-color palette（earth、coast、plum、forest、rose），以及 original/custom accent mode。攝影區保持靠右，寬度可調：Poetry 為 canvas 10–60%（直式乘 0.75），Paper 為原始攝影帶的 10–100%。Background zoom 為 1–3×；X/Y pan 可在不露出空白邊緣的前提下，移動 available crop 的 −100–100%。Cover offset 只移動 artwork 與 mount，不移動 track text。既有紀錄採中性預設值。Panorama spectrum 約佔 frame width 50%。

原始音訊保持 transient。解析後字幕與 image reference 留在瀏覽器本機。SRT source file 與 filename 不保存。Import gate 防止遲到的 subtitle read 修改另一個 project 或恢復已移除字幕。無效 replacement 會保留最後一組有效 cue。

Retired Spectrum Cover、Vinyl Particle、Abstract Pulse identifier 讀取時 migrate 至 Quiet Editorial；project media、metadata 與舊 output 不會刪除。Retired rendering implementation 與 catalog entry 已移除。Retired Geometry Lyrics migrate 至 Poetry Lyrics，保留 subtitle 與 per-template setting；若兩者設定同時存在，以既有 Poetry Lyrics 設定優先。
