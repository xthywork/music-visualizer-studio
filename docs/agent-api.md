# AI Agent API

[English](agent-api.en.md)

此 API 讓 AI agent 或其他程式直接建立伺服器渲染工作，不需要網站 UI，也不提供或接受客戶端本機渲染模式。音訊分析、場景繪製與 MP4 編碼全都在 Music Visualizer 伺服器上完成。

服務沒有帳號、租戶隔離或 API key。僅應部署於可信任網路或 VPN；需要跨網路使用時，必須在 reverse proxy 提供 HTTPS 與驗證。

## 建立工作

使用 `POST /api/agent/render`，Content-Type 必須是 `multipart/form-data`。

- `request`：必要，JSON 字串。
- `audio`：必要，直接上傳 MP3、WAV 或 M4A。
- `cover`：選填，PNG、JPEG 或 WebP 封面圖。
- `background`：選填，PNG、JPEG 或 WebP 背景圖。

伺服器不支援 `audioUrl`，不會替呼叫端下載任意 URL。Agent 應先取得音訊檔，再以 multipart 上傳，避免 SSRF 與不受控的遠端下載。

```json
{
  "template": "quiet-editorial",
  "title": "Night Drive",
  "artist": "Example Artist",
  "aspectRatio": "16:9",
  "resolution": "4k",
  "frameRate": 60
}
```

- `template`：`quiet-editorial`、`paper-resonance`、`night-orbit`、`dawn-spectrum`、`panorama-lyrics` 或 `poetry-lyrics`。
- `title`：必要，1 至 300 字元。
- `artist`：選填，最多 300 字元。
- `aspectRatio`：選填，`16:9`（預設）、`9:16` 或 `1:1`。
- `resolution`：選填，`720p`、`1080p`（預設）或 `4k`。
- `frameRate`：選填，`30`（預設）或 `60`。
- `lyrics`：歌詞模板必要，元素為 `{ "start": 0, "text": "第一句" }`。
- `templateSettings`：選填，沿用網站的 template settings。

`renderMode`、`audioUrl` 與未列欄位皆會被拒絕。此端點固定使用並回傳 `server` 模式。

```bash
curl -fsS -X POST http://127.0.0.1:34388/api/agent/render \
  --form-string 'request={"template":"quiet-editorial","title":"Night Drive","artist":"Example Artist","aspectRatio":"16:9","resolution":"4k","frameRate":60}' \
  -F 'audio=@./song.m4a;type=audio/mp4' \
  -F 'cover=@./cover.jpg;type=image/jpeg'
```

成功的 `201` 回應包含 `renderMode: "server"`、巢狀 `job`，以及 `statusUrl`、`cancelUrl`、`outputUrl`、`deleteUrl`。

## 輪詢、取消、下載與刪除

```text
GET    /api/agent/render/{job_id}         讀取狀態
POST   /api/agent/render/{job_id}/cancel  請求取消
GET    /api/render-jobs/{job_id}/output   完成後下載 MP4
DELETE /api/agent/render/{job_id}         刪除工作與輸出
```

輪詢 `job.state` 至 `completed`，且只有 `job.outputAvailable` 是 `true` 時才下載 `outputUrl`。可用狀態為 `queued`、`running`、`completed`、`failed`、`cancelled`、`interrupted`。輸入素材與輸出的清理生命週期和網站伺服器渲染相同。

建立前可使用 `GET /api/render-capabilities` 確認 `ready: true`；worker 尚未就緒時會回傳 `503`。
