/** Deterministic scoring primitives. These functions never read untrusted client scores.
 * Callers must provide a verified, same-window portfolio snapshot from an audited indexer. */
export type DuelOutcome = "player_one" | "player_two" | "draw";
export interface PortfolioSnapshot { startValueUsd: number; endValueUsd: number; feesUsd: number; transfersUsd: number; asOf: number; }
export interface DuelScore { returnOnePct: number; returnTwoPct: number; outcome: DuelOutcome; }

export function netReturnPct(snapshot: PortfolioSnapshot): number {
  const values = [snapshot.startValueUsd, snapshot.endValueUsd, snapshot.feesUsd, snapshot.transfersUsd, snapshot.asOf];
  if (values.some((v) => !Number.isFinite(v)) || snapshot.startValueUsd <= 0 || snapshot.endValueUsd < 0 || snapshot.feesUsd < 0 || snapshot.asOf < 0) {
    throw new Error("Portfolio snapshot is invalid.");
  }
  // Transfers must already be reconciled by the indexer; they are not silently treated as profit.
  const adjustedEnd = snapshot.endValueUsd - snapshot.feesUsd - snapshot.transfersUsd;
  return ((adjustedEnd - snapshot.startValueUsd) / snapshot.startValueUsd) * 100;
}

export function compareDuelSnapshots(one: PortfolioSnapshot, two: PortfolioSnapshot, tieBandPct = 0.01): DuelScore {
  if (one.asOf !== two.asOf) throw new Error("Both players must use the same valuation timestamp.");
  if (!Number.isFinite(tieBandPct) || tieBandPct < 0 || tieBandPct > 1) throw new Error("Tie band must be between 0 and 1 percentage points.");
  const returnOnePct = netReturnPct(one);
  const returnTwoPct = netReturnPct(two);
  const diff = returnOnePct - returnTwoPct;
  return { returnOnePct, returnTwoPct, outcome: Math.abs(diff) <= tieBandPct ? "draw" : diff > 0 ? "player_one" : "player_two" };
}

export function updateElo(ratingOne: number, ratingTwo: number, outcome: DuelOutcome, kFactor = 32): { ratingOne: number; ratingTwo: number } {
  if (![ratingOne, ratingTwo, kFactor].every(Number.isFinite) || ratingOne < 0 || ratingTwo < 0 || kFactor <= 0 || kFactor > 64) throw new Error("Invalid rating input.");
  const expectedOne = 1 / (1 + 10 ** ((ratingTwo - ratingOne) / 400));
  const scoreOne = outcome === "draw" ? 0.5 : outcome === "player_one" ? 1 : 0;
  const nextOne = Math.round(ratingOne + kFactor * (scoreOne - expectedOne));
  const nextTwo = Math.round(ratingTwo + kFactor * ((1 - scoreOne) - (1 - expectedOne)));
  return { ratingOne: nextOne, ratingTwo: nextTwo };
}

export function isInsideMatchWindow(blockTime: number | null, startTime: number, endTime: number): boolean {
  return blockTime !== null && Number.isFinite(blockTime) && blockTime >= startTime && blockTime <= endTime;
}
