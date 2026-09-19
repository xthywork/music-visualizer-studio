# 儲存與隱私

[English](storage-and-privacy.en.md)

## 資料流

```text
瀏覽器本機保存：專案設定、模板設定、解析後的字幕 cue、job/output reference
                         |
             建立工作時上傳音訊、所需圖片與字幕
                         v
伺服器隔離的 job 暫存目錄
  |-- 音訊分析與 CPU 場景渲染期間使用
  |-- 完成、失敗、取消或確認中斷後清除來源素材與中間檔
  +-- 完成 MP4 留存在伺服器，直到明確刪除
```

正式渲染發生在伺服器。瀏覽器只在使用者建立工作時上傳本次所需素材，並負責設定、狀態查詢、取消、預覽及下載。伺服器以 SQLite 保存 job 狀態；完成 MP4 保存在伺服器輸出目錄，預設沒有自動期限或自動刪除。

## 瀏覽器本機資料

專案紀錄可包含專案名稱、模板與輸出設定、歌名／歌手、圖片資料、解析後的字幕 cue、各模板外觀設定、render history，以及 server job identity 和 last-known status/output availability。Server reference 是狀態查詢依據，不代表輸出仍存在；重新開啟專案會向伺服器確認。

原始 SRT bytes、檔名與 cue end time 不保存；解析後的字幕文字與 start time 可留在專案設定中。來源音訊不會保存於專案，重新開啟專案後建立新工作須重新選擇音訊。瀏覽器本機儲存可能因清除網站資料、瀏覽器政策或 quota eviction 而遺失，不是備份。

## 伺服器暫存與完成輸出

建立工作時，音訊、工作需要的封面／背景圖片及 SRT 會上傳至隔離的暫存目錄。伺服器驗證後使用這些素材渲染；工作進入 completed、failed、cancelled 或 confirmed interrupted 時，來源上傳及中間檔都會清除。取消或失敗不會留下可供下載的 partial MP4。

成功完成的 MP4 依單機伺服器保存，直到使用者明確刪除輸出／工作或管理者明確清理。刪除 server output 不會刪除瀏覽器內的專案設定；若輸出已不存在，UI 顯示 unavailable，且可在重新選取來源音訊後建立新工作。管理者應監控儲存空間並主動刪除不再需要的輸出。

## 存取範圍

服務未提供登入、帳號或租戶隔離。只在可信任網路或 VPN 提供服務；如需跨網路存取，使用具有 HTTPS 和 authentication 的 reverse proxy。此服務不應直接公開到 Internet，也不是 public SaaS。
