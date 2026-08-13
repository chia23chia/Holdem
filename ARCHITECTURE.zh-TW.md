# Holdem — 架構文件

Holdem 專案的深度參考文件。README 負責入門(如何啟動),本檔負責描述程式碼結構、契約與設計決策。有架構性變動(新事件、新 model、新 endpoint、新踩坑)才更新。

最後更新:2026-07-30(新增 time_alert 音效)

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

### 現況(2026-07-29)

- ✅ Phase 1-2 全部完成(OAuth、lobby、rooms、game engine 含下注/showdown/正確 side-pot/timeout/reconnect/hand-log/rebuy),Phase 5 已實際部署上 `https://alan-holdem.duckdns.org`(Let's Encrypt、Google OAuth prod client 皆已設好)
- ✅ Phase 4 SNG 錦標賽 v1 雛形已上線(單桌、盲注自動調漲、淘汰記名次、winner-take-all——已知簡化見 §11.20),與現金局共用引擎、UI 切換
- ✅ Play-money 核心規則皆已定案並上線:正確 side-pot 分層、rebuy(歸零才能補 + chip-leader 上限捨 500 + 玩家自選金額)、broadcastAfterAction 容錯(防 lag 卡死整桌)、站起改「暫離」(seat 可為 null,籌碼保留,§11.17)、蓋牌者可 mid-hand 站起、閒置連續兩次自動代打強制站起(§11.28)
- ✅ All-in 跑池體驗:side-pot 正確分池、公共牌逐街揭露動畫 + 落後者河牌高亮(§11.26)、街事件不再靠 client 猜測(§11.25)
- ✅ 周邊功能:音效 cue(含 `.mp3` 優先 / `.wav` 佔位 fallback)、貼圖 reaction、聊天跑馬燈、即時戰績面板、座位即時動作回饋(過牌標籤 + bet 顏色,§11.27)、Google Sheets 自動同步結算(月曆式戰績表 + 人員分頁,§11.19)
- ❌ 未做:Phase 3 lobby chat model 整理、雲端手牌 log 匯出(目前房間關閉即清)、跨房 chipsBalance 追蹤、錦標賽多桌/獎金分配/延遲報名
- 完整逐版本記錄見 `CHANGELOG.md`;本節只列「目前實際上線的狀態」,不是逐項變更史

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
| `seat` | Int? | 1..maxPlayers;null = 暫離中(站起但保留籌碼,見 §11.17) |
| `chipsAtTable` | Int | 桌上籌碼(play money;seat 時 = buyIn,牌局結束由 persistHandResult 更新;rebuy 規則見下) |
| `totalBuyIn` | Int DEFAULT 0 | 累計買入(初始 buyIn + 所有 rebuys),用來算 settlement 輸贏 = chipsAtTable - totalBuyIn |
| `joinedAt` | DateTime | |

Unique 約束:`(userId, roomId)`(同一玩家在同一房只能坐一個位)+ `(roomId, seat)`(同一座位只能坐一人)。

#### 5.3.1 Rebuy 規則(`rebuyChips`,唯一權威判定點)

- **只有 `chipsAtTable === 0` 才能 rebuy** — 就算自己當初買入比別人少、桌上還剩一點籌碼,也不能加碼,只能等歸零。
- **玩家自己選加碼金額,但必須是 500 的倍數,且不能超過目前的上限**:
  - 令 `leader` = 房內所有座位 `chipsAtTable` 的最大值(`Membership.aggregate` 即時算,不含 in-hand 尚未 persist 的籌碼)。
  - 上限 `cap` = `roundDownTo500(leader > room.buyIn ? leader : room.buyIn)`。例:leader=1999(> buyIn)→ cap=1500,可選 500/1000/1500;leader ≤ buyIn(通常代表原本的 chip leader 已經站起離桌把籌碼帶走)→ cap = buyIn 捨到 500,選最高檔會讓此人變成新的 chip leader。
  - `room:rebuy` payload 帶 `amount`,`rebuyChips` 驗證 `amount % 500 === 0 && amount > 0 && amount <= cap`,不符合直接回錯誤。
- 判定完全在 `rebuyChips` 內,`room:rebuy` handler 兩條路徑(手牌中 queue / 手牌外立即)最終都會走到這裡。手牌中排隊時連同玩家當下選的金額一起存(`pendingRebuysByRoom: Map<userId, amount>`,同一人重複請求以最後一次為準),到手牌結束才用當時最新的 cap 重新驗證,若那時金額已不合法(例如其實沒歸零,或 cap 縮水了)就回錯誤、不會偷偷改金額或洗版報錯。

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
| `room:detail` | `RoomDetail` | `room:<id>` channel | 完整房間細節含座位;`standings` 欄位帶全部成員(含暫離)的即時輸贏,見 §11.21 |
| `room:error` | `{message}` | 這個 socket | 例如「房間不存在」 |
| `room:closed` | `{roomId, settlement?}` | `room:<id>` channel | 房間關閉(房主或 session 到期);若有 `settlement` client 顯示結算 modal 再導回 lobby |
| `chat:message` | `ChatMessage` | `room:<id>` 或 `lobby` | 房內或大廳聊天 |
| `game:started` | `HandStatePublic` | `room:<id>` channel | 新一手發牌(含 `dealerSeat`、`actionTimeoutSeconds`、`players[]`、`currentBet` 等);晚訂閱者透過 `room:subscribe` 補收到 |
| `game:state` | `HandStatePublic` | `room:<id>` channel | 每次 action / 街轉換後廣播的新公開狀態(含 `deadline` epoch ms) |
| `game:hole` | `HandStatePrivate` | 單一 socket | 該座位玩家的私人手牌 + 當前最佳牌型;每次翻公共牌後 server 會**重推**讓 handRank 更新 |
| `game:action-log` | `ActionLogEntry` | `room:<id>` channel | 每次玩家 action 後推一筆(seat、name、phase、actionType、amount);client 累積成本手動作紀錄,`game:started` 時清空 |
| `game:street-log` | `{phase, cards, trailingUserId?}` | `room:<id>` channel | 每次公共牌翻牌就推一筆,一次動作可能連續推好幾筆(all-in 跑池時一次翻完 flop+turn+river);client 直接 append 到本手歷史 + 播 `street` 音效,不靠 `gameState.phase` 推測(見 §11.25)。`trailingUserId` 只在 all-in 跑池時才會有值,用於 §11.26 的逐街動畫 + 河牌落後者高亮 |
| `game:allin-reveal` | `{players: Array<{userId,name,holeCards}>}` | `room:<id>` channel | All-in 跑池開始時觸發一次,提前公開所有還在手牌裡的人的手牌(已無法再行動,不算洩密)。見 §11.26 |
| `game:ended` | `{roomId, result?}` | `room:<id>` channel | 手牌自然結束時帶 `result`(winners + hole reveal + handRank);manual `game:end` 不帶 result 直接清狀態 |
| `sticker:show` | `StickerEvent` | `room:<id>` channel | 有人送 emoji reaction;client 疊到全螢幕飛過的貼圖層(見 §11.22) |

### 7.2 Client → Server

| 事件 | Payload | Ack | Handler 動作 |
|---|---|---|---|
| `lobby:subscribe` | — | — | 加入 `lobby` channel、emit 初始 `lobby:rooms` |
| `lobby:unsubscribe` | — | — | 離開 `lobby` channel |
| `room:join` | `{roomId, seat?}` | `JoinRoomResult` | `seatUser`(扣 buyIn);`seat` 省略 = 自動找第一個空位;`seat` 給 = 指定座位(被佔會回錯誤) |
| `room:leave` | `{roomId}` | — | **僅離開 socket channel**;座位/Membership/chipsAtTable **不動**(session 內可回來繼續)。真的要退出座位要 `room:standup` |
| `room:subscribe` | `{roomId}` | — | 加入 `room:<id>` 當觀戰(不需要 membership)、emit `room:detail` |
| `room:standup` | `{roomId}` | — | Unseat(刪 Membership,play money 模式**不退回**任何餘額),保留訂閱變觀戰;手牌進行中拒絕;若空房自動關閉。不依賴 socket-local 狀態,DB Membership 為準 |
| `room:rebuy` | `{roomId, amount}` | `GameActionResult` | 僅 `chipsAtTable === 0` 時允許;`amount` 由玩家選(500 的倍數,見 §5.3.1 上限公式),寫入 `chipsAtTable` + `totalBuyIn`。手牌**中** queue 到 `pendingRebuysByRoom` map(存玩家選的金額);`broadcastAfterAction ended` 時 drain 進 DB(逐一重新驗證資格 + 金額,不合法則回錯誤、不套用);手牌**外**立即寫入 DB + 廣播,並嘗試自動接續開下一手(見 `startHandForRoom`) |
| `room:close` | `{roomId}` | `CloseRoomResult` | `ownerCloseRoom`(驗權 + 全部退籌 + status=closed)、廣播 `room:closed` |
| `game:start` | `{roomId}` | `GameActionResult` | 只有房主;server 從 Room 讀 `actionTimeoutSeconds`;只發手牌給**有籌碼**(`chipsAtTable > 0`)的就座玩家(≥2 人,否則回錯誤並廣播全房);0 籌碼玩家該手坐山觀虎鬥、廣播 `game:started` + 私人 `game:hole` |
| `game:end` | `{roomId}` | `GameActionResult` | 房主 debug;強制清掉 hand state、廣播 `game:ended`(不帶 result) |
| `game:action` | `{roomId, action}` | `GameActionResult` | 當前輪到的玩家送 fold / check / call / raise{amount} / all-in;server 更新 HandState、廣播 `game:state`;若手牌結束則存 chips 到 Membership + 廣播 `game:ended` {result} + 新的 `room:detail` |
| `game:show-cards` | `{roomId}` | — | 手牌結束後任何曾在該手的玩家(含 fold 者)自願秀牌;server 更新 `endResult.revealedHoles` 加該人的手牌 + handRank(重複呼叫或已被揭露 no-op),再次廣播 `game:ended` {result 更新} |
| `chat:send` | `{roomId\|null, text}` | — | Sanitize、emit `chat:message` 到房間或大廳 |
| `sticker:send` | `{roomId, emoji}` | — | 送 emoji reaction(白名單見 `STICKER_EMOJIS`);per-user 3s cooldown,超頻直接丟掉不回錯,見 §11.22 |

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
- [x] **Phase 1** — Google OAuth、大廳、房間
  - [x] Auth.js v5 Google OAuth(split-config for Edge middleware)
  - [x] Lobby 頁:列房、建房、加入房
  - [x] Room 頁:座位顯示、聊天、離房
  - [x] 全域唯一可編輯暱稱(DB 支援、儲存後 hot reload)
  - [x] 房主關房(確認框、全部退籌、進行中禁止、廣播導離)
  - [x] 手動選座位 + 觀戰模式(入房 = 觀戰;點空位就座;「快速就座」自動找第一個空位)
  - [x] 站起(2026-07-27 改為「暫離」:`seat` 設回 null、籌碼保留,不再是退籌,見 §11.17)
- [x] **Phase 2** — 單桌現金局引擎(牌堆、下注輪、邊池、超時、斷線重連)
  - [x] **Milestone 2.1** — 牌堆 + 洗牌(`crypto.randomInt`)、in-memory `HandState`、房主觸發發手牌(≥2 人)、`game:hole` 只私推給該座位 socket、debug 結束牌局按鈕、dealer button 跨手輪換(in-memory `lastDealerByRoom` map)、環狀桌面布局搭配德撲位置代號(BTN/SB/BB/UTG/…)由 client 從 `dealerSeat` 推導、Session 計時器(30/60/90/120 分,預設 30,不允許無限)**按下「開始牌局」才開始倒數**、server 每 30s 掃描到期房間 → auto-close + 結算 modal、每局 action timeout 選擇(15/30/60s)存進 `HandState` + ring 顯示(實際 auto-fold 行為留給 2.4)。尚無下注;`Room.status` 不動。
  - [x] **Milestone 2.2** — No-Limit Hold'em 完整一手:自動貼盲注、preflop 開始下注輪(fold/check/call/raise/all-in)、行動順序(heads-up + 3+ 特殊 first-to-act 處理)、`toAct` set 追蹤還沒行動的人(BB 選項 + 加注重新 reopen action 都靠這個)、flop/turn/river 依 street 發公共牌 + 每街新一輪下注、只剩 1 人未 fold → fold-out 直接贏、走到 showdown → `pokersolver` 判贏、平手 pot 平分、贏家 chips 累加後 persist 到 `Membership.chipsAtTable`、環狀桌面顯示 chips/bet/dealer(D)/位置代號/active player 高亮/showdown 揭手牌 + 中文牌型(自己的手牌只在環下方 "你的手牌" 區顯示,不重複貼在座位卡)、手牌結束倒數**純自動**開下一手(client-side,owner 端 emit,無提前按鈕;倒數 key 綁 `handNumber` 所以中途秀牌 re-emit 不會 reset;`AUTO_MS` 原本 8 秒,2026-07-29 縮短成 4 秒)、**action timeout 設定改為 room-level**(建房 form 選一次,整局固定,`game:start` 不再帶 param → 避免每手都問玩家)、pokersolver hand `name` 送到 client 翻譯 10 種牌型為中文(皇家同花順 / 同花順 / 四條 / 葫蘆 / 同花 / 順子 / 三條 / 兩對 / 一對 / 高牌)、**即時牌型**(自己的當前最佳牌型顯示在手牌旁,每翻一張公共牌 server 重推 `game:hole`;preflop 用簡單 2-card check「一對」或「高牌」)、**動作紀錄** 側邊面板 tab(聊天 / 本手紀錄 切換);client 累積每手成 `HandRecord[]`(hand number、history、endResult),**跨手保留**在 client memory,可用「上一手 / 下一手 / 回到最新」導覽;每手手牌進行中內文隱藏、結束才展開動作 + 各街公共牌 + 攤牌/秀牌;fold-out 贏家可按「秀牌」emit `game:show-cards` 讓 server 補進 `endResult.revealedHoles` → 再廣播 `game:ended` 讓大家看到。**尚未 persist**(重整 tab 就沒了、server 也不存),未來規劃寫進雲端資料夾。**簡化**:min raise = big blind、沒有 side pot(all-in 多層時大 pot 全給高手優先,不完全準確 → 2.2c 才補)。
  - [x] **Milestone 2.2c**(`54fb117`,2026-07-26)— Side pot 正確分派:`buildSidePots` 依貢獻金額分層,短籌碼 all-in 只贏他能 cover 的層,多下沒人跟的錢退回原下注者;`endWithShowdown` 逐層獨立算贏家
  - [x] **Milestone 2.4** — 行動超時 auto-action:server 每次輪到新玩家算 `deadline = now + Room.actionTimeoutSeconds*1000`,寫進 `HandState.deadline` 廣播;server 用 `setTimeout` 綁 deadline,到期沒動作就自動 check(可過的話)或 fold;client 依 deadline tick 顯示座位卡 + ActionBar 剩餘秒數(<=5s 變紅);cancel 時機:每次 action / 街轉換 / hand 結束 / 房間關 / 系統關房 |
  - [x] **Milestone 2.5** — Session 內座位/籌碼持久化 + Room.status 互鎖:
    - **`room:leave` 不 unseat**、**`disconnect` 不 unseat**(手牌中 auto-fold 靠 deadline 機制,手牌後 chipsAtTable 保留)。玩家關 tab / 換分頁 / 掉線後,座位跟 chipsAtTable 都留著,回同房會拿回原座位跟籌碼
    - 唯二會退籌的路徑:`room:standup`(手牌後,自願站起)/ session-end settlement(auto-close 或 owner-close)
    - `Room.status` 在 `game:start` 成功後 flip 成 `playing`,`broadcastAfterAction ended` / `game:end` debug 後 flip 回 `waiting`。`ownerCloseRoom` 在 `playing` 時拒絕(必須等手牌結束)
    - `standup` 不再依賴 socket-local `seatedRoomId`,以 DB Membership 為準,支援 fresh socket 重連後站起
    - **未做**:「XX 斷線中」座位 UI 提示、mid-hand `standup` 允許(仍拒絕,要等手牌結束)
  - [x] **Milestone 2.6** — 手牌 persist 到 DB(`HandLog` model,一手一 row jsonb `HandLogData`);server 在 `broadcastAfterAction` 手牌結束後寫入,`handNumber` 由 server `countHandLogs + 1` 決定並塞進 `HandStatePublic` 避免 client 端 race;`GET /api/rooms/:id/hands` REST 供 client mount 時 fetch merge(**只保留當前房間 session 期間**);voluntary `game:show-cards` 也會 patch `handLog.data.endResult`;隱私:muck 手牌不寫進 log(照使用者選 (b) 攤牌 + 自願秀才可見);**房間關閉時**(owner close / session expired / 房間空掉自動關)`deleteHandLogsForRoom(roomId)` 整批清掉該房 log,不跨 session 累積;**雲端資料夾** (Google Drive / S3 / 檔案系統匯出)未做
- [ ] **Phase 3** — 房間聊天升級(lobby chat model 仍未重整;2026-07-28 加了聊天跑馬燈 §11.23,算周邊補強不算這個 Phase 完成)
- [x] **Phase 4** — SNG 錦標賽 v1 雛形(`cda3cce`,2026-07-26)— 單桌、盲注每級 ×1.5 自動調漲、輸光即淘汰(不可 rebuy)、winner-take-all、剩 1 人自動結算。已知 v1 簡化(單桌、無獎金拆分、無延遲報名)記在 §11.20,尚未列入排程
- [x] **Phase 5** — UI 打磨 + Oracle VPS 部署(Docker Compose + Caddy)
  - [x] 部署 artefacts:`Dockerfile.web` / `Dockerfile.server` / `docker-compose.prod.yml` / `Caddyfile` / `.env.prod.example` / `DEPLOY.md`
    - Web:multi-stage,build 時 bake `NEXT_PUBLIC_SOCKET_URL`
    - Server:直接跑 `tsx src/index.ts`(避開 workspace TS 解析),進 container 前先 `prisma db push --accept-data-loss`
    - Caddy:反向代理 `alan-holdem.duckdns.org` → `web:3000`(Next.js)+ `/socket.io/*` → `server:3001`;auto SSL(Let's Encrypt)
    - Postgres:同 network,`postgres:5432`
    - DuckDNS 更新器 sidecar 每 5 min ping token 保持 DNS
  - [x] **實際部署到 VM** — 已上線 `https://alan-holdem.duckdns.org`,持續用 §Handoff 快照的「部署更新流程」滾動更新
  - [x] 後續打磨(未列入原始 Phase 規劃,依使用者反饋陸續加做,細節見 `CHANGELOG.md` 逐日條目):音效 cue、貼圖 reaction、聊天跑馬燈、即時戰績面板、Google Sheets 自動同步、all-in 跑池動畫、座位即時動作回饋、閒置強制站起(§11.19、§11.21–§11.28)

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

### 11.14 Side pot(2026-07-26 補完,原 Milestone 2.2c 簡化已解)

`endWithShowdown` 改用標準 side-pot 分層演算法(`buildSidePots`):把 `hand.players` 依 `totalBet` 排序取不重複金額級距,每一級距切一層 pot(該層金額 = 級距差 × 該級距以上的貢獻人數),每層獨立找出**尚未棄牌**的合格贏家算 pokersolver 比大小、獨立分那一層。棄牌者的錢仍計入級距(墊高該層金額)但沒資格贏任何一層。

好處:
- 短籌碼 all-in 只贏他能 cover 的那幾層,贏不到自己蓋不到的上層
- 「多下注但沒人跟」的多餘籌碼,天然變成一個「只有下注者自己合格」的獨立層,原封不動退還 —— 不用另外寫「退錢」邏輯,是分層演算法的自然結果
- 一個玩家可能贏好幾層,`winnerResults` 會把同一人的多層獎金加總成一筆

### 11.15 手牌 'ended' 狀態保留

自然結束(fold-out 或 showdown)的 hand 不會立刻從 `hands` map 刪掉,保留為 `phase: 'ended'`,`endResult` 有 winners / reveals。目的:
- 晚訂閱者(`room:subscribe`)還能看到剛結束的手牌結果
- 客戶端顯示「XX 贏得 100」直到房主開下一手

房主按「開始下一手」→ `game:start` handler 先 `endHand(roomId)` 清掉再 `startHand`。手動 debug `game:end` 也會清掉。`hasActiveHand()` 排除 ended 狀態,確保 game:start 不會 reject。

### 11.16 手牌隱私

`game:hole` **只能**推給特定 socket,絕不廣播到 room channel。實作用 `io.in(channel).fetchSockets()` + 每個 socket 個別 `rs.emit('game:hole', priv)`。如果之後 refactor 改用 `.to()` 或 namespace 廣播,務必確認手牌不會外洩。

### 11.17 手牌中禁止站起 + 站起是「暫離」不是退出(2026-07-27 修正)

`room:standup` handler 若 `hasActiveHand(roomId)` 為真,原則上回 `room:error`「牌局進行中無法站起」。理由:mid-hand 把 player 從 `hand.players` 拔掉會弄亂 `toAct` / `currentPlayerIdx` / 對手期待,實作成本高。

**例外(2026-07-28 起)**:當前玩家在該手已 `status === 'folded'` 時允許站起 —— 蓋牌者不再影響牌局動線,把座位設 null(現金局暫離,籌碼保留)或走 `eliminateStandingPlayer`(錦標賽)都安全。`hand.players` 陣列不動、他的 fold 狀態繼續帶到手牌結束。

**站起 = 暫離,不是退出**(現金局;錦標賽走 `eliminateStandingPlayer`,見 §11.20,不受這節影響)。`Membership.seat` 是 `Int?`,站起時 `unseatUser` 只把 `seat` 設回 `null`,**不刪 Membership、不動 chipsAtTable/totalBuyIn**;之後同一人用 `seatUser` 坐回來(同座位或其他空位皆可),會直接接續原本的籌碼,不是重新用 `room.buyIn` 買入。Postgres 的 `@@unique([roomId, seat])` 允許多個 NULL 並存(跟 `User.nickname` 同一招),所以好幾個人同時暫離不會互相卡到。`seat === null` 的成員不會出現在 `RoomDetail.seats`(座位表看不到、大廳人數也不計入),但設定/結算查詢仍會抓到他們的籌碼記錄。

早期(Milestone 2.5)設計是「站起 = 永久退出、籌碼歸零」,但實測發現使用者會把「站起」當成暫時離桌,再坐下卻發現籌碼被清空、變成重新買入 —— 上面這版修正解決了這個問題。

**Disconnect / room:leave 現況**:兩個路徑都**不 unseat**(座位維持 seated 狀態)。玩家關 tab / 斷線 / 按離開房間都只是離開 socket channel,座位跟 chipsAtTable 留在 DB。手牌中的 turn 靠 `runAutoAction` deadline 自動 check/fold。空房自動關的觸發:「所有人都站起(不再是任何人有 seat) / owner-close / session-expire」—— `closeRoom`(空房自動關專用)現在會連同任何遺留的站起中 Membership 一起刪掉,因為房間關閉後 `seatUser` 一律拒絕加入,沒有留著的必要。

### 11.18 Play-money 模式(2026-07-25 起)

`User.chipsBalance` 這個欄位**保留但不動**(留給以後長期追蹤功能用)。當前為每局獨立 play-money:

- **坐下**:`seatUser` 首次入座才把 `chipsAtTable = room.buyIn` + `totalBuyIn = room.buyIn` 寫進 Membership;暫離後坐回來則保留原本數字,**不從 chipsBalance 扣**
- **Rebuy**:`rebuyChips` 依 §5.3.1 的歸零 + chip-leader 上限規則加碼到 chipsAtTable + totalBuyIn,**不從 chipsBalance 扣**
- **空房自動關 / owner close / session expire**:刪 Membership,**不 refund 到 chipsBalance**(站起本身不再刪 Membership,見 §11.17)
- **Settlement modal**:顯示每人「買入 / 剩下 / 輸贏」,輸贏 = chipsAtTable - totalBuyIn(正綠負紅),純資訊,不動 chipsBalance

長期追蹤功能之後補時,再把 chipsBalance 拉回計算流程(可能 rebuy 從 chipsBalance 扣、settlement 寫回 chipsBalance)。

### 11.19 Google Sheets 自動同步(2026-07-26 起,選填,v2 完整仿照舊表格式)

每次房間結算(`room:close` 房主關房 / session 到期自動關房)成功後,`server/src/sheetsSync.ts` 的 `syncSettlementToSheet` 會把該局每位玩家的結果寫進一份外部 Google Sheet,格式完整仿照原本朋友圈手工維護的那份月曆式戰績表(領先榜 + 每日總表 + 逐場 check 明細),但用 userId 當唯一鍵取代舊表脆弱的「代號手動對應」機制。**完全選填** —— 沒設定對應環境變數就整個 no-op,不影響正常關房流程。

- **驗證方式**:Service Account(不是使用者 OAuth),JSON 金鑰 base64 編碼後放進 `GOOGLE_SHEETS_SA_KEY`;目標試算表要另外用「共用」把該 service account 的 `client_email` 加為編輯者。
- **寫入方式**:直接呼叫 Sheets API v4 REST(`values:batchGet`/`values:batchUpdate`),`google-auth-library` 只拿來換 access token,沒有用整包 `googleapis`。

**分頁「人員」(全域,不分月)** —— 唯一的玩家身份來源:
- 欄位:`userId | 顯示名稱 | 列位 | 停用`。`列位` 是每個 userId 第一次出現時分配的固定序號,之後永不改變
- 每次結算會檢查每位玩家的 `userId`:沒登記過就 append 新列(下一個列位);已登記但顯示名稱變了(玩家在 app 內改暱稱)就更新該列的顯示名稱、列位不動 —— 所以改名不會讓歷史資料對不上人
- 月分頁的 B 欄(玩家名)都是 `='人員'!B<row>` 公式,不是寫死字串,所以人員表改名會自動反映到所有月份
- `停用` 欄(D)是**手動**的,填任何非空值(`V` / `1` / `TRUE` / `停用` 都可、勾選框也可)即視為停用 —— 見 §11.29

**每月一個分頁**(命名 `YYYY/MM`,如 `2026/08`),結構(N = 該分頁**當前**「人員」表總人數;月中有新人加入會 rebuild,詳見下方):

| 區塊 | 列範圍 | 內容 |
|---|---|---|
| 領先榜 | 1 ~ N+1 | 第1列標題;A2 是單一 `=SORT(A<每日總表起>:C<每日總表迄>,3,FALSE)` 依淨輸贏由高到低整塊 spill,B\~D 欄由公式自動填滿,不逐列手動寫 |
| 檢查碼 | F2:G4 | 正/負/sum,`SUMIF`/`SUM` 加總每日總表的 C 欄,驗證零和 |
| 每日總表 | N+3 (表頭) ~ 2N+3 | C 欄 `total` = `=SUM(D:AH)`(固定跨度,不用每次改公式);每個日期一欄,每格 `=C<對應 check 區塊列>` |
| check 明細 | 2N+6 起,每區塊高 N+2 列 | 一個日期一區塊:表頭列(日期)+ N 位玩家列(C=`=SUM(E,F:AD)`)+ 空白列。同一天多場結算 = 同一區塊裡各玩家列往右多加一欄(E→F→G…),不是新開區塊 |

- **日期儲存**:寫入時用 `USER_ENTERED` 送類似 `"7/26"` 的字串,Sheets 會自動解析成真正的日期型別(跟舊表一樣顯示 `7/26`,不是純文字)。**比對「今天這個區塊是否已存在」不能用字串比對**(日期已被 Sheets 轉型),要用 `sheetsDateSerial()` 换算 Excel/Sheets 序列值(1899-12-30 起算天數)去跟 `UNFORMATTED_VALUE` 讀回來的數字比 —— 這個坑在開發時真的踩過一次(每次結算都誤判成新的一天、開新區塊),測試時修掉了。
- **沒玩的人填 0 不填空**(2026-07-29 起):`appendSessionEntries` 從「每人各自找下一個空格寫」改成「所有列先算出**共同**目標欄(取每列 lastNonEmpty+1 的最大值),沒參加該場的人填 0」。這樣每一場結果會 column-aligned 對齊,不會有人跳過一場後續全部往左靠、對不上其他人的第 N 場。同時每次寫入會把該區塊每一列的**中間空格也順手補成 0**(修 2026-07-29 前留下的歷史錯位)—— 對 C 欄 `SUM` 的結果沒影響,因為 SUM 本來就把空格當 0。
- **月中新人加入 = 整頁 rebuild**(2026-07-28 起):`ensureMonthTab` 讀出當前分頁的 N_old,若目前 activeRoster 有 tab 沒收錄的玩家,呼叫 `rebuildMonthTab`:先用 `readPhysicalRoster` **從 column B 的 `=人員!B<row>` 公式反解出 tab 實際每列對應的 slot**(注意:**不能**用 `fullRoster.slice(0, N_old)` 假設 tab 依 slot 順序,dropped 過的 tab 不成立 —— 這個 bug 在 2026-08-03 corrupt 過 2026/08,見下條)→ `snapshotMonthTab` 把每個既有日期的 check 明細讀進記憶體(**保留欄位位置**,空格當 0,每個日期算出 sessionCount = 最長列長度)→ `clearAllValues` 用 `batchUpdate/updateCells fields:userEnteredValue,userEnteredFormat` 清空 values 跟 cell 格式(**欄寬/sheet id 保留**,但 numberFormat 一定要清 —— 曾經有殘留 date format 讓數字顯示成日期)→ 用新 N 重寫 skeleton → 依原本欄位順序逐日 replay 進 rebuilt 分頁。新人在該月之前的每個日期是 sessionCount 個 0(不是空白)。整個 rebuild 非原子(clear 到 replay 中間掛掉會半空),因此 rebuild 前會 `console.warn` 把 snapshot 內容整包 JSON 印進 log 保底;搭配 Google Sheets 內建的 30 天版本歷史,失敗可以還原。
- **手動維護 CLI**(2026-08-03 起):`server/scripts/drop-user-from-month.ts` 可以在既有月分頁中**物理移除**指定 userId 的列(§11.29 的 `停用` 只影響**未來新建**的分頁,對已存在分頁只是保留 0 列)。走的是相同的 snapshot→clear→rewrite→replay 路徑,加了 zero-sum 安全檢查(要移除的人如果有非 0 值直接拒絕,除非 `--force`)。不加 `--user` 就等於「in-place rebuild」,用來修 format 殘留類問題,或**把新加的 settlement 區塊套用到已存在的月分頁**。呼叫方式:`docker exec -it holdem-server sh -c "cd /app/server && pnpm exec tsx scripts/drop-user-from-month.ts --month YYYY/MM [--user <id>] [--force]"`
- **結算區塊 手續費 %**(2026-08-08 起,選填):月分頁的 skeleton 加一區在 leaderboard 右邊(cols I:L, row 1 標題/總收、I2 開始 spill)—— 「當月正收益的人依 `DEV_FEE_PERCENT`% 付手續費給 `DEV_USER_ID`」。純 formula(`SORT + FILTER({name, ROUND(net*p/100)}, net>0, name<>dev_name)`),日總表數字改到哪它自己算,server 不用重寫值。dev 自己不列(排除掉他不用付自己)。**設定**:VM `.env.prod` 加 `DEV_USER_ID=<userId>`、`DEV_FEE_PERCENT=<int, 預設 10>`,兩個都空就整個區塊 no-op。**要套用到已存在的月分頁**(如 2026/07、2026/08),跑一次 `drop-user-from-month.ts --month YYYY/MM`(不帶 `--user`)觸發 in-place rebuild 就會補上。
- **失敗處理**:`syncSettlementSafely`(index.ts)把整個呼叫包在 fire-and-forget + try/catch,Sheets API 掛掉或沒設定都不會擋到、也不會讓房間結算失敗。
- **沒有跨 process 快取**:每次結算都直接讀取試算表當下的真實狀態(有哪些分頁、人員表內容、每日總表已有幾個日期欄)來決定怎麼寫,不依賴記憶體裡的假設 —— 犧牲一點 API 呼叫數換取「server 重啟也不會弄錯位置」的穩定性,對一晚頂多結算幾次房間的量來說完全夠用。

### 11.20 SNG 錦標賽模式(2026-07-26 起,v1 雛形)

`Room.roomType`(`cash`/`tournament`)區分兩種房型,現金局既有邏輯(side pot、rebuy、broadcastAfterAction 容錯)完全不受影響 —— 所有錦標賽專屬邏輯都是「先查房型,對現金局立刻 no-op」的加分支寫法,不改動既有函式的行為路徑。單桌制,app 本來就沒有多桌基礎設施。

- **不可 rebuy(freezeout)**:`rebuyChips`、`room:rebuy` handler 兩處都擋,籌碼歸零直接淘汰,沒有補碼。
- **盲注調漲**:`shared/src/index.ts` 的 `blindsForLevel`/`currentBlindLevel`/`nextBlindLevelAt`/`effectiveBlinds` 是純函式,server(`startHandForRoom`,權威)、client(標頭顯示,純顯示用)共用同一套公式算,不用額外 socket 事件同步。第 1 級 = 建房時設定的原始盲注;之後每級大盲 = 前一級 × 1.5,捨去到最近的 5,並保底 +5(避免小盲注卡住不漲)。時鐘起點 `Room.tournamentClockStartedAt` 在第一手發牌時寫入一次(`startTournamentClockIfNeeded`,道理跟現金局的 `startSessionIfNeeded` 一樣,對彼此房型自然 no-op)。
- **淘汰與名次**:`server/src/tournament.ts` 的 `processTournamentHandEnd` 在每手結束、`persistHandResult` 之後、`persistHandLog` 之前呼叫(掛在 `broadcastAfterAction` 裡)。把這手新輸光(`chipsAtTable<=0` 且還沒名次)的人指定名次 = 這手開始前還在場上(未淘汰)的人數 —— 例如 6 人局打到剩 4 人未淘汰時有人輸光,他是第 4 名。同一手多人同時輸光 → 並列同名次(v1 簡化,不用起始籌碼細分排序)。剩 1 人未淘汰且有籌碼 = 冠軍(第 1 名),整場結束:刪光 membership、房間標 closed、回傳 `SettlementSummary`(`reason:'tournament-finished'`),跟 `room:close`/session-expiry 用同一套善後(`cancelAutoAction`/`clearRoomState`/清 map/刪 HandLog/廣播 `room:closed`)。
- **主動站起 = 淘汰**:`eliminateStandingPlayer` 取代現金局的 `unseatUser`,記名次、籌碼歸零,但**保留** Membership 列(不刪除),讓最終結算還讀得到 `finishRank`,座位也會顯示「已淘汰」而不是直接空出來被別人坐(反正沒有 rebuy,空位也沒意義)。
- **晚期報名擋**:`seatUser` 如果房型是 tournament 且 `tournamentClockStartedAt` 已設定(代表已開打),直接拒絕加入。
- **結算型別**:`SettlementSummary.reason` 多一個 `'tournament-finished'`,`players[]` 多一個選填的 `finishRank`(用加欄位而非 discriminated union,`sheetsSync.ts` 跟現有兩個現金局結算組裝函式完全不用改,反正它們就是不會填這個欄位)。前端「贏家全拿」框架顯示(冠軍「贏得全部籌碼」,其他人「輸掉買入」)只是顯示概念,沒有真的獎池轉帳。
- **已知 v1 簡化**:房主中途手動 `room:close` 一個進行中的錦標賽,走現金局結算畫面(不顯示名次/冠軍),當作安全中止備案;主動站起淘汰籌碼直接消失,不會分配給還在場的其他人;沒有可配置的獎金拆分(1st/2nd/3rd 各拿多少 %),也沒有延遲報名 —— 都是「雛形」範圍外的加強項目。

### 11.21 即時戰績面板(2026-07-28 起)

`RoomDetail.standings: RoomStanding[]` 帶著房內每位成員當下的輸贏,供房間右側面板的「戰績」分頁顯示。跟現金局結算 modal 的區別:結算是**局末**才看得到、且看不到暫離者;戰績面板任何時刻都能開,而且**含暫離**(`seat === null`)成員 —— 有人站起去洗手間,他的輸贏還在榜上,不會消失。

- **資料來源**:`getRoomDetail` 直接讀 `room.memberships`(不篩 seat),映射成 `{userId, name, seat, chipsAtTable, totalBuyIn, finishRank}`,依 `chipsAtTable - totalBuyIn` 由高到低排序,server 端統一排好、client 直接 render 不用再排。
- **傳輸路徑**:走既有的 `room:detail` 事件,不新增 socket 事件。凡是會觸發 `room:detail` 廣播的時機(座位變動、rebuy、hand end 後的 `broadcastAfterAction`、`persistHandResult` 之後)都會順帶把 standings 一起送出,不用額外 tick。
- **UI**:`web/app/room/[id]/page.tsx` 的 `PanelTabs` 從 2 tab(聊天 / 本手紀錄)擴成 3 tab,`StandingsList` 用 `<table>` 顯示 玩家 / 買入 / 剩下 / 輸贏 四欄;輸贏用 `text-emerald-400`(正)/ `text-red-400`(負)/ `text-slate-500`(±0)著色;`seat === null && finishRank === null` 加「(暫離)」小字,`finishRank !== null` 加名次徽章並淡化名字色。desktop 右側 panel 與 mobile 抽屜共用同一個 component。

### 11.22 貼圖 reaction(2026-07-28 起)

房間右下角的 `😀` FAB 打開 8 個 emoji picker(`STICKER_EMOJIS`:👍😂🎉🙈💩🔥❤️😱),點一下 emit `sticker:send`,server 白名單驗證 + per-user 3s cooldown 通過就 broadcast `sticker:show` 給整房。Client 接到後推進 `stickers` state,3 秒後自動移除(對應 CSS `sticker-fly` 動畫 3s 完成)。

- **Whitelist 共享**:`STICKER_EMOJIS` 在 `shared/src/index.ts`,server 用同一份 array 驗證 emoji 合法性,前端 picker 也用它 render 按鈕,兩邊自動 lockstep。
- **Rate limit**:`stickerLastSentByUser: Map<userId, number>` 記每位 user 上次送成功的 timestamp,3 秒內再送直接**丟掉不回錯**(fun feature 不值得 popup)。Map 只有 O(user 數)個 entry,永不清理也沒事。
- **動畫**:`sticker-fly` keyframe(`globals.css`)從 `translateX(110vw)` 滑到 `translateX(-30vw)`,ease-out 3 秒,同時 scale 0.6→1.4 + 微旋轉、頭尾 opacity fade。
- **不亂跳的垂直位置**:StickerLayer 用 `hashStr(sticker.id) % 60 + 15` 算 top%(15–75),同一個 sticker.id 永遠算出同一 top,即使 React 因為 state 變動重 render 也不會 jitter。
- **全螢幕 overlay**:`fixed inset-0 z-40 pointer-events-none`,永遠不擋到底下按鈕點擊。

### 11.23 聊天跑馬燈(2026-07-28 起)

Header 底下一條 fixed-height(`h-6`)的跑馬燈,即時顯示 chat 訊息一則一則橫向捲過,**手機用戶不用主動點開聊天抽屜也能看到誰說了什麼**。走既有的 `chat:message` 事件,client 端多開一個 queue,不新增 socket。

- **實作**:`ChatMarquee` 元件接收當前顯示中的 message + 空 queue callback。每則捲完(`onAnimationEnd`)呼叫 `onDone` 清空 current,`useEffect` 看到 current 空 + queue 有東西就 pop head 成新的 current,自然接續下一則。
- **捲動時長**:`Math.max(6, Math.min(20, text.length * 0.25 + 6))` 秒,長訊息不會一閃而過。
- **CSS 動畫**:`marquee-scroll` keyframe(`globals.css`)`translateX(100% → -100%)` linear,靠 `animationFillMode: 'forwards'` 保持在最終位置直到 React unmount。
- **Queue 上限**:queue 最多留最近 20 則(`prev.slice(-19)`),爆量時掉最舊的,避免久掛的 tab 累積無限多待播訊息。
- **空 queue 空狀態**:元件永遠 render `h-6` 空 div(不管有沒有訊息),避免出現時 layout 跳動。

### 11.24 音效 cue(2026-07-28 起)

`web/lib/sound.ts` — 極簡的 audio cue player,依 event 觸發播 `deal / fold / check / call / raise / allin / street / win / myturn / time_alert` 短音效。全域 localStorage 記錄 mute 狀態(header 的 `🔊/🔇` 按鈕切換),沒設定預設有聲音。

- **音檔位置**:`web/public/sounds/{key}.mp3` 優先、找不到才退回 `{key}.wav`。功能剛做出來那幾天(2026-07-28)這個資料夾其實是空的,音效系統本身沒問題但整個靜音——2026-07-29 先補上 `web/scripts/gen-sounds.mjs` 用純 Node(無外部依賴)合成的 9 個短提示音當佔位 `.wav`(正弦波 + 淡入淡出包絡,不是真的錄音)。同一天 `sound.ts` 又改寫成 `.mp3` 優先的 fallback 機制:每個 cue 用 HEAD request 先探 `.mp3`、沒有才探 `.wav`,探測結果 cache 進 `audioPool: Map<SoundCue, HTMLAudioElement | null>`(`null` = 兩種副檔名都探不到,永久靜音;探測中用 `resolvePending: Set` 去重複)——這樣從 Pixabay/Mixkit 之類的地方下載 `.mp3` 可以直接丟進資料夾覆蓋,不用 ffmpeg 轉檔也不用刪掉原本的 `.wav` 佔位檔(`.mp3` 存在就贏)。模組載入時背景探測全部 cue,所以正常情況下第一次 `playCue` 就已經是 cache hit;真的卡在探測窗口內呼叫到才會那一次靜音。**檔案不存在就靜音,不會壞掉任何流程** —— `Audio.play().catch(() => {})` 吞掉 autoplay policy / codec 錯誤。目前 `allin.wav`、`check.mp3`、`time_alert.mp3` 是真實錄音,其餘仍是合成佔位音。
- **Autoplay policy**:iOS Safari / Chrome 都要求首次播放要在 user gesture 內。因為玩家一定會先點過「就座」或「開始牌局」等按鈕才會聽到第一個 cue,所以實際上不會被擋。真被擋的話 `.catch` 也吞掉了,不用手動 unlock。
- **Cue 對應**:
  - `game:started` → `deal`
  - `game:action-log` → 依 `actionType` 對應到 `fold/check/call/raise/allin`
  - `game:street-log` 收到新的一街 → `street`(見 §11.25;不是從 `gameState.phase` 推的,同一街不會重響)
  - `game:ended` 帶 `result` → `win`
  - 自己成為當前輪次的玩家(false→true transition,靠 `prevMyTurnRef` 去抖動)→ `myturn`
  - 現金局 session 剩餘時間 <= 3 分鐘(2026-07-30 起):`room.sessionEndsAt - now <= 3*60*1000` 時觸發一次 `time_alert`,靠 `timeAlertFiredRef` 去抖動(只播一次,直到 `sessionEndsAt` 本身變動 —— 例如新開一個 session 的房間 —— 才會重置能再播)。錦標賽房不用 `sessionEndsAt`,不會觸發。
- **Audio pool**:每個 cue key 第一次播才 lazy new `Audio()` 存進 `audioPool: Map`,之後 rewind `currentTime = 0` 重播,不重複建立 Element。

### 11.25 All-in 提前跑完全部街時,公共牌紀錄漏掉的修復(2026-07-29)

**問題**:河牌前所有人 all-in 時,`maybeAdvanceIfNoAction`(`hands.ts`)在**同一次** `applyAction` 呼叫裡同步跑完 flop→turn→river→showdown,整手只會觸發**一次** `broadcastAfterAction`,client 只收到一次 `game:state`,而且那次收到時 `phase` 已經是 `'ended'`。

舊機制是 client 端一個 `useEffect` 盯著 `gameState.phase`,只在 `phase` 剛好是 `'flop'/'turn'/'river'` 時才把公共牌 append 進本手的 history(順便觸發 `street` 音效)。All-in 跑池的情況下 `phase` 永遠不會被 client 觀察到停在 flop 或 turn(直接跳到 `ended`),導致這三街**完全沒有**被記進本手歷史紀錄 —— 重整頁面後(REST 重新 fetch 已經 persist 好的 `HandLogData.history`)看起來是對的,但當場、沒重整的即時畫面上,那手的公共牌紀錄整個是空的。音效也是同一個 bug:`street` cue 從來沒響過。

**修法**:不再讓 client 用「觀察 `gameState.phase` 變化」去猜公共牌是什麼時候翻的,改成 server 端直接把答案送過去。`server/src/index.ts` 的 `game:action` handler 跟 `runAutoAction` 現在都會在呼叫 `applyAction` **之前**先記下 `hand.history.length`(`historyLenBefore`),`broadcastAfterAction` 收到這個值後,用 `hand.history.slice(historyLenBefore)` 抓出「這次動作新增的所有 history entry」(可能是 1 個街,也可能是 all-in 跑池時一次新增 3 個),過濾出 `kind==='street'` 的部分,逐一 emit 新事件 `game:street-log`(見 §7.1)。Client 端直接訂閱這個事件 append 到 history + 播音效,不再自己用 `gameState.phase`/`community` 猜測 —— 不管一次動作觸發幾條街,都會收到對應數量的事件,順序保證跟 server 端 push 的順序一致(flop 先、river 後)。

### 11.26 All-in 跑池動畫:逐街翻牌 + 落後者翻河牌(2026-07-29)

在 §11.25 修好「街事件不會漏」的基礎上,進一步做成有懸念感的呈現:河牌前所有人 all-in 時,公共牌不再一次全部跳出來,而是照街(flop 3 張一起、turn 1 張、river 1 張)一批一批翻,河牌翻出來那瞬間額外標示目前暫居下風的玩家。

**Server(`hands.ts`)**:
- `HandState` 新增 `allInRevealPayload?: Array<{userId, name, holeCards}>` —— **純記憶體、不 persist**。`maybeRevealAllIn(hand)` 在 `advancePhase`/`maybeAdvanceIfNoAction` 每次 `dealCommunity` 之後呼叫,冪等,一旦「未蓋牌人數 > 1 且其中還能行動的 (`status==='active'`) <= 1」就把所有未蓋牌玩家的手牌記下來,之後不會再變。不 persist 的理由:all-in 跑池最後一定會走到真正攤牌,`HandEndResult.revealedHoles` 屆時本來就會完整記錄這些人的牌,這欄位只是給「還在跑池過程中」的即時畫面用。
- `computeTrailingUserId(hand)` 只有在 `allInRevealPayload` 已經設定時才會算(避免一般手牌透過這個欄位洩漏誰目前領先/落後),用 `PokerHand.solve` 算出所有未蓋牌玩家目前最佳牌,再用 pokersolver 的 `loseTo`(完整 kicker 比較,不是只比較粗略的 `.rank`)找出真正「輸給全部人」的那位;平手(含還沒開牌前 `community.length===0` 一律回傳 `undefined`)時取座位序在前的,跟既有 side-pot 平手處理一樣簡化。
- 兩個 push `{kind:'street'}` history 的地方都在 push 前呼叫 `maybeRevealAllIn` + `computeTrailingUserId`,把 `trailingUserId` 一併存進該街的 history entry。

**Shared 型別**:`HandHistoryEntry` 的 street 變體加 `trailingUserId?: string`;新增 `game:allin-reveal` 事件(`{players: Array<{userId,name,holeCards}>}`,整手只會收到一次);`game:street-log` payload 也帶 `trailingUserId?`。

**Server 廣播(`index.ts`)**:`game:action` handler / `runAutoAction` 在呼叫 `applyAction` 前多記一個 `hadAllInReveal = !!hand.allInRevealPayload`(跟既有的 `historyLenBefore` 是同一個「動作前快照」套路),`broadcastAfterAction` 用 `!hadAllInReveal && hand.allInRevealPayload` 判斷要不要 emit `game:allin-reveal`(保證整手只送一次),`game:street-log` 迴圈額外帶上 `trailingUserId`。`startHandForRoom` 也補了同一個 emit —— 涵蓋短籌碼盲注就直接讓全員 all-in、`startHand` 內部一開局就觸發跑池的極端情況。

**Client(`web/app/room/[id]/page.tsx`)**:
- 新增 `displayedCommunity` state,取代畫面正中央公共牌顯示原本直接讀的 `gameState.community`。`game:started`(含重連/重整)時**立即**設成當下真實盤面,不做動畫——重連這個 client 早就錯過了對應的 `game:street-log` 事件,沒有東西可以重播,直接顯示正確現況才對。`game:street-log` 進來時改成推進一個 `useRef` 佇列(`streetQueueRef`),用 `streetPlayingRef` 旗標 + `setTimeout` 鏈(`playNextQueuedStreet`)每 700ms 取一組出來才真的 `setDisplayedCommunity` + 播 `street` 音效,街與街之間看得出停頓。700ms 這個延遲對一般沒人 all-in 的手牌來說遠短於真人思考時間,不會有感。
- 新增 `allInReveal: Map<userId, [Card,Card]>`,由 `game:allin-reveal` 整包覆蓋(立即顯示、不用動畫)。座位卡原本只有「真正攤牌後」才會顯示 `reveal`,現在多一個 fallback:沒有真正 `revealEntry` 時退回查 `allInReveal`——牌型標籤(`revealHandRank`)刻意不跟著提前顯示,留到真正攤牌才出現,前端也沒有另外算牌力。
- 新增 `revealingSeatUserId` state:street-log 佇列處理到 `phase==='river'` 且該 entry 帶 `trailingUserId` 時設定,~1.8s 後自動清空。`SeatCard` 新增 `isRevealingRiver` prop,套用紅色邊框 + `animate-pulse`(Tailwind 內建,沒加新 CSS keyframe)+ 「翻牌中...」文字。
- 已知簡化:重連/重整期間如果剛好錯過 `game:allin-reveal`,提前公開的手牌看不到(要等真正攤牌才看得到,跟修這個功能之前的行為一樣,不是回歸);多人平手「暫居下風」只用座位序決定顯示誰,不做並列標示。
- **上線後修的 bug**(2026-07-29):`playNextQueuedStreet` 原本寫成 `setDisplayedCommunity(prev => [...prev, ...next.cards])`,誤把 `next.cards` 當成「這一街新翻的牌」去 append。實際上 `game:street-log` 的 `cards` 是 `hand.community.slice()`,**每次都是當下累積的完整公共牌**(flop 送 3 張、turn 送 4 張、river 送 5 張,不是新增的 1 張)——結果桌面公共牌區變成 3+4+5=12 張疊在一起(K6♦3♦ 出現三次、逐漸變長)。修法是直接 `setDisplayedCommunity(next.cards)`(取代,不是 append),跟 `game:started` 設定當下快照的語意一致。

### 11.27 座位即時動作回饋(2026-07-29)

**問題**:座位卡在 all-in / 蓋牌之外沒有任何「剛剛發生了什麼動作」的即時提示——`bet {bet}` 這行只在該玩家這輪有真的下注時才顯示,過牌(check)不會讓 `bet` 變成非零,所以過牌時座位卡上完全沒有任何變化,直接輪到下一位,玩家反饋是「check 沒有顯示,直接跳下一家」。動作紀錄(`actionZh` / `ACTION_ZH`)雖然存在,但只用在「歷史」分頁裡,而且那個分頁在手牌進行中會被 `inProgress` 擋住只顯示「本手進行中...」的提示文字,不會即時列出動作,所以座位上的視覺回饋是唯一即時管道,卻剛好漏了 check 這個 case。同時 `bet {bet}` 不分加注還是跟注一律同一個顏色(emerald),玩家也反應想要用顏色區分「主動加注/all-in」跟「單純跟注」。

**修法**:新增 `lastActionBySeat: Record<seat, ActionLogEntry['actionType']>` state,由既有的 `game:action-log` 事件(本來就會為每個動作觸發一次,用來播音效跟寫歷史)順便更新;在 `game:street-log`(新的一輪開始,舊動作標籤已經過期)跟 `game:started`(新的一手)時清空。`SeatCard` 新增 `lastActionType` prop:
- `lastActionType === 'check'` 時顯示一個獨立的「過牌」灰字標籤(不管 `bet` 是不是 0 都會顯示,例如 BB preflop check 時 `bet` 還是盲注金額,兩個標籤會一起出現)。
- `bet {bet}` 這行的顏色改成依 `lastActionType` 決定:`raise`/`all-in` → 紅色(`text-red-400`),其他(call、blind 入池但還沒真的行動過)→ 維持原本的 emerald。

FOLD / ALL-IN 本來就有靠 `status` 算出來的持久標籤(不受這輪動作重置影響),不受這次改動影響,`lastActionType` 只補 check 跟顏色這兩個缺口。

### 11.28 閒置連續兩次自動過牌/棄牌 → 強制站起(2026-07-29)

**規則**:同一位玩家「因逾時被 server 自動代打」連續兩次(中間沒有任何一次是自己真的點按鈕),就強制站起——現金局比照 §11.17 的暫離規則(`seat` 設回 `null`,籌碼保留,可隨時坐回來);錦標賽比照 §11.20 的淘汰規則(視同主動站起 = 淘汰,`chipsAtTable` 歸零、記錄名次)。任何一次「真的自己按按鈕」的動作都會把這個連續計數歸零。

**Server(`index.ts`)**:
- `idleStreakByRoom: Map<roomId, Map<userId, number>>` 記錄「連續」被 `runAutoAction` 代打的次數,**跨手牌保留**(不是每手歸零)——因為要抓的是「這人根本不在電腦前」,不是「這手剛好沒空」,folded 就沒有下一次可以行動,只有下一手才能再犯規。`game:action` handler(真的收到玩家點擊)跟 `room:standup`(玩家自己站起)都會呼叫 `resetIdleStreak` 歸零。
- `runAutoAction` 每次代打後 `bumpIdleStreak`,達到 `AUTO_ACTION_STANDUP_THRESHOLD`(= 2)就觸發強制站起。用當次送出的 `action.type` 判斷(不是讀 mutate 後的 `cur.status`,避免 TS narrowing 誤報,而且語意上更直接):
  - 代打結果是 `fold` → 這位玩家已經蓋牌,跟 §11.17 允許蓋牌者 mid-hand 站起是同一個安全前提,直接呼叫共用的 `forceStandUp(roomId, userId)`。
  - 代打結果是 `check`(還在牌局裡、狀態仍是 `active`)→ 現在站起會把還在場上的玩家拉走,不安全,改成 `queuePendingForcedStandup` 排進 `pendingForcedStandupByRoom: Map<roomId, Set<userId>>`,等 `broadcastAfterAction` 偵測到這手結束(`ended` 分支)時,跟既有的 `drainPendingRebuys` 同一個位置呼叫 `drainPendingForcedStandups` 套用——這個時間點手牌已經結束,站起絕對安全,而且早於 client 有機會請求開下一手,沒有 race。
- `forceStandUp(roomId, userId)` 是從原本寫在 `room:standup` handler 裡的邏輯抽出來的共用函式(現金局呼叫 `unseatUser` + `finalizeRoomState`;錦標賽呼叫 `eliminateStandingPlayer`,賽事因此結束的話一路 teardown 到 `room:closed`),`room:standup` handler 現在只保留「牌局進行中必須已蓋牌才能站起」的權限檢查,實際動作呼叫同一個函式——手動站起跟被強制站起走的是完全相同的一條路徑,行為保證一致。
- `resetIdleStreak` 除了清 `idleStreakByRoom`,也會順便清掉 `pendingForcedStandupByRoom` 裡對這個人排的隊——同一手裡如果先被排進強制站起佇列(check 觸發),後來又真的自己動作了一次(證明人回來了),那筆排隊會被取消,不會等到手牌結束還被莫名其妙站起來。
- `idleStreakByRoom` / `pendingForcedStandupByRoom` 在所有既有的「房間狀態整個清掉」的地方(`finalizeRoomState`、`broadcastAfterAction` 的錦標賽結束分支、`forceStandUp` 的錦標賽結束分支、`room:close`)都比照 `pendingRebuysByRoom` 一起 `.delete(roomId)`,避免長期掛著空房間的殘留資料。

**已知簡化**:被強制站起的玩家目前沒有專屬的提示訊息(例如「你因閒置太久被移出座位」)——房間的 `room:detail` 會照常廣播座位變化,前端看得到自己的座位變空,但沒有額外解釋原因;之後有需要再補。

### 11.29 Google Sheet 停用玩家(2026-08-03 起)

**情境**:有玩家不再參加(退出、換帳號…),需要讓他**從未來的月分頁完全消失**,同時**歷史月分頁的資料一格都不動**。

**用法**:去 Google Sheet 的「人員」分頁,對想停用的那一列在 **D 欄(`停用`)** 填任何非空值(`V` / `1` / `TRUE` / `停用` / 勾選框都可),存檔就好。**不要動 A/B/C 欄,尤其不能刪整列**(刪列會讓所有月分頁的名字公式錯位,見 §11.19 開頭警告)。

**Server 邏輯**(`sheetsSync.ts`):
- `RosterEntry` 加 `hidden: boolean`,`getRoster` 讀 D 欄用 `Boolean(r[3])` 判斷(任何 truthy 都算停用)
- `ensureRosterTab` 每次呼叫都寫一次 4 欄 header(冪等),自動 backfill `停用` 欄名到舊 sheet
- `syncSettlementToSheet` 算出 `activeRoster = fullRoster.filter(!hidden)`,把兩個 roster 都傳給 `ensureMonthTab`
- `ensureMonthTab`:
  - **建新月分頁**(該月首次結算):用 `activeRoster` 當 N,停用者**完全沒有那一列**
  - **既有月分頁**:讀 tab 的 N_old,只在有**新的未停用**玩家超過 N_old 時 rebuild(新的停用玩家不觸發 rebuild)。已存在的列**絕不縮減**——包含現在被標停用的舊玩家,他們的歷史仍完整
- `rebuildMonthTab`:保留 N_old 原本所有列(含現在被停用的人),只 append 新的**未停用**玩家。停用者的名字在該 tab 是 `=人員!B<row>` 公式,你在人員表把他改名成什麼就顯示什麼(建議改成 `—` 或空白仍留一個字讓 N_old 偵測不誤判)
- 停用者未來的結算:玩家不會再登入 = server 不會收到他的結算 payload = 他的列一路 0(在既有月分頁中)。新月分頁根本沒他

**已知邊界**:停用者的**顯示名稱不能完全空白**——`ensureMonthTab` 讀 N_old 靠掃 B2:B50 的非空 cell,如果他的名字被改成純空白,月分頁對應列的公式會回傳空字串,N_old 計數會提前停止、後面所有列被當成不存在。改成 `—` / `已停用` 之類任何非空字串就好。

### 11.30 Time bank(2026-08-07 起)

**概念**:每個玩家除了現有的基本行動時間(`Room.actionTimeoutSeconds`,例如 30 秒)之外,還有一份**個人時間銀行**(60 秒)。基本時間**不會自動延伸**——玩家要在剩 ≤5 秒時**手動按「⚡ 延時」按鈕**才啟用。啟用等於「開放**最多**再多 30 秒可用」,實際扣多少 bank 取決於他真的思考多久:按下後 5 秒內就 act → 只扣 5 秒;想到 auto-action 才觸發 → 扣滿 30 秒(或當時 bank 剩下的量)。同一 turn 只能按一次;沒按就照舊到時間 auto-fold/check。

**規格 v1**:
- 池子大小 = 60 秒 / 玩家,**全站固定**(不在建房 UI 開變數)
- 每次啟用 deadline 立刻加 `addedMs = min(30 秒, 剩餘 bank)`;bank 當下**不扣**
- 該 turn 結束時(自己 act 或 auto-action 觸發)才扣真實用量:`spent = min(TIME_BANK_MAX_EXTEND_MS, max(0, elapsed - baseMs))`
- **手動觸發**:剩 ≤5 秒時才浮出按鈕,按下去 deadline 立刻跳、按鈕消失
- **不回補**:用完就沒,只有 `clearRoomState`(空房自動關 / owner close / session-expire / 錦標賽結束)才歸零
- 現金局跟錦標賽規則一樣

**Server(`hands.ts`)**:
- 常數 `TIME_BANK_INITIAL_MS = 60_000`、`TIME_BANK_MAX_EXTEND_MS = 30_000`
- 模組狀態 `timeBankByRoom: Map<roomId, Map<userId, number>>`(ms),跨手保留 —— 只有 `clearRoomState` 會 `.delete(roomId)`
- `HandState.turnStartedAt: number | null` —— 當前 turn 起算時間,`refreshDeadline` 換手時設 `now`,用來算實際 elapsed
- `HandState.currentTurnExtended: boolean` —— 標記當前 turn 已按過延時,`refreshDeadline` 每次換手都重設為 `false`。這樣一個 turn 只能按一次(reopen action 讓同一位再輪次算新 turn,可以再按)
- `refreshDeadline(hand)` 只設 base timeout(`now + actionTimeoutSeconds * 1000`),**不自動加 bank**。同時設 `turnStartedAt = now`、`currentTurnExtended = false`
- `extendCurrentTurn(roomId, userId): ExtendTimeBankOutcome` —— 驗證(hand 存在、非 ended、輪到 userId、`!currentTurnExtended`、bank > 0)→ `addedMs = min(30_000, bank)` 加到 `hand.deadline` → 設 `currentTurnExtended = true`。**不扣 bank**
- `consumeExtensionForCurrentTurn(hand, roomId)`:在 `applyAction` **advance 到下一位之前**呼叫。只有 `currentTurnExtended` 為 true 時才動作:算 `elapsed = now - turnStartedAt`、`overBase = elapsed - baseMs`、`spent = min(30_000, max(0, overBase))`,從 bank 扣。因為 `deadline = turnStartedAt + baseMs + addedMs` 且 auto-action 最晚在 deadline fire,所以 `elapsed ≤ baseMs + addedMs`,`overBase ≤ addedMs ≤ 30_000` —— 自然上限,不會扣超過該次啟用允許的量
- `HandStatePublic` 帶 `currentTurnExtended`,每個 `HandPlayerPublic` 帶 `timeBankMs = getTimeBank(roomId, p.userId)`
- 沒有 DB persistence —— server 重啟 bank 歸零(跟 HandState 一樣是記憶體)

**Server(`index.ts`)**:
- 新 socket handler `game:time-bank`(`{roomId}`, cb):呼叫 `extendCurrentTurn` → 回傳 ack → `resetIdleStreak`(按按鈕算作真的在互動,跟 `game:action` 同等)→ `rescheduleAutoAction`(deadline 移遠了,要重排 timer)→ 廣播新的 `game:state`

**Client(`web/app/room/[id]/page.tsx`)**:
- 浮動按鈕(`fixed bottom-24 left-1/2`,pulse 動畫),只在**同時**滿足以下四個條件時渲染:
  1. `itsMyTurn`
  2. `!gameState.currentTurnExtended`
  3. `myHandPlayer.timeBankMs > 0`
  4. `Math.ceil((deadline - now) / 1000) <= 5`
- 按下 emit `game:time-bank`(server 會回廣播 `game:state`,`currentTurnExtended` 變 true → 按鈕自然消失,timer 也跳到新的 deadline)
- `SeatCard` 有 `timeBankMs?` + `extended?` 兩個 prop:座位卡下方常駐顯示 `TB Xs`(bank 剩多少 —— 這個數字在 turn 進行中不會即時扣,要等 turn 結束才更新);當前玩家如果已延時,計時字改紫色 + `⚡`
- `ActionBar` 也有 `extended` prop:標題從「輪到你行動」→「⚡ 時間銀行」提示這段是延伸時間
- 音效 cue `timebank`(`web/lib/sound.ts`):client 監聽 `gameState.currentTurnExtended` 的 false→true edge,用 ref 去抖動,啟用瞬間全房播一次

**跟 §11.28(閒置強制站起)的互動**:按下延時按鈕會 `resetIdleStreak`(跟真的下注同樣算「有互動」)。如果玩家延時完仍然無操作到過期,`runAutoAction` 一樣 fire,idle streak 一樣 +1 —— 邏輯完全共用,不用改。

### 11.31 個人屏蔽 + 4-color deck(2026-08-08 起)

兩個純 client-side 的個人化 UI 選項,共用 `web/lib/prefs.ts` 存 localStorage、不上 server。

**屏蔽**:玩家 A 可以在自己畫面把玩家 B 的內容藏起來,B 完全不知道也沒被禁言 —— 只是 A 看不到而已。實作:
- Storage key `holdem:blocked-users`,存 `BlockedUser[] = {userId, name}[]`;name 存起來給「管理」清單顯示
- `RoomPage` 頂層 state + `blockedIdsRef`,socket handler 用 ref 讀最新集合(不然改屏蔽要重掛 handler)
- **Chat**:訊息全部存進 `messages` state(解除屏蔽可以往回翻歷史訊息),渲染時 `.filter(m => !blockedIds.has(m.userId))`
- **跑馬燈 / 未讀計數 / 貼圖**:在 socket handler 早期就 `if (blocked) return;`(這些是 transient,不用留 replay)
- **UI**:聊天訊息的名字改成 `<button>`(自己名字不加,onNameClick 傳 null 就自然變 span),點下去開 `BlockPopover`(全螢幕居中 confirm 對話框);聊天欄下方常駐 `已屏蔽 N 人 [管理]` 小字(count > 0 才顯示),點管理開 `BlockManageModal` 逐一「解除」
- **不涵蓋**:座位卡的名字沒改成可點(避免每個座位都變按鈕、也避免手誤在牌桌上點到);要屏蔽只能透過聊天訊息點名字

**4-color deck**:♠♣ 兩個都是黑色容易搞混(玩家回報),加一個 header toggle 切成 4 色。實作:
- Storage key `holdem:4color-deck`,預設 `true`(這功能本來就是要修這個回報,預設開)
- 顏色:♠ 黑、♥ 紅、♦ **藍**、♣ **綠**(PokerStars 標準)
- 因為 `CardView` / `InlineCard` 有 8 個 call site(有些包在 `SeatCard` / `HistoryList` 裡),避免 prop 一路傳,用 `FourColorContext` 在 `RoomPage` 頂層 provide,兩個 card 元件 `useContext` 讀
- Header 加 `🎨 4色 / 🎨 2色` toggle 按鈕(mute 旁邊)

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
| `GOOGLE_SHEETS_SA_KEY` | 選填,見 §11.19。Service account JSON 金鑰整份 base64 編碼成一行 |
| `GOOGLE_SHEETS_SPREADSHEET_ID` | 選填,見 §11.19。留空則整個 Sheets 同步功能自動關閉 |

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
