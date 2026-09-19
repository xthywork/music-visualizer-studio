# Paper Resonance／紙上聲景

[English](paper-resonance.en.md)

Template ID：`paper-resonance`。

## 視覺方向

現代印刷音樂海報：暖象牙紙、朱紅墨色、深石墨文字、攝影帶與重疊的專輯封套。粗體無襯線標題與寬闊流動輪廓建立獨立的層級與節奏；使用者上傳的兩張圖片是主要視覺素材。

背景圖片以 proportional crop 填滿內縮橫向帶，並加入些微暖色調。封套重疊其下緣，置於淡色紙張 mount 上；contain fitting 即使遇到長方形 artwork 也保留完整圖片。封套保持靜止。缺少任一圖片時，折紙形狀與簡潔印刷封套會提供有意識的 fallback。

橫式使用偏移封套與旁邊的大標題；直式把封套置中放在寬標題區上方；方形維持緊湊的封套／標題並排構圖。標題支援中文與拉丁文字，可換成兩行，溢出則省略；歌手文字維持單行。

上方「SOUND / STUDY」masthead、紅色 registration rule 與下方 progress line 形成一致印刷語彙。時間標籤使用 semibold monospace，置中於 timeline 兩端。紙張碎點是固定、低透明度 texture，不是移動粒子。模板不需要外部 font 或 bundled bitmap artwork。

## 動態

三層墨線分工明確：朱紅 bass contour、石墨 midrange contour，以及更細的 treble echo。三者共用 baseline，兩端逐漸收細，使構圖穩定、中央流動。曲線是能量驅動的插畫形式，不是逐點 PCM oscillogram。

Audio feature 會在 analysis row 間插值，並對跨越 200 ms 的七個 weighted sample 取平均。已平滑的 audio envelope 控制曲線高度；偵測到的 beat 只輕微加強輪廓。有限插值與 absolute timestamp 讓 seek 與不同 frame rate 產生 deterministic frame。靜音時線條趨平；振幅受上方文字與下方 progress line 限制。

只有固定攝影帶內部的 source crop 會移動，水平／垂直週期分別為 47／61 秒。4% overscan 確保 crop 不露出圖片邊界。沒有封面彈跳、glow、RGB separation、閃光或快速鏡頭運動。

Editor 會標示其 synthetic motion loop 為示範。MP4 export 透過相同 scene factory 與 worker pipeline，使用上傳音訊的實際分析。

## 驗證

Unit checks 涵蓋靜止且不變形的封套、三種比例下有邊界的 moving background crop、deterministic contour、靜音反應、文字安全距離、template registration，以及兩個 image reference 的 persistence。Browser checks 使用 synthetic artwork 與短 WAV，在三種比例下 export、download、reopen 720p/30 fps，並測試 16:9、4K/30 fps。
