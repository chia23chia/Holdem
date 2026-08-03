// ONE-OFF RECOVERY: 2026/08 got corrupted by a rebuild bug where the
// snapshot assumed `fullRoster.slice(0, N_old)` matched the tab's
// physical row order (breaks after any drop happened). This hardcodes
// the correct data from the server log printed right before the bad
// rebuild + reruns the write path from scratch.
//
// After running: delete this script. If needed again, don't reuse — the
// data is hardcoded for THIS specific incident.
//
// Usage:
//   docker exec -it holdem-server sh -c \
//     "cd /app/server && pnpm exec tsx scripts/restore-2026-08.ts"
import { restoreMonthTab } from '../src/sheetsSync.js';

async function main(): Promise<void> {
  // Recovered from `[sheetsSync] 2026/08 pre-drop snapshot` log entry
  // printed by the first drop-user run (before the corrupting rebuild).
  const entries = new Map<string, number[]>([
    ['cms0bli62000av3pccagm4mrv', [1258]],   // 蟒蛇
    ['cms1dts6d0008j40hj6bx3gee', [-5]],     // 新造的人
    // cms923s3z000m2mhpsl9u62ut (— 停用) intentionally omitted
    ['cms0cj8kk000iv3pcq3izrwqt', [-3010]],  // 北海道喜知次
    ['cms0byl14000fv3pcqq7bmjov', [0]],      // UNFIND
    ['cms0o6h990000j40h64oe2j6z', [0]],      // 加演
    ['cms1z8o0p000010vfm9vhy89e', [1143]],   // Sheng
    ['cms0bcdyz0000v3pcn10jpjcy', [0]],      // 內湖翻車魚
    ['cms2rtjwt000212mslir6nqgd', [0]],      // melt汪
    ['cms0e9dq10000alstp91urolf', [614]],    // 竹北車銀優
  ]);
  await restoreMonthTab('2026/08', {
    dateSerial: 46236, // = 2026-08-02 in Sheets epoch
    entriesByUserId: entries,
  });
  console.log('[restore-2026-08] done');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
