import { describe, expect, test } from "bun:test";
import { compareDuelSnapshots, netReturnPct, updateElo, isInsideMatchWindow } from "../src/lib/trading-engine";

describe("TradeDuel scoring primitives", () => {
  test("deducts fees from ending portfolio value", () => {
    expect(netReturnPct({ startValueUsd: 100, endValueUsd: 120, feesUsd: 2, transfersUsd: 0, asOf: 1000 })).toBe(18);
  });
  test("rejects mismatched valuation timestamps", () => {
    expect(() => compareDuelSnapshots({ startValueUsd: 100, endValueUsd: 110, feesUsd: 0, transfersUsd: 0, asOf: 1000 }, { startValueUsd: 100, endValueUsd: 105, feesUsd: 0, transfersUsd: 0, asOf: 1001 })).toThrow();
  });
  test("detects a tie inside the configured band", () => {
    expect(compareDuelSnapshots({ startValueUsd: 100, endValueUsd: 110, feesUsd: 0, transfersUsd: 0, asOf: 1000 }, { startValueUsd: 100, endValueUsd: 109.995, feesUsd: 0, transfersUsd: 0, asOf: 1000 }).outcome).toBe("draw");
  });
  test("ELO is zero-sum for a completed duel", () => {
    const next = updateElo(1000, 1000, "player_one");
    expect(next.ratingOne).toBe(1016);
    expect(next.ratingTwo).toBe(984);
  });
  test("only accepts activity inside the match time window", () => {
    expect(isInsideMatchWindow(150, 100, 200)).toBe(true);
    expect(isInsideMatchWindow(99, 100, 200)).toBe(false);
    expect(isInsideMatchWindow(null, 100, 200)).toBe(false);
  });
});
