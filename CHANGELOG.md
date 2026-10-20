# Changelog

所有值得記錄的變動都記在這裡,新的在最上面。日期是 commit 當天(UTC+8),不是嚴格的版本號。

## 2026-10-20

這一天量非常大(18 commits,跨安全 / 體質 / UI / 重構 / 資料庫),分區標題跟 2026-07-28 一致。全部純技術打磨 + 修 audit 發現的洞,無新遊戲功能。完整審查報告見 [`docs/AUDIT_2026-10-20.md`](docs/AUDIT_2026-10-20.md)。

### 安全性(F batch,3 批)

- **底牌 IDOR**(`c2b7891` C1):`/api/rooms/:id/hands` 加 `Membership` 檢查,之前任何登入者只要知道 `roomId` 就能看別房 showdown 底牌 + 完整下注紀錄 —— 現在非該房成員回 403。
- **Socket JWT 拆成獨立 secret**(`c2b7891` C4):`NEXTAUTH_SECRET` 原本同時簽 Auth.js session + Socket.IO 握手,拆成獨立的 `SOCKET_JWT_SECRET`,`jwt.verify` 也 pin `algorithms: ['HS256']` 擋 algorithm-confusion。
- **Google Sheets formula injection**(`c2b7891` L6):暱稱設 `=IMPORTRANGE(...)` 類公式,sync 到 roster 時原本會變成活公式竊取整張表(因為用 `valueInputOption: 'USER_ENTERED'`),加 `sanitizeSheetCell` 偵測 `=/+/-/@` 開頭 prefix `'` 強制當 literal。
- **`scanExpiredSessions` Map leak**(`c2b7891` R2 bug):4 處 room teardown 應該清 7 個 per-room Map,`scanExpiredSessions` 漏掉 3 個(`pendingRebuysByRoom` / `idleStreakByRoom` / `pendingForcedStandupByRoom`)—— session 過期的房 Map entry 永久 leak。補齊。
- **Rate limits**(`b4caf73` C2/C3):`/api/rooms` POST per-user 30 秒 cooldown;Socket `chat:send` / `game:action` / `game:time-bank` / `room:rebuy` / `room:join` 都加 token-bucket rate limit。
- **`game:end` 中途砍手阻擋**(`b4caf73` H3):房主在手牌進行中按結束 → committed bets 跟著 `hands.delete(roomId)` 被砍、不入 ledger(可能被用來免費洗手)。現在擋 `hasActiveHand`,訊息「目前有牌進行中,等本手結束再試」。
- **Caddy security headers**(`b4caf73` M1):HSTS / X-Frame-Options:DENY / X-Content-Type-Options / Referrer-Policy。
- **`sheetsSync` mutex + fetch timeout**(`b4caf73` R3):兩房 30s 內關閉會 race,`getRoster` 兩邊都讀到 N 然後都分 slot N+1 給不同新 user,其中一人變 orphan 把 month tab 弄壞。加 per-spreadsheet Promise queue + 每個 fetch `AbortSignal.timeout(10_000)`。
- **Socket zod schema**(`b6864c6` M2):5 個高風險事件(`game:action` / `room:rebuy` / `chat:send` / `sticker:send` / `room:join`)入口 `safeParse`,discriminated union 幹掉 NaN / Infinity / float / negative raise amount 在 boundary 層。
- **Socket token TTL** 從 5 分鐘縮到 60 秒(`b6864c6` H2);**pokersolver 鎖版** `^2.1.4` → `2.1.4`(M8);**jwt error 訊息 generic 化** 不洩庫 internals(L1);**sticker cooldown 改成 per-(user, room)**(M3)。
- **跳過 H1** Google OAuth `email_verified` check —— 10 人朋友圈 threat model 不需要擋 stranger preregistration takeover(audit doc 已標 skipped)。

### 程式體質(A batch,3 批)

- **A-1 refactor**(`0724d4f`,純結構無行為變化):
  - 抽 `dealNextStreet()` 消除 `advancePhase` 和 `maybeAdvanceIfNoAction` 兩份一樣的 phase table + reveal + history-push。
  - 5 個 per-room transient Map(autoActionTimer / lastHandLogId / pendingRebuys / idleStreak / pendingForcedStandup)收攏成 `RoomRuntimeState`,`disposeRoomState(roomId)` 取代原本 5 行 teardown。
  - 拆 `broadcastAfterAction` 165 行 God-function 成 `handleHandEnded` + `teardownRoom` + 剩下的 orchestration。teardown 三處(`finalizeRoomState` empty / `room:close` / `scanExpiredSessions`)共用 `teardownRoom`。
- **A-2 TS tightening + simplify**(`dccbea1`):
  - `isHandLogData()` 結構驗證,HandLog.data 3 處 cast site 替換 —— 歷史資料跟 shared type 不符的 row 用 warn log 跳過不交給 render。
  - `persistHandResult` `updateMany` → `update` 走 composite key,membership 消失(tournament bust mid-hand)不再 silently `count:0`。
  - `applyAction` raise 加 `Number.isInteger` boundary check。
  - `StartHandOutcome` 錯誤分支改成 discriminated union(`kind: 'not-found' | 'already-in-progress' | 'session-expired' | 'too-few' | 'needs-rebuy'`),加新錯誤 compiler 會逼人處理。
  - S1 刪 `endHand`(跟 `clearRoomState` 重複);S4 preflop `evalHandRank` 回 `''`(2 張牌寫 "Pair"/"High Card" 無資訊);S2 inline `isEnded` **嘗試後 reverted**(TS narrowing 擋,wrapper 存在就是為了這個)。
- **A-3 defensive**(`6708d88`):
  - Vitest 進 server workspace,`hands.test.ts` 覆蓋 `buildSidePots`(6 case)+ `blindsForLevel`(4 case),10/10 pass。
  - Pino structured logger `server/src/logger.ts`,server 內 27 處 `console.*` 轉成帶 `roomId` / `userId` / `handNumber` / `err` 的 JSON log。線上 docker log 可以 `grep` 特定房的事件。

### UI 美感 + a11y(U batch,4 批)

- **U-1 palette tokens + a11y quick wins**(`dd8cbcc`):`tailwind.config.ts` 加 6 色 token(felt / rail / bg / surface / bone / brass),鋪 U-2 的視覺大改。6 個金額 input 加 `inputMode="numeric"` 強制手機叫數字鍵盤;chat input 加 `enterKeyHint="send"`;全站 `focus-visible` 金色 outline;iOS Safari 聚焦 input 自動放大問題用全域 `input { font-size: 16px }` 擋掉。
- **U-2 視覺 Top 3**(`7be9cd0`):牌氈改用徑向綠漸層 + 暖木紋邊 + 內陰影;body 從 slate-950 的 "Vercel 預設黑" 改成 `#0F1613` 暖色深 + bone 文字減螢幕眩光;卡牌 CardView + InlineCard 加紙質漸層 + 內高光 + 掉落陰影,看起來像物理牌不是 inline table cell。
- **U-3 modal `<form>` + Esc + 熱鍵**(`44e04bc`):`useEscape` shared hook,8 個 modal 都加;RaiseModal / RebuyModal 包 `<form>` 讓 Enter 提交;8 個 modal 加 `role="dialog"` + `aria-modal` + `aria-labelledby`;ActionBar 內鍵盤 F / C / R 熱鍵(自己回合時觸發,聊天輸入焦點時停用),按鈕右邊有 `KbdHint` 小徽章(桌面才顯示)。
- **U-4 polish**(`aa744ee`):底池改大金字 + 底下「底池」小字 tracked-widest;座位籌碼改金色 tabular-nums + `.toLocaleString()`;Fold / Call / Raise 重分權重(ghost / felt / brass hero)+ 48px thumb target;翻前 3 張紅色對角線條紋牌背佔位;CardView 300ms flip-in 動畫 + `prefers-reduced-motion` honor;4 處 panel 統一 `rounded-lg border-amber-900/30 bg-surface/60`;延時按鈕 purple → brass + rail palette;lobby 錦標賽房左側 `border-l-4 border-brass` 金條。

### 大重構(R batch,3 批 + 2 features)

- **R-1 新 feature + safety**(`ce31712`):
  - `TurnIndicator` 牌桌上方浮條顯示「輪到 Alan · 25s」/「輪到你 · 25s」,倒數 ≤5 秒變紅,`aria-live="polite"`。
  - `SidePotsPanel` 當側池 ≥2 層才出現,列「主池 $N 可爭 Alice、Bob」/「邊池1 $N 可爭 Alice」—— 不再有「我 all-in 怎麼只拿到部分 pot」的疑問。
  - `ErrorBoundary` 包牌桌主區塊,子組件 throw 時顯示「畫面載入出錯」+ 重試 / 重載按鈕,header + chat FAB 不受影響。
  - `computeSidePots` 進 `@holdem/shared`(搭配 R-1b 需要在 client 算),server 現有 vitest 加 4 個 test case,總計 14/14 pass。
- **R-2 Design system**(`c4b5cd5`):`web/components/ui/{Button, Panel, Modal}.tsx`。Button 4 variants(primary / secondary / ghost / danger)× 2 sizes;Panel 一致的鍍金邊暖面;Modal 內建 useEscape + role=dialog + useId 的 aria-labelledby。Lobby 的 header / room list / NicknameModal / CreateRoomModal 都轉用。
- **R-3a file split**(`6427914`,純搬動 811 行 code 無行為變化):`room/[id]/page.tsx` 從 3100 行縮到 2300 行,抽出:
  - `_lib/FourColorContext.ts` + `_lib/utils.ts`(10 個 pure fn + 2 shared type)
  - `_components/CardView.tsx`(CardView + InlineCard + suitColorClass)
  - `_components/SeatCard.tsx`
  - `_components/ActionBar.tsx`(ActionBar + RaiseModal + KbdHint)
  - `_components/RebuyModal.tsx`
  - `_components/TableOverlays.tsx`(TurnIndicator + SidePotsPanel)
- **R-3b state refactor + 效能**(`fd10d71`):
  - `_hooks/usePokerState.ts` `useReducer` 收攏 4 個耦合 state(gameState / holeCards / handRank / displayedCommunity)+ 5 個 action type。Socket event handler 從 7 行 `setX` 變 1 行 `dispatchPoker`。
  - `React.memo` on `SeatCard` —— 一個 `game:state` 不再 re-render 全部 10 張座位卡(audit P1)。
  - `useMemo` for `computeRingPositionsPercent(room.maxPlayers)` 避免每次 game:state tick 重算 10 個三角函數。
  - `useMemo` for `visibleMessages` —— 聊天 filter 不再每 render 跑兩遍(desktop + mobile)(audit P2)。

### 資料庫(E batch,4 批)

- **E-1 刪 HandLog 多餘 index**(`418d68b`):`@@unique([roomId, handNumber])` 已經是複合 index,再加 `@@index` 多此一舉。
- **E-2 (option A) `User.chipsBalance` 重分類為 reserved**(`48c9b46`):Pre-drop snapshot 發現 3 位用戶的值不是 default 10000(10228 / 8772 / 11000)—— 歷史上被寫過;且 `ARCHITECTURE.zh-TW.md §11.19` 明確保留此欄位給未來跨房 chip tracking。改成 schema 註解標 "reserved",audit M4 reclassified。
- **E-3 文件化 index + retention**(`418d68b`):`ARCHITECTURE.zh-TW.md §5.4` 寫清楚 unique = index、HandLog 在 room close 時由 `deleteHandLogsForRoom` 刪(無額外 TTL)。
- **E-4b `prisma db push` → `prisma migrate deploy`**(`1bc5990 + 674dde4`):
  - 原本 Dockerfile 的 `prisma db push --accept-data-loss` 遇到 schema 不一致會**靜默丟資料**(典型場景:schema.prisma typo 看起來像 column rename → prod 整欄資料瞬間消失)。
  - 從現有 schema 產出 `db/prisma/migrations/0_initial/migration.sql` baseline(150 行 SQL),Dockerfile CMD 改成 `prisma migrate deploy`。
  - Prod 用 `prisma migrate resolve --applied 0_initial` 標記 baseline 已套用 —— 之後 server 重啟看到 `No pending migrations to apply` 直接 boot。
  - DEPLOY.md §6.1 新增 schema-changes workflow 章節:改 schema 要 `prisma migrate dev --name xxx` 產 migration 檔,commit 連 schema + migration 一起,rebuild 時 server 自動套用,失敗則**不開機**(loud 不 silent)。

### 其他

- **稽核報告**:[`docs/AUDIT_2026-10-20.md`](docs/AUDIT_2026-10-20.md) 這天的所有 fix 都對應到裡面的 ID。
- **測試覆蓋**:server workspace 現有 14 個 vitest case 保護 `buildSidePots` + `blindsForLevel` + `computeSidePots`。CI 還沒接 —— 下次改 `hands.ts` 時 `pnpm test` 要手動跑。
- **ARCHITECTURE.zh-TW.md** 這天跟著更新了 §3 技術棧、§5.4 HandLog index + retention、§12 環境變數(拆出 `SOCKET_JWT_SECRET`)、Socket 握手序列。
- **延後決定** / 保留的小項目:中文 UI「習禁屏」字詞是否 typo、Fold / Raise / Call 按鈕順序是否要重排、next/font 載入 Noto Sans TC + Inter、SettlementModal 大贏/大輸 highlight、client 端 React vitest。

## 2026-08-08

- **個人屏蔽**:在聊天訊息**點名字**可以屏蔽該玩家 —— 純個人化,只影響自己畫面(對方不知道也沒被禁言,只是我看不到)。涵蓋:聊天訊息、跑馬燈、貼圖(貼圖飛過螢幕都不會出現)。聊天欄下方會顯示「已屏蔽 N 人 [管理]」,點「管理」可以解除。屏蔽紀錄存 localStorage,清 cookies / 換裝置會消失(不 sync)。細節見 §11.31。
- **4-color deck(4 色牌組)**:有玩家反映 ♠ ♣ 兩個都黑色容易看錯,加了 header toggle 切成 PokerStars 風的 4 色(♠ 黑 / ♥ 紅 / ♦ **藍** / ♣ **綠**)。**預設開**,想切回傳統 2 色用 header 的 `🎨 4色 / 🎨 2色` 按鈕,選擇存在自己的 localStorage。細節見 §11.31。

## 2026-08-07

- **Time bank(時間銀行)**:每位玩家有一份 **60 秒**個人時間銀行,基本時間**不會自動延伸**——剩 ≤5 秒時螢幕會浮出「⚡ 延時」按鈕。按下去等於「開放最多再多 30 秒可用」,實際扣多少 bank 看真的思考多久:按下後 5 秒內就 act → 只扣 5 秒;想到 auto-action 才觸發 → 扣滿 30 秒。同一 turn 只能按一次,沒按就照舊到時間 auto-fold/check。全站固定 60 秒、不回補、跨手保留、現金局/錦標賽規則相同。按延時 = 互動,會 reset §11.28 idle streak。全房會播 `timebank.mp3` 音效通知。細節見 `ARCHITECTURE.zh-TW.md` §11.30。

## 2026-08-03

- **Fix physical-roster bug + drop-user maintenance CLI**:設計上一直有個潛在 bug —— `rebuildMonthTab` / `snapshotMonthTab` 用 `fullRoster.slice(0, N_old)` 假設 tab 第 N 列對應 slot N,drop 過的 tab 就不成立(dropped slot 留下 gap,實際物理列跟 slot 序不再對齊)。今天新加的 `drop-user-from-month.ts` CLI 第一次觸發這個 bug,把 2026/08 corrupt 掉(竹北車銀優消失、加演拿到 Sheng 的 1143、slot 3 停用者拿到 北海道 的 -3010)。修法:新增 `readPhysicalRoster` 從 tab 的 column B `=人員!B<row>` 公式反解出實際 slot 順序,`rebuild` / `snapshot` / `removeUsers` 都改吃 physicalRoster。同時 `clearAllValues` 也順便補了 `userEnteredFormat` 一起清(否則 date format 會殘留讓數字顯示成日期,見 §11.19)。CLI 使用方式與 zero-sum 安全檢查見 §11.19。2026/08 已用一次性 `restore-2026-08.ts` 從 server log 印出的 pre-drop snapshot 復原完成。
- **Google Sheet 停用玩家**:「人員」分頁加第 4 欄 `停用`,填任何非空值(`V` / `1` / `TRUE` / 勾選框皆可)就把這個玩家從**未來新建的月分頁**完全排除。已存在的月分頁不動(歷史保留),停用者的行仍在原本位置(名字改什麼就顯示什麼),沒新資料就一路 0。用途:有人退出、換帳號時,新月不再顯示他,舊月完整保留。細節見 `ARCHITECTURE.zh-TW.md` §11.29。**⚠️ 一樣不能刪「人員」的整列**(會讓所有月分頁名字公式錯位)。

## 2026-07-30

- **新增 time_alert 音效**:現金局 session 剩餘時間 <= 3 分鐘時播放一次提示音,提醒大家房間快自動結算了。錦標賽房不受影響(不用 `sessionEndsAt`)。細節見 `ARCHITECTURE.zh-TW.md` §11.24。

## 2026-07-29

- **下一手自動開始倒數 8 秒 → 4 秒**:`AUTO_MS` 縮短一半,手牌結束後等比較短就自動開下一手。
- **修正跑池公共牌疊成一長排的問題**:上線後發現逐街翻牌動畫(§11.26)桌面公共牌區會疊成 12 張(K6♦3♦ 出現三次)——`game:street-log` 的 `cards` 其實是當下累積的完整公共牌(flop 3 張、turn 4 張、river 5 張),不是新翻的那幾張,client 卻寫成 append,三街疊起來變 3+4+5=12 張。改成直接取代(跟 `game:started` 設快照同一個語意),不再 append。
- **音效 `.mp3` 自動 fallback**:`sound.ts` 從寫死 `.wav` 改成先找 `.mp3`、找不到再退回 `.wav`(HEAD 探測結果 cache 起來)。這樣從 Pixabay/Mixkit 抓的 `.mp3` 直接丟進 `web/public/sounds/` 就會響,不用 ffmpeg 轉檔、也不用刪掉原本的 `.wav` 佔位檔(有 `.mp3` 就贏)。模組載入時對 9 個 cue 全部背景 HEAD 探一次,第一個 playCue 時已經是 cache hit,不會漏第一聲。
- **Google Sheet 沒玩的人填 0 不填空**:先前 `appendSessionEntries` 每位玩家各自找「下一個空格」寫,結果只要有人跳過一場,他的後續紀錄就整排往左靠,對不上其他人的第 N 場(圖見討論記錄)。改成所有列先算出**共同**目標欄(取每列 lastNonEmpty+1 的最大值),沒參加的人補 0,順便把每列的**中間空格**也補成 0(修 2026-07-29 前留下的歷史錯位)。`snapshotMonthTab` 也一起改成保留欄位位置,rebuild 時新玩家的舊日期是 sessionCount 個 0(不是空白)。對 SUM 結果零影響(SUM 本來就把空格當 0)。細節見 §11.19。
- **閒置連續兩次自動過牌/棄牌 → 強制站起**:同一位玩家連續兩次被 server 因逾時自動代打(中間沒有真的自己動作過),就強制站起——現金局暫離(籌碼保留,可坐回來),錦標賽視同淘汰。蓋牌代打可以立刻站起(跟既有規則一樣安全);過牌代打因為人還在場上,延到這手結束才套用,不會打斷正在進行的牌局。細節見 `ARCHITECTURE.zh-TW.md` §11.28。
- **音效補上實際音檔**:2026-07-28 做的音效系統(§11.24)一直是靜音的——`web/public/sounds/` 資料夾當時根本沒建,所以 `deal/fold/check/call/raise/allin/street/win/myturn` 全部 404 靜音,程式邏輯本身沒問題。補上 `web/scripts/gen-sounds.mjs`(純 Node 合成短提示音,無外部依賴)產生 9 個佔位 `.wav`,以後要換真的音效檔直接覆蓋同名檔案即可。
- **座位補上即時動作回饋 + bet/raise 顏色區分**:過牌(check)先前在座位卡上完全沒有任何視覺提示,直接跳下一位行動——因為 `bet {bet}` 只在真的有下注時才顯示,而動作紀錄面板在手牌進行中會被擋住不顯示。新增座位上的「過牌」標籤,並把 `bet {bet}` 依動作類型上色:加注/all-in 顯示紅色,跟注維持原本綠色,一眼能分辨誰在跟、誰在加。細節見 `ARCHITECTURE.zh-TW.md` §11.27。
- **All-in 跑池動畫:逐街翻牌 + 落後者翻河牌**:河牌前所有人 all-in 時,公共牌不再一次全部跳出來,改成照街(flop/turn/river)一批一批翻、中間有停頓,翻到河牌那張時額外標示目前暫居下風的玩家(紅色脈衝邊框 +「翻牌中...」)。做法:all-in 跑池一開始,server 就提前把還在手牌裡的人的手牌公開給所有人(這些人已無法再行動,不算洩密),之後每翻一街順便算出目前真正落後的玩家;client 收到街事件後不會馬上顯示,推進一個佇列每 700ms 才翻一組,一般沒人 all-in 的手牌感覺不出這個延遲。細節見 `ARCHITECTURE.zh-TW.md` §11.26。
- **修正 all-in 跑池時公共牌紀錄跟音效漏掉的問題**:河牌前所有人 all-in 時,server 會在同一次動作裡跑完 flop→turn→river→showdown,只廣播一次 `game:state`(此時 phase 已經是 `ended`)。原本 client 靠「觀察 `gameState.phase` 有沒有停在 flop/turn/river」來記錄公共牌翻牌歷史,這種情況下永遠觀察不到中間狀態,導致那三街完全沒進本手歷史(重整頁面才會因為重新 fetch 到正確的 persisted 資料而看起來正常)、`street` 音效也從沒響過。改成 server 明確送新事件 `game:street-log`,每次動作新增幾條街的 history 就送幾筆,client 直接訂閱、不再用猜的。細節見 `ARCHITECTURE.zh-TW.md` §11.25。

## 2026-07-28

這一天量特別大(4 新功能 + 2 修正),破例加上小標題把兩類切開;其他日期維持 flat bullet。

### 新功能

- **音效 cue + mute 開關**(`480af6b`):發牌、fold / check / call / raise / all-in、翻公共牌、贏牌、輪到自己各有一個短音效,header 加 `🔊/🔇` 一鍵靜音(記在 localStorage,重整不掉)。音檔期望放在 `web/public/sounds/{deal,fold,check,call,raise,allin,street,win,myturn}.mp3`,**沒放就是靜音**,不會壞掉任何遊戲流程(`.catch(()=>{})` 吞掉 404/autoplay/codec 錯)。見 `ARCHITECTURE.zh-TW.md` §11.24。
- **貼圖 reaction**(`480af6b`):房間右下角加 `😀` FAB,打開 8 個 emoji picker(👍😂🎉🙈💩🔥❤️😱),送出後全房看到那個 emoji 飛過螢幕 3 秒消失。Server 白名單驗證 + per-user 3 秒 cooldown(超頻直接丟掉不回錯,fun feature 不值得 popup)。細節見 §11.22。
- **聊天跑馬燈**(`480af6b`):Header 下面一條跑馬燈,即時顯示 chat 訊息一則一則橫向捲過,手機用戶不用主動點開聊天抽屜也能看到誰說了什麼。走既有 `chat:message` 事件不新增 socket;queue 上限 20 則,爆量掉最舊的。長訊息會拉長捲動時間(6–20 秒),不會一閃而過。細節見 §11.23。
- **即時戰績面板**(`1e398dc`):房間右側面板加第 3 個分頁「戰績」,顯示房內每位成員當下的 買入 / 剩下 / 輸贏,依淨輸贏由高到低排序。**含暫離成員**(結算 modal 看不到暫離者,這個 tab 看得到),名次算完的錦標賽淘汰者也帶名次徽章顯示。走既有 `room:detail` 事件,不新增 socket。細節見 §11.21。

### 修正

- **Google Sheet 月中新人自動加入**:先前月分頁的玩家陣容在建立時就固定死,月中才第一次參加的新玩家會被 `console.warn` 記一下但**跳過**當月寫入,要等下個月才有資料。改成 `ensureMonthTab` 偵測到 `fullRoster.length > N_old` 時整頁 rebuild:snapshot 既有日期資料 → `values:clear` 清內容(保留格式)→ 用新 N 重寫 skeleton → 逐日 replay 回去。新人所有舊日期自然空白 = 0。Rebuild 非原子,失敗前會把 snapshot 整包 JSON 印進 log,加上 Sheets 內建 30 天版本歷史雙保險。細節見 §11.19。
- **Session 到期擋新手**(`20608ca`):`startHandForRoom` 加 `sessionEndsAt <= now` 檢查,現金局到期後不能再開新手(先前靠 `scanExpiredSessions` 30s tick,client 自動開下一手能塞進空檔多打 1-2 手)。錦標賽不受影響(不用 sessionEndsAt)。
- **蓋牌者允許 mid-hand 站起**(`20608ca`):`room:standup` 對已 `status === 'folded'` 的玩家放行 —— 該玩家已無牌局動線影響,現金局走 seat=null 暫離、錦標賽走 `eliminateStandingPlayer`。原本一律拒絕。見 §11.17。

## 2026-07-27

- **修正站起會清空籌碼的問題**(`00e64ba`):`room:standup` 原本會整筆刪除 Membership,導致再坐下時被當成新玩家、重新用 `room.buyIn` 買入,原本的籌碼(不管輸贏)都不見了。改成「暫離」:`Membership.seat` 改成可為 null,站起只把 `seat` 設回 null(籌碼不動),坐回來時接續原本的 `chipsAtTable`/`totalBuyIn`,不是重新買入。錦標賽的淘汰邏輯是完全獨立的路徑,不受影響。

## 2026-07-26

- **SNG 錦標賽模式 v1 雛形**(`cda3cce`):新增單桌錦標賽房型(`Room.roomType`),跟現金局共用引擎但分支獨立。不可 rebuy(輸光即淘汰)、盲注每級 ×1.5 自動調漲(公式在 `shared`,server/client 共用)、剩 1 人時自動結算出冠軍(名次 = 淘汰當下還有籌碼的人數)。建房畫面新增現金局/錦標賽切換,房間內顯示盲注級數倒數,結算彈窗改成名次排行榜。已知 v1 簡化(單桌、無獎金拆分、無延遲報名)記在 `ARCHITECTURE.zh-TW.md` §11.20。
- **Side pot 正確分池**(`54fb117`):`endWithShowdown` 改用標準 side-pot 分層演算法,短籌碼 all-in 只贏他能 cover 的部分,多下沒人跟的錢自動退回原下注者,不再整池平分。
- **broadcastAfterAction 容錯**(`54fb117`):每個行動後的廣播/持久化步驟(DB 寫入、socket 廣播)各自包 try/catch,任何一步出錯都不會再讓 auto-fold/auto-check 計時器永久停擺、卡死整桌。
- **Rebuy 規則重寫**(`54fb117`):只有籌碼歸零才能加值;加值上限 = 檯面籌碼王捨去到 500 的倍數;玩家自己在 500 級距內用彈窗選金額(不是系統自動補到頂);補值補到 2 人以上有籌碼時自動接續開下一手。
- **對戰紀錄補籌碼快照**(`54fb117`):`HandEndResult` 新增每位玩家該手結束時的起始/最終籌碼,歷史紀錄面板顯示「起始→結束」增減。
- **結算彈窗排序**(`6c4a4fd`):照淨輸贏由高到低排序,加上名次欄位。
- **Google Sheets 自動同步**(`6c4a4fd` 初版、`5e4fdcd` 重寫):房間結算自動寫進外部 Google Sheet。初版是簡單 append-only log;重寫後完整仿照朋友圈原本手工維護的月曆式戰績表(領先榜 + 每日總表 + 逐日 check 明細),並用「人員」分頁以 userId 為永久鍵(改暱稱不會斷歷史)。選填功能,沒設定環境變數就整個 no-op。細節見 `ARCHITECTURE.zh-TW.md` §11.19。
- **技術債清理**(`d345701`):移除未使用的 `hasHand`、`seatedRoomId`;修掉 `hand.phase === 'ended'` 的 TypeScript 型別窄化誤報。

## 2026-07-25

- **all-in 輸光卡住修復 + 加註確認彈窗 + rebuy 上限**(`8708e6a`):開新一手時只發牌給有籌碼的玩家,籌碼歸零者坐山觀虎鬥不再卡住;加註 UI 改成確認彈窗(1/3、1/2、2/3 底池、All-in 快速選項或自訂金額),移除一鍵送出的 All-in 按鈕;rebuy 加入「不超過 chip leader」的上限規則(此版本後續在 7/26 又改成玩家自選金額)。
- **Handoff 快照文件**(`b3649f5`):`ARCHITECTURE.zh-TW.md` 補上接手者快照(部署位置、SSH、已知踩過的坑)。
- **Play-money 模式 + rebuy + 結算輸贏欄**(`7bb9265`):首次引入玩家自主加值、結算畫面顯示每人輸贏。
- **Prisma / Auth.js prod 修復**(`0392630`):Alpine 版 Prisma 需要裝 openssl;Auth.js v5 prod 需要 `trustHost: true`。
- **`phaseLabel` 補 'ended' case**(`9443768`):嚴格 TS 檢查修復。
- **手機版歷史列表 props 修復**(`b21f35d`):修掉呼叫舊版 API 的 stale props。
- **Docker base image 升級到 `node:22-alpine`**(`29ee21c`):因為 pnpm 11 需要 Node 22+。
- **正式部署骨架**(`c42b897`):Dockerfile、`docker-compose.prod.yml`、Caddy 反向代理設定、`DEPLOY.md` 部署指南。

## 2026-07-24

- **專案初始化**(`eebba48`):web(Next.js)/server(Socket.IO)/db(Prisma)/shared(型別)四個 workspace 骨架,含 Google OAuth、大廳、房間、完整下注引擎(showdown / timeout / reconnect / hand-log)。
