# 產品需求

[English](product-requirements.en.md)

## 產品目標

讓使用者設定專案，並選擇由伺服器或目前裝置產生精緻音樂視覺化影片：

```text
設定專案 → 選擇渲染位置 → 生成 → 預覽／下載 MP4
```

介面應減少不必要的決策，同時保留實用的輸出自訂能力。

## 使用流程

1. 在瀏覽器選擇音訊、模板、可選圖片與歌名／歌手，調整模板設定。
2. 選擇畫面比例、解析度及幀率，以及專案列表底部的伺服器／此裝置渲染位置；依所選模式檢查能力，不自動 fallback。
3. 伺服器模式將設定及本次素材上傳至單機佇列；此裝置模式在瀏覽器 Worker 內處理。
4. 顯示準備、排隊（伺服器）、渲染、完成、取消、失敗或中斷狀態及進度，並允許取消該次工作。
5. 依 render source 預覽與下載 completed MP4；重新載入時，server output 依 job identity 確認，client output 依 IndexedDB 實際 Blob 判定。
6. 專案設定與解析後字幕保存在瀏覽器本機；原始音訊不保存在專案，建立新工作時需重新選擇。

## 支援輸出

- 畫面比例：16:9、9:16、1:1
- 最高目標：4K、60 fps
- Resolution 選項依畫面比例限制，且需由目前選定模式的 capability check 接受。
- Server CPU 使用 Pillow 與 NumPy 分析音訊並逐幀繪製；NVIDIA NVENC 輸出 H.264 `yuv420p`，搭配 AAC 封裝成 MP4。
- 此裝置模式使用 AudioContext、Web Worker、WebCodecs 與客戶端 MP4 muxer；是否支援 4K60 由瀏覽器與裝置能力決定。

## 模板與編輯器

模板目錄使用緊湊的 2×2 網格；媒體區也是 2×2，音訊與 SRT 位於上排，封面與背景位於下排。左側 editor 可獨立捲動；render progress 與 Generate/Cancel 控制放在捲動區外的固定底列。窄螢幕上 editor 有高度上限，preview 接續顯示於下方。

選擇任何模板後，使用者可開啟設定並調整明／暗模式、強調色、動態強度、背景顯示與封面尺寸。每個模板在同一專案中各自保存設定。歌詞模板另提供文字大小、行距與相鄰行透明度。

### Paper Resonance／紙上聲景

明亮的印刷海報構圖，包含暖色紙張、攝影背景帶、完整置入的專輯封套、粗體無襯線標題與三條流動墨線。Bass、midrange、treble 分別驅動朱紅、石墨與細緻低彩度線條。支援三種畫面比例；任一圖片缺少時仍提供完整 fallback 構圖。詳見[視覺與動態設計](paper-resonance.md)。

### Quiet Editorial／靜謐唱片誌

以使用者上傳的攝影背景與固定、不裁切的專輯封面形成編輯設計構圖。暖中性色文字、精細 sleeve mount 與緊湊 frequency notation 建立清楚層級。橫式採雙欄，直式與方形採堆疊構圖。背景動態緩慢連續；頻率與 mount 光線會回應平滑化音訊能量。詳見[視覺與動態設計](quiet-editorial.md)。

### Panorama Lyrics／全景映像

滿版圖片舞台、緊湊專輯識別與半透明中央歌詞區。目前歌詞行穩定停在中央，相鄰行依距離漸淡。明／暗模式使用對應的攝影 scrim。

### Poetry Lyrics／留白詩頁

安靜的閱讀頁面，將襯線歌詞搭配全高攝影側欄。完整封套固定在 header。歌詞下方配置克制的 audio-reactive 墨線與置中時間。Ivory 與 charcoal 模式在橫式、直式、方形輸出都維持相同層級。

舊 Geometry Lyrics 專案重新開啟時會轉為 Poetry Lyrics，並保留設定與媒體。

Spectrum Cover 與 Vinyl Particle 已退役。使用任一 identifier（或舊 Abstract Pulse）的既有紀錄會以 Quiet Editorial 開啟，同時保留文字、圖片、render history 與 generated output reference。

### SRT 行為

歌詞模板在 export 前必須有有效 UTF-8 SRT。檔案上限 1 MiB、5000 cues，每個合併後 cue 最多 1000 字元。Cue 依起始時間排序；相同起始時間會合併成 multiline cue。結束時間必須是語法有效的 SRT timestamp，但不控制顯示或捲動。第一個 start 前沒有 active cue；每個 cue 持續至下一個 start（包括時間空隙），最後一個 cue 則持續至影片結束。

每次 start 後，歌詞會向上移動；接近或離開中央時 opacity 連續變化。Transition duration 會配合密集 start 自動調整。Multiline／CJK 內容會換行並縮小，以留在分配的 row 內。無效匯入不會破壞先前字幕。移除字幕後 lyric export 會停用；非歌詞模板不需要 SRT 也能渲染。

Editor 使用示範 audio feature 與無聲的定時歌詞 preview，不播放上傳歌曲，也不提供 scrubber。SRT 匯入前會顯示有標示的範例歌詞；範例不會 export 或 persist。實際 export 使用匯入的 cue start 與上傳音訊分析。

模板使用穩定、可序列化的 scene configuration，供伺服器 worker 與客戶端 render worker 生成正式輸出；編輯器內的即時模板示意本身不等於正式逐幀輸出。

## 專案紀錄

瀏覽器本機專案紀錄包含：

- 專案名稱與 timestamps
- Template identifier 與 template configuration
- 歌名與歌手文字
- 封面／背景圖片資料或 local reference，受 browser quota 限制
- 各模板解析後的字幕文字／起始時間與設定
- 畫面比例、解析度與幀率
- Render source、status 與錯誤資訊
- Server job/output reference，或 client output metadata／IndexedDB Blob reference

原始音訊 bytes、file metadata、絕對路徑與 file handle 不屬於 persisted project record。伺服器模式把本次需要的素材上傳至 job 暫存目錄並在終止後清除；此裝置模式只在目前頁面／Worker 使用來源。重新開啟專案後，建立新工作前必須再次選擇來源音訊。

Artwork 只接受 PNG、JPEG、WebP，不接受 SVG。超尺寸或不一致的 image header 與 decode failure 必須在素材進入 preview、worker 或 project persistence 前拒絕。

成功的 server MP4 保存在伺服器直到明確刪除；client MP4 在 quota 允許時保存於 IndexedDB。若 client persistence 失敗，當前分頁仍提供立即下載，但 reload 後必須標示未保存。刪除任一 output 時保留專案設定；不存在的輸出必須標示 unavailable。

## MVP 非目標

- 使用者帳號與團隊協作
- 公開分享連結
- 雲端專案同步
- 逐字歌詞動畫
- 16:9、9:16、1:1 以外的比例
- 保證每台裝置都能渲染 4K60
- 帳號、租戶、計費或公開 SaaS
- Server/client 自動 fallback 或 server output 自動過期
