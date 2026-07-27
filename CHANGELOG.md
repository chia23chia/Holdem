# Changelog

所有值得記錄的變動都記在這裡,新的在最上面。日期是 commit 當天(UTC+8),不是嚴格的版本號。

## 2026-07-28

- **Session 到期擋新手**:`startHandForRoom` 加 `sessionEndsAt <= now` 檢查,現金局到期後不能再開新手(先前靠 `scanExpiredSessions` 30s tick,client 自動開下一手能塞進空檔多打 1-2 手)。錦標賽不受影響(不用 sessionEndsAt)。
- **蓋牌者允許 mid-hand 站起**:`room:standup` 對已 `status === 'folded'` 的玩家放行 —— 該玩家已無牌局動線影響,現金局走 seat=null 暫離、錦標賽走 `eliminateStandingPlayer`。原本一律拒絕。

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
