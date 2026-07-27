# Changelog

所有值得記錄的變動都記在這裡,新的在最上面。日期是 commit 當天(UTC+8),不是嚴格的版本號。

## 2026-07-29

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
