// Audio cue player. Client-only (references Audio + localStorage). Every cue
// is optional — if the file 404s or autoplay is blocked, the call is a
// silent no-op. Sound files live at web/public/sounds/{key}.wav and are
// deployed as static assets; missing files just mean the cue is silent.
// Shipped as short synthesized placeholder tones (see
// scripts/gen-sounds.mjs) — swap in real recordings by replacing the .wav
// files, no code change needed as long as the filenames match.

const CUE_FILES = {
  deal: '/sounds/deal.wav',
  fold: '/sounds/fold.wav',
  check: '/sounds/check.wav',
  call: '/sounds/call.wav',
  raise: '/sounds/raise.wav',
  allin: '/sounds/allin.wav',
  street: '/sounds/street.wav',
  win: '/sounds/win.wav',
  myturn: '/sounds/myturn.wav',
} as const;

export type SoundCue = keyof typeof CUE_FILES;

const MUTED_KEY = 'holdem:sound-muted';
const audioPool = new Map<SoundCue, HTMLAudioElement>();

export function isMuted(): boolean {
  if (typeof window === 'undefined') return true;
  return window.localStorage.getItem(MUTED_KEY) === '1';
}

export function setMuted(muted: boolean): void {
  if (typeof window === 'undefined') return;
  if (muted) window.localStorage.setItem(MUTED_KEY, '1');
  else window.localStorage.removeItem(MUTED_KEY);
}

export function playCue(cue: SoundCue): void {
  if (typeof window === 'undefined') return;
  if (isMuted()) return;
  let audio = audioPool.get(cue);
  if (!audio) {
    audio = new Audio(CUE_FILES[cue]);
    audio.preload = 'auto';
    audioPool.set(cue, audio);
  }
  try {
    audio.currentTime = 0;
    void audio.play().catch(() => {
      // Autoplay policy, 404, or codec issue — silent no-op is fine.
    });
  } catch {
    // Some browsers throw setting currentTime before metadata loads.
  }
}
