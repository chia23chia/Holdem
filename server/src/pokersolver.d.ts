// Minimal ambient declaration for the `pokersolver` package.
// Package is CommonJS with no official @types. We only use `Hand.solve`, `Hand.winners`,
// and instance method `loseTo`.
// Import pattern (ESM consumer):
//   import pokersolver from 'pokersolver';
//   const { Hand } = pokersolver;
declare module 'pokersolver' {
  export interface SolvedHand {
    name: string;         // e.g. "Two Pair"
    descr: string;        // e.g. "Two Pair, K's & 8's"
    rank: number;         // Higher = stronger
    cards: unknown[];     // Best 5-card selection (opaque; we don't inspect)
    cardPool?: unknown[]; // 7-card pool passed in
    loseTo(hand: SolvedHand): boolean; // full kicker-level comparison
  }

  export interface HandStatic {
    // cards: array of 2-char strings like 'As' (rank + lowercase suit)
    solve(cards: string[]): SolvedHand;
    winners(hands: SolvedHand[]): SolvedHand[];
  }

  const pokersolver: { Hand: HandStatic };
  export default pokersolver;
  // Named export also works via Node's ESM interop for CJS modules that set
  // module.exports.Hand, but the default-then-destructure pattern is more portable.
  export const Hand: HandStatic;
}
