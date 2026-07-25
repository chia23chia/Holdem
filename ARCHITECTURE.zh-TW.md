# Holdem — 架構文件

Holdem 專案的深度參考文件。README 負責入門(如何啟動),本檔負責描述程式碼結構、契約與設計決策。有架構性變動(新事件、新 model、新 endpoint、新踩坑)才更新。

最後更新:2026-07-25(Phase 2 全部子 milestone 完成、Phase 5 已上線、play-money + rebuy 剛實作)

---

## Handoff 快照(給接手者)

- **線上位置**:`https://alan-holdem.duckdns.org`(Oracle Free ARM,`217.142.252.51`,ubuntu 帳號)
- **SSH**:`ssh -i ~/.ssh/id_rsa ubuntu@217.142.252.51`(私鑰在原機器 + trade-bot 部署機器,新機器要手動搬 `~/.ssh/id_rsa`)
- **VM 專案位置**:`~/Holdem`(git clone 自 `https://github.com/chia23chia/Holdem.git`,已 pull 到 c42b897 之後的 commits — 見 git log)
- **VM 環境檔**:`~/Holdem/.env.prod`(chmod 600,不進版控;新機器**不需要**改這個,只有 VM 才有)
- **共存**:同一台 VM 還跑著 trade-bot(systemd timer,不佔 port,無衝突)
- **DB**:Postgres 16 in Docker(`holdem-postgres` container),資料 volume `holdem_postgres_data`
- **DuckDNS token**(短期需要)`32f4f4bf-e479-4e3b-abba-a5f139123413`

### 部署更新流程(新機器上手可跑)

```powershell
# 本地 push
cd D:\Alan\project\Holdem
git add -A && git commit -m "..." && git push
```

```bash
# VM 上 pull + rebuild
ssh -i ~/.ssh/id_rsa ubuntu@217.142.252.51
cd ~/Holdem
git pull
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --build
docker compose -f docker-compose.prod.yml --env-file .env.prod logs -f --tail=50
```

### 現況(2026-07-25)

- ✅ Phase 1-2 全部完成(OAuth、lobby、rooms、game engine 含下注/showdown/side-pot-simplified/timeout/reconnect/hand-log/rebuy)
- ✅ Phase 5 已實際部署,`https` 拿到 Let's Encrypt,Google OAuth prod client 已加 `alan-holdem.duckdns.org` callback
- ⏳ **剛實作但未部署**:play-money 模式 + rebuy + 結算輸贏欄(要 push + pull + rebuild 才會在 prod 生效)
- ❌ 未做:Phase 3 chat 系統訊息、Phase 4 SNG、Milestone 2.2c side pot、雲端手牌 log 匯出、跨房 chipsBalance 追蹤

### 已知踩過的坑(避免重蹈)

- pnpm 11 需要 Node 22(Dockerfile 已改)
- Prisma 需要 Alpine 裝 openssl(Dockerfile 已改)
- Auth.js v5 prod 需要 `trustHost: true`(auth.config.ts 已改)
- Google OAuth 「電腦」類型 client 不能用在域名,要建「網頁應用程式」類型
- OCI Security List 要記得開 80/443 ingress,host UFW 也要
- Windows PowerShell 沒 pnpm 時 Claude sandbox 也沒(靠 user shell)
- `docker compose logs` 也要帶 `--env-file`

---

## 1. 目標與範圍

私人朋友圈線上德州撲克;虛擬籌碼、無真錢。純 Web(不做 native)。UI 繁體中文,程式碼識別字用英文。單桌 2–10 人。含現金局與 SNG 錦標賽(Phase 4)。

部署目標:單台 Oracle Cloud Free ARM VM(Osaka),Docker Compose + Caddy。開發用 Neon Postgres,正式環境自架 Postgres(Phase 5 決定)。

---

## 2. 專案結構

Monorepo,pnpm workspaces。全 TypeScript + ESM。

```
Holdem/
├── web/       # Next.js 14 App Router — UI、Auth.js、REST API
├── server/    # 獨立 Node.js Socket.IO server — 大廳/房間即時通訊
├── shared/    # 跨 package TS 型別(Socket 事件、wire shape、Card)
├── db/        # Prisma schema + PrismaClient singleton
├── docker-compose.yml   # dev Postgres
└── package.json         # workspace scripts (dev / db:* / typecheck)
```

### 2.1 Workspace 依賴圖

```
web  ──依賴──► shared, db
server ──依賴──► shared, db
db  ──依賴──► @prisma/client
shared ──(無依賴)
```

`shared` 與 `db` 是**原始碼直連**(`main: ./src/index.ts`),consumer 拿到改動不用先 build — 但 Next.js 對 `middleware.ts` 相關檔案有時需要重啟。

### 2.2 各 package 摘要

| Package | Runtime | 用途 |
|---|---|---|
| `web` | Node(Next.js)+ Edge(僅 middleware) | UI、Auth.js、REST endpoint、socket-token 發放 |
| `server` | Node(dev 用 tsx watch,prod 用 tsc→node) | Socket.IO server、lobby + room + chat + game(`hands.ts`、`deck.ts`) |
| `shared` | —(只有型別) | Wire 型別(`ClientToServerEvents`、`RoomDetail`、`Card`、`HandStatePublic` …) |
| `db` | Node | PrismaClient singleton、`Prisma` re-export、型別 re-export |

---

## 3. 技術棧

| 層 | 選型 | 備註 |
|---|---|---|
| 前端 | Next.js 14 (App Router) + React 18 + Tailwind 3 | lobby / room 都是 Client Component |
| 後端 | Node.js + Socket.IO 4(long-lived process) | **不是 serverless** — Auth.js JWT 跨 process 靠 `NEXTAUTH_SECRET` 一致 |
| DB | PostgreSQL 16 | Dev:Neon(雲端)透過 `DATABASE_URL`;或本機 Docker `docker-compose up postgres` |
| ORM | Prisma 5.22 | 用 `db push` 流程(無 migrations 目錄);schema 是唯一真相 |
| 認證 | Auth.js v5(beta.22)+ Google provider | JWT session、Prisma adapter |
| 牌力判定 | `pokersolver`(server 端) | Milestone 2.2 引入,無官方 types,自寫 `server/src/pokersolver.d.ts` ambient 宣告 |
| 套件管理 | pnpm 11 workspaces | `pnpm-workspace.yaml` 明列 `allowBuilds` |
| Runtime 工具 | `tsx watch`(server dev)、Next dev server | prod:`tsc` build + `node --env-file` |

尚未引入:Caddy + Docker Compose 部署(Phase 5)。

---

## 4. Runtime 拓撲(dev)

```
Browser ─┬─ HTTP  ────────────► web (Next.js) :3000
         │                          │  (認證、REST /api/*、靜態檔)
         │                          ▼
         │                        Neon Postgres(或本機 Docker Postgres)
         │                          ▲
         └─ WebSocket ────────► server (Socket.IO) :3001
                                    │
                                    └─ Prisma → 同一個 Postgres
```

- Web(`:3000`)負責 OAuth、session cookie、所有 `/api/*`
- Server(`:3001`)接受 WebSocket 握手,browser 從 `GET /api/socket-token` 拿短效 JWT
- 兩個 process 共用 `NEXTAUTH_SECRET`,所以 JWT 能跨 process 簽/驗
- 兩個 process 共用 `DATABASE_URL`(web REST 寫入 + server socket 事件寫入都到同一個 DB)

---

## 5. 資料模型(Prisma)

`db/prisma/schema.prisma`。所有 PK 都是 cuid 字串。

### 5.1 User(Auth.js + 領域欄位)

| 欄位 | 型別 | 可空 | 備註 |
|---|---|---|---|
| `id` | String (cuid) | PK | 所有地方的 session.user.id 都指這個 |
| `name` | String? | ✓ | Google 註冊時的顯示名,不編輯 |
| `nickname` | String? UNIQUE | ✓ | 使用者可編輯的暱稱;NULL 時 fallback 到 `name` |
| `email` | String? UNIQUE | ✓ | Google email |
| `emailVerified` | DateTime? | ✓ | Auth.js 標準欄位 |
| `image` | String? | ✓ | Google 頭像 URL |
| `chipsBalance` | Int DEFAULT 10000 | | 桌外總籌碼 |
| `createdAt` | DateTime DEFAULT now() | | |

關聯:`accounts[]`、`sessions[]`、`ownedRooms[]`(Room.RoomOwner)、`memberships[]`。

**顯示名規則**(任何顯示玩家身份的地方):
`nickname ?? name ?? 'unknown'`。`nickname` 唯一性由 DB 層強制(Postgres 允許多個 NULL,只有非 NULL 值才會衝突)。

### 5.2 Room

| 欄位 | 型別 | 備註 |
|---|---|---|
| `id` | String (cuid) PK | |
| `name` | String | 建房 API 強制 ≤40 字元 |
| `ownerId` | String | FK → User.id |
| `maxPlayers` | Int DEFAULT 9 | 2–10 |
| `smallBlind` | Int DEFAULT 5 | |
| `bigBlind` | Int DEFAULT 10 | 必須 ≥ 2× smallBlind |
| `buyIn` | Int DEFAULT 1000 | 必須 ≥ 20× bigBlind |
| `status` | Enum `waiting`/`playing`/`closed` | Phase 1 只會 `waiting` → `closed`;`playing` 是 Phase 2 |
| `sessionMinutes` | Int? | Session 長度(分),建房時由用戶選 30/60/90/120。目前 API 強制必填,schema 保留 nullable 給未來擴充 |
| `sessionEndsAt` | DateTime? | 建房時 NULL(還沒開始);房主第一次按「開始牌局」時 server 寫入 `now + sessionMinutes`。之後不再更動。掃描器只掃 sessionEndsAt < now 且非 NULL 的房 |
| `actionTimeoutSeconds` | Int DEFAULT 30 | 每人每手行動秒數,建房時由用戶選 15/30/60,整局固定不變。`game:start` 每次都從 Room 讀,client 不再傳 param(避免每手都問) |
| `createdAt` | DateTime | |

索引:`(status, createdAt)` 給 lobby 列表查詢用。

### 5.3 Membership(玩家在某房間就座)

| 欄位 | 型別 | 備註 |
|---|---|---|
| `id` | String (cuid) PK | |
| `userId` | String | FK → User(CASCADE) |
| `roomId` | String | FK → Room(CASCADE) |
| `seat` | Int | 1..maxPlayers |
| `chipsAtTable` | Int | 桌上籌碼(play money;seat 時 = buyIn,每 rebuy +buyIn,牌局結束由 persistHandResult 更新) |
| `totalBuyIn` | Int DEFAULT 0 | 累計買入(初始 buyIn + 所有 rebuys),用來算 settlement 輸贏 = chipsAtTable - totalBuyIn |
| `joinedAt` | DateTime | |

Unique 約束:`(userId, roomId)`(同一玩家在同一房只能坐一個位)+ `(roomId, seat)`(同一座位只能坐一人)。

### 5.4 HandLog(Milestone 2.6)

| 欄位 | 型別 | 備註 |
|---|---|---|
| `id` | String (cuid) PK | |
| `roomId` | String | FK → Room(CASCADE) |
| `handNumber` | Int | 該房間內序號,從 1 開始;server 在 `game:start` 前 `count + 1` 決定 |
| `startedAt` | DateTime | 手牌開始時 |
| `endedAt` | DateTime | 寫入時 |
| `data` | Json | 完整快照:startedAt/endedAt/dealerSeat/blinds/actionTimeoutSeconds/players (含 startingChips + finalChips)/history/endResult(照 shared 的 `HandLogData` 型別) |

Unique 約束:`(roomId, handNumber)`。索引:`(roomId, handNumber)`。

隱私:`endResult.revealedHoles` 只含 showdown 揭牌 + 自願秀牌者;蓋牌沒秀的 hole cards **不寫進 log**(muck stays muck)。

### 5.5 Auth.js 相關 tables

`Account`、`Session`、`VerificationToken` — Auth.js Prisma-adapter 標準 shape。用 JWT strategy 但 `Session` 表保留(以後如果要切換 session strategy 時省事)。

---

## 6. 認證流程

**Split-config 模式**(Auth.js v5 + Prisma + Edge middleware 的必要模式,否則 middleware 會噴 "PrismaClient is not configured to run in Edge Runtime"):

| 檔案 | Runtime | 內容 |
|---|---|---|
| `web/lib/auth.config.ts` | Edge 安全 | Providers、session strategy、pages — **不含 adapter、不含 DB callback** |
| `web/lib/auth.ts` | Node | 完整設定:adapter + DB-backed jwt/session callback;spread `auth.config` |
| `web/middleware.ts` | Edge | 自己建一個 `NextAuth(authConfig)` — 只檢查 `req.auth` 有沒有值 |

兩個 instance 共用 `NEXTAUTH_SECRET` 與 cookie 名稱,所以 Node instance 寫的 JWT 能被 Edge instance 讀,反之亦然。

### 6.1 登入序列

```
1. GET /                 → app/page.tsx 未登入時顯示「Sign in with Google」
2. 點按 → signIn('google', { callbackUrl: '/lobby' })
3. Auth.js 導向 Google → 使用者同意 → 回到
   /api/auth/callback/google
4. Auth.js PrismaAdapter upsert User + Account
5. jwt callback 觸發(帶 `user`)→ 查 nickname → token.name = nickname ?? name
6. session callback 把 token.sub 展成 session.user.id、token.name 展成 session.user.name
7. 導向 /lobby(middleware 看到 req.auth truthy,放行)
```

### 6.2 Socket 握手

```
Browser(lobby / room 頁):
  1. connectSocket() 呼叫 GET /api/socket-token
  2. web/app/api/socket-token/route.ts:
      - await auth() → session.user.{id,name}(name 是最新 nickname,經 jwt callback DB 讀)
      - jwt.sign({ sub: id, name }, NEXTAUTH_SECRET, { expiresIn: '5m' })
      - return { token }
  3. io(SOCKET_URL, { auth: { token } })
Server(server/src/auth.ts authMiddleware):
  4. jwt.verify(token, NEXTAUTH_SECRET) → SocketTokenPayload
  5. socket.data.user = { userId: payload.sub, name: payload.name }
  6. 所有後續 event handler 從 socket.data.user 拿身份
```

**副作用**:改暱稱後,socket 只有下次 `connectSocket()`(disconnect + reconnect)才會拿到新名字。Lobby 頁在 PATCH 成功後用 `window.location.reload()` 強制觸發。

### 6.3 JWT callback DB fetch(設計決策)

`auth.ts` 的 `jwt` callback **每次 JWT 讀取都會** call `prisma.user.findUnique`(任何 `auth()` 呼叫都會)。每個 request 一次 DB query,拿最新 coalesce 後的 nickname。

**為什麼**:Auth.js v5 beta 的 `useSession().update()` 不穩(實測 F5 也拉不到新 nickname)。每次都撈 DB → 沒有 cache staleness、client 也不用寫額外邏輯。預期同時線上 < 20 人,cost 可接受。

**只在 Node runtime**(`auth.ts`)有這個行為 — Edge middleware 用 `auth.config`,那邊 callback 是預設 no-op,不會呼叫 Prisma。

---

## 7. Socket.IO 事件契約

型別全在 `shared/src/index.ts`。Server:`Server<ClientToServerEvents, ServerToClientEvents>`。Client:`io<ServerToClientEvents, ClientToServerEvents>`。

### 7.1 Server → Client

| 事件 | Payload | 廣播對象 | 用途 |
|---|---|---|---|
| `connection:ok` | `{userId, name}` | 這個 socket | 握手成功 |
| `connection:error` | `{message}` | 這個 socket | 握手失敗(JWT 壞) |
| `lobby:rooms` | `RoomSummary[]` | 訂閱者(加入 `lobby` channel) | 初始 + 完整刷新 |
| `lobby:room-updated` | `RoomSummary` | `lobby` channel | 建房 / 座位變動 |
| `lobby:room-removed` | `{roomId}` | `lobby` channel | 房間關閉 |
| `room:detail` | `RoomDetail` | `room:<id>` channel | 完整房間細節含座位 |
| `room:error` | `{message}` | 這個 socket | 例如「房間不存在」 |
| `room:closed` | `{roomId, settlement?}` | `room:<id>` channel | 房間關閉(房主或 session 到期);若有 `settlement` client 顯示結算 modal 再導回 lobby |
| `chat:message` | `ChatMessage` | `room:<id>` 或 `lobby` | 房內或大廳聊天 |
| `game:started` | `HandStatePublic` | `room:<id>` channel | 新一手發牌(含 `dealerSeat`、`actionTimeoutSeconds`、`players[]`、`currentBet` 等);晚訂閱者透過 `room:subscribe` 補收到 |
| `game:state` | `HandStatePublic` | `room:<id>` channel | 每次 action / 街轉換後廣播的新公開狀態(含 `deadline` epoch ms) |
| `game:hole` | `HandStatePrivate` | 單一 socket | 該座位玩家的私人手牌 + 當前最佳牌型;每次翻公共牌後 server 會**重推**讓 handRank 更新 |
| `game:action-log` | `ActionLogEntry` | `room:<id>` channel | 每次玩家 action 後推一筆(seat、name、phase、actionType、amount);client 累積成本手動作紀錄,`game:started` 時清空 |
| `game:ended` | `{roomId, result?}` | `room:<id>` channel | 手牌自然結束時帶 `result`(winners + hole reveal + handRank);manual `game:end` 不帶 result 直接清狀態 |

### 7.2 Client → Server

| 事件 | Payload | Ack | Handler 動作 |
|---|---|---|---|
| `lobby:subscribe` | — | — | 加入 `lobby` channel、emit 初始 `lobby:rooms` |
| `lobby:unsubscribe` | — | — | 離開 `lobby` channel |
| `room:join` | `{roomId, seat?}` | `JoinRoomResult` | `seatUser`(扣 buyIn);`seat` 省略 = 自動找第一個空位;`seat` 給 = 指定座位(被佔會回錯誤) |
| `room:leave` | `{roomId}` | — | **僅離開 socket channel**;座位/Membership/chipsAtTable **不動**(session 內可回來繼續)。真的要退出座位要 `room:standup` |
| `room:subscribe` | `{roomId}` | — | 加入 `room:<id>` 當觀戰(不需要 membership)、emit `room:detail` |
| `room:standup` | `{roomId}` | — | Unseat(刪 Membership,play money 模式**不退回**任何餘額),保留訂閱變觀戰;手牌進行中拒絕;若空房自動關閉。不依賴 socket-local 狀態,DB Membership 為準 |
| `room:rebuy` | `{roomId}` | `GameActionResult` | 加碼 `room.buyIn` 到 `chipsAtTable` + `totalBuyIn`。手牌**中** queue 到 `pendingRebuysByRoom` map,`broadcastAfterAction ended` 時 drain 進 DB;手牌**外**立即寫入 DB + 廣播 |
| `room:close` | `{roomId}` | `CloseRoomResult` | `ownerCloseRoom`(驗權 + 全部退籌 + status=closed)、廣播 `room:closed` |
| `game:start` | `{roomId}` | `GameActionResult` | 只有房主;server 從 Room 讀 `actionTimeoutSeconds`;發手牌給就座玩家(≥2 人)、廣播 `game:started` + 私人 `game:hole` |
| `game:end` | `{roomId}` | `GameActionResult` | 房主 debug;強制清掉 hand state、廣播 `game:ended`(不帶 result) |
| `game:action` | `{roomId, action}` | `GameActionResult` | 當前輪到的玩家送 fold / check / call / raise{amount} / all-in;server 更新 HandState、廣播 `game:state`;若手牌結束則存 chips 到 Membership + 廣播 `game:ended` {result} + 新的 `room:detail` |
| `game:show-cards` | `{roomId}` | — | 手牌結束後任何曾在該手的玩家(含 fold 者)自願秀牌;server 更新 `endResult.revealedHoles` 加該人的手牌 + handRank(重複呼叫或已被揭露 no-op),再次廣播 `game:ended` {result 更新} |
| `chat:send` | `{roomId\|null, text}` | — | Sanitize、emit `chat:message` 到房間或大廳 |

### 7.3 Disconnect 清理

`socket.on('disconnect')` 如果有 `seatedRoomId` 就呼叫 `handleLeave`。因為 client 端 cleanup 也會 emit `room:leave`(在 `useEffect` return 裡),所以 `unseatUser` **必須 idempotent** — 用 `deleteMany` + 只在 `count === 1` 才退籌實作。

---

## 8. REST API endpoint

全在 `web/app/api/` 底下。Auth = 需要透過 `await auth()` 拿到 `session.user.id`。

| Method | Path | Auth | 用途 | Response |
|---|---|---|---|---|
| GET/POST | `/api/auth/[...nextauth]` | — | Auth.js handlers(signin、callback、session、csrf) | Auth.js 標準 |
| GET | `/api/auth/session` | — | 當前 session;JWT callback 觸發(DB 讀 nickname) | `{user:{id,name,...}}` or `{}` |
| GET | `/api/socket-token` | ✓ | 簽 5 分鐘 JWT 給 socket 握手 | `{token}` |
| GET | `/api/rooms` | — | 列出開放房間(waiting/playing) | `{rooms: RoomSummary[]}` |
| POST | `/api/rooms` | ✓ | 建房(驗證名字、盲注、buyIn、sessionMinutes ∈ {30,60,90,120}、actionTimeoutSeconds ∈ {15,30,60},皆必填預設 30) | `{id}` 201 |
| PATCH | `/api/user/nickname` | ✓ | 改暱稱(trim、≤100 字元、唯一) | `{nickname}` / 409 撞名 |
| GET | `/api/rooms/:id/hands` | ✓ | 該房間的 HandLog 歷史(newest first, limit 200) | `{hands: [{id, handNumber, startedAt, endedAt, data}]}` |

### 8.1 驗證規則

- 建房:`name` 非空 ≤40 字元、`2 ≤ maxPlayers ≤ 10`、`bigBlind ≥ 2×smallBlind`、`buyIn ≥ 20×bigBlind`、`sessionMinutes` 必填 ∈ {30,60,90,120}(預設 30)、`actionTimeoutSeconds` 必填 ∈ {15,30,60}(預設 30)
- 暱稱:trim 後非空、≤100 字元(DB 防呆硬上限);不做內容過濾(朋友圈);DB unique index → 撞名回 409

---

## 9. 房間生命週期

```
[建房]        POST /api/rooms → status: waiting、ownerId 設好、
                sessionMinutes 記錄、sessionEndsAt = NULL(未開始)
                ↓  廣播 lobby:room-updated

[進房]        socket room:subscribe → 加入 room:<id> channel 當觀戰
                (無 membership、不扣 buyIn)
                ↓  emit room:detail

[選座就坐]    socket room:join {seat?} → seatUser tx:檢查 status、
                座位、buyIn;扣 chipsBalance;insert Membership
                ↓  廣播 lobby:room-updated + room:detail

[站起]        socket room:standup → unseatUser tx(退籌 + 刪 Membership);
                保留訂閱(仍是觀戰);
                ↓  finalizeRoomState → 空房:closeRoom + room:closed,
                   否則:廣播 lobby + detail

[玩家離開]    socket room:leave(或 disconnect)→ handleLeave:
                unseatUser(退籌)+ 離開 room channel;
                ↓  finalizeRoomState(同 standup)

[房主關房]    socket room:close → ownerCloseRoom tx:
                驗證 ownerId;若 status=playing 拒絕;
                先 snapshot memberships(給結算用)然後
                全部 Membership 退籌 + 刪除;status=closed
                ↓  廣播 room:closed {settlement}(結算 modal → lobby)
                ↓  廣播 lobby:room-removed

[房主首次開牌局] game:start handler 呼叫 startSessionIfNeeded():
                若 sessionEndsAt = NULL,寫入 now + sessionMinutes;
                再廣播新的 room:detail(client 拿到才開始倒數)
                → session 開始跑

[Session 到期] server setInterval 30s 掃描 sessionEndsAt < now(且非 NULL):
                有手牌進行中 → 跳過(等手牌結束下一次掃到);
                否則 → systemCloseRoomWithSettlement:
                  snapshot + 退籌 + 刪除 + status=closed;
                ↓  廣播 room:closed {settlement, reason: 'session-expired'}
                ↓  廣播 lobby:room-removed

[Phase 2]     牌局開始 → status=waiting → playing → 手牌結束再回 waiting
```

**併發保證**:`seatUser` / `unseatUser` / `ownerCloseRoom` 全部包在 `prisma.$transaction`。`unseatUser` 與 `ownerCloseRoom` 用 `deleteMany` 做 idempotent(併發的 `room:leave` + `disconnect` 常見;dev 環境 React strict mode double-mount 也會觸發)。

**空房規則**:任何 unseat 完發現 0 個剩餘 membership 的路徑 → 房間關閉 + 所有訂閱者(含觀戰者)收到 `room:closed`。封裝在 `finalizeRoomState(roomId, empty)`。

---

## 10. Phase 進度

- [x] **Phase 0**(2026-07-24)— 骨架、mock 暱稱登入、Socket.IO smoke test
- [ ] **Phase 1**(進行中)— Google OAuth、大廳、房間
  - [x] Auth.js v5 Google OAuth(split-config for Edge middleware)
  - [x] Lobby 頁:列房、建房、加入房
  - [x] Room 頁:座位顯示、聊天、離房
  - [x] 全域唯一可編輯暱稱(DB 支援、儲存後 hot reload)
  - [x] 房主關房(確認框、全部退籌、進行中禁止、廣播導離)
  - [x] 手動選座位 + 觀戰模式(入房 = 觀戰;點空位就座;「快速就座」自動找第一個空位)
  - [x] 站起(退籌但保留訂閱,繼續看牌;若空房則自動關閉)
- [ ] **Phase 2** — 單桌現金局引擎(牌堆、下注輪、邊池、超時、斷線重連)
  - [x] **Milestone 2.1** — 牌堆 + 洗牌(`crypto.randomInt`)、in-memory `HandState`、房主觸發發手牌(≥2 人)、`game:hole` 只私推給該座位 socket、debug 結束牌局按鈕、dealer button 跨手輪換(in-memory `lastDealerByRoom` map)、環狀桌面布局搭配德撲位置代號(BTN/SB/BB/UTG/…)由 client 從 `dealerSeat` 推導、Session 計時器(30/60/90/120 分,預設 30,不允許無限)**按下「開始牌局」才開始倒數**、server 每 30s 掃描到期房間 → auto-close + 結算 modal、每局 action timeout 選擇(15/30/60s)存進 `HandState` + ring 顯示(實際 auto-fold 行為留給 2.4)。尚無下注;`Room.status` 不動。
  - [x] **Milestone 2.2** — No-Limit Hold'em 完整一手:自動貼盲注、preflop 開始下注輪(fold/check/call/raise/all-in)、行動順序(heads-up + 3+ 特殊 first-to-act 處理)、`toAct` set 追蹤還沒行動的人(BB 選項 + 加注重新 reopen action 都靠這個)、flop/turn/river 依 street 發公共牌 + 每街新一輪下注、只剩 1 人未 fold → fold-out 直接贏、走到 showdown → `pokersolver` 判贏、平手 pot 平分、贏家 chips 累加後 persist 到 `Membership.chipsAtTable`、環狀桌面顯示 chips/bet/dealer(D)/位置代號/active player 高亮/showdown 揭手牌 + 中文牌型(自己的手牌只在環下方 "你的手牌" 區顯示,不重複貼在座位卡)、手牌結束 8 秒倒數**純自動**開下一手(client-side,owner 端 emit,無提前按鈕;倒數 key 綁 `handNumber` 所以中途秀牌 re-emit 不會 reset)、**action timeout 設定改為 room-level**(建房 form 選一次,整局固定,`game:start` 不再帶 param → 避免每手都問玩家)、pokersolver hand `name` 送到 client 翻譯 10 種牌型為中文(皇家同花順 / 同花順 / 四條 / 葫蘆 / 同花 / 順子 / 三條 / 兩對 / 一對 / 高牌)、**即時牌型**(自己的當前最佳牌型顯示在手牌旁,每翻一張公共牌 server 重推 `game:hole`;preflop 用簡單 2-card check「一對」或「高牌」)、**動作紀錄** 側邊面板 tab(聊天 / 本手紀錄 切換);client 累積每手成 `HandRecord[]`(hand number、history、endResult),**跨手保留**在 client memory,可用「上一手 / 下一手 / 回到最新」導覽;每手手牌進行中內文隱藏、結束才展開動作 + 各街公共牌 + 攤牌/秀牌;fold-out 贏家可按「秀牌」emit `game:show-cards` 讓 server 補進 `endResult.revealedHoles` → 再廣播 `game:ended` 讓大家看到。**尚未 persist**(重整 tab 就沒了、server 也不存),未來規劃寫進雲端資料夾。**簡化**:min raise = big blind、沒有 side pot(all-in 多層時大 pot 全給高手優先,不完全準確 → 2.2c 才補)。
  - [ ] Milestone 2.2c — Side pot(all-in 多層正確分派)
  - [x] **Milestone 2.4** — 行動超時 auto-action:server 每次輪到新玩家算 `deadline = now + Room.actionTimeoutSeconds*1000`,寫進 `HandState.deadline` 廣播;server 用 `setTimeout` 綁 deadline,到期沒動作就自動 check(可過的話)或 fold;client 依 deadline tick 顯示座位卡 + ActionBar 剩餘秒數(<=5s 變紅);cancel 時機:每次 action / 街轉換 / hand 結束 / 房間關 / 系統關房 |
  - [x] **Milestone 2.5** — Session 內座位/籌碼持久化 + Room.status 互鎖:
    - **`room:leave` 不 unseat**、**`disconnect` 不 unseat**(手牌中 auto-fold 靠 deadline 機制,手牌後 chipsAtTable 保留)。玩家關 tab / 換分頁 / 掉線後,座位跟 chipsAtTable 都留著,回同房會拿回原座位跟籌碼
    - 唯二會退籌的路徑:`room:standup`(手牌後,自願站起)/ session-end settlement(auto-close 或 owner-close)
    - `Room.status` 在 `game:start` 成功後 flip 成 `playing`,`broadcastAfterAction ended` / `game:end` debug 後 flip 回 `waiting`。`ownerCloseRoom` 在 `playing` 時拒絕(必須等手牌結束)
    - `standup` 不再依賴 socket-local `seatedRoomId`,以 DB Membership 為準,支援 fresh socket 重連後站起
    - **未做**:「XX 斷線中」座位 UI 提示、mid-hand `standup` 允許(仍拒絕,要等手牌結束)
  - [x] **Milestone 2.6** — 手牌 persist 到 DB(`HandLog` model,一手一 row jsonb `HandLogData`);server 在 `broadcastAfterAction` 手牌結束後寫入,`handNumber` 由 server `countHandLogs + 1` 決定並塞進 `HandStatePublic` 避免 client 端 race;`GET /api/rooms/:id/hands` REST 供 client mount 時 fetch merge(**只保留當前房間 session 期間**);voluntary `game:show-cards` 也會 patch `handLog.data.endResult`;隱私:muck 手牌不寫進 log(照使用者選 (b) 攤牌 + 自願秀才可見);**房間關閉時**(owner close / session expired / 房間空掉自動關)`deleteHandLogsForRoom(roomId)` 整批清掉該房 log,不跨 session 累積;**雲端資料夾** (Google Drive / S3 / 檔案系統匯出)未做
- [ ] **Phase 3** — 房間聊天升級(目前部分有;lobby chat model 要重整)
- [ ] **Phase 4** — SNG 錦標賽(盲注升級、淘汰、獎金分配)
- [ ] **Phase 5** — UI 打磨 + Oracle VPS 部署(Docker Compose + Caddy)
  - [x] 部署 artefacts:`Dockerfile.web` / `Dockerfile.server` / `docker-compose.prod.yml` / `Caddyfile` / `.env.prod.example` / `DEPLOY.md`
    - Web:multi-stage,build 時 bake `NEXT_PUBLIC_SOCKET_URL`
    - Server:直接跑 `tsx src/index.ts`(避開 workspace TS 解析),進 container 前先 `prisma db push --accept-data-loss`
    - Caddy:反向代理 `alan-holdem.duckdns.org` → `web:3000`(Next.js)+ `/socket.io/*` → `server:3001`;auto SSL(Let's Encrypt)
    - Postgres:同 network,`postgres:5432`
    - DuckDNS 更新器 sidecar 每 5 min ping token 保持 DNS
  - [ ] **實際部署到 VM**(需 SSH 執行 `DEPLOY.md` 步驟)

---

## 11. 已知踩坑 / 設計決策

### 11.1 Auth.js Edge Runtime + Prisma

Middleware 跑在 Edge;Prisma 在那邊會爆。解法是 split-config(`auth.config.ts` 給 Edge、`auth.ts` 給 Node)。**絕對不要**從 `middleware.ts` 或 `auth.config.ts` import `prisma` — Prisma 的 browser stub 只在方法呼叫時噴錯,import 本身會通過,但實際 call 會炸 `PrismaClient is not configured to run in Edge Runtime`。

### 11.2 JWT 暱稱同步

**不依賴** `useSession().update()` — beta.22 不能穩定觸發 jwt callback。作法:jwt callback 每次讀取都撈 DB;改暱稱 modal 在 PATCH 完後 `window.location.reload()`。

### 11.3 Idempotent unseat

Client cleanup 同時 emit `room:leave` 和 `socket.disconnect()`,dev 環境 React strict mode 又會 double-mount。`unseatUser` 必須容忍雙呼叫。實作:`deleteMany({where:{id}})`,只在 `count === 1` 才退籌(輸掉 race 的那邊看到 0 就跳過退籌;贏的那邊剛好退一次)。

### 11.4 Windows 上 Prisma DLL 被鎖

`prisma db push` 會 regenerate client,如果有 Node process 在跑抓著 `query_engine-windows.dll.node`,就會 EPERM 失敗。解法:先停 dev server 再 push,或殺掉後跑 `pnpm --filter @holdem/db exec prisma generate`。

### 11.5 db package env 解析

`prisma db push` 從 `db/` 執行;Prisma CLI 只讀 `db/.env`,不會往上找 workspace root 或 `server/.env`。`db/.env` 是 `server/.env` 的複本(同一個 `DATABASE_URL`)。如果之後換 URL,兩個都要換。

### 11.6 獨立 Socket.IO(非 serverless)

Game server 必須 long-lived — Socket.IO 在 `socket.data.user` + `subscribedRoomId` + `seatedRoomId` 持有 per-connection 狀態。這排除 serverless 部署,也是 prod 計劃選「Oracle VPS」的主因。

### 11.7 房主權限 server 端驗證

`ownerCloseRoom` 在 server 端驗證 `room.ownerId === requesterId`。**不要只信 client 端** `isOwner` — 那只是為了 UX 藏按鈕;socket 事件到 server 一樣會強制驗權。

### 11.8 `Room.status = 'playing'` 互鎖

Phase 1 永遠不會設 `playing`。Phase 2 必須在手牌開始時設、結束時清。`ownerCloseRoom` 在 `playing` 時會拒絕關房 → 忘記清 flag = 孤兒房。也跟 `seatUser` 有關(目前允許 `playing` 中加入 — Phase 2 要決定要 gate 還是延到下一手)。

**Milestone 2.1 例外**:房主 `game:start` **不會**設 `Room.status = 'playing'`。理由:demo slice 還沒有結束手牌的邏輯,如果現在真的切狀態,房主忘記結束就永久卡住。狀態互鎖延到 Milestone 2.5。

### 11.9 Hand state 只在記憶體

`server/src/hands.ts` 有兩張 Map 存在記憶體:
- `hands: Map<roomId, HandState>` — 進行中的手牌(deck + hole cards + community + dealerSeat)
- `lastDealerByRoom: Map<roomId, number>` — 上一手的 dealer seat,用來輪換下一手 button

兩張表都跟 server process 一起死。副作用:
- 手牌途中 server 重啟 → 手牌消失,所有玩家看到牌局結束
- `game:start` 沒辦法恢復,房主要再按一次
- 重啟後 dealer 輪換從 seat 1 重來
- 晚訂閱者(在 `game:start` 之後進來)靠 `room:subscribe` 補收(server 會補 emit `game:started` + `game:hole`),但僅限 process 還活著

Cleanup:`endHand(roomId)` 只清當前 hand(保留 dealer 記憶方便下一手輪換)。`clearRoomState(roomId)` 兩張都清 — 房間本身要拆時才呼叫(`ownerCloseRoom` 或 `finalizeRoomState` 空房)。

DB 持久化延到 Milestone 2.5(斷線寬限)才做。

### 11.10 Session 到期用 polling,不用 per-room 計時器

`server/src/index.ts` 用 `setInterval(scanExpiredSessions, 30_000)` + 啟動時掃一次。相對於 per-room `setTimeout` 的優點:
- 撐得住 server 重啟(`sessionEndsAt` 在 DB,下一次掃就會找到)
- 手牌進行中的房會被跳過(`hasHand(roomId)`),下一次(`game:ended` 之後)再掃到就關(最多延遲 30s)
- 朋友圈 scale overhead 忽略不計

如果一手牌拖過 session 到期後 30s 才結束,關房會延到那次 tick,可接受。

**倒數起點**:`sessionEndsAt` 在**房主第一次按「開始牌局」**時才由 `startSessionIfNeeded()` 寫入 DB(而不是在建房時)。這樣建房後召集朋友的等待時間不會消耗 session。之後所有手牌共享同一個 `sessionEndsAt`,不會被 `game:end` 或後續 `game:start` 重置。

### 11.11 結算 snapshot 的順序

`SettlementSummary.players` 必須在 memberships 被退籌刪除**之前**建好。在 `room:close` handler 是 `snapshotSeatedPlayers()` 先,然後才 `ownerCloseRoom()`。系統自動關房則靠 `systemCloseRoomWithSettlement()` 在同一個 transaction 做 snapshot + 退籌 + 刪除。之後若重構把這順序打亂,結算會變空。

### 11.12 Round-close 用 `toAct: Set<idx>` 模型(非 last-aggressor)

早期實作用「action 回到 lastAggressor 就關輪」的判斷,BB preflop 選項會誤判(BB 就是初始 lastAggressor,everyone limp 後 BB check 就會誤以為輪未結束)。改成:每街初始把所有 active 玩家丟進 `hand.toAct: Set<number>`,每次 action 完 `delete` 掉;若是完整加注,重新把「除加注者外所有 active」丟回 `toAct`;`toAct.size === 0` 表示這街收盤。這符合標準德撲規則(含 BB 選項、all-in-for-less 不 reopen)。

### 11.13 pokersolver 沒官方 types

`server/src/pokersolver.d.ts` 手寫 ambient 宣告,只 export `Hand.solve` / `Hand.winners` + `SolvedHand` interface(name/descr/rank)。若之後 pokersolver 升版 API 有動,調這個檔案。

### 11.14 沒有 side pot(2.2 已知簡化)

當多人 all-in 且金額不同,標準德撲要建 side pots(小 stack all-in 者只贏他能贏的部分)。目前 `endWithShowdown` 直接把整個 pot 平分給所有 pokersolver winners,short-stack all-in 贏家可能拿到超額(不公平但不會爆錯)。Milestone 2.2c 補。

朋友圈實際玩多人一起 all-in 的機率不高,先跳過可接受。

### 11.15 手牌 'ended' 狀態保留

自然結束(fold-out 或 showdown)的 hand 不會立刻從 `hands` map 刪掉,保留為 `phase: 'ended'`,`endResult` 有 winners / reveals。目的:
- 晚訂閱者(`room:subscribe`)還能看到剛結束的手牌結果
- 客戶端顯示「XX 贏得 100」直到房主開下一手

房主按「開始下一手」→ `game:start` handler 先 `endHand(roomId)` 清掉再 `startHand`。手動 debug `game:end` 也會清掉。`hasActiveHand()` 排除 ended 狀態,確保 game:start 不會 reject。

### 11.16 手牌隱私

`game:hole` **只能**推給特定 socket,絕不廣播到 room channel。實作用 `io.in(channel).fetchSockets()` + 每個 socket 個別 `rs.emit('game:hole', priv)`。如果之後 refactor 改用 `.to()` 或 namespace 廣播,務必確認手牌不會外洩。

### 11.17 手牌中禁止站起 + Exit-不-unseat(Milestone 2.5 收斂)

`room:standup` handler 若 `hasActiveHand(roomId)` 為真,回 `room:error`「牌局進行中無法站起」。理由:mid-hand 把 player 從 `hand.players` 拔掉會弄亂 `toAct` / `currentPlayerIdx` / 對手期待,實作成本高。

**Disconnect / room:leave 現況(2.5)**:兩個路徑都**不 unseat**。玩家關 tab / 斷線 / 按離開房間都只是離開 socket channel,座位跟 chipsAtTable 留在 DB。手牌中的 turn 靠 `runAutoAction` deadline 自動 check/fold。真的要「不玩了」只能 `站起`(等手牌結束)。空房自動關的觸發:「所有人都主動站起 / owner-close / session-expire」。

### 11.18 Play-money 模式(2026-07-25 起)

`User.chipsBalance` 這個欄位**保留但不動**(留給以後長期追蹤功能用)。當前為每局獨立 play-money:

- **坐下**:`seatUser` 直接把 `chipsAtTable = room.buyIn` + `totalBuyIn = room.buyIn` 寫進 Membership,**不從 chipsBalance 扣**
- **Rebuy**:`rebuyChips` 加 `room.buyIn` 到 chipsAtTable + totalBuyIn,**不從 chipsBalance 扣**
- **站起 / 空房自動關 / owner close / session expire**:刪 Membership,**不 refund 到 chipsBalance**
- **Settlement modal**:顯示每人「買入 / 剩下 / 輸贏」,輸贏 = chipsAtTable - totalBuyIn(正綠負紅),純資訊,不動 chipsBalance

長期追蹤功能之後補時,再把 chipsBalance 拉回計算流程(可能 rebuy 從 chipsBalance 扣、settlement 寫回 chipsBalance)。

---

## 12. 環境變數

### 12.1 `web/.env.local`

| 變數 | 用途 |
|---|---|
| `NEXTAUTH_URL` | dev 是 `http://localhost:3000` |
| `NEXTAUTH_SECRET` | 同時簽 Auth.js session JWT 與 socket 握手 JWT — **必須跟 server/.env 一致** |
| `GOOGLE_CLIENT_ID` | Google Cloud Console OAuth client |
| `GOOGLE_CLIENT_SECRET` | Google Cloud Console OAuth client |
| `NEXT_PUBLIC_SOCKET_URL` | Socket.IO endpoint,browser 端要看到(dev:`http://localhost:3001`) |
| `DATABASE_URL` | Postgres URL(目前 dev 用 Neon) |

### 12.2 `server/.env`

| 變數 | 用途 |
|---|---|
| `SERVER_PORT` | Socket.IO server port(預設 3001) |
| `DATABASE_URL` | 跟 web 同一個 DB |
| `CORS_ORIGIN` | 允許的 browser origin(預設 `http://localhost:3000`) |
| `NEXTAUTH_SECRET` | 要跟 web 一致 — server 用它驗握手 JWT |

### 12.3 `db/.env`

`server/.env` 的複本,給 `prisma db push` / `prisma generate` 用。Prisma CLI 只讀 `DATABASE_URL`。

### 12.4 Root `.env`(只給 Docker Compose)

| 變數 | 用途 |
|---|---|
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` / `POSTGRES_PORT` | 本機 Postgres 走 `pnpm db:up`(用 Neon 時可忽略) |

---

## 13. Scripts(workspace 根)

| Script | 命令 | 用途 |
|---|---|---|
| `pnpm dev` | `pnpm -r --filter=web --filter=server dev` | 兩個服務並行 |
| `pnpm dev:web` | 只跑 web | 隔離除錯 web |
| `pnpm dev:server` | 只跑 server | 隔離除錯 socket server |
| `pnpm db:push` | `prisma db push` | 把 schema.prisma sync 到 DB(不產生 migration file) |
| `pnpm db:generate` | `prisma generate` | 重新產生 PrismaClient(型別過期時修) |
| `pnpm db:studio` | `prisma studio` | GUI browser at :5555 |
| `pnpm typecheck` | `-r typecheck` | 全 package tsc --noEmit |
| `pnpm build` | `-r build` | Compile server + web(prod artifact) |
