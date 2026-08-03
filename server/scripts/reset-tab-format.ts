// One-off maintenance CLI: reset all cell formatting on a Sheet tab
// without touching values. Useful after a rebuild leaked old date
// formatting into cells now holding numeric SUM formulas.
//
// Usage (run inside the server container):
//   docker exec -it holdem-server sh -c \
//     "cd /app/server && pnpm exec tsx scripts/reset-tab-format.ts <tabName>"
import { resetTabFormatting } from '../src/sheetsSync.js';

async function main(): Promise<void> {
  const tabName = process.argv[2];
  if (!tabName) throw new Error('Usage: reset-tab-format.ts <tabName>');
  await resetTabFormatting(tabName);
  console.log(`[reset-tab-format] done: ${tabName}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
