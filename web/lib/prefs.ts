// Client-only user prefs kept in localStorage. Anything here is a personal
// UI preference (blocklist, deck color scheme, …) — never sent to the
// server and never shared across devices.

const BLOCKED_KEY = 'holdem:blocked-users';
const FOUR_COLOR_KEY = 'holdem:4color-deck';

export interface BlockedUser {
  userId: string;
  name: string; // cached at block time so the manage UI can label it later
}

export function loadBlocked(): BlockedUser[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(BLOCKED_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (v): v is BlockedUser =>
        typeof v?.userId === 'string' && typeof v?.name === 'string',
    );
  } catch {
    return [];
  }
}

export function saveBlocked(list: BlockedUser[]): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(BLOCKED_KEY, JSON.stringify(list));
}

// Default true — enabled by default because the whole reason for adding it
// is that black spade / black club were reported as confusing.
export function loadFourColorDeck(): boolean {
  if (typeof window === 'undefined') return true;
  const raw = window.localStorage.getItem(FOUR_COLOR_KEY);
  if (raw === null) return true;
  return raw === '1';
}

export function saveFourColorDeck(enabled: boolean): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(FOUR_COLOR_KEY, enabled ? '1' : '0');
}
