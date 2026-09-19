# Quiet Editorial／靜謐唱片誌

[English](quiet-editorial.en.md)

Template ID：`quiet-editorial`。這是一種經過構圖的 listening-room 美學：封套是主體，攝影圖片建立氣氛，動態則克制地表達音樂。使用者上傳的兩張圖片都直接參與畫面。

## 構圖

- 橫式：左側為框裱封套，右側是兩行襯線標題與較小歌手文字，下方配置緊湊 frequency marks。
- 直式：較大的封套位於標題上方；artwork、文字與 frequency marks 之間保留充足空間。
- 方形：採較小封套與標題尺寸的緊湊堆疊構圖。
- 細 top rule 與「NOW PLAYING」標籤帶入構圖；下方 rule 顯示實際 track progress，含 elapsed 與 total time。

背景以 centered cover crop 填滿畫面。定向 dark scrim 保留原始色彩，同時支撐暖象牙文字。封套使用 contain fitting，即使上傳非方形圖片也保留完整比例。暖紙 mount 與 contact shadow 將封套和攝影背景分離。無需 color extraction、外部圖片、font 或 network call；缺圖時有設計過的中性 fallback。

## 動態

背景移動上限為 frame width 0.8%、frame height 0.6%，水平／垂直週期為 41／59 秒。53 秒 scale cycle 在 1.043 至 1.067 間變化；overscan 確保不露邊。不同週期可避免明顯短 loop。

封套與文字保持靜止。Low-frequency energy 只微調 mount 上緣照明。64 條窄 frequency marks 橫跨 text column 的 88%，一般高度不超過 short edge 9.5%；1.35 次方 response curve 壓低安靜段落並擴大高低 stroke 對比。2× reactive gain 讓一般動態更清楚，並在 accent boost 前限制於 full scale，保留 headroom、避免碰撞文字。

Artist credit 下方可用空間會限制長標題 compact layout 的高度。Detected accent 最多增加 50% reactive height，使用 55 ms eased attack 與 345 ms release。Layout 預留完整 accent range；方形封套稍小，直式 marks 位置更低。靜音時 marks 回到小 baseline。Progress rule 稍粗，以便 preview 尺寸仍清楚。

Frequency stroke 與 editorial rule 使用較重線寬。兩個 time label 採較大的 semibold monospace，各自置中於 timeline 端點，並在 timeline 下方固定高度 row 中垂直置中。Timeline 位於 frame height 92.5%，時間標籤和同一 group 一起移動；方形 marks 與抬高的 timeline 間保留間隔。沒有 particle、additive glow、flash 或節奏性 camera punch。

Audio feature 使用前 267 ms 的九個 weighted sample，並在 analysis row 間插值。有限、timestamp-based filter 在 seek 與不同輸出幀率下會產生相同 frame，不依賴前一次 render call。Peak response 約延遲 transient 130 ms，形成柔和 attack/release，而不是突然跳動。

Editor 是使用 synthetic looping audio feature 的動畫示範，不是上傳歌曲的 live audition。Demo loop 間背景時間保持連續。MP4 export 透過既有 worker pipeline 使用上傳歌曲實際、time-aligned 的 analysis 與 duration。

## 整合

既有 project schema 會保存新 template identifier 與兩個 image reference。Retired template identifier 讀取時會 migrate 至此模板，不移除圖片、文字或 generated output。預設 theme 為 dark；template editor 也支援 light palette 與 appearance controls。Preview 與 export 共用同一 scene factory。Canvas 2D 讓 worker 中的 scene 不需新增 graphics backend。

驗證涵蓋 image fit、靜止封套幾何、silence／energy response、project serialization，以及兩張圖片在三種比例 720p/30 fps 的 MP4 export/reopen，另含短版 16:9 4K/30 fps export。Browser checks 使用 synthetic artwork，不需要私人使用者素材。
