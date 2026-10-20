'use client';
import { useEffect } from 'react';

// Shared modal-dismissal hook (U-3 A4). Dismisses on the Escape key.
// External BT keyboards on iOS have Esc; desktop players reflex-press it.
// Called from inside each modal component so the listener is scoped to its
// own mount/unmount — no need for a central "which modal is open" registry.
export function useEscape(onEscape: () => void): void {
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onEscape();
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onEscape]);
}
