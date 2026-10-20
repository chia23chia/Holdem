'use client';
import { createContext } from 'react';

// Deck color scheme is read deep in CardView / InlineCard — passing a prop
// through 8 call sites (some inside SeatCard/HistoryList) would be noisy,
// so hand it out via context set once at the top of RoomPage.
export const FourColorContext = createContext(true);
