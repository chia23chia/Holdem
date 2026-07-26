# Holdem

線上德州撲克 · 朋友同樂 · 虛擬籌碼

線上位置:<https://alan-holdem.duckdns.org>

更新紀錄見 [CHANGELOG.md](CHANGELOG.md);架構 / 契約 / 設計決策見 [ARCHITECTURE.zh-TW.md](ARCHITECTURE.zh-TW.md)。

## 專案結構

```
Holdem/
├── web/                # Next.js 14 前端(App Router)
├── server/             # Node.js Socket.IO 遊戲後端
├── shared/             # 共享 TypeScript 型別(Card / Player / Socket events)
├── docker-compose.yml  # 開發時起 PostgreSQL
└── package.json        # pnpm workspace 根
```

## 技術棧

- **前端** Next.js 14 (App Router) + TypeScript + Tailwind CSS
- **後端** Node.js + Socket.IO (獨立 WebSocket server)
- **資料庫** PostgreSQL 16(dev 用 Neon 或本機 Docker;prod 用 Docker 自架於 Oracle VM)
- **認證** Auth.js v5 + Google OAuth
- **牌力判定** `pokersolver`,含正確 side pot 分池
- **部署** Oracle Cloud Free ARM A1.Flex + Docker Compose + Caddy(已上線)
- **選填**:房間結算可自動同步到外部 Google Sheet,見 [ARCHITECTURE.zh-TW.md §11.19](ARCHITECTURE.zh-TW.md)

## 本機開發前置

需要先安裝:

- **Node.js 22+** — https://nodejs.org/(`pnpm 11` 硬性要求,Node 20 會直接報錯)
- **pnpm 11**(`corepack enable` 或 `npm install -g pnpm@11`)
- **Docker Desktop** — 本機沒接 Neon 時用來跑 PostgreSQL

## 首次啟動

```powershell
# 1. 安裝所有 workspace 依賴
pnpm install

# 2. 複製 root env(給 docker compose 用)
Copy-Item .env.example .env

# 3. 起 PostgreSQL
pnpm db:up

# 4. 複製 workspace env
Copy-Item web/.env.example web/.env.local
Copy-Item server/.env.example server/.env

# 5. 同時啟動 web + server
pnpm dev
```

打開 <http://localhost:3000>:

1. 用 Google 帳號登入 → 進入大廳
2. 大廳右上角應顯示「已連線」
3. 開兩個瀏覽器視窗(不同 Google 帳號)測試聊天

## 常用指令

| 指令 | 作用 |
|---|---|
| `pnpm dev` | 同時起 web (3000) + server (3001) |
| `pnpm dev:web` | 只起 web |
| `pnpm dev:server` | 只起 server |
| `pnpm db:up` | 啟動 PostgreSQL(background) |
| `pnpm db:down` | 停 PostgreSQL(資料保留在 volume) |
| `pnpm db:logs` | 看 PostgreSQL log |
| `pnpm typecheck` | 全 workspace TypeScript 檢查 |

## 開發階段

- [x] **Phase 0** — 專案骨架、Socket.IO 連線測試
- [x] **Phase 1** — Google OAuth、大廳、房間建立/加入
- [x] **Phase 2** — 單桌現金局引擎(下注 / side pot / 超時 / 斷線重連 / hand log / rebuy)
- [ ] **Phase 3** — 房間聊天系統訊息(目前只有玩家聊天,無系統事件訊息)
- [ ] **Phase 4** — 錦標賽(SNG,盲注升級,淘汰制)
- [x] **Phase 5** — UI 打磨 + Oracle VPS 部署(已上線)

## 部署

已上線於 Oracle Cloud Always Free ARM A1.Flex,Docker Compose + Caddy(HTTPS)。詳細步驟見 [DEPLOY.md](DEPLOY.md);接手者快照見 [ARCHITECTURE.zh-TW.md 的「Handoff 快照」章節](ARCHITECTURE.zh-TW.md)。
