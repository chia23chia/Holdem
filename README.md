# Holdem

線上德州撲克 · 朋友同樂 · 虛擬籌碼

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
- **資料庫** PostgreSQL 16(dev via Docker,prod 之後 self-host 於 Oracle VPS)
- **認證** Phase 0 mock nickname / Phase 1 Auth.js + Google OAuth
- **牌力判定** `pokersolver`(Phase 2 引入)
- **部署** Oracle Cloud Free ARM A1.Flex + Docker Compose + Caddy(Phase 5)

## 本機開發前置

需要先安裝:

- **Node.js 20 LTS** — https://nodejs.org/
- **pnpm 9+** — `npm install -g pnpm`
- **Docker Desktop** — 只為了跑 PostgreSQL

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

1. 輸入暱稱 → 進入大廳
2. 大廳右上角應顯示「已連線」
3. 開兩個瀏覽器視窗(不同暱稱)測試聊天

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

- [x] **Phase 0** — 專案骨架、mock 登入、Socket.IO 連線測試
- [ ] **Phase 1** — Google OAuth、大廳、房間建立/加入
- [ ] **Phase 2** — 單桌現金局引擎(下注 / 邊池 / 超時)
- [ ] **Phase 3** — 房間聊天室(升級 Phase 0 的 broadcast 為 room-scoped)
- [ ] **Phase 4** — 錦標賽(SNG,盲注升級,淘汰制)
- [ ] **Phase 5** — UI 打磨 + Oracle VPS 部署

## 部署(Phase 5,尚未執行)

目標:Oracle Cloud Always Free ARM A1.Flex(2 OCPU / 12GB / Osaka),沿用 Trade 專案的 systemd + `~/.ssh/id_rsa` + OCI Resource Manager 流程。
