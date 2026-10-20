'use client';
import { useReducer } from 'react';
import type { Card, HandStatePublic } from '@holdem/shared';

// R-3b: Consolidates the four tightly-coupled "live hand" pieces that all
// reset together on game:started and are read together everywhere. Keeps
// the rest of RoomPage's useState (room, messages, chat, modals, timer,
// prefs) as-is — those aren't coupled to the poker hand lifecycle.
//
// Not covered here on purpose:
//   streetQueue / streetPlaying / timeouts — refs, not state (mutating
//     them shouldn't trigger re-render; useRef is still the right call)
//   hands history, standings, allInReveal, lastActionBySeat — orthogonal
//     to the "current frame" and change on different events
//   currentEndResult — derived from hands.last.endResult, not stored

export interface PokerState {
  gameState: HandStatePublic | null;
  holeCards: [Card, Card] | null;
  handRank: string | null;
  // The community cards actually shown on the felt right now. During an
  // all-in runout this lags behind gameState.community for ~700ms per
  // street so each one is seen; otherwise it mirrors gameState.community
  // exactly (set instantly on game:started).
  displayedCommunity: Card[];
}

const initial: PokerState = {
  gameState: null,
  holeCards: null,
  handRank: null,
  displayedCommunity: [],
};

export type PokerAction =
  | { type: 'started'; state: HandStatePublic }
  | { type: 'state'; state: HandStatePublic }
  | { type: 'hole'; holeCards: [Card, Card]; handRank: string | null }
  | { type: 'display-community'; community: Card[] }
  | { type: 'ended-manual' }
  | { type: 'reset' };

function pokerReducer(s: PokerState, a: PokerAction): PokerState {
  switch (a.type) {
    case 'started':
      // New hand: fresh gameState, clear hole/rank (server will push
      // game:hole shortly), community snaps to whatever the server says
      // (reconnect-mid-hand case included).
      return {
        gameState: a.state,
        holeCards: null,
        handRank: null,
        displayedCommunity: a.state.community,
      };
    case 'state':
      return { ...s, gameState: a.state };
    case 'hole':
      return { ...s, holeCards: a.holeCards, handRank: a.handRank };
    case 'display-community':
      return { ...s, displayedCommunity: a.community };
    case 'ended-manual':
      // Owner force-end: drop active display but keep already-rendered
      // community (for players to still see). Caller handles the hands
      // history list separately.
      return { ...s, gameState: null, holeCards: null, handRank: null };
    case 'reset':
      return initial;
  }
}

export function usePokerState() {
  return useReducer(pokerReducer, initial);
}
