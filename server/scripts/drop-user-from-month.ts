// One-off maintenance CLI: physically remove specific userIds' rows from
// a month tab in the Google Sheet.
//
// Usage (run from the server container so env + deps are in scope):
//   docker exec -it holdem-server sh -c \
//     "cd /app && pnpm --filter server exec tsx server/scripts/drop-user-from-month.ts \
//        --month 2026/08 --user <userId> [--user <userId2>] [--force]"
//
// Refuses by default if any target user has a non-zero entry on any date
// in this tab (would break zero-sum silently). Pass --force to override.
import { removeUsersFromMonthTab } from '../src/sheetsSync.js';

function parseArgs(argv: string[]): {
  month: string;
  users: string[];
  force: boolean;
} {
  let month = '';
  const users: string[] = [];
  let force = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--month') {
      month = argv[++i] ?? '';
    } else if (a === '--user') {
      const v = argv[++i];
      if (v) users.push(v);
    } else if (a === '--force') {
      force = true;
    } else {
      throw new Error(`Unknown arg: ${a}`);
    }
  }
  if (!month) throw new Error('--month <YYYY/MM> is required');
  if (users.length === 0) throw new Error('at least one --user <userId> is required');
  return { month, users, force };
}

async function main(): Promise<void> {
  const { month, users, force } = parseArgs(process.argv.slice(2));
  console.log(
    `[drop-user] month=${month} users=${users.join(',')} force=${force}`,
  );
  const result = await removeUsersFromMonthTab(month, users, { force });
  console.log(
    `[drop-user] done: N ${result.N_before}→${result.N_after}, removed ${result.droppedNames.join('、')}`,
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
