// Auto-posts each room's settlement to a Google Sheet for external tracking
// (e.g. a running friend-group ledger). Entirely optional: no-ops unless
// GOOGLE_SHEETS_SA_KEY + GOOGLE_SHEETS_SPREADSHEET_ID are set, so a room
// close never fails or blocks on this.
import { JWT } from 'google-auth-library';
import type { SettlementSummary } from '@holdem/shared';

const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';
const LOG_SHEET = '對局紀錄';
const LEADERBOARD_SHEET = '總排行';
const LOG_HEADER = ['日期時間', '房間', '玩家', '買入', '結算籌碼', '淨輸贏'];

let authClient: JWT | null | undefined; // undefined = not yet resolved

// Lazily built from GOOGLE_SHEETS_SA_KEY — the service account's downloaded
// JSON key, base64-encoded (sidesteps quoting/newline issues of putting raw
// JSON in a .env file). Returns null if unconfigured — callers treat that as
// "sync disabled" rather than an error.
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

async function sheetsRequest<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
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

interface SpreadsheetMeta {
  sheets: Array<{ properties: { title: string } }>;
}

// Per-spreadsheet, only check/create tabs once per process lifetime — the
// structure never changes after bootstrap, so repeat settlements skip this.
const bootstrapped = new Set<string>();

async function ensureBootstrapped(spreadsheetId: string): Promise<void> {
  if (bootstrapped.has(spreadsheetId)) return;

  const meta = await sheetsRequest<SpreadsheetMeta>(`/${spreadsheetId}`);
  const titles = new Set(meta.sheets.map((s) => s.properties.title));

  const addSheetRequests = [];
  if (!titles.has(LOG_SHEET)) {
    addSheetRequests.push({ addSheet: { properties: { title: LOG_SHEET } } });
  }
  if (!titles.has(LEADERBOARD_SHEET)) {
    addSheetRequests.push({
      addSheet: { properties: { title: LEADERBOARD_SHEET } },
    });
  }
  if (addSheetRequests.length > 0) {
    await sheetsRequest(`/${spreadsheetId}:batchUpdate`, {
      method: 'POST',
      body: JSON.stringify({ requests: addSheetRequests }),
    });
  }

  if (!titles.has(LOG_SHEET)) {
    await sheetsRequest(
      `/${spreadsheetId}/values/${encodeURIComponent(`${LOG_SHEET}!A1:F1`)}?valueInputOption=RAW`,
      { method: 'PUT', body: JSON.stringify({ values: [LOG_HEADER] }) },
    );
  }

  if (!titles.has(LEADERBOARD_SHEET)) {
    // Dynamic array formulas — spill to fit however many distinct players
    // ever show up in the log, no per-row maintenance needed.
    await sheetsRequest(
      `/${spreadsheetId}/values/${encodeURIComponent(`${LEADERBOARD_SHEET}!A1:C2`)}?valueInputOption=USER_ENTERED`,
      {
        method: 'PUT',
        body: JSON.stringify({
          values: [
            ['玩家', '總淨輸贏', '場次'],
            [
              `=SORT(UNIQUE(${LOG_SHEET}!C2:C))`,
              `=ARRAYFORMULA(IF(A2:A="","",SUMIF(${LOG_SHEET}!C:C,A2:A,${LOG_SHEET}!F:F)))`,
              `=ARRAYFORMULA(IF(A2:A="","",COUNTIF(${LOG_SHEET}!C:C,A2:A)))`,
            ],
          ],
        }),
      },
    );
  }

  bootstrapped.add(spreadsheetId);
}

// Appends one row per player to the log tab. Fire-and-forget from the
// caller's perspective — throws are caught there so a sync hiccup never
// blocks or fails a room close.
export async function syncSettlementToSheet(
  summary: SettlementSummary,
): Promise<void> {
  const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
  if (!spreadsheetId || !getAuthClient()) return; // sync disabled

  await ensureBootstrapped(spreadsheetId);

  const ts = new Date().toISOString();
  const rows = summary.players.map((p) => [
    ts,
    summary.roomName,
    p.name,
    p.totalBuyIn,
    p.chipsAtTable,
    p.chipsAtTable - p.totalBuyIn,
  ]);
  if (rows.length === 0) return;

  await sheetsRequest(
    `/${spreadsheetId}/values/${encodeURIComponent(`${LOG_SHEET}!A:F`)}:append?valueInputOption=USER_ENTERED`,
    { method: 'POST', body: JSON.stringify({ values: rows }) },
  );
}
