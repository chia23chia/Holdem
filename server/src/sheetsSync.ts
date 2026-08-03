// Auto-posts each room's settlement to a Google Sheet that replicates the
// group's existing hand-built tracker: a "人員" (roster) tab keyed by
// userId (so nickname changes never lose someone), plus one tab per
// calendar month laid out exactly like the original — live leaderboard,
// a daily total table (one date per column), and one "check" detail block
// per date (one sub-entry per settled session that day).
//
// Entirely optional: no-ops unless GOOGLE_SHEETS_SA_KEY +
// GOOGLE_SHEETS_SPREADSHEET_ID are set, so a room close never fails or
// blocks on this.
import { JWT } from 'google-auth-library';
import type { SettlementSummary } from '@holdem/shared';

const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';
const ROSTER_SHEET = '人員';
// Column D `停用` is a manual flag — put any non-empty value in a user's D
// cell to exclude them from NEWLY-created month tabs. Existing month tabs
// (including the current one if already bootstrapped) still show their row
// so historical data is never lost. See §11.29.
const ROSTER_HEADER = ['userId', '顯示名稱', '列位', '停用'];

// Check-block sub-entries live in columns E..AD (26 slots/day/player) —
// same span as the original. Daily-table date columns live in D..AH (31
// slots), also matching the original's one-month-per-tab convention.
const CHECK_ENTRY_FIRST_COL = 5; // E
const CHECK_ENTRY_LAST_COL = 30; // AD
const DAILY_DATE_FIRST_COL = 4; // D
const DAILY_DATE_LAST_COL = 34; // AH

let authClient: JWT | null | undefined; // undefined = not yet resolved

function getAuthClient(): JWT | null {
  if (authClient !== undefined) return authClient;
  const raw = process.env.GOOGLE_SHEETS_SA_KEY;
  if (!raw) {
    authClient = null;
    return authClient;
  }
  const key = JSON.parse(Buffer.from(raw, 'base64').toString('utf8')) as {
    client_email: string;
    private_key: string;
  };
  authClient = new JWT({
    email: key.client_email,
    key: key.private_key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return authClient;
}

async function sheetsRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const client = getAuthClient();
  if (!client) throw new Error('Sheets sync not configured');
  const { token } = await client.getAccessToken();
  const res = await fetch(`${SHEETS_API}${path}`, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  });
  if (!res.ok) {
    throw new Error(`Sheets API ${res.status}: ${await res.text()}`);
  }
  return res.json() as Promise<T>;
}

interface ValueRange {
  range: string;
  values?: unknown[][];
}

async function batchGetValues(
  spreadsheetId: string,
  ranges: string[],
): Promise<ValueRange[]> {
  const qs = ranges
    .map((r) => `ranges=${encodeURIComponent(r)}`)
    .concat('valueRenderOption=UNFORMATTED_VALUE')
    .join('&');
  const body = await sheetsRequest<{ valueRanges: ValueRange[] }>(
    `/${spreadsheetId}/values:batchGet?${qs}`,
  );
  return body.valueRanges;
}

async function batchUpdateValues(
  spreadsheetId: string,
  data: ValueRange[],
): Promise<void> {
  if (data.length === 0) return;
  await sheetsRequest(`/${spreadsheetId}/values:batchUpdate`, {
    method: 'POST',
    body: JSON.stringify({ valueInputOption: 'USER_ENTERED', data }),
  });
}

function colLetter(n: number): string {
  let s = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

interface SheetMeta {
  sheetId: number;
  title: string;
}

async function listTabs(spreadsheetId: string): Promise<SheetMeta[]> {
  const meta = await sheetsRequest<{ sheets: Array<{ properties: SheetMeta }> }>(
    `/${spreadsheetId}?fields=sheets.properties`,
  );
  return meta.sheets.map((s) => s.properties);
}

async function addTab(
  spreadsheetId: string,
  title: string,
): Promise<void> {
  await sheetsRequest(`/${spreadsheetId}:batchUpdate`, {
    method: 'POST',
    body: JSON.stringify({
      requests: [
        {
          addSheet: {
            properties: {
              title,
              gridProperties: { rowCount: 1000, columnCount: 34 },
            },
          },
        },
      ],
    }),
  });
}

// ============================================================
// Roster ("人員") — userId is the permanent key. Slot (row order) is
// assigned once and never changes; display name is kept in sync so a
// later in-app nickname change doesn't orphan someone's history.
// ============================================================

interface RosterEntry {
  userId: string;
  name: string;
  slot: number;   // 1-based, stable
  hidden: boolean; // manual "停用" flag in col D, see §11.29
}

async function ensureRosterTab(
  spreadsheetId: string,
  existingTabs: SheetMeta[],
): Promise<void> {
  if (!existingTabs.some((t) => t.title === ROSTER_SHEET)) {
    await addTab(spreadsheetId, ROSTER_SHEET);
  }
  // Idempotent header write — cheap, and backfills the new col-D 停用
  // header for rosters created before that column existed.
  await batchUpdateValues(spreadsheetId, [
    { range: `${ROSTER_SHEET}!A1:D1`, values: [ROSTER_HEADER] },
  ]);
}

async function getRoster(spreadsheetId: string): Promise<RosterEntry[]> {
  const [vr] = await batchGetValues(spreadsheetId, [
    `${ROSTER_SHEET}!A2:D`,
  ]);
  const rows = vr.values ?? [];
  return rows
    .filter((r) => r[0])
    .map((r) => ({
      userId: String(r[0]),
      name: String(r[1] ?? ''),
      slot: Number(r[2]),
      // Any truthy value = hidden. Boolean(true) from a Sheets checkbox
      // and any non-empty string ('V', '1', 'TRUE', '停用', ...) both work.
      hidden: Boolean(r[3]),
    }))
    .sort((a, b) => a.slot - b.slot);
}

// Registers any never-seen userIds (assigning the next slot) and keeps
// display names in sync for existing ones. Returns the full roster,
// ordered by slot, after applying these updates.
async function registerAndSyncRoster(
  spreadsheetId: string,
  existingTabs: SheetMeta[],
  players: SettlementSummary['players'],
): Promise<RosterEntry[]> {
  await ensureRosterTab(spreadsheetId, existingTabs);
  const roster = await getRoster(spreadsheetId);
  const byUserId = new Map(roster.map((r) => [r.userId, r]));

  const appends: unknown[][] = [];
  const nameUpdates: ValueRange[] = [];
  let nextSlot = roster.length > 0 ? roster[roster.length - 1].slot + 1 : 1;

  for (const p of players) {
    const existing = byUserId.get(p.userId);
    if (!existing) {
      const entry: RosterEntry = {
        userId: p.userId,
        name: p.name,
        slot: nextSlot,
        hidden: false,
      };
      nextSlot += 1;
      byUserId.set(p.userId, entry);
      roster.push(entry);
      appends.push([entry.userId, entry.name, entry.slot, '']);
    } else if (existing.name !== p.name) {
      nameUpdates.push({
        range: `${ROSTER_SHEET}!B${existing.slot + 1}`,
        values: [[p.name]],
      });
      existing.name = p.name;
    }
  }

  if (appends.length > 0) {
    await sheetsRequest(
      `/${spreadsheetId}/values/${encodeURIComponent(`${ROSTER_SHEET}!A:D`)}:append?valueInputOption=USER_ENTERED`,
      { method: 'POST', body: JSON.stringify({ values: appends }) },
    );
  }
  if (nameUpdates.length > 0) {
    await batchUpdateValues(spreadsheetId, nameUpdates);
  }

  return roster.sort((a, b) => a.slot - b.slot);
}

// ============================================================
// Monthly tab layout — all row numbers are computed from N (this month's
// fixed player count), so a block never needs to grow after it's written:
//
//   rows 1..N+1      leaderboard (row1 header, rows 2..N+1 = one per player)
//   row  N+2         blank
//   row  N+3         daily-table header ("total" + date columns)
//   rows N+4..2N+3   daily-table player rows
//   rows 2N+4,2N+5   blank
//   rows 2N+6..      one check-block per date, height N+2 each
// ============================================================

function dailyStartRow(N: number): number {
  return N + 4;
}
function dailyEndRow(N: number): number {
  return 2 * N + 3;
}
function dailyHeaderRow(N: number): number {
  return N + 3;
}
function checkBlockHeight(N: number): number {
  return N + 2;
}
function firstCheckBlockRow(N: number): number {
  return 2 * N + 6;
}
function checkBlockStartRow(N: number, blockIndex0: number): number {
  return firstCheckBlockRow(N) + blockIndex0 * checkBlockHeight(N);
}

function monthTabName(date: Date): string {
  return `${date.getFullYear()}/${String(date.getMonth() + 1).padStart(2, '0')}`;
}
function dateLabel(date: Date): string {
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

// USER_ENTERED input auto-parses a date-like string ("7/26") into a real
// Sheets date cell (serial = days since 1899-12-30), which is what we want
// for display — but it means we can no longer compare header cells by
// string equality after the round-trip; compute the same serial ourselves
// to check "does today's column already exist" against the numeric value
// read back via UNFORMATTED_VALUE.
function sheetsDateSerial(date: Date): number {
  const epoch = Date.UTC(1899, 11, 30);
  const d = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  return Math.round((d - epoch) / 86400000);
}

interface MonthTab {
  N: number;
  rosterSlots: RosterEntry[]; // this month's fixed player set, in slot order
}

// Writes the leaderboard + daily-table skeleton into a fresh (or
// freshly-cleared) tab. Shared by first-time creation and mid-month rebuild.
async function writeMonthSkeleton(
  spreadsheetId: string,
  tabName: string,
  N: number,
  rosterSlots: RosterEntry[],
): Promise<void> {
  const dStart = dailyStartRow(N);
  const dEnd = dailyEndRow(N);
  const data: ValueRange[] = [
    { range: `${tabName}!B1`, values: [['即時排行榜']] },
    { range: `${tabName}!F1`, values: [['check']] },
    {
      range: `${tabName}!F2:G4`,
      values: [
        ['正', `=SUMIF(C${dStart}:C${dEnd},">0")`],
        ['負', `=SUMIF(C${dStart}:C${dEnd},"<0")`],
        ['sum', `=SUM(C${dStart}:C${dEnd})`],
      ],
    },
    // Leaderboard is a single spill formula sorted by net win/loss
    // descending — B2:D<N+1> are left alone; SORT fills them.
    {
      range: `${tabName}!A2`,
      values: [[`=SORT(A${dStart}:C${dEnd},3,FALSE)`]],
    },
    { range: `${tabName}!C${dailyHeaderRow(N)}`, values: [['total']] },
  ];

  for (let i = 0; i < N; i += 1) {
    const dailyRow = dStart + i;
    const rosterRow = rosterSlots[i].slot + 1; // +1 for roster header row
    data.push({
      range: `${tabName}!A${dailyRow}:C${dailyRow}`,
      values: [[
        `=RANK(C${dailyRow},$C$${dStart}:$C$${dEnd})`,
        `=${ROSTER_SHEET}!B${rosterRow}`,
        `=SUM(D${dailyRow}:${colLetter(DAILY_DATE_LAST_COL)}${dailyRow})`,
      ]],
    });
  }

  await batchUpdateValues(spreadsheetId, data);
}

// Creates the month's tab (leaderboard + daily-table skeleton) the first
// time it's needed. Two roster inputs:
// - activeRoster: roster minus 停用-flagged users. Used for FIRST-TIME
//   creation so a stopped player never appears in a brand-new month tab.
// - fullRoster: everyone, for existing-tab continuity (N_old rows were
//   written using the full roster's slot order, so we must keep matching
//   that when reading back / rebuilding, even if some of those slots are
//   now hidden — dropping them would misalign historical data).
// If the tab already exists AND new *active* players have been added
// beyond N_old, rebuilds in place to make room for them; a new hidden
// player alone does NOT trigger rebuild.
async function ensureMonthTab(
  spreadsheetId: string,
  tabName: string,
  existingTabs: SheetMeta[],
  fullRoster: RosterEntry[],
  activeRoster: RosterEntry[],
): Promise<MonthTab> {
  const exists = existingTabs.some((t) => t.title === tabName);

  if (exists) {
    const [vr] = await batchGetValues(spreadsheetId, [`${tabName}!B2:B50`]);
    const names = vr.values ?? [];
    let N_old = 0;
    while (N_old < names.length && names[N_old][0]) N_old += 1;

    // Count NEW active players beyond N_old — hidden latecomers don't
    // warrant a rebuild since they wouldn't have gotten a row anyway.
    const newActive = fullRoster.slice(N_old).filter((r) => !r.hidden);
    if (newActive.length > 0) {
      return rebuildMonthTab(spreadsheetId, tabName, N_old, fullRoster);
    }
    return { N: N_old, rosterSlots: fullRoster.slice(0, N_old) };
  }

  const N = activeRoster.length;
  const rosterSlots = activeRoster;
  await addTab(spreadsheetId, tabName);
  await writeMonthSkeleton(spreadsheetId, tabName, N, rosterSlots);
  return { N, rosterSlots };
}

// Wipes values AND cell formatting for the tab (column widths + sheetId
// preserved). Used before rebuild — clearing FORMAT too is important:
// values:clear alone preserves numberFormat, so a cell that used to be
// the daily-table date header (which parses as a date and gets date
// format) still shows dates even after being overwritten with a numeric
// SUM formula — that's the "1258 → 6/11" bug we hit during drop-user.
async function clearAllValues(spreadsheetId: string, tabName: string): Promise<void> {
  const meta = await lookupSheetMeta(spreadsheetId, tabName);
  await sheetsRequest(`/${spreadsheetId}:batchUpdate`, {
    method: 'POST',
    body: JSON.stringify({
      requests: [
        {
          updateCells: {
            range: { sheetId: meta.sheetId },
            fields: 'userEnteredValue,userEnteredFormat',
          },
        },
      ],
    }),
  });
}

async function lookupSheetMeta(spreadsheetId: string, tabName: string): Promise<SheetMeta> {
  const tabs = await listTabs(spreadsheetId);
  const meta = tabs.find((t) => t.title === tabName);
  if (!meta) throw new Error(`Tab ${tabName} not found`);
  return meta;
}

// Inverse of sheetsDateSerial — reconstruct a Date from the numeric serial
// we read back out of the header row. Used during replay so
// findOrCreateDateBlock's label + serial matching stays consistent.
function dateFromSerial(serial: number): Date {
  const epoch = Date.UTC(1899, 11, 30);
  return new Date(epoch + serial * 86400000);
}

interface DateSnapshot {
  serial: number;
  // Per player: all their session entries for this date, in the order they
  // were originally written (E, F, G, ...). Missing/blank cells are dropped.
  entriesByUserId: Map<string, number[]>;
}

// Reads back everything we need from an existing month tab so we can
// replay it into a fresh layout with a larger N. Assumes the roster's
// first N_old entries match the tab's current player row order (which is
// true because roster is append-only and month layout uses slot order).
async function snapshotMonthTab(
  spreadsheetId: string,
  tabName: string,
  N_old: number,
  rosterAtBuildTime: RosterEntry[],
): Promise<DateSnapshot[]> {
  const headerRow = dailyHeaderRow(N_old);
  const [headerVR] = await batchGetValues(spreadsheetId, [
    `${tabName}!${colLetter(DAILY_DATE_FIRST_COL)}${headerRow}:${colLetter(DAILY_DATE_LAST_COL)}${headerRow}`,
  ]);
  const dateSerials: number[] = (headerVR.values?.[0] ?? []).filter(
    (v): v is number => typeof v === 'number',
  );
  if (dateSerials.length === 0) return [];

  // Batch-read every player row of every check block in a single call.
  const ranges: string[] = [];
  for (let i = 0; i < dateSerials.length; i += 1) {
    const blockRow = checkBlockStartRow(N_old, i);
    for (let p = 0; p < N_old; p += 1) {
      const row = blockRow + 1 + p;
      ranges.push(
        `${tabName}!${colLetter(CHECK_ENTRY_FIRST_COL)}${row}:${colLetter(CHECK_ENTRY_LAST_COL)}${row}`,
      );
    }
  }
  const allVRs = await batchGetValues(spreadsheetId, ranges);

  const dates: DateSnapshot[] = [];
  let vrIdx = 0;
  for (let i = 0; i < dateSerials.length; i += 1) {
    // First pass: collect raw cells for every player so we can compute
    // sessionCount = length of longest row (ignoring trailing blanks).
    // Preserves column positions — critical because a blank in the middle
    // means the player skipped that session, not that they never played.
    const raw: Array<{ userId: string; cells: unknown[] }> = [];
    let sessionCount = 0;
    for (let p = 0; p < N_old; p += 1) {
      const userId = rosterAtBuildTime[p].userId;
      const cells = allVRs[vrIdx].values?.[0] ?? [];
      vrIdx += 1;
      let lastNonEmpty = 0;
      for (let j = cells.length - 1; j >= 0; j -= 1) {
        if (typeof cells[j] === 'number') {
          lastNonEmpty = j + 1;
          break;
        }
      }
      if (lastNonEmpty > sessionCount) sessionCount = lastNonEmpty;
      raw.push({ userId, cells });
    }
    // Second pass: pad every player's row to sessionCount with 0 for
    // blanks. Absent-players and internal-blank cases both become 0.
    const entriesByUserId = new Map<string, number[]>();
    if (sessionCount > 0) {
      for (const r of raw) {
        const padded: number[] = [];
        for (let j = 0; j < sessionCount; j += 1) {
          const v = r.cells[j];
          padded.push(typeof v === 'number' ? v : 0);
        }
        entriesByUserId.set(r.userId, padded);
      }
    }
    dates.push({ serial: dateSerials[i], entriesByUserId });
  }
  return dates;
}

// One-shot write of every player's entries for a single date's check block.
// Used only during replay. Every player (including new roster additions
// beyond N_old, who have no map entry) gets a row padded with 0s to the
// date's session count — this is what makes their prior dates read as 0
// instead of blank and keeps session columns aligned across all players.
async function bulkWriteBlockEntries(
  spreadsheetId: string,
  tabName: string,
  blockRow: number,
  rosterSlots: RosterEntry[],
  entriesByUserId: Map<string, number[]>,
): Promise<void> {
  // All entries in the map are the same length after snapshotMonthTab
  // (padded to sessionCount), so any one gives us the width.
  const firstRow = entriesByUserId.values().next().value;
  const sessionCount = firstRow?.length ?? 0;
  if (sessionCount === 0) return;

  const startCol = colLetter(CHECK_ENTRY_FIRST_COL);
  const endCol = colLetter(CHECK_ENTRY_FIRST_COL + sessionCount - 1);
  const zeros: number[] = new Array(sessionCount).fill(0);
  const data: ValueRange[] = rosterSlots.map((r, i) => ({
    range: `${tabName}!${startCol}${blockRow + 1 + i}:${endCol}${blockRow + 1 + i}`,
    values: [entriesByUserId.get(r.userId) ?? zeros],
  }));
  await batchUpdateValues(spreadsheetId, data);
}

// Snapshot → clear values → rewrite skeleton with new N → replay every
// prior date's entries into the new layout. New players (those in
// fullRoster beyond N_old) get rows of 0s for every prior session, and
// pre-existing internal blanks also get normalized to 0 — so every date's
// session columns stay aligned across all players.
//
// Not atomic: if the process dies between clear and replay, the tab is
// partially empty. Snapshot content is logged BEFORE clear so it's
// recoverable from server logs. Google Sheets also keeps 30d version
// history as a further safety net.
async function rebuildMonthTab(
  spreadsheetId: string,
  tabName: string,
  N_old: number,
  fullRoster: RosterEntry[],
): Promise<MonthTab> {
  // Preserve the N_old rows this tab already has (may include now-hidden
  // users — dropping them retroactively would corrupt historical data),
  // then append only NEW ACTIVE players. A hidden latecomer wouldn't
  // trigger a rebuild in the first place, and if one somehow slips in
  // via a same-batch registration we skip them here too.
  const rosterAtBuildTime = fullRoster.slice(0, N_old);
  const newActive = fullRoster.slice(N_old).filter((r) => !r.hidden);
  const rosterSlots = [...rosterAtBuildTime, ...newActive];
  const N = rosterSlots.length;
  console.warn(
    `[sheetsSync] ${tabName} rebuild: N ${N_old}→${N} (+` +
      `${newActive.map((r) => r.name).join('、')})`,
  );

  const dates = await snapshotMonthTab(
    spreadsheetId,
    tabName,
    N_old,
    rosterAtBuildTime,
  );
  console.warn(
    `[sheetsSync] ${tabName} pre-rebuild snapshot (` +
      `${dates.length} dates): ` +
      JSON.stringify(
        dates.map((d) => ({
          serial: d.serial,
          entries: Object.fromEntries(d.entriesByUserId),
        })),
      ),
  );

  await clearAllValues(spreadsheetId, tabName);

  const month: MonthTab = { N, rosterSlots };
  await writeMonthSkeleton(spreadsheetId, tabName, N, rosterSlots);

  // Replay dates in the same column order as before (snapshotMonthTab
  // returned them left-to-right from D..AH, so calling
  // findOrCreateDateBlock in order preserves the original date column
  // ordering).
  for (const d of dates) {
    const date = dateFromSerial(d.serial);
    const blockRow = await findOrCreateDateBlock(spreadsheetId, tabName, month, date);
    await bulkWriteBlockEntries(
      spreadsheetId,
      tabName,
      blockRow,
      month.rosterSlots,
      d.entriesByUserId,
    );
  }

  console.warn(`[sheetsSync] ${tabName} rebuild done`);
  return month;
}

// One-off maintenance: physically remove specific userIds' rows from an
// existing month tab (not just hide via 停用 — that only affects NEW tabs,
// see §11.29). Reuses the same snapshot/clear/rewrite/replay path as
// rebuildMonthTab, but shrinks the roster instead of growing it.
//
// Safety: refuses to drop any user who has a non-zero entry on any date
// in this tab, because zero-sum would break (they took/gave chips to real
// players — removing them silently re-writes history). Pass `force: true`
// to override. Non-zero warnings are per-date so the caller can see which
// dates would be affected.
export async function removeUsersFromMonthTab(
  tabName: string,
  userIdsToDrop: string[],
  opts: { force?: boolean } = {},
): Promise<{ N_before: number; N_after: number; droppedNames: string[] }> {
  const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
  if (!spreadsheetId || !getAuthClient()) {
    throw new Error('Sheets sync not configured (env GOOGLE_SHEETS_*)');
  }
  // Empty drop set = "just rebuild in place" — useful to fix format issues
  // without changing content. All the snapshot/clear/rewrite/replay logic
  // still runs, but no rows are filtered out.
  const dropSet = new Set(userIdsToDrop);

  // Determine N_old from the tab's current row count.
  const [vr] = await batchGetValues(spreadsheetId, [`${tabName}!B2:B50`]);
  const names = vr.values ?? [];
  let N_old = 0;
  while (N_old < names.length && names[N_old][0]) N_old += 1;
  if (N_old === 0) throw new Error(`Tab ${tabName} not found or empty`);

  // Match the tab's first-N_old rows to roster entries (they're in slot order).
  const fullRoster = await getRoster(spreadsheetId);
  const rosterAtBuildTime = fullRoster.slice(0, N_old);
  const rosterUserIds = new Set(rosterAtBuildTime.map((r) => r.userId));
  for (const uid of dropSet) {
    if (!rosterUserIds.has(uid)) {
      throw new Error(
        `userId ${uid} is not in ${tabName}'s first ${N_old} rows`,
      );
    }
  }
  const droppedEntries = rosterAtBuildTime.filter((r) => dropSet.has(r.userId));
  const droppedNames = droppedEntries.map((r) => r.name);

  const dates = await snapshotMonthTab(
    spreadsheetId,
    tabName,
    N_old,
    rosterAtBuildTime,
  );

  // Zero-sum safety: check for any non-zero entry belonging to a dropped
  // user. If found and !force, refuse and list which dates + users.
  const violations: Array<{ date: number; userId: string; nums: number[] }> = [];
  for (const d of dates) {
    for (const uid of dropSet) {
      const nums = d.entriesByUserId.get(uid) ?? [];
      if (nums.some((n) => n !== 0)) {
        violations.push({ date: d.serial, userId: uid, nums });
      }
    }
  }
  if (violations.length > 0 && !opts.force) {
    const summary = violations
      .map((v) => {
        const name =
          rosterAtBuildTime.find((r) => r.userId === v.userId)?.name ?? v.userId;
        return `  serial=${v.date} ${name}: [${v.nums.join(', ')}]`;
      })
      .join('\n');
    throw new Error(
      `Dropping these users would break zero-sum on some dates:\n${summary}\n` +
        `Re-run with force:true to proceed anyway.`,
    );
  }

  console.warn(
    `[sheetsSync] ${tabName} drop-users: N ${N_old}→${N_old - dropSet.size} (` +
      `removing ${droppedNames.join('、')})`,
  );
  console.warn(
    `[sheetsSync] ${tabName} pre-drop snapshot: ` +
      JSON.stringify(
        dates.map((d) => ({
          serial: d.serial,
          entries: Object.fromEntries(d.entriesByUserId),
        })),
      ),
  );

  // Filter each date's entries to drop the target users. Also recompute
  // row width from the remaining rows' non-zero extent — a dropped user's
  // trailing 0-padding shouldn't inflate width in the rebuilt tab. Dates
  // where nothing non-zero remains get skipped entirely (would just be an
  // empty column that adds noise).
  const filteredDates = dates
    .map((d) => {
      const kept = new Map(
        [...d.entriesByUserId.entries()].filter(([uid]) => !dropSet.has(uid)),
      );
      let maxLen = 0;
      for (const nums of kept.values()) {
        for (let i = nums.length - 1; i >= 0; i -= 1) {
          if (nums[i] !== 0) {
            if (i + 1 > maxLen) maxLen = i + 1;
            break;
          }
        }
      }
      const trimmed = new Map(
        [...kept.entries()].map(([uid, nums]) => [uid, nums.slice(0, maxLen)]),
      );
      return { serial: d.serial, entriesByUserId: trimmed, width: maxLen };
    })
    .filter((d) => d.width > 0);

  await clearAllValues(spreadsheetId, tabName);

  const rosterSlots = rosterAtBuildTime.filter((r) => !dropSet.has(r.userId));
  const N = rosterSlots.length;
  const month: MonthTab = { N, rosterSlots };
  await writeMonthSkeleton(spreadsheetId, tabName, N, rosterSlots);

  for (const d of filteredDates) {
    const date = dateFromSerial(d.serial);
    const blockRow = await findOrCreateDateBlock(spreadsheetId, tabName, month, date);
    await bulkWriteBlockEntries(
      spreadsheetId,
      tabName,
      blockRow,
      month.rosterSlots,
      d.entriesByUserId,
    );
  }

  console.warn(`[sheetsSync] ${tabName} drop-users done`);
  return { N_before: N_old, N_after: N, droppedNames };
}

// Finds today's check-block if it already exists (another settlement
// earlier today), otherwise creates it — including wiring the new date
// column into the daily table. Returns the block's header row.
async function findOrCreateDateBlock(
  spreadsheetId: string,
  tabName: string,
  month: MonthTab,
  date: Date,
): Promise<number> {
  const { N } = month;
  const label = dateLabel(date);
  const targetSerial = sheetsDateSerial(date);
  const headerRow = dailyHeaderRow(N);
  const [vr] = await batchGetValues(spreadsheetId, [
    `${tabName}!${colLetter(DAILY_DATE_FIRST_COL)}${headerRow}:${colLetter(DAILY_DATE_LAST_COL)}${headerRow}`,
  ]);
  // Read as UNFORMATTED_VALUE, so an already-written date column comes
  // back as its numeric serial (see sheetsDateSerial) — a still-empty
  // column comes back as '' (not present in the row at all, past the end).
  const existingDates: Array<number | null> = (vr.values?.[0] ?? []).map((v) =>
    typeof v === 'number' ? v : null,
  );
  const existingIdx = existingDates.findIndex((d) => d === targetSerial);
  if (existingIdx !== -1) {
    return checkBlockStartRow(N, existingIdx);
  }

  const blockIndex = existingDates.filter((d) => d !== null).length;
  const blockRow = checkBlockStartRow(N, blockIndex);
  const dateCol = colLetter(DAILY_DATE_FIRST_COL + blockIndex);

  const data: ValueRange[] = [
    { range: `${tabName}!${dateCol}${headerRow}`, values: [[label]] },
    { range: `${tabName}!A${blockRow}:C${blockRow}`, values: [['check', '', label]] },
  ];
  for (let i = 0; i < N; i += 1) {
    const row = blockRow + 1 + i;
    const dailyRow = dailyStartRow(N) + i;
    data.push({
      range: `${tabName}!B${row}:C${row}`,
      values: [[
        `=B${dailyRow}`,
        `=SUM(${colLetter(CHECK_ENTRY_FIRST_COL)}${row},${colLetter(CHECK_ENTRY_FIRST_COL + 1)}${row}:${colLetter(CHECK_ENTRY_LAST_COL)}${row})`,
      ]],
    });
    data.push({ range: `${tabName}!${dateCol}${dailyRow}`, values: [[`=C${row}`]] });
  }
  data.push({
    range: `${tabName}!A${blockRow + 1}`,
    values: [[`=SUM(C${blockRow + 1}:C${blockRow + N})`]],
  });

  await batchUpdateValues(spreadsheetId, data);
  return blockRow;
}

// Writes ONE session's entries into today's block — every player in the
// roster gets a cell in the same target column (0 for absent players), so
// session-N is column-aligned across all players. Also opportunistically
// rewrites internal blanks in existing rows as 0, cleaning up any
// misalignment left by pre-2026-07-29 writes.
async function appendSessionEntries(
  spreadsheetId: string,
  tabName: string,
  blockRow: number,
  rosterSlots: RosterEntry[],
  entriesByUserId: Map<string, number>,
): Promise<void> {
  if (rosterSlots.length === 0) return;

  // Read every player row's check-entry range so we can (a) pick one
  // aligned target column and (b) rewrite each row filling internal blanks.
  const ranges = rosterSlots.map(
    (_, i) =>
      `${tabName}!${colLetter(CHECK_ENTRY_FIRST_COL)}${blockRow + 1 + i}:${colLetter(CHECK_ENTRY_LAST_COL)}${blockRow + 1 + i}`,
  );
  const existing = await batchGetValues(spreadsheetId, ranges);

  // Target column offset = max(lastNonEmpty+1) across all rows. Using
  // lastNonEmpty (rather than firstEmpty) so a row that has an internal
  // blank doesn't get its later entry overwritten. If someone else's row is
  // longer, we align to that.
  let targetOffset = 0;
  for (const vr of existing) {
    const cells = vr.values?.[0] ?? [];
    let lastNonEmpty = 0;
    for (let j = cells.length - 1; j >= 0; j -= 1) {
      if (typeof cells[j] === 'number') {
        lastNonEmpty = j + 1;
        break;
      }
    }
    if (lastNonEmpty > targetOffset) targetOffset = lastNonEmpty;
  }

  // Rewrite every player's row from column E up through the new target
  // column, filling with 0 for both internal blanks and absent players.
  const rowLen = targetOffset + 1;
  const startCol = colLetter(CHECK_ENTRY_FIRST_COL);
  const endCol = colLetter(CHECK_ENTRY_FIRST_COL + rowLen - 1);
  const data: ValueRange[] = rosterSlots.map((r, i) => {
    const cells = existing[i].values?.[0] ?? [];
    const rowValues: number[] = [];
    for (let j = 0; j < rowLen; j += 1) {
      if (j === targetOffset) {
        rowValues.push(entriesByUserId.get(r.userId) ?? 0);
      } else {
        const v = cells[j];
        rowValues.push(typeof v === 'number' ? v : 0);
      }
    }
    return {
      range: `${tabName}!${startCol}${blockRow + 1 + i}:${endCol}${blockRow + 1 + i}`,
      values: [rowValues],
    };
  });

  await batchUpdateValues(spreadsheetId, data);
}

export async function syncSettlementToSheet(
  summary: SettlementSummary,
): Promise<void> {
  const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
  if (!spreadsheetId || !getAuthClient() || summary.players.length === 0) return;

  const now = new Date();
  const tabName = monthTabName(now);

  const tabs = await listTabs(spreadsheetId);
  const fullRoster = await registerAndSyncRoster(spreadsheetId, tabs, summary.players);
  // Roster registration may have just created the 人員 tab — re-list so
  // ensureMonthTab sees an accurate picture.
  const tabsAfterRoster = tabs.some((t) => t.title === ROSTER_SHEET)
    ? tabs
    : await listTabs(spreadsheetId);
  // 停用-flagged users are excluded from NEW month tab creation only.
  // Existing tabs keep their rows (fullRoster passed for continuity).
  const activeRoster = fullRoster.filter((r) => !r.hidden);
  const month = await ensureMonthTab(
    spreadsheetId,
    tabName,
    tabsAfterRoster,
    fullRoster,
    activeRoster,
  );

  // ensureMonthTab guarantees month.rosterSlots contains every roster entry
  // (auto-rebuilds if the roster grew since the tab was first written), so
  // every summary.players entry has a home row here.
  const blockRow = await findOrCreateDateBlock(spreadsheetId, tabName, month, now);
  const entries = new Map(
    summary.players.map((p) => [p.userId, p.chipsAtTable - p.totalBuyIn] as const),
  );
  await appendSessionEntries(spreadsheetId, tabName, blockRow, month.rosterSlots, entries);
}
