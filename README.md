# cf-gateway-mcp

把一把 Cloudflare API token 放進你自己的 Worker，之後任何 agent 連上這個 MCP 就能操作 Cloudflare，不用每次重新拿 token。agent 也看不到 token 本身。

```
agent ──(存取密碼或 OAuth)──> 你的 Worker /mcp ──(API token)──> api.cloudflare.com
```

這個倉庫只有程式碼。每個人都部署到自己的 Cloudflare 帳號，放自己的 token。

> Cloudflare 官方也有 MCP：`https://mcp.cloudflare.com/mcp`，用 OAuth 登入，不用 API token，但每個 agent 要各授權一次。這個項目適合想只設定一次、並用 token 權限自己控制範圍的人。

## 安裝

需要 Node.js 20 以上和 Cloudflare 帳號（免費方案可用）。

```bash
git clone https://github.com/Nan7Li/cf-gateway-mcp.git
cd cf-gateway-mcp
npm install
npm run setup
```

`npm run setup` 會：

1. 請你登入 Cloudflare（需要時才開瀏覽器）
2. 請你貼上 API token（輸入時不顯示），驗證通過才繼續
3. 部署 Worker，產生隨機存取密碼，把兩者存成 Worker Secret
4. 確認伺服器能用，然後註冊到本機的 Claude Code、Codex、Gemini CLI、opencode（改動前會備份成 `*.cf-gateway.bak`）
5. 顯示 MCP 網址和存取密碼

**存取密碼只顯示這一次**，請存進密碼管理器。裝完要重開已經開著的 agent。

Token 在 [API Tokens 頁面](https://dash.cloudflare.com/profile/api-tokens)建立，**只開你需要的權限和 zone**，不要用 Global API Key。之後權限不夠，到同一頁編輯 token 就好，token 值不變，不用重新安裝。

或者用一鍵部署（之後仍要自己把 MCP 加進各 agent）：

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Nan7Li/cf-gateway-mcp)

`MCP_ACCESS_KEY` 要自己產生，至少 32 個字元，否則伺服器會拒絕所有請求：

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

## 連接其他 agent

把 `<網址>` 換成 `https://你的-worker.workers.dev/mcp`。

**只能填網址的客戶端（例如 claude.ai）：** 加入自訂連接器時只填網址，跳出授權頁後輸入存取密碼。授權頁會顯示申請者和回呼網域，不認得就不要批准。

**能設定標頭的客戶端：** 連 Streamable HTTP，加上標頭：

```
Authorization: Bearer <存取密碼>
```

## 工具

| 工具 | 作用 |
| --- | --- |
| `cloudflare_status` | 檢查 token 是否有效，列出帳號和預設 account ID |
| `cloudflare_request` | 呼叫任意 Cloudflare API |
| `cloudflare_deploy_worker` | 用 API 部署已打包的 Worker |

## 已知限制

- **本機的 `wrangler deploy` 用不了這個 MCP。** Worker 不會把 token 交出來。替代做法是在本機打包（`npx wrangler deploy --dry-run --outdir dist`），再用 `cloudflare_deploy_worker` 上傳。只支援文字模組，不支援 WASM 等二進位檔。
- **覆蓋現有 Worker 時，`keep_bindings` 要自己指定**，例如 `["secret_text"]`，否則原有的 Secret 會被移除。
- **回應上限約 20 萬字元**，超過會截斷；請用 `per_page` 或篩選條件縮小範圍。二進位回應不適用。
- **只有一把 token**，不支援多 token 或多使用者。

## 安全

**拿到存取密碼，就等於擁有這把 token 的所有權限。** 這個項目的保護範圍如下：

- token 只存在 Worker Secret，不會出現在回應、錯誤訊息或 agent 設定檔裡。回應中的 token 和存取密碼字串都會被遮蔽。
- 請求只會送到 `api.cloudflare.com/client/v4`，並拒絕 `..`、完整網址，也不跟隨轉址。
- 缺少任一 Secret，或存取密碼太短時，伺服器一律回 503。
- 驗證失敗和 OAuth 註冊會按 IP 限流。

做不到的事：

- 存取密碼會以**明文**存在各 agent 的設定檔，這是這些 agent 的存放方式。
- `*.workers.dev` 網址是公開的，可能被掃到，靠的是存取密碼和限流。
- agent 能做的事只受 token 權限限制。如果 token 有 Workers 編輯權限，agent 也能改掉這個 MCP 自己，進而取得 token。

存取密碼疑似外洩時，換一把：

```bash
npm run rotate-key
```

這會更新本機 agent，並讓所有舊密碼和 OAuth 授權立刻失效。如果懷疑 Cloudflare token 本身外洩，到 dashboard 撤銷它，再跑一次 `npm run setup`。

## 移除

```bash
npx wrangler delete
```

然後到 Cloudflare 撤銷 token，並刪除 OAuth 用的 KV namespace（名稱含 `cf-gateway-mcp`）。各 agent 設定檔裡名為 `cf-gateway` 的項目要自己刪：`~/.claude.json`（或 `claude mcp remove cf-gateway -s user`）、`~/.codex/config.toml`、`~/.gemini/settings.json`、`~/.config/opencode/opencode.json(c)`。

## 開發

```bash
npm run typecheck
```
```bash
npm test
```
```bash
npm run test:e2e
```

`test:e2e` 用真的 `wrangler dev` 和假的 Cloudflare API 跑完整流程，全部是假資料，不會連到你的帳號。

## 授權

[MIT](LICENSE)
