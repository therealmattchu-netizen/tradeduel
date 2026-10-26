/** Pure helpers for conservative Solana evidence classification. These do not certify fills. */
export type TokenBalanceLike = {
  mint: string;
  owner?: string;
  accountIndex?: number;
  uiTokenAmount?: { amount?: string; decimals?: number; uiAmountString?: string | null; uiAmount?: number | null };
};

/** Exact raw-unit aggregation avoids float rounding when reconciling token accounts. */
export function aggregateRawTokenBalances(balances: TokenBalanceLike[], wallet: string) {
  const totals = new Map<string, { raw: bigint; decimals: number }>();
  for (const balance of balances) {
    if (balance.owner !== wallet) continue;
    const amount = balance.uiTokenAmount?.amount ?? "0";
    const decimals = Number(balance.uiTokenAmount?.decimals ?? 0);
    if (!/^\d+$/.test(amount) || !Number.isInteger(decimals) || decimals < 0 || decimals > 30) continue;
    const current = totals.get(balance.mint) ?? { raw: 0n, decimals };
    // If inconsistent decimals are returned for one mint, retain the evidence but do not merge it.
    if (current.decimals !== decimals) continue;
    current.raw += BigInt(amount);
    totals.set(balance.mint, current);
  }
  return totals;
}

export function tokenBalanceDeltas(pre: TokenBalanceLike[], post: TokenBalanceLike[], wallet: string) {
  const before = aggregateRawTokenBalances(pre, wallet);
  const after = aggregateRawTokenBalances(post, wallet);
  const mints = new Set([...before.keys(), ...after.keys()]);
  return [...mints].flatMap((mint) => {
    const a = before.get(mint), b = after.get(mint);
    const decimals = b?.decimals ?? a?.decimals ?? 0;
    if (a && b && a.decimals !== b.decimals) return [];
    const rawDelta = (b?.raw ?? 0n) - (a?.raw ?? 0n);
    if (rawDelta === 0n) return [];
    return [{ mint, rawDelta: rawDelta.toString(), decimals, amount: Number(rawDelta) / (10 ** decimals) }];
  });
}

export type TransferContext = {
  source?: string | null;
  destination?: string | null;
  sourceOwner?: string | null;
  destinationOwner?: string | null;
  wallet: string;
  kind: "sol" | "token";
};

/** Directional labels are evidence of wallet flows, not evidence of trading or profit. */
export function classifyTransferFlow(input: TransferContext): string {
  const sourceIsWallet = input.source === input.wallet || input.sourceOwner === input.wallet;
  const destinationIsWallet = input.destination === input.wallet || input.destinationOwner === input.wallet;
  if (sourceIsWallet && destinationIsWallet) return input.kind === "sol" ? "internal_sol_transfer" : "internal_token_transfer";
  if (input.kind === "sol") {
    if (sourceIsWallet) return "external_sol_outflow_candidate";
    if (destinationIsWallet) return "external_sol_inflow_candidate";
  } else {
    if (sourceIsWallet) return "external_token_outflow_candidate";
    if (destinationIsWallet) return "external_token_inflow_candidate";
  }
  return input.kind === "sol" ? "other_sol_transfer" : "other_token_transfer";
}

export function nativeBalanceAccounting(preLamports: number, postLamports: number, feeLamports: number, walletIsFeePayer: boolean) {
  const rawDelta = postLamports - preLamports;
  const fee = walletIsFeePayer ? feeLamports : 0;
  return {
    rawDeltaLamports: rawDelta,
    feeLamports: fee,
    deltaExcludingNetworkFeeLamports: rawDelta + fee,
    // Never claim rent is fully reconciled from net balances alone.
    rentAndOtherNativeEffectsReconciled: false as const,
  };
}



export const SOLANA_SWAP_PROGRAMS = {
  jupiter_v6: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
  jupiter_v4: "JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB",
  pump_fun: "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
  raydium_amm: "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
} as const;

/** Resolve both parsed instructions and compiled instructions, including v0 loaded keys. */
export function resolveInstructionProgramId(
  instruction: { programId?: unknown; programIdIndex?: unknown },
  accountKeys: Array<string | { pubkey?: string }>,
  loadedAddresses: { writable?: string[]; readonly?: string[] } = {},
): string | null {
  if (typeof instruction.programId === "string" && instruction.programId.length > 0) return instruction.programId;
  const index = instruction.programIdIndex;
  if (typeof index !== "number" || !Number.isInteger(index) || index < 0) return null;
  const staticKeys = accountKeys.map((key) => typeof key === "string" ? key : key.pubkey ?? "");
  const allKeys = [...staticKeys, ...(loadedAddresses.writable ?? []), ...(loadedAddresses.readonly ?? [])];
  return allKeys[index] || null;
}

export function identifySwapProtocol(programIds: string[]): string[] {
  const protocols = new Set<string>();
  for (const id of programIds) {
    if (id === SOLANA_SWAP_PROGRAMS.pump_fun) protocols.add("pump_fun");
    else if (id === SOLANA_SWAP_PROGRAMS.jupiter_v6 || id === SOLANA_SWAP_PROGRAMS.jupiter_v4) protocols.add("jupiter");
    else if (id === SOLANA_SWAP_PROGRAMS.raydium_amm) protocols.add("raydium_amm");
  }
  return [...protocols];
}

const PUMP_FUN_PROGRAM_ID = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const PUMP_INSTRUCTION_DISCRIMINATORS: Record<string, string> = {
  "102,6,61,18,1,218,235,234": "buy",
  "51,230,133,164,1,127,131,173": "sell",
};

function decodeBase58(input: string): Uint8Array | null {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let value = 0n;
  for (const char of input) {
    const digit = alphabet.indexOf(char);
    if (digit < 0) return null;
    value = value * 58n + BigInt(digit);
  }
  const bytes: number[] = [];
  while (value > 0n) { bytes.unshift(Number(value & 255n)); value >>= 8n; }
  for (let i = 0; i < input.length && input[i] === "1"; i++) bytes.unshift(0);
  return Uint8Array.from(bytes);
}

function readU64LE(bytes: Uint8Array, offset: number): string | null {
  if (bytes.length < offset + 8) return null;
  let value = 0n;
  for (let i = 7; i >= 0; i--) value = (value << 8n) | BigInt(bytes[offset + i]);
  return value.toString();
}

/** Decode only stable, documented Pump.fun buy/sell instruction headers and u64 args.
 * The result is instruction intent, never proof that a fill settled successfully. */
export function decodePumpFunInstruction(programId: string, encodedData: string | undefined) {
  if (programId !== PUMP_FUN_PROGRAM_ID || !encodedData) return null;
  const bytes = decodeBase58(encodedData);
  if (!bytes || bytes.length < 24) return null;
  const discriminator = Array.from(bytes.slice(0, 8)).join(",");
  const name = PUMP_INSTRUCTION_DISCRIMINATORS[discriminator];
  if (!name) return null;
  return {
    program: "pump_fun",
    name,
    firstArgumentRaw: readU64LE(bytes, 8),
    secondArgumentRaw: readU64LE(bytes, 16),
    argumentsNote: name === "buy" ? "amount_raw_and_max_sol_cost_raw" : "amount_raw_and_min_sol_output_raw",
    isExecutionProof: false as const,
  };
}

export function selectHistoricalCandle(candles: number[][], targetAt: number, maxDistanceSeconds = 180) {
  const valid = candles.filter((row) => row.length >= 5 && Number.isFinite(row[0]) && Number.isFinite(row[4]) && row[4] > 0 && Number.isInteger(row[0]));
  const candle = valid.sort((a,b) => Math.abs(a[0]-targetAt)-Math.abs(b[0]-targetAt))[0];
  if (!candle || Math.abs(candle[0]-targetAt) > maxDistanceSeconds) return null;
  return { timestamp: candle[0], closeUsd: candle[4], distanceSeconds: Math.abs(candle[0]-targetAt) };
}

export type SwapBalanceDelta = { mint: string; rawDelta: string; decimals: number };

/** Produces a normalized swap-shaped candidate from transaction balance deltas.
 * It deliberately never calls this a confirmed fill: transfer, rent, and protocol
 * event reconciliation are separate requirements. Native SOL amounts are lamports.
 */
export function buildProtocolSwapCandidate(input: {
  success: boolean;
  protocol: string | null;
  instructionNames: string[];
  tokenDeltas: SwapBalanceDelta[];
  nativeDeltaLamports: number;
  feeLamports: number;
  walletIsFeePayer: boolean;
  externalFlowClasses: string[];
  hasLifecycleEffects: boolean;
}) {
  if (!input.success || !input.protocol) return null;
  const blockers = ["balance_delta_inference_not_protocol_fill_event"];
  const normalizedNames = input.instructionNames.map((name) => name.toLowerCase());
  if (!normalizedNames.some((name) => /buy|sell|swap|route|exact.?in|exact.?out|sharedaccountsroute/.test(name))) blockers.push("recognized_protocol_without_recognized_swap_instruction_log");
  if (input.externalFlowClasses.length) blockers.push("external_transfer_flows_need_reconciliation");
  if (input.hasLifecycleEffects) blockers.push("token_account_rent_or_lifecycle_effects_unresolved");
  if (input.feeLamports > 0) blockers.push("network_fee_not_allocated_to_swap_legs");

  const legs: Array<{ mint: string; raw: bigint; decimals: number }> = input.tokenDeltas.flatMap((delta) => {
    if (!/^-?\d+$/.test(delta.rawDelta) || !Number.isInteger(delta.decimals) || delta.decimals < 0 || delta.decimals > 30) return [];
    const raw = BigInt(delta.rawDelta);
    return raw === 0n ? [] : [{ mint: delta.mint, raw, decimals: delta.decimals }];
  });
  const negative = legs.filter((leg) => leg.raw < 0n);
  const positive = legs.filter((leg) => leg.raw > 0n);
  let inputLeg: { mint: string; raw: bigint; decimals: number } | null = null;
  let outputLeg: { mint: string; raw: bigint; decimals: number } | null = null;
  if (negative.length === 1 && positive.length === 1 && legs.length === 2) {
    inputLeg = { ...negative[0], raw: -negative[0].raw }; outputLeg = positive[0];
  } else if (legs.length === 1 && Math.abs(input.nativeDeltaLamports) > 0) {
    // Remove network fee only when paid by this wallet. Other native effects (rent,
    // bundled transfers, priority fees) remain a blocker rather than being guessed away.
    const adjustedNative = BigInt(Math.trunc(input.nativeDeltaLamports + (input.walletIsFeePayer ? input.feeLamports : 0)));
    const token = legs[0];
    if (token.raw > 0n && adjustedNative < 0n) {
      inputLeg = { mint: "native:SOL", raw: -adjustedNative, decimals: 9 };
      outputLeg = { mint: token.mint, raw: token.raw, decimals: token.decimals };
    } else if (token.raw < 0n && adjustedNative > 0n) {
      inputLeg = { mint: token.mint, raw: -token.raw, decimals: token.decimals };
      outputLeg = { mint: "native:SOL", raw: adjustedNative, decimals: 9 };
    }
    blockers.push("native_balance_may_include_rent_or_bundled_transfers");
  }
  if (!inputLeg || !outputLeg) return null;
  return {
    protocol: input.protocol,
    instructionNames: [...new Set(input.instructionNames)],
    inputMint: inputLeg.mint,
    inputRaw: inputLeg.raw.toString(),
    inputDecimals: inputLeg.decimals,
    outputMint: outputLeg.mint,
    outputRaw: outputLeg.raw.toString(),
    outputDecimals: outputLeg.decimals,
    nativeDeltaLamports: Math.trunc(input.nativeDeltaLamports),
    feeLamports: Math.trunc(input.walletIsFeePayer ? input.feeLamports : 0),
    evidenceLevel: "candidate" as const,
    blockers: [...new Set(blockers)],
    canCountAsVerifiedFill: false as const,
  };
}

export function classifySwapEvidence(input: { success: boolean; recognizedProgram: boolean; hasTokenDelta: boolean; hasExternalFlow: boolean; hasLifecycleInstruction: boolean }) {
  if (!input.success) return { classification: "failed", confidence: "none", canCountAsFill: false } as const;
  if (input.hasExternalFlow) return { classification: "swap_or_flow_ambiguous", confidence: "low", canCountAsFill: false } as const;
  if (input.recognizedProgram && input.hasTokenDelta) return { classification: "swap_candidate", confidence: "low", canCountAsFill: false } as const;
  if (input.hasLifecycleInstruction) return { classification: "account_lifecycle_or_rent", confidence: "low", canCountAsFill: false } as const;
  if (input.hasTokenDelta) return { classification: "token_movement", confidence: "low", canCountAsFill: false } as const;
  return { classification: "unclassified", confidence: "none", canCountAsFill: false } as const;
}

export type LedgerSummaryInput = {
  success: boolean;
  nativeDeltaLamports: number;
  feeLamports: number;
  walletIsFeePayer: boolean;
  tokenDeltas: Array<{ mint: string; rawDelta: string; decimals: number; amount: number }>;
  externalFlows: Array<{ classification: string; mint?: string | null; raw?: string | null; lamports?: number | null }>;
  protocols: string[];
  hasLifecycleEffects: boolean;
};

export function buildAccountingLedgerSummary(input: LedgerSummaryInput) {
  const fee = input.walletIsFeePayer ? input.feeLamports : 0;
  const blockers: string[] = [];
  if (!input.success) blockers.push("transaction_failed");
  if (input.externalFlows.length) blockers.push("external_flows_need_reconciliation");
  if (input.hasLifecycleEffects) blockers.push("token_account_lifecycle_or_rent_unresolved");
  if (fee > 0) blockers.push("network_fee_observed_not_allocated_to_fill");
  if (!input.protocols.length) blockers.push("protocol_not_recognized");
  if (!input.tokenDeltas.length) blockers.push("no_wallet_token_delta");
  return {
    nativeDeltaLamports: input.nativeDeltaLamports,
    feeLamports: fee,
    nativeDeltaExFeeLamports: input.nativeDeltaLamports + fee,
    tokenDeltas: input.tokenDeltas,
    externalFlows: input.externalFlows,
    protocols: input.protocols,
    evidenceLevel: "candidate" as const,
    blockers,
    canCountAsVerifiedFill: false as const,
  };
}
