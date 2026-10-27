import { describe, expect, test } from "bun:test";
import { summarizeEstimatedRealizedPnl } from "../src/lib/solana-evidence";
import { aggregateRawTokenBalances, buildAccountingLedgerSummary, buildProtocolSwapCandidate, classifySwapEvidence, classifyTransferFlow, decodePumpFunInstruction, identifySwapProtocol, nativeBalanceAccounting, resolveInstructionProgramId, selectHistoricalCandle, tokenBalanceDeltas } from "../src/lib/solana-evidence";

const wallet = "Wallet111111111111111111111111111111111";

describe("Solana evidence helpers", () => {
  test("aggregates all token accounts using exact raw integer amounts", () => {
    const rows = [
      { mint: "mintA", owner: wallet, uiTokenAmount: { amount: "9007199254740991", decimals: 6 } },
      { mint: "mintA", owner: wallet, uiTokenAmount: { amount: "9", decimals: 6 } },
      { mint: "mintA", owner: "other", uiTokenAmount: { amount: "999", decimals: 6 } },
    ];
    expect(aggregateRawTokenBalances(rows, wallet).get("mintA")?.raw).toBe(9007199254741000n);
  });

  test("computes raw-unit deltas without dropping a tiny change", () => {
    const pre = [{ mint: "mintA", owner: wallet, uiTokenAmount: { amount: "1000000000000000001", decimals: 9 } }];
    const post = [{ mint: "mintA", owner: wallet, uiTokenAmount: { amount: "1000000000000000002", decimals: 9 } }];
    expect(tokenBalanceDeltas(pre, post, wallet)[0].rawDelta).toBe("1");
  });

  test("marks wallet-directed transfers as external flow candidates", () => {
    expect(classifyTransferFlow({ source: "outside", destination: "token-account", destinationOwner: wallet, wallet, kind: "token" })).toBe("external_token_inflow_candidate");
    expect(classifyTransferFlow({ source: wallet, destination: "outside", wallet, kind: "sol" })).toBe("external_sol_outflow_candidate");
  });

  test("separates fee adjustment from unresolved rent and native effects", () => {
    expect(nativeBalanceAccounting(1000, 700, 100, true)).toEqual({ rawDeltaLamports: -300, feeLamports: 100, deltaExcludingNetworkFeeLamports: -200, rentAndOtherNativeEffectsReconciled: false });
  });

  test("does not label unsupported or unrelated instruction data as Pump.fun trades", () => {
    expect(decodePumpFunInstruction("11111111111111111111111111111111", "3Bxs4h")).toBeNull();
    expect(decodePumpFunInstruction("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P", undefined)).toBeNull();
  });

  test("resolves parsed, compiled, and v0 loaded-address program IDs", () => {
    const keys = ["wallet", { pubkey: "static-program" }];
    expect(resolveInstructionProgramId({ programId: "parsed-program" }, keys)).toBe("parsed-program");
    expect(resolveInstructionProgramId({ programIdIndex: 1 }, keys)).toBe("static-program");
    expect(resolveInstructionProgramId({ programIdIndex: 2 }, keys, { writable: ["loaded-writable"], readonly: ["loaded-readonly"] })).toBe("loaded-writable");
    expect(resolveInstructionProgramId({ programIdIndex: 3 }, keys, { writable: ["loaded-writable"], readonly: ["loaded-readonly"] })).toBe("loaded-readonly");
    expect(resolveInstructionProgramId({ programIdIndex: -1 }, keys)).toBeNull();
  });

  test("identifies known swap protocols without treating them as confirmed fills", () => {
    expect(identifySwapProtocol([
      "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
      "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
      "JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB",
      "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
      "unknown-program",
    ])).toEqual(["pump_fun", "jupiter", "raydium_amm"]);
  });

  test("accepts only valid historical candles close to the target timestamp", () => {
    expect(selectHistoricalCandle([[1000,1,2,1,1.5,10],[1120,1,2,1,1.8,20]],1100)).toEqual({timestamp:1120,closeUsd:1.8,distanceSeconds:20});
    expect(selectHistoricalCandle([[700,1,2,1,1.5,10]],1000)).toBeNull();
    expect(selectHistoricalCandle([[1000,1,2,1,0,10]],1000)).toBeNull();
  });

  test("normalizes token-to-token swap-shaped deltas with exact raw amounts", () => {
    const candidate = buildProtocolSwapCandidate({
      success: true, protocol: "jupiter", instructionNames: ["Route"],
      tokenDeltas: [
        { mint: "mint-in", rawDelta: "-9007199254740993", decimals: 6 },
        { mint: "mint-out", rawDelta: "123456789", decimals: 9 },
      ], nativeDeltaLamports: -5000, feeLamports: 5000, walletIsFeePayer: true,
      externalFlowClasses: [], hasLifecycleEffects: false,
    });
    expect(candidate?.inputMint).toBe("mint-in");
    expect(candidate?.inputRaw).toBe("9007199254740993");
    expect(candidate?.outputMint).toBe("mint-out");
    expect(candidate?.outputRaw).toBe("123456789");
    expect(candidate?.canCountAsVerifiedFill).toBe(false);
    expect(candidate?.blockers).toContain("balance_delta_inference_not_protocol_fill_event");
  });

  test("normalizes SOL-to-token candidates while keeping rent and transfer blockers", () => {
    const candidate = buildProtocolSwapCandidate({
      success: true, protocol: "pump_fun", instructionNames: ["Buy"],
      tokenDeltas: [{ mint: "mint-out", rawDelta: "1000", decimals: 6 }],
      nativeDeltaLamports: -150000, feeLamports: 5000, walletIsFeePayer: true,
      externalFlowClasses: ["external_sol_outflow_candidate"], hasLifecycleEffects: true,
    });
    expect(candidate?.inputMint).toBe("native:SOL");
    expect(candidate?.inputRaw).toBe("145000");
    expect(candidate?.outputRaw).toBe("1000");
    expect(candidate?.blockers).toContain("external_transfer_flows_need_reconciliation");
    expect(candidate?.blockers).toContain("token_account_rent_or_lifecycle_effects_unresolved");
    expect(candidate?.canCountAsVerifiedFill).toBe(false);
  });

  test("does not normalize failed, unrelated, or ambiguous multi-token transactions", () => {
    const base = { protocol: "jupiter", instructionNames: ["Route"], tokenDeltas: [{ mint: "mint", rawDelta: "1", decimals: 6 }], nativeDeltaLamports: 0, feeLamports: 0, walletIsFeePayer: false, externalFlowClasses: [], hasLifecycleEffects: false };
    expect(buildProtocolSwapCandidate({ ...base, success: false })).toBeNull();
    expect(buildProtocolSwapCandidate({ ...base, success: true, protocol: null })).toBeNull();
    expect(buildProtocolSwapCandidate({ ...base, success: true, tokenDeltas: [{mint:"a",rawDelta:"-1",decimals:0},{mint:"b",rawDelta:"2",decimals:0},{mint:"c",rawDelta:"3",decimals:0}] })).toBeNull();
  });

  test("ledger keeps fees, flows, and unresolved rent as explicit blockers", () => {
    const ledger = buildAccountingLedgerSummary({
      success: true,
      nativeDeltaLamports: -1200,
      feeLamports: 100,
      walletIsFeePayer: true,
      tokenDeltas: [{ mint: "mintA", rawDelta: "25", decimals: 6, amount: 0.000025 }],
      externalFlows: [{ classification: "external_sol_outflow_candidate", lamports: 500 }],
      protocols: ["pump_fun"],
      hasLifecycleEffects: true,
    });
    expect(ledger.nativeDeltaExFeeLamports).toBe(-1100);
    expect(ledger.blockers).toContain("external_flows_need_reconciliation");
    expect(ledger.blockers).toContain("token_account_lifecycle_or_rent_unresolved");
    expect(ledger.canCountAsVerifiedFill).toBe(false);
  });

  test("never promotes a recognized swap program to a confirmed fill", () => {
    expect(classifySwapEvidence({ success: true, recognizedProgram: true, hasTokenDelta: true, hasExternalFlow: false, hasLifecycleInstruction: false })).toEqual({ classification: "swap_candidate", confidence: "low", canCountAsFill: false });
    expect(classifySwapEvidence({ success: true, recognizedProgram: true, hasTokenDelta: true, hasExternalFlow: true, hasLifecycleInstruction: false }).classification).toBe("swap_or_flow_ambiguous");
  });
});

describe("estimated realized P&L from buy/sell candidates", () => {
  const wallet = "Wallet111111111111111111111111111111111";
  const buy = (overrides: Record<string, unknown> = {}) => ({
    wallet, token_mint: "mintA", token_delta: 10, sol_delta_net: 1, direction: "buy_candidate",
    block_time: 100, signature: "buy-1", ...overrides,
  });
  const sell = (overrides: Record<string, unknown> = {}) => ({
    wallet, token_mint: "mintA", token_delta: -10, sol_delta_net: 1.3, direction: "sell_candidate",
    block_time: 200, signature: "sell-1", ...overrides,
  });

  test("records realized profit when a holding is sold above cost basis", () => {
    const [result] = summarizeEstimatedRealizedPnl([sell(), buy()] as any);
    expect(result.realizedPnlSol).toBeCloseTo(0.3);
    expect(result.matchedSellTokens).toBe(10);
    expect(result.unmatchedSellTokens).toBe(0);
    expect(result.status).toBe("provisional_candidate_estimate");
  });

  test("records realized loss when a holding is sold below cost basis", () => {
    const [result] = summarizeEstimatedRealizedPnl([sell({sol_delta_net:0.7}), buy()] as any);
    expect(result.realizedPnlSol).toBeCloseTo(-0.3);
  });

  test("handles partial sells and preserves unsold cost basis", () => {
    const [result] = summarizeEstimatedRealizedPnl([buy(), sell({token_delta:-4, sol_delta_net:0.6})] as any);
    expect(result.realizedPnlSol).toBeCloseTo(0.2);
    expect(result.matchedSellTokens).toBe(4);
    expect(result.unmatchedSellTokens).toBe(0);
  });

  test("does not assume profit for sells without a tracked buy", () => {
    const [result] = summarizeEstimatedRealizedPnl([sell()] as any);
    expect(result.realizedPnlSol).toBe(0);
    expect(result.unmatchedSellTokens).toBe(10);
    expect(result.blockers).toContain("sell_quantity_exceeds_tracked_buy_lots");
  });

  test("keeps wallet and token cost bases separate", () => {
    const [result] = summarizeEstimatedRealizedPnl([
      buy({wallet:"wallet-1"}), sell({wallet:"wallet-2"}),
    ] as any);
    expect(result.wallet).toBe("wallet-1");
    expect(result.realizedPnlSol).toBe(0);
  });
});
