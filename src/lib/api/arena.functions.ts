import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { bindings } from "../bindings.server";
import { buildAccountingLedgerSummary, buildProtocolSwapCandidate, classifyTransferFlow, decodePumpFunInstruction, identifySwapProtocol, resolveInstructionProgramId, selectHistoricalCandle, tokenBalanceDeltas } from "../solana-evidence";

const WALLET_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
type ParsedTokenAccounts = { value: Array<{ account: { data: { parsed: { info: { mint: string; tokenAmount: { uiAmount: number | null } } } } } }> };
function base58Decode(input: string): Uint8Array {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n = 0n;
  for (const c of input) {
    const digit = alphabet.indexOf(c);
    if (digit < 0) throw new Error("Invalid base58 wallet address");
    n = n * 58n + BigInt(digit);
  }
  const bytes: number[] = [];
  while (n > 0n) { bytes.unshift(Number(n & 255n)); n >>= 8n; }
  for (let i = 0; i < input.length && input[i] === "1"; i++) bytes.unshift(0);
  return new Uint8Array(bytes);
}
function base64ToBytes(input: string): Uint8Array {
  const raw = atob(input);
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}
async function hash(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
type GeckoPoolChoice = { address: string; liquidityUsd: number };
type GeckoCandlePrice = { priceUsd: number | null; candleAt: number | null; poolAddress: string | null; liquidityUsd: number; reason: string };
async function fetchHistoricalTokenPrice(mint: string, targetAt: number, poolCache: Map<string, GeckoPoolChoice | null>): Promise<GeckoCandlePrice> {
  const noPrice = (reason: string, pool: GeckoPoolChoice | null = null): GeckoCandlePrice => ({ priceUsd: null, candleAt: null, poolAddress: pool?.address ?? null, liquidityUsd: pool?.liquidityUsd ?? 0, reason });
  let pool = poolCache.get(mint);
  if (pool === undefined) {
    try {
      const response = await fetch(`https://api.geckoterminal.com/api/v2/networks/solana/tokens/${encodeURIComponent(mint)}/pools?page=1`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(4000) });
      if (!response.ok) { poolCache.set(mint, null); return noPrice(`pool_lookup_http_${response.status}`); }
      const body = await response.json() as { data?: Array<{ id?: string; attributes?: { address?: string; reserve_in_usd?: string }; relationships?: { base_token?: { data?: { id?: string } }; quote_token?: { data?: { id?: string } } } }> };
      const candidates = (body.data ?? []).flatMap((item) => {
        const baseId = item.relationships?.base_token?.data?.id;
        const address = item.attributes?.address ?? item.id?.split("_").slice(1).join("_");
        const liquidityUsd = Number(item.attributes?.reserve_in_usd ?? 0);
        const quoteId = item.relationships?.quote_token?.data?.id;
        return (baseId === `solana_${mint}` || quoteId === `solana_${mint}`) && address && Number.isFinite(liquidityUsd) && liquidityUsd >= 1000 ? [{ address, liquidityUsd }] : [];
      }).sort((a,b) => b.liquidityUsd-a.liquidityUsd);
      pool = candidates[0] ?? null;
      poolCache.set(mint, pool);
    } catch { poolCache.set(mint, null); return noPrice("pool_lookup_unavailable"); }
  }
  if (!pool) return noPrice("no_liquid_pool_with_token_as_base_or_quote_asset");
  try {
    const url = `https://api.geckoterminal.com/api/v2/networks/solana/pools/${encodeURIComponent(pool.address)}/ohlcv/minute?aggregate=1&before_timestamp=${Math.floor(targetAt)+60}&limit=5&currency=usd`;
    const response = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(8000) });
    if (!response.ok) return noPrice(`ohlcv_http_${response.status}`, pool);
    const body = await response.json() as { data?: { attributes?: { ohlcv_list?: number[][] } } };
    const candle = selectHistoricalCandle(body.data?.attributes?.ohlcv_list ?? [],targetAt,180);
    if (!candle) return noPrice("no_candle_within_180_seconds_of_snapshot", pool);
    return { priceUsd: candle.closeUsd, candleAt: candle.timestamp, poolAddress: pool.address, liquidityUsd: pool.liquidityUsd, reason: "historical_minute_close_within_180_seconds" };
  } catch { return noPrice("ohlcv_unavailable", pool); }
}

async function requireSession(token: string) {
  const { DB } = bindings();
  if (!DB) throw new Error("Arena database is not configured yet.");
  if (!token || token.length < 24) throw new Error("Connect and verify your wallet first.");
  const tokenHash = await hash(token);
  const session = await DB.prepare("SELECT wallet FROM td_sessions WHERE token_hash = ? AND expires_at > ?").bind(tokenHash, Math.floor(Date.now() / 1000)).first<{ wallet: string }>();
  if (!session) throw new Error("Your session expired. Reconnect your wallet.");
  return { DB, wallet: session.wallet };
}

export const getArenaStatus = createServerFn({ method: "GET" }).handler(async () => {
  const { DB } = bindings();
  if (!DB) return { ready: false, message: "Database is not configured." };
  try {
    const row = await DB.prepare("SELECT (SELECT COUNT(*) FROM td_users) AS players, (SELECT COUNT(*) FROM td_matches WHERE verification_status = 'verified' AND status = 'completed') AS verified_matches, (SELECT COUNT(*) FROM td_queue WHERE status = 'waiting') AS waiting").first<{ players: number; verified_matches: number; waiting: number }>();
    return { ready: true, players: row?.players ?? 0, verifiedMatches: row?.verified_matches ?? 0, waiting: row?.waiting ?? 0 };
  } catch {
    return { ready: false, message: "Arena database is being initialized." };
  }
});

export const createWalletChallenge = createServerFn({ method: "POST" }).validator(z.object({ wallet: z.string().regex(WALLET_RE) })).handler(async ({ data }) => {
  const { DB } = bindings();
  if (!DB) throw new Error("Wallet verification is not configured yet.");
  const nonce = crypto.randomUUID();
  const domain = bindings().TRADEDUEL_WALLET_DOMAIN?.trim().toLowerCase();
  if (!domain || !/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(domain)) {
    throw new Error("Wallet verification is not configured for this deployment.");
  }
  const expiresAt = Math.floor(Date.now() / 1000) + 300;
  const message = `TradeDuel wallet verification\nDomain: ${domain}\nWallet: ${data.wallet}\nNonce: ${nonce}\nIssued At: ${new Date().toISOString()}\nExpiration Time: ${new Date(expiresAt * 1000).toISOString()}\n\nThis signature proves wallet ownership only. It does not authorize transactions or transfer funds.`;
  await DB.prepare("INSERT INTO td_challenges (nonce, wallet, message, expires_at) VALUES (?, ?, ?, ?)").bind(nonce, data.wallet, message, expiresAt).run();
  return { nonce, message, expiresAt };
});

export const verifyWalletChallenge = createServerFn({ method: "POST" }).validator(z.object({ wallet: z.string().regex(WALLET_RE), nonce: z.string().uuid(), signature: z.string().min(80).max(200) })).handler(async ({ data }) => {
  const { DB } = bindings();
  if (!DB) throw new Error("Wallet verification is not configured yet.");
  const challenge = await DB.prepare("SELECT message, expires_at, used FROM td_challenges WHERE nonce = ? AND wallet = ?").bind(data.nonce, data.wallet).first<{ message: string; expires_at: number; used: number }>();
  if (!challenge || challenge.used || challenge.expires_at < Math.floor(Date.now() / 1000)) throw new Error("This verification request expired. Please try again.");
  let valid = false;
  try {
    const publicKey = base58Decode(data.wallet);
    const signature = base64ToBytes(data.signature);
    if (publicKey.length !== 32 || signature.length !== 64) throw new Error("Invalid key or signature length");
    const keyBytes = new Uint8Array(publicKey).buffer as ArrayBuffer;
    const signatureBytes = new Uint8Array(signature).buffer as ArrayBuffer;
    const messageBytes = new TextEncoder().encode(challenge.message).buffer as ArrayBuffer;
    const key = await crypto.subtle.importKey("raw", keyBytes, { name: "Ed25519" }, false, ["verify"]);
    valid = await crypto.subtle.verify({ name: "Ed25519" }, key, signatureBytes, messageBytes);
  } catch { valid = false; }
  if (!valid) throw new Error("Wallet signature could not be verified.");
  // Consume the nonce atomically after signature verification. Two concurrent
  // requests may both verify the same signature, but only one may create a session.
  const consumed = await DB.prepare("UPDATE td_challenges SET used = 1 WHERE nonce = ? AND wallet = ? AND used = 0 AND expires_at >= ?")
    .bind(data.nonce, data.wallet, Math.floor(Date.now() / 1000)).run();
  if ((consumed.meta?.changes ?? 0) !== 1) throw new Error("This verification request has already been used or expired. Please reconnect your wallet.");
  await DB.prepare("INSERT INTO td_users (wallet) VALUES (?) ON CONFLICT(wallet) DO UPDATE SET last_seen_at = datetime('now')").bind(data.wallet).run();
  const token = `${crypto.randomUUID()}${crypto.randomUUID().replaceAll("-", "")}`;
  const tokenHash = await hash(token);
  const expiresAt = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 7;
  await DB.prepare("INSERT INTO td_sessions (token_hash, wallet, expires_at) VALUES (?, ?, ?)").bind(tokenHash, data.wallet, expiresAt).run();
  return { token, wallet: data.wallet, expiresAt };
});

export const getMyRating = createServerFn({ method: "POST" }).validator(z.object({ token: z.string().min(24) })).handler(async ({ data }) => {
  const { DB, wallet } = await requireSession(data.token);
  const row = await DB.prepare("SELECT rating, wins, losses, draws FROM td_users WHERE wallet = ?").bind(wallet).first<{ rating: number; wins: number; losses: number; draws: number }>();
  return { wallet, rating: row?.rating ?? 1000, wins: row?.wins ?? 0, losses: row?.losses ?? 0, draws: row?.draws ?? 0, eloActive: false };
});

export const getLeaderboard = createServerFn({ method: "GET" }).handler(async () => {
  const { DB } = bindings();
  if (!DB) return { players: [], verified: false };
  const result = await DB.prepare("SELECT u.wallet, u.rating, u.wins, u.losses, u.draws FROM td_users u WHERE EXISTS (SELECT 1 FROM td_matches m WHERE m.verification_status = 'verified' AND m.status = 'completed' AND (m.player_one = u.wallet OR m.player_two = u.wallet)) ORDER BY u.rating DESC, u.wins DESC LIMIT 100").all<{ wallet: string; rating: number; wins: number; losses: number; draws: number }>();
  return { players: result.results ?? [], verified: true };
});

export const joinMatchmakingQueue = createServerFn({ method: "POST" }).validator(z.object({ token: z.string().min(24), format: z.enum(["standard", "one_position", "exposure_cap", "equal_start"]), durationSeconds: z.number().int().min(900).max(86400) })).handler(async ({ data }) => {
  const { DB, wallet } = await requireSession(data.token);
  const existing = await DB.prepare("SELECT id, status, match_id, format, duration_seconds FROM td_queue WHERE wallet = ?").bind(wallet).first<{ id: number; status: string; match_id: string | null; format: string; duration_seconds: number }>();
  if (existing?.status === "matched" && existing.match_id) {
    const linkedMatch = await DB.prepare("SELECT status, ends_at FROM td_matches WHERE id = ? AND (player_one = ? OR player_two = ?)").bind(existing.match_id, wallet, wallet).first<{ status: string; ends_at: string | null }>();
    const matchFinished = linkedMatch && (linkedMatch.status !== "active" || (linkedMatch.ends_at && linkedMatch.ends_at <= new Date().toISOString()));
    if (matchFinished) {
      await DB.prepare("UPDATE td_matches SET status = 'completed', finished_at = COALESCE(finished_at, datetime('now')) WHERE id = ? AND status = 'active'").bind(existing.match_id).run();
      await DB.prepare("DELETE FROM td_queue WHERE wallet = ? AND status = 'matched' AND match_id = ?").bind(wallet, existing.match_id).run();
    } else {
      return { status: "matched", matchId: existing.match_id, message: "You already have an active match. Finish or surrender before entering another queue." };
    }
  }
  if (existing?.status === "waiting" && existing.format === data.format && existing.duration_seconds === data.durationSeconds) return { status: "waiting", matchId: existing.match_id, message: "You're already in this queue." };
  // Do not delete a matched queue record: it is the durable link used by polling.
  await DB.prepare("DELETE FROM td_queue WHERE wallet = ? AND status != 'matched'").bind(wallet).run();
  await DB.prepare("INSERT INTO td_queue (wallet, format, status, duration_seconds) VALUES (?, ?, 'waiting', ?) ON CONFLICT(wallet) DO UPDATE SET format = excluded.format, status = 'waiting', duration_seconds = excluded.duration_seconds, match_id = NULL, joined_at = datetime('now') WHERE td_queue.status != 'matched'")
    .bind(wallet, data.format, data.durationSeconds).run();
  const opponent = await DB.prepare("SELECT wallet FROM td_queue WHERE status = 'waiting' AND wallet != ? AND format = ? AND duration_seconds = ? ORDER BY joined_at ASC LIMIT 1")
    .bind(wallet, data.format, data.durationSeconds).first<{ wallet: string }>();
  if (!opponent) return { status: "waiting", matchId: null, message: "You're in the queue. A compatible opponent has not joined yet." };
  // Claim the opponent's queue row with a conditional update. If another request
  // wins the race, this request must not create a duplicate match.
  const claim = await DB.prepare("UPDATE td_queue SET status = 'matching' WHERE wallet = ? AND status = 'waiting' AND format = ? AND duration_seconds = ?")
    .bind(opponent.wallet, data.format, data.durationSeconds).run();
  if ((claim.meta?.changes ?? 0) !== 1) return { status: "waiting", matchId: null, message: "An opponent is being paired. Check queue status again shortly." };
  const matchId = crypto.randomUUID();
  const now = new Date().toISOString();
  const end = new Date(Date.now() + data.durationSeconds * 1000).toISOString();
  try {
    await DB.batch([
      DB.prepare("INSERT INTO td_matches (id, player_one, player_two, status, format, started_at, ends_at, verification_status, duration_seconds) VALUES (?, ?, ?, 'active', ?, ?, ?, 'unverified', ?)")
        .bind(matchId, opponent.wallet, wallet, data.format, now, end, data.durationSeconds),
      DB.prepare("UPDATE td_queue SET status = 'matched', match_id = ? WHERE wallet IN (?, ?) AND status IN ('waiting','matching')")
        .bind(matchId, opponent.wallet, wallet),
    ]);
  } catch (error) {
    await DB.prepare("UPDATE td_queue SET status = 'waiting' WHERE wallet = ? AND status = 'matching'").bind(opponent.wallet).run();
    throw error;
  }
  return { status: "matched", matchId, message: "Opponent found. Competitive test match started; trade evidence is collected, but official ELO scoring is not active yet." };
});

export const leaveMatchmakingQueue = createServerFn({ method: "POST" }).validator(z.object({ token: z.string().min(24) })).handler(async ({ data }) => {
  const { DB, wallet } = await requireSession(data.token);
  await DB.prepare("DELETE FROM td_queue WHERE wallet = ? AND status = 'waiting'").bind(wallet).run();
  return { status: "left" };
});

export const getMyMatches = createServerFn({ method: "POST" }).validator(z.object({ token: z.string().min(24) })).handler(async ({ data }) => {
  const { DB, wallet } = await requireSession(data.token);
  await DB.prepare("UPDATE td_matches SET status = 'completed', finished_at = datetime('now') WHERE status = 'active' AND ends_at IS NOT NULL AND ends_at <= ? AND (player_one = ? OR player_two = ?)").bind(new Date().toISOString(), wallet, wallet).run();
  const result = await DB.prepare("SELECT id, player_one, player_two, status, format, started_at, ends_at, finished_at, verification_status FROM td_matches WHERE player_one = ? OR player_two = ? ORDER BY created_at DESC LIMIT 30").bind(wallet, wallet).all<{ id: string; player_one: string; player_two: string | null; status: string; format: string; started_at: string | null; ends_at: string | null; finished_at: string | null; verification_status: string }>();
  return { matches: result.results ?? [] };
});

export const surrenderMatch = createServerFn({ method: "POST" }).validator(z.object({ token: z.string().min(24), matchId: z.string().uuid() })).handler(async ({ data }) => {
  const { DB, wallet } = await requireSession(data.token);
  const match = await DB.prepare("SELECT id, player_one, player_two, status, ends_at FROM td_matches WHERE id = ? AND (player_one = ? OR player_two = ?)")
    .bind(data.matchId, wallet, wallet).first<{ id: string; player_one: string; player_two: string | null; status: string; ends_at: string | null }>();
  if (!match) throw new Error("Match not found for this wallet.");
  if (match.status !== "active") throw new Error("This match is no longer active.");
  if (match.ends_at && match.ends_at <= new Date().toISOString()) {
    await DB.prepare("UPDATE td_matches SET status = 'completed', finished_at = datetime('now') WHERE id = ? AND status = 'active'").bind(data.matchId).run();
    return { status: "completed" as const, message: "The match timer has already ended." };
  }
  const result = await DB.prepare("UPDATE td_matches SET status = 'completed', finished_at = datetime('now') WHERE id = ? AND status = 'active' AND (player_one = ? OR player_two = ?)")
    .bind(data.matchId, wallet, wallet).run();
  if ((result.meta?.changes ?? 0) !== 1) throw new Error("The match has already ended.");
  return { status: "completed" as const, message: "You surrendered. The match has ended. Competitive test data is retained, but no official winner or ELO change is applied." };
});

export const getQueueStatus = createServerFn({ method: "POST" }).validator(z.object({ token: z.string().min(24) })).handler(async ({ data }) => {
  const { DB, wallet } = await requireSession(data.token);
  const row = await DB.prepare("SELECT status, match_id FROM td_queue WHERE wallet = ?").bind(wallet).first<{ status: string; match_id: string | null }>();
  if (!row) return { status: "idle" as const, matchId: null };
  if (row.status === "matched" && row.match_id) {
    const match = await DB.prepare("SELECT status, ends_at FROM td_matches WHERE id = ? AND (player_one = ? OR player_two = ?)").bind(row.match_id, wallet, wallet).first<{ status: string; ends_at: string | null }>();
    if (!match || match.status !== "active" || (match.ends_at && match.ends_at <= new Date().toISOString())) {
      await DB.prepare("UPDATE td_matches SET status = 'completed', finished_at = COALESCE(finished_at, datetime('now')) WHERE id = ? AND status = 'active'").bind(row.match_id).run();
      await DB.prepare("DELETE FROM td_queue WHERE wallet = ? AND status = 'matched' AND match_id = ?").bind(wallet, row.match_id).run();
      return { status: "idle" as const, matchId: null };
    }
    return { status: "matched" as const, matchId: row.match_id };
  }
  return { status: row.status === "matched" ? "matched" as const : "waiting" as const, matchId: row.match_id };
});

export const getMatchDetail = createServerFn({ method: "POST" }).validator(z.object({ token: z.string().min(24), matchId: z.string().uuid() })).handler(async ({ data }) => {
  const { DB, wallet } = await requireSession(data.token);
  await DB.prepare("UPDATE td_matches SET status = 'completed', finished_at = datetime('now') WHERE status = 'active' AND ends_at IS NOT NULL AND ends_at <= ? AND (player_one = ? OR player_two = ?)").bind(new Date().toISOString(), wallet, wallet).run();
  const match = await DB.prepare("SELECT id, player_one, player_two, status, format, started_at, ends_at, finished_at, verification_status FROM td_matches WHERE id = ? AND (player_one = ? OR player_two = ?)").bind(data.matchId, wallet, wallet).first<{ id: string; player_one: string; player_two: string | null; status: string; format: string; started_at: string | null; ends_at: string | null; finished_at: string | null; verification_status: string }>();
  if (!match) throw new Error("Match not found, or this wallet is not a participant.");
  return { match, yourWallet: wallet };
});


export const getPublicMatches = createServerFn({ method: "GET" }).handler(async () => {
  const { DB } = bindings();
  if (!DB) return { matches: [] };
  await DB.prepare("UPDATE td_matches SET status = 'completed', finished_at = datetime('now') WHERE status = 'active' AND ends_at IS NOT NULL AND ends_at <= ? AND format IN ('standard','one_position','exposure_cap','equal_start','practice','same_token','open_token')").bind(new Date().toISOString()).run();
  const result = await DB.prepare("SELECT id, player_one, player_two, status, format, started_at, ends_at, verification_status, duration_seconds FROM td_matches WHERE player_two IS NOT NULL AND status IN ('active','completed') ORDER BY created_at DESC LIMIT 40").all<{id:string;player_one:string;player_two:string|null;status:string;format:string;started_at:string|null;ends_at:string|null;verification_status:string;duration_seconds:number}>();
  return { matches: result.results ?? [] };
});

const PUBLIC_SOLANA_MAINNET_RPCS = [
  "https://api.mainnet-beta.solana.com",
  "https://solana-rpc.publicnode.com",
  "https://solana.drpc.org",
  "https://rpc.ankr.com/solana",
] as const;

function solanaRpcEndpoints(): string[] {
  const env = bindings();
  // Helius is inserted first when configured, but explicit RPC URLs remain supported.
  // This is server-only: the API key must never be sent to browser code.
  const helius = env.HELIUS_API_KEY?.trim()
    ? `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(env.HELIUS_API_KEY.trim())}`
    : "";
  const configured = (env.SOLANA_RPC_URLS ?? env.SOLANA_RPC_URL ?? "")
    .split(/[\s,;]+/).map(value => value.trim()).filter(Boolean);
  const primary = [...new Set([helius, ...configured].filter(Boolean))];
  const fallbacks = [...new Set(PUBLIC_SOLANA_MAINNET_RPCS.filter(url => !primary.includes(url)))];
  // Keep configured providers first on every request. Only rotate public fallbacks.
  const offset = Math.floor(Date.now() / 15000) % Math.max(fallbacks.length, 1);
  return [...primary, ...fallbacks.slice(offset), ...fallbacks.slice(0, offset)];
}

/** RPC failover: try configured providers first, then independent public fallbacks.
 * A provider returning an RPC error or HTTP throttle is never treated as valid data. */
async function solanaRpcCall(method: string, params: unknown[]) {
  const failures: string[] = [];
  const endpoints = solanaRpcEndpoints();
  for (const endpoint of endpoints) {
    let lastFailure = "request failed";
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
          signal: AbortSignal.timeout(4500),
        });
        if (response.status === 429 || response.status >= 500) {
          lastFailure = `HTTP ${response.status}`;
          if (attempt === 0) { await new Promise(resolve => setTimeout(resolve, 150 * (attempt + 1))); continue; }
          break;
        }
        if (!response.ok) { lastFailure = `HTTP ${response.status}`; break; }
        const json = await response.json() as { result?: unknown; error?: { code?: number; message?: string } };
        if (json.error) { lastFailure = json.error.message || "RPC error"; break; }
        if (!("result" in json)) { lastFailure = "missing result"; break; }
        return json.result;
      } catch (error) {
        lastFailure = error instanceof Error ? error.message : "request failed";
        if (attempt === 0) { await new Promise(resolve => setTimeout(resolve, 150)); continue; }
      }
    }
    let host = "invalid-endpoint";
    try { host = new URL(endpoint).hostname; } catch {}
    failures.push(`${host}: ${lastFailure}`);
  }
  console.error("Solana mainnet RPC providers failed", { method, providerCount: endpoints.length, failures });
  throw new Error("Solana mainnet RPC is temporarily unavailable across all configured providers. Configure a dedicated Solana RPC URL for production and retry.");
}

/** Lightweight, read-only portfolio estimate for wallet-value matchmaking.
 * Matchmaking is disabled for wallets with unpriced holdings; estimates are not official P&L. */
export const getWalletPortfolioEstimate = createServerFn({ method: "POST" })
  .validator(z.object({ wallet: z.string().regex(WALLET_RE) }))
  .handler(async ({ data }) => {
    const wallet = data.wallet;
    const call = solanaRpcCall;
    const programs = ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"];
    const [balance, ...accountResults] = await Promise.all([
      call("getBalance", [wallet, { commitment: "confirmed" }]) as Promise<{value:number}>,
      ...programs.map(program => call("getTokenAccountsByOwner", [wallet, {programId:program}, {encoding:"jsonParsed", commitment:"confirmed"}]).catch(() => ({value:[]})) as Promise<ParsedTokenAccounts>),
    ]);
    const holdings = new Map<string, number>();
    accountResults.forEach(result => {
      for (const account of (result as ParsedTokenAccounts).value ?? []) {
        const info = account.account?.data?.parsed?.info;
        const mint = info?.mint;
        const amount = Number(info?.tokenAmount?.uiAmount ?? 0);
        if (mint && Number.isFinite(amount) && amount > 0) holdings.set(mint, (holdings.get(mint) ?? 0) + amount);
      }
    });
    const mints = [...holdings.keys()].slice(0, 30);
    const prices = new Map<string, number>();
    let solPrice: number | null = null;
    const requests: Promise<void>[] = [];
    if (mints.length) requests.push((async()=>{try {
      const response = await fetch("https://api.dexscreener.com/tokens/v1/solana/" + mints.join(","), {headers:{accept:"application/json"}, signal:AbortSignal.timeout(6000)});
      if (!response.ok) return;
      const pairs = await response.json() as Array<{baseToken?:{address?:string};priceUsd?:string;liquidity?:{usd?:number}}>;
      for (const pair of pairs ?? []) {
        const mint = pair.baseToken?.address, price = Number(pair.priceUsd);
        if (!mint || !holdings.has(mint) || !Number.isFinite(price) || price <= 0) continue;
        const current = prices.get(mint);
        if (current === undefined || Number(pair.liquidity?.usd ?? 0) > 0) prices.set(mint, price);
      }
    } catch { /* Unknown token prices make this estimate ineligible for strict matching. */ }})());
    requests.push((async()=>{try {
      const response = await fetch("https://api.dexscreener.com/tokens/v1/solana/So11111111111111111111111111111111111111112", {headers:{accept:"application/json"}, signal:AbortSignal.timeout(4000)});
      if (!response.ok) return;
      const pairs = await response.json() as Array<{baseToken?:{address?:string};priceUsd?:string;liquidity?:{usd?:number}}>;
      const best = (pairs ?? []).filter(p=>p.baseToken?.address==="So11111111111111111111111111111111111111112"&&Number(p.priceUsd)>0).sort((x,y)=>Number(y.liquidity?.usd??0)-Number(x.liquidity?.usd??0))[0];
      if (best) solPrice = Number(best.priceUsd);
    } catch { /* no SOL quote */ }})());
    await Promise.all(requests);
    const unpricedMints = mints.filter(mint => !prices.has(mint));
    const tokenValueUsd = [...holdings.entries()].reduce((sum,[mint,amount])=>sum+amount*(prices.get(mint)??0),0);
    const balanceSol = balance.value / 1_000_000_000;
    const complete = holdings.size <= 30 && unpricedMints.length === 0 && (balanceSol === 0 || solPrice !== null);
    return {
      wallet, balanceSol, solPriceUsd: solPrice, tokenValueUsd,
      portfolioValueUsd: complete ? balanceSol * (solPrice ?? 0) + tokenValueUsd : null,
      pricedTokens: prices.size, tokenCount: holdings.size, unpricedTokens: unpricedMints.length + Math.max(0, holdings.size - mints.length),
      complete, updatedAt: new Date().toISOString(),
      disclaimer: "Estimated current holdings using public RPC balances and DexScreener spot prices. Not a cost basis, verified P&L, or official match result."
    };
  });

export const trackPublicWallet = createServerFn({ method: "POST" })
  .validator(z.object({ wallet: z.string().regex(WALLET_RE) }))
  .handler(async ({ data }) => {
    const call = solanaRpcCall;
    const wallet = data.wallet;
    const { DB } = bindings();
    if (!DB) throw new Error("Wallet tracking database is not configured.");
    const tokenPrograms = [
      { name: "spl-token", id: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" },
      { name: "token-2022", id: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" },
    ];
    const [balanceResult, signatureResult, ...tokenAccountResults] = await Promise.all([
      call("getBalance", [wallet, { commitment: "confirmed" }]) as Promise<{ value: number }>,
      call("getSignaturesForAddress", [wallet, { limit: 20, commitment: "confirmed" }]) as Promise<Array<{signature:string;blockTime:number|null;err:unknown;confirmationStatus:string|null}>>,
      ...tokenPrograms.map(program => call("getTokenAccountsByOwner", [wallet, { programId: program.id }, { encoding: "jsonParsed", commitment: "confirmed" }]).catch(() => ({ value: [] })) as Promise<ParsedTokenAccounts>),
    ]);
    const holdings = new Map<string, {mint:string;amount:number;programs:Set<string>}>();
    for (let i=0;i<tokenAccountResults.length;i++) {
      const result = tokenAccountResults[i] as ParsedTokenAccounts;
      for (const item of result.value ?? []) {
        const info = item.account?.data?.parsed?.info;
        const mint = info?.mint;
        const amount = Number(info?.tokenAmount?.uiAmount ?? 0);
        if (!mint || !Number.isFinite(amount) || amount <= 0) continue;
        const current = holdings.get(mint) ?? { mint, amount: 0, programs: new Set<string>() };
        current.amount += amount;
        current.programs.add(tokenPrograms[i].name);
        holdings.set(mint, current);
      }
    }
    const signatures = signatureResult;
    // Keep indexing history one page at a time per request. Recent signatures are
    // always refreshed; the durable cursor lets repeated lookups progressively walk
    // backwards through the wallet's full available RPC history.
    const indexState = await DB.prepare("SELECT before_signature,exhausted,last_checked_at FROM td_wallet_index_state WHERE wallet=?").bind(wallet).first<{before_signature:string|null;exhausted:number;last_checked_at:string}>();
    let historyPage: typeof signatures = [];
    if (!indexState || !indexState.exhausted) {
      try {
        const options: Record<string,unknown> = {limit:100,commitment:"confirmed"};
        if (indexState?.before_signature) options.before = indexState.before_signature;
        historyPage = await call("getSignaturesForAddress",[wallet,options]) as typeof signatures;
        const nextCursor = historyPage.length ? historyPage[historyPage.length-1].signature : (indexState?.before_signature ?? null);
        const exhausted = historyPage.length === 0 || historyPage.length < 100;
        await DB.prepare("INSERT INTO td_wallet_index_state (wallet,before_signature,exhausted,pages_fetched,last_checked_at) VALUES (?,?,?,1,datetime('now')) ON CONFLICT(wallet) DO UPDATE SET before_signature=excluded.before_signature,exhausted=excluded.exhausted,pages_fetched=td_wallet_index_state.pages_fetched+1,last_checked_at=datetime('now')").bind(wallet,nextCursor,exhausted?1:0).run();
      } catch {/* The next lookup retries history discovery. */}
    }
    const scanSignatures = [...new Map([...signatures,...historyPage].map(sig=>[sig.signature,sig])).values()];
    const tradeActivity: Array<{signature:string;blockTime:number|null;mint:string;amount:number;direction:"inflow_candidate"|"outflow_candidate";programIds:string[]}> = [];
    const buyCandidates: Array<{signature:string;blockTime:number|null;mint:string;amount:number;quoteAsset:"SOL"|"USDC";quoteAmount:number;estimatedCostUsd:number|null}> = [];
    const sellCandidates: Array<{signature:string;blockTime:number|null;mint:string;amount:number;quoteAsset:"SOL"|"USDC";quoteAmount:number;estimatedProceedsUsd:number|null}> = [];
    // Inspect recent and newly indexed historical transactions. Events remain candidates
    // because transfers, liquidity operations, and multi-leg swaps can resemble trades.
    const txResults = await Promise.all(scanSignatures.map(async sig => {
      if (sig.err !== null) return null;
      try {
        return { sig, tx: await call("getTransaction", [sig.signature, { encoding:"jsonParsed", commitment:"confirmed", maxSupportedTransactionVersion:0 }]) as any };
      } catch { return null; }
    }));
    for (const item of txResults) {
      if (!item?.tx?.meta) continue;
      const tx=item.tx;
      const keys=(tx.transaction?.message?.accountKeys??[]).map((k:any)=>typeof k==="string"?k:k.pubkey);
      const walletIndex=keys.indexOf(wallet);
      if(walletIndex<0) continue;
      const preByMint=new Map<string,number>(); const postByMint=new Map<string,number>();
      for(const b of tx.meta.preTokenBalances??[]) if(b.owner===wallet&&b.mint) preByMint.set(b.mint,(preByMint.get(b.mint)??0)+Number(b.uiTokenAmount?.uiAmount??0));
      for(const b of tx.meta.postTokenBalances??[]) if(b.owner===wallet&&b.mint) postByMint.set(b.mint,(postByMint.get(b.mint)??0)+Number(b.uiTokenAmount?.uiAmount??0));
      const deltas=new Map<string,number>(); for(const mint of new Set([...preByMint.keys(),...postByMint.keys()])) deltas.set(mint,(postByMint.get(mint)??0)-(preByMint.get(mint)??0));
      const programIds: string[]=[...new Set<string>((tx.transaction?.message?.instructions??[]).map((ix:any)=>String(ix.programId??"")).filter((id:string)=>Boolean(id)))];
      for(const inner of tx.meta.innerInstructions??[]) for(const ix of inner.instructions??[]) if(ix.programId) programIds.push(String(ix.programId));
      const feeLamports=keys[0]===wallet?Number(tx.meta.fee??0):0;
      const preLamports=Number(tx.meta.preBalances?.[walletIndex]??0); const postLamports=Number(tx.meta.postBalances?.[walletIndex]??0); const solSpent=Math.max(0,(preLamports-postLamports-feeLamports)/1e9);
      const usdcMint="EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
      const usdcDelta=deltas.get(usdcMint)??0;
      const usdcSpent=Math.max(0,-usdcDelta);
      const usdcReceived=Math.max(0,usdcDelta);
      const solReceived=Math.max(0,(postLamports-preLamports+feeLamports)/1e9);
      const knownSwapPrograms = new Set(["JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4","JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB","whirLbMiicVdio4qvUfM5KAg6Ct3Vq1P6gP1XJ6","675kPX9MHTjS2zt1qfr1NYHuzefyq8","pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA","6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"]);
      const looksLikeSwap=programIds.some((id:string)=>knownSwapPrograms.has(id)||/JUP|whirLb|675kPX9MHTjS2zt1qfr1NYHuzefy|pAMMBay|6EF8rrect/i.test(id));
      for(const [mint,amount] of deltas) if(Number.isFinite(amount)&&Math.abs(amount)>1e-10){
        tradeActivity.push({signature:item.sig.signature,blockTime:item.sig.blockTime,mint,amount,direction:amount>0?"inflow_candidate":"outflow_candidate",programIds:[...new Set<string>(programIds)]});
        if(looksLikeSwap&&mint!==usdcMint){
          if(amount>0){
            if(usdcSpent>0) buyCandidates.push({signature:item.sig.signature,blockTime:item.sig.blockTime,mint,amount,quoteAsset:"USDC",quoteAmount:usdcSpent,estimatedCostUsd:usdcSpent});
            else if(solSpent>0) buyCandidates.push({signature:item.sig.signature,blockTime:item.sig.blockTime,mint,amount,quoteAsset:"SOL",quoteAmount:solSpent,estimatedCostUsd:null});
          } else if(amount<0){
            if(usdcReceived>0) sellCandidates.push({signature:item.sig.signature,blockTime:item.sig.blockTime,mint,amount:Math.abs(amount),quoteAsset:"USDC",quoteAmount:usdcReceived,estimatedProceedsUsd:usdcReceived});
            else if(solReceived>0) sellCandidates.push({signature:item.sig.signature,blockTime:item.sig.blockTime,mint,amount:Math.abs(amount),quoteAsset:"SOL",quoteAmount:solReceived,estimatedProceedsUsd:null});
          }
        }
      }
    }
    const mints=[...holdings.keys()].slice(0,30);
    const prices=new Map<string,{priceUsd:number|null;liquidityUsd:number|null;pairUrl:string|null}>();
    if(mints.length){
      try{
        const response=await fetch("https://api.dexscreener.com/tokens/v1/solana/"+mints.join(","),{headers:{accept:"application/json"},signal:AbortSignal.timeout(7000)});
        if(response.ok){
          const pairs=await response.json() as Array<{baseToken?:{address?:string};priceUsd?:string;liquidity?:{usd?:number};url?:string}>;
          for(const pair of pairs??[]){
            const mint=pair.baseToken?.address;const price=Number(pair.priceUsd);const liquidity=Number(pair.liquidity?.usd??0);
            if(!mint||!Number.isFinite(price)||price<=0)continue;
            const old=prices.get(mint);
            if(!old||(liquidity>(old.liquidityUsd??0)))prices.set(mint,{priceUsd:price,liquidityUsd:liquidity,pairUrl:pair.url??null});
          }
        }
      }catch{/* Spot prices are optional; balances and chain activity remain available. */}
    }
    let solPriceUsd:number|null=null;
    try{const sr=await fetch("https://api.dexscreener.com/tokens/v1/solana/So11111111111111111111111111111111111111112",{headers:{accept:"application/json"},signal:AbortSignal.timeout(4000)});if(sr.ok){const sp=await sr.json() as Array<{baseToken?:{address?:string};priceUsd?:string;liquidity?:{usd?:number}}>;const best=(sp??[]).filter(p=>p.baseToken?.address==="So11111111111111111111111111111111111111112"&&Number(p.priceUsd)>0).sort((a,b)=>Number(b.liquidity?.usd??0)-Number(a.liquidity?.usd??0))[0];if(best)solPriceUsd=Number(best.priceUsd);}}catch{}
    for(const buy of buyCandidates){try{const costUsd=buy.estimatedCostUsd??(solPriceUsd===null?null:buy.quoteAmount*solPriceUsd);await DB.prepare("INSERT OR IGNORE INTO td_wallet_token_buys (wallet,mint,signature,block_time,token_amount,sol_spent,estimated_cost_usd,sol_price_usd,source,quote_asset,quote_amount) VALUES (?,?,?,?,?,?,?,?,?,?,?)").bind(wallet,buy.mint,buy.signature,buy.blockTime,buy.amount,buy.quoteAsset==="SOL"?buy.quoteAmount:0,costUsd,solPriceUsd,buy.quoteAsset==="USDC"?"usdc_outflow_plus_swap_program_candidate":"sol_outflow_plus_swap_program_candidate",buy.quoteAsset,buy.quoteAmount).run();}catch{}}
    for(const sell of sellCandidates){try{const proceedsUsd=sell.estimatedProceedsUsd??(solPriceUsd===null?null:sell.quoteAmount*solPriceUsd);await DB.prepare("INSERT OR IGNORE INTO td_wallet_token_sells (wallet,mint,signature,block_time,token_amount,quote_asset,quote_amount,estimated_proceeds_usd,source) VALUES (?,?,?,?,?,?,?,?,?)").bind(wallet,sell.mint,sell.signature,sell.blockTime,sell.amount,sell.quoteAsset,sell.quoteAmount,proceedsUsd,sell.quoteAsset==="USDC"?"usdc_inflow_plus_swap_program_candidate":"sol_inflow_plus_swap_program_candidate").run();}catch{}}
    const positions=[...holdings.values()].map(h=>({mint:h.mint,amount:h.amount,priceUsd:prices.get(h.mint)?.priceUsd??null,valueUsd:prices.has(h.mint)?h.amount*prices.get(h.mint)!.priceUsd!:null,liquidityUsd:prices.get(h.mint)?.liquidityUsd??null,pairUrl:prices.get(h.mint)?.pairUrl??null,programs:[...h.programs]})).sort((a,b)=>(b.valueUsd??-1)-(a.valueUsd??-1));
    const pricedValue=positions.reduce((sum,p)=>sum+(p.valueUsd??0),0);
    const unpricedPositions=positions.filter(p=>p.valueUsd===null).length;
    const buyRows=await DB.prepare("SELECT mint,SUM(token_amount) AS bought_amount,SUM(estimated_cost_usd) AS spent_usd,COUNT(*) AS buy_count,MIN(block_time) AS first_buy_at FROM td_wallet_token_buys WHERE wallet=? GROUP BY mint").bind(wallet).all<{mint:string;bought_amount:number;spent_usd:number|null;buy_count:number;first_buy_at:number|null}>();
    const sellRows=await DB.prepare("SELECT mint,SUM(token_amount) AS sold_amount,SUM(estimated_proceeds_usd) AS proceeds_usd,COUNT(*) AS sell_count FROM td_wallet_token_sells WHERE wallet=? GROUP BY mint").bind(wallet).all<{mint:string;sold_amount:number;proceeds_usd:number|null;sell_count:number}>();
    const sellMap=new Map<string,{soldAmount:number;proceedsUsd:number|null;sellCount:number}>();
    for(const row of sellRows.results??[])sellMap.set(row.mint,{soldAmount:Number(row.sold_amount??0),proceedsUsd:row.proceeds_usd===null?null:Number(row.proceeds_usd),sellCount:Number(row.sell_count??0)});
    const buyMap=new Map<string,{boughtAmount:number;spentUsd:number|null;buyCount:number;firstBuyAt:number|null}>();
    for(const row of buyRows.results??[])buyMap.set(row.mint,{boughtAmount:Number(row.bought_amount??0),spentUsd:row.spent_usd===null?null:Number(row.spent_usd),buyCount:Number(row.buy_count??0),firstBuyAt:row.first_buy_at});
    const priorPrices=new Map<string,number>(); for(const p of positions){const prev=await DB.prepare("SELECT price_usd FROM td_wallet_token_price_history WHERE wallet=? AND mint=? ORDER BY observed_at DESC LIMIT 1").bind(wallet,p.mint).first<{price_usd:number|null}>();if(prev?.price_usd!==null&&prev?.price_usd!==undefined&&Number(prev.price_usd)>0)priorPrices.set(p.mint,Number(prev.price_usd));}
    const trackedPositions=positions.map(p=>{const b=buyMap.get(p.mint);const sells=sellMap.get(p.mint);const avg=b&&b.spentUsd!==null&&b.boughtAmount>0?b.spentUsd/b.boughtAmount:null;const bought=b?.boughtAmount??0;const sold=sells?.soldAmount??0;const remainingQty=Math.max(0,bought-sold);const basis=avg===null?null:avg*Math.min(p.amount,remainingQty);const proceeds=sells?.proceedsUsd??null;const realizedPnl=avg!==null&&proceeds!==null?proceeds-avg*sold:null;const unrealizedPnl=p.valueUsd!==null&&basis!==null?p.valueUsd-basis:null;const pnl=realizedPnl!==null&&unrealizedPnl!==null?realizedPnl+unrealizedPnl:null;return {...p,estimatedTotalSpentUsd:b?.spentUsd??null,estimatedRemainingCostUsd:basis,estimatedRealizedProceedsUsd:proceeds,estimatedSoldAmount:sold,detectedSellCount:sells?.sellCount??0,estimatedRealizedPnlUsd:realizedPnl,estimatedUnrealizedPnlUsd:unrealizedPnl,estimatedPnlUsd:pnl,estimatedPnlPercent:pnl!==null&&basis!==null&&basis>0?pnl/basis*100:null,detectedBuyCount:b?.buyCount??0,firstBuyAt:b?.firstBuyAt??null,priceChangePercent:p.priceUsd!==null&&priorPrices.has(p.mint)?(p.priceUsd/priorPrices.get(p.mint)!-1)*100:null};});
    const observedAt=Math.floor(Date.now()/1000);
    for(const p of positions){try{await DB.prepare("INSERT OR REPLACE INTO td_wallet_token_price_history (wallet,mint,observed_at,token_amount,price_usd,value_usd,liquidity_usd) VALUES (?,?,?,?,?,?,?)").bind(wallet,p.mint,observedAt,p.amount,p.priceUsd,p.valueUsd,p.liquidityUsd).run();}catch{}}
    const trackedBuyCount=(buyRows.results??[]).reduce((sum,row)=>sum+Number(row.buy_count??0),0);
    const trackedSpend=(buyRows.results??[]).reduce((sum,row)=>sum+(row.spent_usd===null?0:Number(row.spent_usd)),0);
    const estimatedOpenPnl=trackedPositions.reduce((sum,p)=>sum+(p.estimatedUnrealizedPnlUsd??0),0);
    const estimatedRealizedPnl=trackedPositions.reduce((sum,p)=>sum+(p.estimatedRealizedPnlUsd??0),0);
    const trackedPnlCoverage=trackedPositions.filter(p=>p.estimatedPnlUsd!==null).length;
    return {
      wallet,
      balanceSol: balanceResult.value / 1_000_000_000,
      signatures: signatures.map((sig) => ({ signature: sig.signature, blockTime: sig.blockTime, success: sig.err === null, confirmationStatus: sig.confirmationStatus })),
      positions:trackedPositions,
      estimatedTokenValueUsd: unpricedPositions===0?pricedValue:null,
      unpricedPositions,
      trackedBuyCount,
      estimatedTotalSpentUsd:trackedSpend,
      estimatedOpenPnlUsd:estimatedOpenPnl,
      trackedPnlCoverage,
      estimatedRealizedProceedsUsd:(sellRows.results??[]).reduce((sum,row)=>sum+(row.proceeds_usd===null?0:Number(row.proceeds_usd)),0),
      estimatedRealizedPnlUsd:estimatedRealizedPnl,
      indexedHistoryPageSize:historyPage.length,
      historyIndexExhausted:Boolean((await DB.prepare("SELECT exhausted FROM td_wallet_index_state WHERE wallet=?").bind(wallet).first<{exhausted:number}>())?.exhausted),
      costBasisMethod:"Candidate buy/sell events are indexed progressively. Current remaining basis uses average-cost approximation; realized proceeds are shown when quote-asset proceeds are identified. SOL conversions use spot price at first detection, not historical fill prices.",
      tradeActivity:tradeActivity.sort((a,b)=>(b.blockTime??0)-(a.blockTime??0)).slice(0,30),
      source: "Solana mainnet RPC + DexScreener spot quotes",
      updatedAt: new Date().toISOString(),
      refreshIntervalSeconds: 20,
      disclaimer: "Historical signature indexing advances by up to 100 transactions every five minutes and may take repeated refreshes for large wallets. Current balances, recent transactions, and market quotes refresh automatically while this page is open. Swap identification is heuristic. USDC is treated as approximately $1; SOL quote amounts use the SOL/USD spot quote at first detection, not historical fill prices. Transfers, LP actions, other quote assets, incomplete RPC history and token-account lifecycle changes can cause errors. Realized proceeds are estimates; average-cost P&L is not audited FIFO accounting.",
    };
  });

/** Indexes a bounded number of public Solana transactions for a participant's active match.
 * This is an activity-ingestion engine, not a token price or P&L oracle. */
export const syncMatchActivity = createServerFn({ method: "POST" }).validator(z.object({ token: z.string().min(24), matchId: z.string().uuid() })).handler(async ({ data }) => {
  const { DB, wallet } = await requireSession(data.token);
  type SyncMatch = {id:string;player_one:string;player_two:string|null;status:string;started_at:string|null;ends_at:string|null;verification_status:string;custom:boolean;mode?:string;max_players?:number};
  let match: SyncMatch | null = await DB.prepare("SELECT id, player_one, player_two, status, started_at, ends_at, verification_status FROM td_matches WHERE id = ? AND (player_one = ? OR player_two = ?)").bind(data.matchId, wallet, wallet).first<Omit<SyncMatch,"custom">>().then(row=>row?{...row,custom:false}:null);
  let participants: string[] = [];
  if (!match) {
    const custom = await DB.prepare("SELECT id,status,started_at,ends_at,mode,max_players,duration_seconds FROM td_custom_matches WHERE id=?").bind(data.matchId).first<{id:string;status:string;started_at:string|null;ends_at:string|null;mode:string;max_players:number;duration_seconds:number}>();
    const member = await DB.prepare("SELECT wallet FROM td_custom_match_members WHERE match_id=? AND wallet=?").bind(data.matchId,wallet).first<{wallet:string}>();
    if (!custom || !member) throw new Error("Match not found for this wallet.");
    const members = await DB.prepare("SELECT wallet,team_number FROM td_custom_match_members WHERE match_id=? ORDER BY team_number,id").bind(data.matchId).all<{wallet:string;team_number:number}>();
    if (!custom.started_at || custom.status === "open") return {matchId:custom.id,indexed:0,events:[],accountingLedger:[],valuations:[],valuationObservations:[],fillCandidates:[],priceEvidence:[],status:"waiting_for_players",customRoom:{status:custom.status,startedAt:custom.started_at,endsAt:custom.ends_at,durationSeconds:custom.duration_seconds,mode:custom.mode,maxPlayers:custom.max_players,members:members.results??[]},note:"Room is waiting for all player slots to fill. The match timer and transaction indexing begin together."};
    participants = [...new Set((members.results??[]).map(row=>row.wallet))];
    match = {id:custom.id,player_one:participants[0]??wallet,player_two:participants[1]??null,status:custom.status,started_at:custom.started_at,ends_at:custom.ends_at,verification_status:"unverified",custom:true,mode:custom.mode,max_players:custom.max_players};
  }
  const rpcCall = async (method:string, params:unknown[]): Promise<any> => await solanaRpcCall(method, params) as any;
  const start = match.started_at ? Math.floor(new Date(match.started_at).getTime()/1000) : 0;
  const end = match.ends_at ? Math.floor(new Date(match.ends_at).getTime()/1000) : Math.floor(Date.now()/1000);
  let indexed = 0;
  let indexingErrors = 0;
  if (!participants.length) participants = [...new Set([match.player_one, match.player_two].filter((address): address is string => Boolean(address)))];
  for (const trackedWallet of participants) {
  // Page signatures from a durable cursor and queue them before processing. This
  // prevents the old fixed-latest-100 scan from permanently missing older match activity.
  let state = await DB.prepare("SELECT before_signature,exhausted FROM td_match_index_state WHERE match_id = ? AND wallet = ?")
    .bind(match.id, trackedWallet).first<{before_signature:string|null;exhausted:number}>();
  try {
    // Always ingest the newest signatures on every room sync, even while the
    // historical cursor is still paging backwards. Previously, recent discovery
    // only ran after history exhaustion, delaying live-match activity for large wallets.
    const recent = await rpcCall("getSignaturesForAddress",[trackedWallet,{limit:25,commitment:"confirmed"}]) as Array<{signature:string;slot:number;blockTime:number|null;err:unknown}>;
    for (const sig of recent) {
      if (sig.blockTime !== null && sig.blockTime >= start && sig.blockTime <= end) {
        await DB.prepare("INSERT OR IGNORE INTO td_match_index_queue (match_id,wallet,signature,slot,block_time,tx_error_json) VALUES (?,?,?,?,?,?)")
          .bind(match.id,trackedWallet,sig.signature,sig.slot,sig.blockTime,sig.err == null ? null : JSON.stringify(sig.err)).run();
      }
    }
    // In parallel with live discovery, advance one durable historical page until
    // the match start boundary is crossed. INSERT OR IGNORE makes overlap safe.
    if (!state || !state.exhausted) {
      const options:Record<string,unknown> = {limit:100,commitment:"confirmed"};
      if (state?.before_signature) options.before = state.before_signature;
      const page = await rpcCall("getSignaturesForAddress",[trackedWallet,options]) as Array<{signature:string;slot:number;blockTime:number|null;err:unknown}>;
      let exhausted = page.length === 0;
      for (const sig of page) {
        if (sig.blockTime !== null && sig.blockTime >= start && sig.blockTime <= end) {
          await DB.prepare("INSERT OR IGNORE INTO td_match_index_queue (match_id,wallet,signature,slot,block_time,tx_error_json) VALUES (?,?,?,?,?,?)")
            .bind(match.id,trackedWallet,sig.signature,sig.slot,sig.blockTime,sig.err == null ? null : JSON.stringify(sig.err)).run();
        }
        if (sig.blockTime !== null && sig.blockTime < start) exhausted = true;
      }
      const nextCursor = page.length ? page[page.length-1].signature : (state?.before_signature ?? null);
      await DB.prepare("INSERT INTO td_match_index_state (match_id,wallet,before_signature,exhausted,pages_fetched,last_checked_at) VALUES (?,?,?,?,1,datetime('now')) ON CONFLICT(match_id,wallet) DO UPDATE SET before_signature=excluded.before_signature,exhausted=excluded.exhausted,pages_fetched=td_match_index_state.pages_fetched+1,last_checked_at=datetime('now')")
        .bind(match.id,trackedWallet,nextCursor,exhausted?1:0).run();
    }
  } catch {
    // Transaction indexing must not prevent portfolio snapshots from being captured.
    // The next room sync retries signature discovery; ELO remains blocked if evidence is missing.
    indexingErrors++;
  }
  // Quarantine repeatedly unavailable transactions rather than retrying them on every room poll.
  await DB.prepare("UPDATE td_match_index_queue SET status='skipped',last_error=COALESCE(last_error,'retry_limit_reached'),updated_at=datetime('now') WHERE match_id=? AND wallet=? AND status='retry' AND attempts>=8")
    .bind(match.id,trackedWallet).run();
  const pending = await DB.prepare("SELECT signature,slot,block_time,tx_error_json FROM td_match_index_queue WHERE match_id = ? AND wallet = ? AND (status='pending' OR (status='retry' AND attempts<8 AND updated_at<=datetime('now','-2 minutes'))) ORDER BY id LIMIT 12")
    .bind(match.id,trackedWallet).all<{signature:string;slot:number;block_time:number|null;tx_error_json:string|null}>();
  let walletIndexed = 0;
  for (const sig of pending.results ?? []) {
    try {
    const exists = await DB.prepare("SELECT id FROM td_match_events WHERE match_id = ? AND signature = ?").bind(match.id,sig.signature).first<{id:number}>();
    if (exists) {
      await DB.prepare("UPDATE td_match_index_queue SET status='processed',updated_at=datetime('now') WHERE match_id=? AND wallet=? AND signature=?").bind(match.id,trackedWallet,sig.signature).run();
      continue;
    }
    const tx = await rpcCall("getTransaction",[sig.signature,{encoding:"jsonParsed",commitment:"confirmed",maxSupportedTransactionVersion:0}]) as any;
    if (!tx?.meta) {
      await DB.prepare("UPDATE td_match_index_queue SET status='retry',attempts=attempts+1,last_error='transaction_metadata_not_available',updated_at=datetime('now') WHERE match_id=? AND wallet=? AND signature=?").bind(match.id,trackedWallet,sig.signature).run();
      continue;
    }
    const keys = (tx.transaction?.message?.accountKeys ?? []).map((k:any)=>typeof k === "string" ? k : k.pubkey);
    const instructions = tx.transaction?.message?.instructions ?? [];
    const inner = (tx.meta.innerInstructions ?? []).flatMap((x:any)=>x.instructions ?? []);
    const allInstructions = [...instructions,...inner];
    const pumpRelated = allInstructions.some((ix:any)=>resolveInstructionProgramId(ix, keys, tx.meta?.loadedAddresses) === "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P" || ix.program === "pump");
    const logMessages: string[] = tx.meta.logMessages ?? [];
    const pumpInstructionNames = logMessages.filter((line) => line.includes("Program log: Instruction:")).map((line) => line.split("Program log: Instruction:")[1]?.trim().toLowerCase() ?? "");
    const isBuy = pumpRelated && pumpInstructionNames.some((name) => name === "buy" || name === "buy_exact_sol_in");
    const isSell = pumpRelated && pumpInstructionNames.some((name) => name === "sell");
    const index = keys.indexOf(trackedWallet);
    const preSol = index >= 0 ? Number(tx.meta.preBalances?.[index] ?? 0) : 0;
    const postSol = index >= 0 ? Number(tx.meta.postBalances?.[index] ?? 0) : 0;
    // Preserve exact integer token movement across every token account. UI amounts
    // remain available for display, but raw deltas are the canonical evidence value.
    const tokenDeltas = tokenBalanceDeltas(tx.meta.preTokenBalances ?? [], tx.meta.postTokenBalances ?? [], trackedWallet)
      .map(({ mint, amount, rawDelta, decimals }) => ({ mint, amount, rawDelta, decimals }));
    const feeLamports = Number(tx.meta.fee ?? 0);
    const programIds = [...new Set(allInstructions.map((ix:any)=>resolveInstructionProgramId(ix, keys, tx.meta?.loadedAddresses)).filter((id:any):id is string=>typeof id==="string"))];
    const protocols = identifySwapProtocol(programIds);
    const instructionNames = logMessages.filter((line) => line.includes("Program log: Instruction:")).map((line) => line.split("Program log: Instruction:")[1]?.trim() ?? "");
    const hasLifecycleEffects = instructionNames.some((name)=>/createaccount|initializeaccount|closeaccount|syncnative/i.test(name)) || allInstructions.some((ix:any)=>/createAccount|closeAccount|initializeAccount/i.test(String(ix.parsed?.type??"")));
    const ledger = buildAccountingLedgerSummary({
      success: sig.tx_error_json === null,
      nativeDeltaLamports: postSol-preSol,
      feeLamports,
      walletIsFeePayer: index===0,
      tokenDeltas,
      externalFlows: [],
      protocols,
      hasLifecycleEffects,
    });
    await DB.prepare("INSERT OR IGNORE INTO td_match_accounting_ledger (match_id,wallet,signature,slot,block_time,success,fee_lamports,native_delta_lamports,native_delta_ex_fee_lamports,token_deltas_json,external_flows_json,protocols_json,evidence_level,blockers_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .bind(match.id,trackedWallet,sig.signature,sig.slot,sig.block_time,sig.tx_error_json===null?1:0,ledger.feeLamports,ledger.nativeDeltaLamports,ledger.nativeDeltaExFeeLamports,JSON.stringify(ledger.tokenDeltas),JSON.stringify(ledger.externalFlows),JSON.stringify(ledger.protocols),ledger.evidenceLevel,JSON.stringify([...new Set([...ledger.blockers,"external_transfer_analysis_not_yet_complete"])]))
      .run();
    const signatureFailed = sig.tx_error_json !== null;
    const eventType = signatureFailed ? "failed" : isBuy ? "pump_fun_buy_candidate" : isSell ? "pump_fun_sell_candidate" : pumpRelated ? "pump_fun_instruction_unclassified" : tokenDeltas.length ? "token_activity" : "sol_activity";
    await DB.prepare("INSERT OR IGNORE INTO td_match_events (match_id,wallet,signature,block_time,slot,success,pump_fun_related,sol_delta,token_deltas_json,event_type) VALUES (?,?,?,?,?,?,?,?,?,?)").bind(match.id,trackedWallet,sig.signature,sig.block_time,sig.slot,signatureFailed?0:1,pumpRelated?1:0,(postSol-preSol)/1e9,JSON.stringify(tokenDeltas),eventType).run();
    // Persist a clearly labelled swap candidate during automatic indexing. This is
    // inferred from token deltas + Pump.fun instruction logs, not a protocol fill receipt.
    if (!signatureFailed && (pumpRelated || protocols.length > 0) && tokenDeltas.length === 1) {
       const delta = tokenDeltas[0];
       const tokenAmount = Math.abs(Number(delta.amount));
       const solDelta = (postSol-preSol)/1e9;
       const feeSol = index === 0 ? Number(tx.meta.fee ?? 0)/1e9 : 0;
       // Pump.fun instruction logs are the strongest direction hint. Other recognized
       // swap protocols get only a low-confidence candidate when SOL/token deltas align.
       const netSolOut = Math.max(0, -solDelta-feeSol);
       const netSolIn = Math.max(0, solDelta+feeSol);
       const direction = delta.amount > 0 && (isBuy || (!isSell && netSolOut > 0))
         ? "buy_candidate"
         : delta.amount < 0 && (isSell || (!isBuy && netSolIn > 0))
           ? "sell_candidate"
           : "ambiguous_candidate";
       const solAmount = direction === "buy_candidate" ? netSolOut : direction === "sell_candidate" ? netSolIn : 0;
       const estimatedPrice = tokenAmount > 0 && solAmount > 0 ? solAmount/tokenAmount : null;
       await DB.prepare("INSERT OR IGNORE INTO td_swap_fill_candidates (match_id,wallet,signature,block_time,slot,token_mint,token_delta,sol_delta_net,estimated_token_price_sol,direction,parser,confidence,explanation) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)")
         .bind(match.id,trackedWallet,sig.signature,sig.block_time,sig.slot,delta.mint,Number(delta.amount),solAmount,estimatedPrice,direction,pumpRelated?"pump_instruction_log_plus_wallet_balance_delta":"recognized_swap_protocol_plus_wallet_balance_delta","low","Candidate derived from a recognized swap protocol and one wallet token balance delta. SOL movement is a rough net-wallet estimate; bundled transfers, USDC/other quote assets, rent, and program-specific fill details may remain unresolved. This is not a verified fill or official P&L.")
         .run();
     }
    await DB.prepare("UPDATE td_match_index_queue SET status='processed',attempts=attempts+1,last_error=NULL,updated_at=datetime('now') WHERE match_id=? AND wallet=? AND signature=?")
      .bind(match.id,trackedWallet,sig.signature).run();
    indexed++;
    walletIndexed++;
    } catch (error) {
      await DB.prepare("UPDATE td_match_index_queue SET status='retry',attempts=attempts+1,last_error=?,updated_at=datetime('now') WHERE match_id=? AND wallet=? AND signature=?")
        .bind(error instanceof Error ? error.message.slice(0,300) : "unknown_indexing_error",match.id,trackedWallet,sig.signature).run();
    }
  }
  // Capture portfolio valuations close to the start and after the deadline. These are
  // supporting evidence only: incomplete pricing or unresolved transfers never yield ELO.
  const nowSec = Math.floor(Date.now() / 1000);
  // Capture start evidence during a wider two-minute startup window to tolerate room-load/RPC latency.
  // The actual observed_at timestamp is retained and settlement still enforces its boundary tolerance.
  const existingStart = await DB.prepare("SELECT id FROM td_match_valuations WHERE match_id = ? AND wallet = ? AND phase = 'start'").bind(match.id,trackedWallet).first<{id:number}>();
  const existingEnd = await DB.prepare("SELECT id FROM td_match_valuations WHERE match_id = ? AND wallet = ? AND phase = 'end'").bind(match.id,trackedWallet).first<{id:number}>();
  // Capture a baseline on the first available sync if the start window was missed.
  // Its real timestamp is retained; reconciliation will block official scoring when it is outside the start boundary.
  const phase = !existingStart && match.started_at ? "start" : nowSec >= end && !existingEnd ? "end" : null;
  if (phase) {
    const existingSnapshot = await DB.prepare("SELECT id FROM td_match_valuations WHERE match_id = ? AND wallet = ? AND phase = ?").bind(match.id,trackedWallet,phase).first<{id:number}>();
    if (!existingSnapshot) {
      const balance = await rpcCall("getBalance",[trackedWallet,{commitment:"confirmed"}]) as {value:number};
      const [classicAccounts, token2022Accounts] = await Promise.all([
        rpcCall("getTokenAccountsByOwner",[trackedWallet,{programId:"TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"},{encoding:"jsonParsed",commitment:"confirmed"}]) as Promise<ParsedTokenAccounts>,
        rpcCall("getTokenAccountsByOwner",[trackedWallet,{programId:"TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"},{encoding:"jsonParsed",commitment:"confirmed"}]) as Promise<ParsedTokenAccounts>,
      ]);
      const tokenBalances = [...classicAccounts.value,...token2022Accounts.value].map((entry)=>({mint:entry.account.data.parsed.info.mint,amount:Number(entry.account.data.parsed.info.tokenAmount.uiAmount ?? 0)})).filter((entry)=>entry.amount>0);
      const mints = [...new Set(["So11111111111111111111111111111111111111112",...tokenBalances.map((entry)=>entry.mint)])].slice(0,30);
      let priceRows: Array<{baseToken?:{address?:string};priceUsd?:string;liquidity?:{usd?:number};marketCap?:number;fdv?:number}> = [];
      try {
        const pricesResponse = await fetch(`https://api.dexscreener.com/tokens/v1/solana/${mints.join(",")}`);
        if (pricesResponse.ok) priceRows = await pricesResponse.json() as typeof priceRows;
      } catch { /* valuation remains incomplete when the price source is unavailable */ }
      const priceByMint = new Map<string,number>();
      const liquidityByMint = new Map<string,number>();
      const marketCapByMint = new Map<string,number>();
      for (const pair of priceRows) {
        const mint = pair.baseToken?.address; const price = Number(pair.priceUsd); const liquidity = Number(pair.liquidity?.usd ?? 0);
        if (mint && Number.isFinite(price) && price > 0 && liquidity >= 100 && liquidity > (liquidityByMint.get(mint) ?? 0)) { priceByMint.set(mint,price); liquidityByMint.set(mint,liquidity); const cap=Number(pair.marketCap ?? pair.fdv ?? 0); if(Number.isFinite(cap)&&cap>0) marketCapByMint.set(mint,cap); }
      }
      const solPrice = priceByMint.get("So11111111111111111111111111111111111111112");
      const tokenValues = tokenBalances.map((entry)=>({ ...entry, priceUsd:priceByMint.get(entry.mint) ?? null, marketCapUsd:marketCapByMint.get(entry.mint) ?? null, liquidityUsd:liquidityByMint.get(entry.mint) ?? null, valueUsd:priceByMint.has(entry.mint)?entry.amount*priceByMint.get(entry.mint)!:null }));
      for (const mint of mints) {
        const price = priceByMint.get(mint) ?? null;
        const liquidity = liquidityByMint.get(mint) ?? null;
        const accepted = price !== null && liquidity !== null && liquidity >= 100;
        const reason = accepted ? "Latest DexScreener spot quote passed the configured $100 minimum liquidity threshold; not a historical quote." : "No quote passed the configured price/liquidity checks.";
        await DB.prepare("INSERT OR IGNORE INTO td_match_price_evidence (match_id,wallet,phase,mint,price_usd,liquidity_usd,source,observed_at,quote_kind,accepted,reason) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
          .bind(match.id,trackedWallet,phase,mint,price,liquidity,"dexscreener_tokens_v1",nowSec,"observed_spot",accepted?1:0,reason).run();
      }
      const unpricedMints = tokenValues.filter((entry)=>entry.valueUsd===null).length;
      const complete = solPrice !== undefined && unpricedMints===0 && tokenBalances.length <= 29;
      // Partial estimate for the live UI; complete remains false whenever any held asset is unpriced.
      const pricedTokenValue = tokenValues.reduce((sum,entry)=>sum+(entry.valueUsd??0),0);
      const portfolioUsd = solPrice !== undefined || tokenValues.some(entry=>entry.valueUsd!==null) ? (solPrice !== undefined ? balance.value/1e9*solPrice : 0) + pricedTokenValue : null;
      await DB.prepare("INSERT OR IGNORE INTO td_match_valuations (match_id,wallet,phase,observed_at,sol_balance,portfolio_usd,token_balances_json,priced_mints,unpriced_mints,complete,integrity_note) VALUES (?,?,?,?,?,?,?,?,?,?,?)").bind(match.id,trackedWallet,phase,nowSec,balance.value/1e9,portfolioUsd,JSON.stringify(tokenValues),tokenValues.length-unpricedMints,unpricedMints,complete?1:0,complete?"Portfolio priced by DexScreener liquidity-selected token pairs; external transfers and all eligibility rules still require independent reconciliation.":"Incomplete portfolio valuation: one or more token balances or SOL could not be priced reliably.").run();
    }
  }
  const cursor = await DB.prepare("SELECT before_signature FROM td_match_index_state WHERE match_id=? AND wallet=?").bind(match.id,trackedWallet).first<{before_signature:string|null}>();
  await DB.prepare("INSERT INTO td_wallet_sync_state (wallet,last_signature,last_synced_at) VALUES (?,?,datetime('now')) ON CONFLICT(wallet) DO UPDATE SET last_signature=excluded.last_signature,last_synced_at=datetime('now')").bind(trackedWallet,cursor?.before_signature ?? null).run();
  }
  // Record a fresh observation-time portfolio estimate on every sync, not only at
  // match start/end. Current DexScreener quotes are explicitly spot observations;
  // this creates a sampled series, never a claim of historical pricing between syncs.
  const observationAt = Math.floor(Date.now() / 1000);
  for (const trackedWallet of participants) {
    // Avoid hammering Solana RPC and the spot-price API when the match room polls.
    // Observations are sampled at most once per minute per wallet and match.
    const latestObservation = await DB.prepare("SELECT observed_at FROM td_match_valuation_observations WHERE match_id = ? AND wallet = ? ORDER BY observed_at DESC LIMIT 1")
      .bind(match.id, trackedWallet).first<{ observed_at: number }>();
    if (latestObservation && observationAt - latestObservation.observed_at < 15) continue;
    const balance = await rpcCall("getBalance", [trackedWallet, { commitment: "confirmed" }]) as { value: number };
    const [classicAccounts, token2022Accounts] = await Promise.all([
      rpcCall("getTokenAccountsByOwner", [trackedWallet, { programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" }, { encoding: "jsonParsed", commitment: "confirmed" }]) as Promise<ParsedTokenAccounts>,
      rpcCall("getTokenAccountsByOwner", [trackedWallet, { programId: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" }, { encoding: "jsonParsed", commitment: "confirmed" }]) as Promise<ParsedTokenAccounts>,
    ]);
    const tokenBalances = [...classicAccounts.value, ...token2022Accounts.value]
      .map((entry) => ({ mint: entry.account.data.parsed.info.mint, amount: Number((entry.account.data.parsed.info.tokenAmount as { uiAmountString?: string; uiAmount?: number | null }).uiAmountString ?? entry.account.data.parsed.info.tokenAmount.uiAmount ?? 0) }))
      .filter((entry) => Number.isFinite(entry.amount) && entry.amount > 0);
    const mints = [...new Set(["So11111111111111111111111111111111111111112", ...tokenBalances.map((entry) => entry.mint)])].slice(0, 30);
    let priceRows: Array<{ baseToken?: { address?: string; name?: string; symbol?: string }; priceUsd?: string; liquidity?: { usd?: number }; marketCap?: number; fdv?: number; url?: string }> = [];
    try {
      const response = await fetch(`https://api.dexscreener.com/tokens/v1/solana/${mints.join(",")}`);
      if (response.ok) priceRows = await response.json() as typeof priceRows;
      // Some quote responses omit results for comma-separated batches. Fall back
      // to individual token lookups so one missing mint cannot zero the whole panel.
      if (priceRows.length === 0) {
        const fallback = await Promise.all(mints.slice(0, 12).map(async (mint) => {
          try {
            const single = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`);
            if (!single.ok) return [];
            const body = await single.json() as { pairs?: typeof priceRows };
            return body.pairs ?? [];
          } catch { return []; }
        }));
        priceRows = fallback.flat();
      }
    } catch { /* Preserve an incomplete observation when the quote source is unavailable. */ }
    const prices = new Map<string, number>();
    const liquidities = new Map<string, number>();
    const marketCaps = new Map<string, number>();
    const tokenNames = new Map<string, {name:string|null;symbol:string|null;pairUrl:string|null}>();
    for (const pair of priceRows) {
      const mint = pair.baseToken?.address;
      const price = Number(pair.priceUsd);
      const liquidity = Number(pair.liquidity?.usd ?? 0);
      if (mint && Number.isFinite(price) && price > 0 && liquidity >= 100 && liquidity > (liquidities.get(mint) ?? 0)) {
        prices.set(mint, price);
        liquidities.set(mint, liquidity);
        const cap=Number(pair.marketCap??pair.fdv??0); if(Number.isFinite(cap)&&cap>0)marketCaps.set(mint,cap);
        tokenNames.set(mint,{name:pair.baseToken?.name??null,symbol:pair.baseToken?.symbol??null,pairUrl:pair.url??null});
      }
    }
    // Batched quote responses can omit individual holdings even when other tokens are priced.
    // Retry missing mints individually so one missing batch entry does not freeze this wallet.
    const missingMints = [...new Set(["So11111111111111111111111111111111111111112", ...tokenBalances.map(entry => entry.mint)])].filter(mint => !prices.has(mint)).slice(0, 15);
    await Promise.all(missingMints.map(async mint => {
      try {
        const response = await fetch("https://api.dexscreener.com/latest/dex/tokens/" + mint, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(4000) });
        if (!response.ok) return;
        const body = await response.json() as { pairs?: Array<{baseToken?:{address?:string;name?:string;symbol?:string};priceUsd?:string;liquidity?:{usd?:number};marketCap?:number;fdv?:number;url?:string}> };
        const best = (body.pairs ?? []).filter(pair => pair.baseToken?.address === mint && Number(pair.priceUsd) > 0 && Number(pair.liquidity?.usd ?? 0) >= 100).sort((left,right) => Number(right.liquidity?.usd ?? 0) - Number(left.liquidity?.usd ?? 0))[0];
        if (!best) return;
        prices.set(mint, Number(best.priceUsd)); liquidities.set(mint, Number(best.liquidity?.usd ?? 0));
        const cap = Number(best.marketCap ?? best.fdv ?? 0); if (Number.isFinite(cap) && cap > 0) marketCaps.set(mint, cap);
        tokenNames.set(mint, {name:best.baseToken?.name ?? null,symbol:best.baseToken?.symbol ?? null,pairUrl:best.url ?? null});
      } catch { /* Keep this wallet observation incomplete if no reliable quote exists. */ }
    }));
    // Wrapped SOL may appear as the quote asset in pools. Recover a SOL/USD
    // estimate from liquid quote-side pools if the base-token lookup missed it.
    const wrappedSolMint = "So11111111111111111111111111111111111111112";
    if (!prices.has(wrappedSolMint)) {
      try {
        const solResponse = await fetch("https://api.dexscreener.com/latest/dex/tokens/" + wrappedSolMint, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(4000) });
        if (solResponse.ok) {
          const solBody = await solResponse.json() as { pairs?: Array<{ baseToken?: { address?: string }; quoteToken?: { address?: string }; priceUsd?: string; priceNative?: string; liquidity?: { usd?: number } }> };
          const liquidPairs = (solBody.pairs ?? []).filter(pair => Number(pair.liquidity?.usd ?? 0) >= 100);
          const direct = liquidPairs.filter(pair => pair.baseToken?.address === wrappedSolMint && Number(pair.priceUsd) > 0).sort((a,b) => Number(b.liquidity?.usd ?? 0) - Number(a.liquidity?.usd ?? 0))[0];
          if (direct) { prices.set(wrappedSolMint, Number(direct.priceUsd)); liquidities.set(wrappedSolMint, Number(direct.liquidity?.usd ?? 0)); }
          else {
            const inverse = liquidPairs.filter(pair => pair.quoteToken?.address === wrappedSolMint && Number(pair.priceUsd) > 0 && Number(pair.priceNative) > 0).map(pair => ({ usd: Number(pair.priceUsd) / Number(pair.priceNative), liquidity: Number(pair.liquidity?.usd ?? 0) })).filter(pair => Number.isFinite(pair.usd) && pair.usd > 0).sort((a,b) => b.liquidity - a.liquidity)[0];
            if (inverse) { prices.set(wrappedSolMint, inverse.usd); liquidities.set(wrappedSolMint, inverse.liquidity); }
          }
        }
      } catch { /* Keep SOL unpriced rather than inventing a quote. */ }
    }
    const tokenValues = tokenBalances.map((entry) => ({ ...entry, ...(tokenNames.get(entry.mint)??{}), marketCapUsd:marketCaps.get(entry.mint)??null, priceUsd: prices.get(entry.mint) ?? null, valueUsd: prices.has(entry.mint) ? entry.amount * prices.get(entry.mint)! : null }));
    const solPrice = prices.get("So11111111111111111111111111111111111111112");
    const unpricedMints = tokenValues.filter((entry) => entry.valueUsd === null).length;
    const complete = solPrice !== undefined && unpricedMints === 0 && tokenBalances.length <= 29;
    // Preserve a useful partial estimate when some memecoins lack a qualifying quote. This is display-only and remains marked incomplete.
    const pricedTokenValue = tokenValues.reduce((sum, entry) => sum + (entry.valueUsd ?? 0), 0);
    const portfolioUsd = solPrice !== undefined || tokenValues.some(entry => entry.valueUsd !== null) ? (solPrice !== undefined ? balance.value / 1e9 * solPrice : 0) + pricedTokenValue : null;
    const note = complete
      ? "Observation-time estimate using current DexScreener spot quotes passing a $100 liquidity floor. Not historical pricing, official P&L, or settlement evidence; transfers and token eligibility remain unresolved."
      : "Incomplete observation-time estimate: one or more assets lacked a qualifying current spot quote or token coverage exceeded the cap. Not historical pricing or settlement evidence.";
    await DB.prepare("INSERT OR IGNORE INTO td_match_valuation_observations (match_id,wallet,observed_at,sol_balance,portfolio_usd,token_balances_json,priced_mints,unpriced_mints,complete,integrity_note) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .bind(match.id, trackedWallet, observationAt, balance.value / 1e9, portfolioUsd, JSON.stringify(tokenValues), tokenValues.length - unpricedMints, unpricedMints, complete ? 1 : 0, note).run();
  }
  const observations = await DB.prepare("SELECT wallet,observed_at,sol_balance,portfolio_usd,token_balances_json,priced_mints,unpriced_mints,complete,source,integrity_note FROM td_match_valuation_observations WHERE match_id = ? ORDER BY observed_at DESC LIMIT 500").bind(match.id).all<{wallet:string;observed_at:number;sol_balance:number;portfolio_usd:number|null;token_balances_json:string;priced_mints:number;unpriced_mints:number;complete:number;source:string;integrity_note:string}>();
  const fillCandidates = await DB.prepare("SELECT wallet,signature,block_time,slot,token_mint,token_delta,sol_delta_net,estimated_token_price_sol,direction,parser,confidence,explanation FROM td_swap_fill_candidates WHERE match_id = ? ORDER BY block_time DESC LIMIT 100").bind(match.id).all<{wallet:string;signature:string;block_time:number|null;slot:number|null;token_mint:string;token_delta:number;sol_delta_net:number;estimated_token_price_sol:number|null;direction:string;parser:string;confidence:string;explanation:string}>();
  const events = await DB.prepare("SELECT wallet,signature,block_time,slot,success,pump_fun_related,sol_delta,token_deltas_json,event_type FROM td_match_events WHERE match_id = ? ORDER BY block_time DESC LIMIT 60").bind(match.id).all<{wallet:string;signature:string;block_time:number|null;slot:number|null;success:number;pump_fun_related:number;sol_delta:number;token_deltas_json:string;event_type:string}>();
  const accountingRows = await DB.prepare("SELECT wallet,signature,block_time,success,fee_lamports,native_delta_lamports,native_delta_ex_fee_lamports,token_deltas_json,protocols_json,evidence_level,blockers_json FROM td_match_accounting_ledger WHERE match_id=? ORDER BY block_time DESC LIMIT 100").bind(match.id).all<{wallet:string;signature:string;block_time:number|null;success:number;fee_lamports:number;native_delta_lamports:number;native_delta_ex_fee_lamports:number;token_deltas_json:string;protocols_json:string;evidence_level:string;blockers_json:string}>();
  const valuations = await DB.prepare("SELECT wallet,phase,observed_at,portfolio_usd,priced_mints,unpriced_mints,complete,integrity_note FROM td_match_valuations WHERE match_id = ? ORDER BY observed_at DESC").bind(match.id).all<{wallet:string;phase:string;observed_at:number;portfolio_usd:number|null;priced_mints:number;unpriced_mints:number;complete:number;integrity_note:string}>();
  const priceEvidence = await DB.prepare("SELECT wallet,phase,mint,price_usd,liquidity_usd,source,observed_at,quote_kind,accepted,reason FROM td_match_price_evidence WHERE match_id = ? ORDER BY observed_at DESC,mint LIMIT 100").bind(match.id).all<{wallet:string;phase:string;mint:string;price_usd:number|null;liquidity_usd:number|null;source:string;observed_at:number;quote_kind:string;accepted:number;reason:string}>();
  let customRoom: {status:string;startedAt:string|null;endsAt:string|null;mode:string;maxPlayers:number;members:Array<{wallet:string;team_number:number}>}|undefined;
  let responseStatus = "activity_and_valuation_evidence";
  if (match.custom) {
    if (match.ends_at && Date.now() >= new Date(match.ends_at).getTime() && match.status === "active") { await DB.prepare("UPDATE td_custom_matches SET status='completed',finished_at=datetime('now') WHERE id=? AND status='active'").bind(match.id).run(); responseStatus="completed_review_required"; }
    const room = await DB.prepare("SELECT status,started_at,ends_at,mode,max_players FROM td_custom_matches WHERE id=?").bind(match.id).first<{status:string;started_at:string|null;ends_at:string|null;mode:string;max_players:number}>();
    const members = await DB.prepare("SELECT wallet,team_number FROM td_custom_match_members WHERE match_id=? ORDER BY team_number,id").bind(match.id).all<{wallet:string;team_number:number}>();
    if (room) customRoom={status:room.status,startedAt:room.started_at,endsAt:room.ends_at,mode:room.mode,maxPlayers:room.max_players,members:members.results??[]};
    if (room?.status === "completed") {
      const matchStartSec=room?.started_at?Math.floor(new Date(room.started_at).getTime()/1000):null;const matchEndSec=room?.ends_at?Math.floor(new Date(room.ends_at).getTime()/1000):null;const memberReturns=(members.results??[]).map(member=>{const startSnap=(valuations.results??[]).find(row=>row.wallet===member.wallet&&row.phase==="start"&&row.complete&&row.portfolio_usd!==null&&matchStartSec!==null&&Math.abs(row.observed_at-matchStartSec)<=120);const endSnap=(valuations.results??[]).find(row=>row.wallet===member.wallet&&row.phase==="end"&&row.complete&&row.portfolio_usd!==null&&matchEndSec!==null&&Math.abs(row.observed_at-matchEndSec)<=120);const returnPct=startSnap&&endSnap&&startSnap.portfolio_usd!==null&&endSnap.portfolio_usd!==null&&startSnap.portfolio_usd>0?((endSnap.portfolio_usd-startSnap.portfolio_usd)/startSnap.portfolio_usd)*100:null;return {wallet:member.wallet,team:member.team_number,returnPct,firstObservedAt:startSnap?.observed_at??null,lastObservedAt:endSnap?.observed_at??null,sampleCount:(observations.results??[]).filter(row=>row.wallet===member.wallet&&row.complete).length,baselineStatus:startSnap?"valid":"missing_or_outside_start_window",endStatus:endSnap?"valid":"missing_or_outside_end_window"};});
      const teamScore=(teamNumber:number)=>{const scores=memberReturns.filter(row=>row.team===teamNumber&&row.returnPct!==null).map(row=>row.returnPct as number);return scores.length?scores.reduce((sum,value)=>sum+value,0)/scores.length:null;};
      const blockers=[ "official_scoring_disabled", "portfolio_values_are_estimates", "transaction_fill_reconciliation_incomplete" ];
      if(memberReturns.some(row=>row.returnPct===null))blockers.push("missing_complete_start_or_end_snapshot_within_120_second_boundary");
      if((accountingRows.results??[]).some(row=>JSON.parse(row.blockers_json).length>0))blockers.push("transaction_ledger_contains_unresolved_evidence");
      await DB.prepare("INSERT INTO td_custom_match_settlements (match_id,status,team_one_return_pct,team_two_return_pct,member_returns_json,blockers_json,indexed_transactions,updated_at) VALUES (? ,'blocked',?,?,?,?,?,datetime('now')) ON CONFLICT(match_id) DO UPDATE SET status='blocked',team_one_return_pct=excluded.team_one_return_pct,team_two_return_pct=excluded.team_two_return_pct,member_returns_json=excluded.member_returns_json,blockers_json=excluded.blockers_json,indexed_transactions=excluded.indexed_transactions,updated_at=datetime('now')").bind(match.id,teamScore(1),teamScore(2),JSON.stringify(memberReturns),JSON.stringify([...new Set(blockers)]),(accountingRows.results??[]).length).run();
    }
  }
  return { matchId:match.id, indexed, events:(events.results??[]).map(e=>({...e,tokenDeltas:JSON.parse(e.token_deltas_json),token_deltas_json:undefined,success:Boolean(e.success),pump_fun_related:Boolean(e.pump_fun_related)})), accountingLedger:(accountingRows.results??[]).map(row=>({...row,success:Boolean(row.success),tokenDeltas:JSON.parse(row.token_deltas_json),protocols:JSON.parse(row.protocols_json),blockers:JSON.parse(row.blockers_json),token_deltas_json:undefined,protocols_json:undefined,blockers_json:undefined})), valuations:valuations.results??[], valuationObservations:(observations.results??[]).map(row=>({...row,tokenBalances:JSON.parse(row.token_balances_json),token_balances_json:undefined,complete:Boolean(row.complete)})), fillCandidates:fillCandidates.results??[], priceEvidence:(priceEvidence.results??[]).map(row=>({...row,accepted:Boolean(row.accepted)})), status:responseStatus, customRoom, note:`Buy/sell labels are instruction-log candidates. Portfolio values and valuationObservations are sampled spot-price estimates at sync time, not historical prices between syncs, and may be incomplete. They are not official P&L; transfers, fees, token eligibility, price quality, and both players' snapshots require reconciliation before scoring.${indexingErrors ? ` Signature indexing failed for ${indexingErrors} wallet(s) on this poll; portfolio monitoring continued and indexing will retry.` : ""}` };
});

/**
 * Expiry reconciliation is deliberately fail-closed: expired rooms are closed, but no
 * winner or rating is written unless an audited settlement engine has verified both
 * portfolios. Activity labels alone are never treated as proof of a winning trade.
 */
export const reconcileExpiredMatches = createServerFn({ method: "POST" }).validator(z.object({ token: z.string().min(24) })).handler(async ({ data }) => {
  const { DB, wallet } = await requireSession(data.token);
  const expired = await DB.prepare("SELECT id, verification_status FROM td_matches WHERE status = 'active' AND ends_at IS NOT NULL AND ends_at <= ? AND (player_one = ? OR player_two = ?)").bind(new Date().toISOString(), wallet, wallet).all<{id:string;verification_status:string}>();
  let closed = 0;
  for (const match of expired.results ?? []) {
    // Preserve verified state if a future audited settlement has already set it.
    await DB.prepare("UPDATE td_matches SET status = 'completed', finished_at = COALESCE(finished_at, datetime('now')) WHERE id = ? AND status = 'active'").bind(match.id).run();
    closed++;
  }
  return { closed, scored: 0, message: "Expired matches are closed. No winner or ELO change is published without verified portfolio valuations." };
});

/** Public spectator data contains only public match metadata and already-indexed public-chain events. */
export const getPublicMatchDetail = createServerFn({ method: "GET" }).validator(z.object({ matchId: z.string().uuid() })).handler(async ({ data }) => {
  const { DB } = bindings();
  if (!DB) throw new Error("Match feed is unavailable.");
  const match = await DB.prepare("SELECT id,player_one,player_two,status,format,started_at,ends_at,finished_at,verification_status,duration_seconds FROM td_matches WHERE id = ? AND player_two IS NOT NULL").bind(data.matchId).first<{id:string;player_one:string;player_two:string|null;status:string;format:string;started_at:string|null;ends_at:string|null;finished_at:string|null;verification_status:string;duration_seconds:number}>();
  if (!match) throw new Error("Public match not found.");
  const rows = await DB.prepare("SELECT wallet,signature,block_time,slot,success,pump_fun_related,sol_delta,token_deltas_json,event_type FROM td_match_events WHERE match_id = ? ORDER BY block_time DESC LIMIT 60").bind(match.id).all<{wallet:string;signature:string;block_time:number|null;slot:number|null;success:number;pump_fun_related:number;sol_delta:number;token_deltas_json:string;event_type:string}>();
  const valuations = await DB.prepare("SELECT wallet,phase,observed_at,portfolio_usd,priced_mints,unpriced_mints,complete,integrity_note FROM td_match_valuations WHERE match_id = ? ORDER BY observed_at DESC").bind(match.id).all<{wallet:string;phase:string;observed_at:number;portfolio_usd:number|null;priced_mints:number;unpriced_mints:number;complete:number;integrity_note:string}>();
  return { match, events:(rows.results??[]).map(e=>({wallet:e.wallet,signature:e.signature,block_time:e.block_time,slot:e.slot,success:Boolean(e.success),pump_fun_related:Boolean(e.pump_fun_related),sol_delta:e.sol_delta,tokenDeltas:JSON.parse(e.token_deltas_json),event_type:e.event_type})), valuations:valuations.results??[], note:"Public transaction activity and portfolio valuation evidence only. Neither is an official P&L result; no winner or ELO is published." };
});

/**
 * Conservative integrity audit for real-wallet matches. It never awards ELO.
 * Missing evidence and unusual patterns are surfaced as review flags, not proof of abuse.
 */
export const auditMatchIntegrity = createServerFn({ method: "POST" }).validator(z.object({ token: z.string().min(24), matchId: z.string().uuid() })).handler(async ({ data }) => {
  const { DB, wallet } = await requireSession(data.token);
  const match = await DB.prepare("SELECT id,player_one,player_two,status,started_at,ends_at,verification_status FROM td_matches WHERE id = ? AND (player_one = ? OR player_two = ?)").bind(data.matchId,wallet,wallet).first<{id:string;player_one:string;player_two:string|null;status:string;started_at:string|null;ends_at:string|null;verification_status:string}>();
  if (!match || !match.player_two) throw new Error("Match not found for this wallet.");
  const flags: Array<{code:string;severity:string;detail:string}> = [];
  const snapshots = await DB.prepare("SELECT wallet,phase,complete,portfolio_usd,observed_at FROM td_match_valuations WHERE match_id = ?").bind(match.id).all<{wallet:string;phase:string;complete:number;portfolio_usd:number|null;observed_at:number}>();
  const snapshotRows = snapshots.results ?? [];
  for (const player of [match.player_one,match.player_two]) {
    const suffix = player===match.player_one ? "p1" : "p2";
    const start = snapshotRows.find(s=>s.wallet===player&&s.phase==="start");
    const end = snapshotRows.find(s=>s.wallet===player&&s.phase==="end");
    if (!start) flags.push({code:"missing_start_snapshot_"+suffix,severity:"block",detail:"No start-of-match portfolio snapshot exists for "+player.slice(0,5)+"…"+player.slice(-4)+". Pre-existing positions cannot be reliably excluded."});
    else if (!start.complete || start.portfolio_usd===null) flags.push({code:"incomplete_start_snapshot_"+suffix,severity:"block",detail:"Start snapshot is not completely priced for "+player.slice(0,5)+"…"+player.slice(-4)+"."});
    if (match.status==="completed"&&!end) flags.push({code:"missing_end_snapshot_"+suffix,severity:"block",detail:"No end-of-match portfolio snapshot exists for "+player.slice(0,5)+"…"+player.slice(-4)+"."});
    else if (end&&(!end.complete||end.portfolio_usd===null)) flags.push({code:"incomplete_end_snapshot_"+suffix,severity:"block",detail:"End snapshot is not completely priced for "+player.slice(0,5)+"…"+player.slice(-4)+"."});
  }
  const ambiguous = await DB.prepare("SELECT COUNT(*) AS count FROM td_match_events WHERE match_id = ? AND success = 1 AND event_type IN ('token_activity','sol_activity','pump_fun_instruction_unclassified')").bind(match.id).first<{count:number}>();
  if ((ambiguous?.count??0)>0) flags.push({code:"unclassified_activity",severity:"review",detail:(ambiguous?.count??0)+" successful transactions are not classified as verified swaps. Transfers and other movements must not count as trading profit."});
  const failed = await DB.prepare("SELECT COUNT(*) AS count FROM td_match_events WHERE match_id = ? AND success = 0").bind(match.id).first<{count:number}>();
  if ((failed?.count??0)>0) flags.push({code:"failed_transactions_present",severity:"review",detail:(failed?.count??0)+" failed transactions were observed and must not count as trades."});
  const prior = await DB.prepare("SELECT COUNT(*) AS count FROM td_matches WHERE status = 'completed' AND player_two IS NOT NULL AND ((player_one = ? AND player_two = ?) OR (player_one = ? AND player_two = ?)) AND id != ?").bind(match.player_one,match.player_two,match.player_two,match.player_one,match.id).first<{count:number}>();
  if ((prior?.count??0)>=2) flags.push({code:"repeat_opponent_pairing",severity:"review",detail:"These wallets have completed "+(prior?.count??0)+" prior matches together. Repeated pairings can enable rating farming and should be reviewed."});
  for (const flag of flags) {
    await DB.prepare("INSERT INTO td_match_integrity_flags (match_id,flag_code,severity,detail) VALUES (?,?,?,?) ON CONFLICT(match_id,flag_code) DO UPDATE SET severity=excluded.severity,detail=excluded.detail").bind(match.id,flag.code,flag.severity,flag.detail).run();
  }
  const existing = await DB.prepare("SELECT flag_code,severity,detail,created_at FROM td_match_integrity_flags WHERE match_id = ? ORDER BY severity DESC,created_at ASC").bind(match.id).all<{flag_code:string;severity:string;detail:string;created_at:string}>();
  const allFlags = existing.results ?? [];
  const blocked = allFlags.some(f=>f.severity==="block");
  if (allFlags.length>0) await DB.prepare("UPDATE td_matches SET verification_status = 'review_required' WHERE id = ? AND verification_status != 'verified'").bind(match.id).run();
  return {
    matchId:match.id,
    status:blocked?"blocked_missing_evidence":allFlags.length>0?"manual_review_required":"no_flags_from_available_evidence",
    flags:allFlags,
    canAwardElo:false,
    message:"This is a conservative screening pass, not proof of cheating or complete settlement. Official ELO remains disabled until swap fills, transfers, token eligibility, price manipulation, and both full portfolio snapshots can be independently reconciled."
  };
});

/** Transaction-level evidence only. This never calculates P&L or awards ELO. */
export const verifyMatchTrades = createServerFn({ method: "POST" }).validator(z.object({ token: z.string().min(24), matchId: z.string().uuid() })).handler(async ({ data }) => {
  const { DB, wallet } = await requireSession(data.token);
  const match = await DB.prepare("SELECT id,player_one,player_two,status,started_at,ends_at FROM td_matches WHERE id = ? AND (player_one = ? OR player_two = ?)").bind(data.matchId,wallet,wallet).first<{id:string;player_one:string;player_two:string|null;status:string;started_at:string|null;ends_at:string|null}>();
  if (!match || !match.player_two) throw new Error("Match not found for this wallet.");
  if (!match.started_at || !match.ends_at) throw new Error("Match has no authoritative time window.");
  const start = Math.floor(new Date(match.started_at).getTime()/1000), end = Math.floor(new Date(match.ends_at).getTime()/1000);
  if (!Number.isFinite(start)||!Number.isFinite(end)||end<=start) throw new Error("Match time window is invalid.");
  const rpcCall = async (method:string, params:unknown[]): Promise<any> => await solanaRpcCall(method, params) as any;
  let scanned = 0, saved = 0;
  for (const player of [match.player_one,match.player_two]) {
    const queuedSignatures = await DB.prepare("SELECT signature,slot,block_time,tx_error_json FROM td_match_index_queue WHERE match_id=? AND wallet=? AND block_time>=? AND block_time<=? ORDER BY block_time DESC LIMIT 5000")
      .bind(match.id,player,start,end).all<{signature:string;slot:number|null;block_time:number|null;tx_error_json:string|null}>();
    const signatures: Array<{signature:string;slot:number;blockTime:number|null;err:unknown}> = (queuedSignatures.results?.length
      ? queuedSignatures.results.map(row=>({signature:row.signature,slot:row.slot??0,blockTime:row.block_time,err:row.tx_error_json}))
      : await rpcCall("getSignaturesForAddress",[player,{limit:100,commitment:"confirmed"}]) as Array<{signature:string;slot:number;blockTime:number|null;err:unknown}>);
    for (const sig of signatures) {
      if (sig.blockTime===null || sig.blockTime<start || sig.blockTime>end) continue;
      const old = await DB.prepare("SELECT id FROM td_match_trade_audits WHERE match_id = ? AND wallet = ? AND signature = ?").bind(match.id,player,sig.signature).first<{id:number}>();
      if (old) continue;
      const tx = await rpcCall("getTransaction",[sig.signature,{encoding:"jsonParsed",commitment:"confirmed",maxSupportedTransactionVersion:0}]);
      if (!tx?.meta) continue;
      scanned++;
      const keys = (tx.transaction?.message?.accountKeys??[]).map((key:any)=>typeof key==="string"?key:key.pubkey);
      const accountIndex = keys.indexOf(player);
      const preLamports = accountIndex>=0?Number(tx.meta.preBalances?.[accountIndex]??0):0;
      const postLamports = accountIndex>=0?Number(tx.meta.postBalances?.[accountIndex]??0):0;
      const feeLamports = accountIndex===0?Number(tx.meta.fee??0):0;
      // Preserve decimal precision where the RPC supplies uiAmountString, and sum
      // across every token account belonging to this wallet for the same mint.
      const tokenDeltas = tokenBalanceDeltas(tx.meta.preTokenBalances??[], tx.meta.postTokenBalances??[], player).map(({mint,amount,rawDelta,decimals})=>({mint,amount,rawDelta,decimals}));
      const instructions = [...(tx.transaction?.message?.instructions??[]),...(tx.meta.innerInstructions??[]).flatMap((group:any)=>group.instructions??[])];
      const programIds = [...new Set(instructions.map((ix:any)=>resolveInstructionProgramId(ix, keys, tx.meta?.loadedAddresses)).filter((id:any): id is string => typeof id === "string"))];
      // Persist parsed instruction-level movements so later accounting can distinguish
      // token transfers and SOL transfers from actual swap executions.
      const tokenAccountInfo = new Map<string,{mint:string;decimals:number;owner:string}>();
      for(const balance of [...(tx.meta.preTokenBalances??[]),...(tx.meta.postTokenBalances??[])]) {
        const account=keys[Number(balance.accountIndex)];
        if(account && balance.mint) tokenAccountInfo.set(account,{mint:balance.mint,decimals:Number(balance.uiTokenAmount?.decimals??0),owner:String(balance.owner??"")});
      }
      const instructionEvidence:any[]=[];
      const collectInstruction=(ix:any,index:number,inner:number)=>{
        const parsed=ix?.parsed; const info=parsed?.info??{}; const program=String(ix?.programId??ix?.program??"");
        const decodedPump=decodePumpFunInstruction(program,typeof ix?.data==="string"?ix.data:undefined);
        const type=String(parsed?.type??decodedPump?.name??ix?.dataType??"unknown");
        let classification="other_instruction", mint:string|null=null, raw:string|null=null, decimals:number|null=null, amountUi:number|null=null, lamports:number|null=null;
        const source=typeof info.source==="string"?info.source:null, destination=typeof info.destination==="string"?info.destination:null;
        if(/transferchecked/i.test(type) && info.tokenAmount) {
          classification="token_transfer"; mint=String(info.mint??"")||null; raw=String(info.tokenAmount.amount??""); decimals=Number(info.tokenAmount.decimals??0); amountUi=Number(info.tokenAmount.uiAmountString??info.tokenAmount.uiAmount??(Number(raw)/10**(decimals??0)));
        } else if(/transfer/i.test(type) && (info.amount!==undefined || info.lamports!==undefined)) {
          const srcInfo=source?tokenAccountInfo.get(source):undefined; const dstInfo=destination?tokenAccountInfo.get(destination):undefined;
          if(program.includes("Token") || srcInfo || dstInfo) { classification="token_transfer"; const tokenInfo=srcInfo??dstInfo; mint=String(info.mint??tokenInfo?.mint??"")||null; decimals=tokenInfo?.decimals??null; raw=String(info.amount??""); amountUi=decimals===null?null:Number(raw)/10**decimals; }
          else { classification="sol_transfer"; lamports=Number(info.lamports??info.amount??0); }
        } else if(/syncnative|closeaccount|initializeaccount/i.test(type)) classification="token_account_lifecycle";
        const sourceOwner=tokenAccountInfo.get(source??"")?.owner??null;
        const destinationOwner=tokenAccountInfo.get(destination??"")?.owner??null;
        const walletInvolved=source===player||destination===player||sourceOwner===player||destinationOwner===player;
        if(walletInvolved && (classification==="token_transfer" || classification==="sol_transfer")) {
          classification=classifyTransferFlow({source,destination,sourceOwner,destinationOwner,wallet:player,kind:classification==="sol_transfer"?"sol":"token"});
        }
        if(walletInvolved) instructionEvidence.push({index,inner,program,type,source,destination,mint,raw,decimals,amountUi,lamports,classification,info:{...info,...(decodedPump?{decodedPump}: {})}});
      };
      (tx.transaction?.message?.instructions??[]).forEach((ix:any,index:number)=>collectInstruction(ix,index,0));
      for(const group of tx.meta.innerInstructions??[]) for(const [innerIndex,ix] of (group.instructions??[]).entries()) collectInstruction(ix,Number(group.index??0),innerIndex+1);
      for(const ev of instructionEvidence) await DB.prepare("INSERT OR IGNORE INTO td_match_instruction_evidence (match_id,wallet,signature,instruction_index,inner_instruction,program_id,instruction_type,source,destination,mint,amount_raw,decimals,amount_ui,lamports,classification,details_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
        .bind(match.id,player,sig.signature,ev.index,ev.inner,ev.program,ev.type,ev.source,ev.destination,ev.mint,ev.raw,ev.decimals,Number.isFinite(ev.amountUi)?ev.amountUi:null,Number.isFinite(ev.lamports)?ev.lamports:null,ev.classification,JSON.stringify(ev.info)).run();
      const externalFlowClasses = new Set(["external_sol_inflow_candidate","external_sol_outflow_candidate","external_token_inflow_candidate","external_token_outflow_candidate"]);
      const externalFlows = instructionEvidence.filter((ev:any)=>externalFlowClasses.has(ev.classification)).map((ev:any)=>({classification:ev.classification,mint:ev.mint,raw:ev.raw,lamports:ev.lamports,source:ev.source,destination:ev.destination,instructionIndex:ev.index,innerInstruction:ev.inner}));
      const hasLifecycleEffects = instructionEvidence.some((ev:any)=>ev.classification==="token_account_lifecycle");
      const swapPrograms = new Set(["JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4","JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB","6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P","675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8"]);
      const knownSwap = programIds.some(id=>swapPrograms.has(id));
      const swapLogs = (tx.meta.logMessages??[]).some((line:string)=>/Instruction: (Buy|Sell|Swap|Route|ExactIn|ExactOut)/i.test(line));
      const success = sig.err===null && tx.meta.err===null;
      const hasTokens = tokenDeltas.length>0, solDelta = (postLamports-preLamports)/1e9;
      let classification = "other", reason = "No wallet token balance change or recognized swap instruction was found.";
      if(!success){classification="failed";reason="Transaction failed on-chain; excluded from trade candidates.";}
      else if((knownSwap||swapLogs)&&hasTokens){classification="swap_candidate";reason="Swap-related program/log and wallet token changes found. This is a candidate, not a verified fill.";}
      else if(hasTokens){classification="token_movement";reason="Token balance changed, but a verified swap could not be established. May be a transfer, mint, burn, or unsupported swap.";}
      else if(Math.abs(solDelta)>0.000000001){classification="sol_movement";reason="SOL balance changed. This may include transfers, rent, fees, or protocol activity; it is not profit evidence.";}
      const reasonText = reason + (feeLamports>0 ? " Fee paid: "+(feeLamports/1e9).toFixed(9)+" SOL." : "");
      const protocolIds = identifySwapProtocol(programIds);
      const ledger = buildAccountingLedgerSummary({success,nativeDeltaLamports:postLamports-preLamports,feeLamports,walletIsFeePayer:accountIndex===0,tokenDeltas,externalFlows,protocols:[...new Set(protocolIds)],hasLifecycleEffects});
      const ledgerBlockers = [...ledger.blockers];
      if(!success) ledgerBlockers.push("failed_transaction_not_trade");
      await DB.prepare("INSERT OR IGNORE INTO td_match_accounting_ledger (match_id,wallet,signature,slot,block_time,success,fee_lamports,native_delta_lamports,native_delta_ex_fee_lamports,token_deltas_json,external_flows_json,protocols_json,evidence_level,blockers_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
        .bind(match.id,player,sig.signature,sig.slot,sig.blockTime,success?1:0,ledger.feeLamports,ledger.nativeDeltaLamports,ledger.nativeDeltaExFeeLamports,JSON.stringify(ledger.tokenDeltas),JSON.stringify(ledger.externalFlows),JSON.stringify(ledger.protocols),ledger.evidenceLevel,JSON.stringify([...new Set(ledgerBlockers)])).run();
      await DB.prepare("INSERT OR IGNORE INTO td_match_trade_audits (match_id,wallet,signature,slot,block_time,success,fee_lamports,sol_delta,token_deltas_json,program_ids_json,classification,reason) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
        .bind(match.id,player,sig.signature,sig.slot,sig.blockTime,success?1:0,feeLamports,solDelta,JSON.stringify(tokenDeltas),JSON.stringify(programIds),classification,reasonText).run();
      const instructionNames = (tx.meta.logMessages ?? [])
        .filter((line: string) => line.includes("Program log: Instruction:"))
        .map((line: string) => line.split("Program log: Instruction:")[1]?.trim() ?? "")
        .filter(Boolean);
      const swapEvidence = buildProtocolSwapCandidate({
        success, protocol: protocolIds.length ? protocolIds.join("+") : null, instructionNames,
        tokenDeltas, nativeDeltaLamports: postLamports-preLamports, feeLamports,
        walletIsFeePayer: accountIndex===0,
        externalFlowClasses: externalFlows.map((flow:any)=>flow.classification), hasLifecycleEffects,
      });
      if (swapEvidence) {
        await DB.prepare("INSERT OR IGNORE INTO td_protocol_swap_evidence (match_id,wallet,signature,slot,block_time,protocol,instruction_names_json,input_mint,input_raw,input_decimals,output_mint,output_raw,output_decimals,native_delta_lamports,fee_lamports,evidence_level,blockers_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
          .bind(match.id,player,sig.signature,sig.slot,sig.blockTime,swapEvidence.protocol,JSON.stringify(swapEvidence.instructionNames),swapEvidence.inputMint,swapEvidence.inputRaw,swapEvidence.inputDecimals,swapEvidence.outputMint,swapEvidence.outputRaw,swapEvidence.outputDecimals,swapEvidence.nativeDeltaLamports,swapEvidence.feeLamports,swapEvidence.evidenceLevel,JSON.stringify(swapEvidence.blockers)).run();
      }
      saved++;
      if(scanned>=80) break;
    }
    if(scanned>=80) break;
  }
  const rows = await DB.prepare("SELECT wallet,signature,slot,block_time,success,fee_lamports,sol_delta,token_deltas_json,program_ids_json,classification,reason FROM td_match_trade_audits WHERE match_id = ? ORDER BY block_time DESC LIMIT 100").bind(match.id).all<{wallet:string;signature:string;slot:number|null;block_time:number|null;success:number;fee_lamports:number;sol_delta:number;token_deltas_json:string;program_ids_json:string;classification:string;reason:string}>();
  const counts = await DB.prepare("SELECT classification,COUNT(*) AS count FROM td_match_trade_audits WHERE match_id = ? GROUP BY classification").bind(match.id).all<{classification:string;count:number}>();
  const fillRows = await DB.prepare("SELECT wallet,signature,block_time,slot,token_mint,token_delta,sol_delta_net,estimated_token_price_sol,direction,parser,confidence,explanation FROM td_swap_fill_candidates WHERE match_id = ? ORDER BY block_time DESC LIMIT 100").bind(match.id).all<{wallet:string;signature:string;block_time:number|null;slot:number|null;token_mint:string;token_delta:number;sol_delta_net:number;estimated_token_price_sol:number|null;direction:string;parser:string;confidence:string;explanation:string}>();
  const movementCounts = await DB.prepare("SELECT classification,COUNT(*) AS count FROM td_match_instruction_evidence WHERE match_id = ? GROUP BY classification").bind(match.id).all<{classification:string;count:number}>();
  const protocolEvidenceRows = await DB.prepare("SELECT wallet,signature,slot,block_time,protocol,instruction_names_json,input_mint,input_raw,input_decimals,output_mint,output_raw,output_decimals,native_delta_lamports,fee_lamports,evidence_level,blockers_json FROM td_protocol_swap_evidence WHERE match_id = ? ORDER BY block_time DESC LIMIT 100").bind(match.id).all<{wallet:string;signature:string;slot:number|null;block_time:number|null;protocol:string;instruction_names_json:string;input_mint:string;input_raw:string;input_decimals:number;output_mint:string;output_raw:string;output_decimals:number;native_delta_lamports:number;fee_lamports:number;evidence_level:string;blockers_json:string}>();
  const ledgerRows = await DB.prepare("SELECT wallet,signature,slot,block_time,success,fee_lamports,native_delta_lamports,native_delta_ex_fee_lamports,token_deltas_json,external_flows_json,protocols_json,evidence_level,blockers_json FROM td_match_accounting_ledger WHERE match_id = ? ORDER BY block_time DESC LIMIT 100").bind(match.id).all<{wallet:string;signature:string;slot:number|null;block_time:number|null;success:number;fee_lamports:number;native_delta_lamports:number;native_delta_ex_fee_lamports:number;token_deltas_json:string;external_flows_json:string;protocols_json:string;evidence_level:string;blockers_json:string}>();
  return {matchId:match.id,scanned,saved,counts:counts.results??[],instructionMovementCounts:movementCounts.results??[],accountingLedger:(ledgerRows.results??[]).map(row=>({...row,success:Boolean(row.success),tokenDeltas:JSON.parse(row.token_deltas_json),externalFlows:JSON.parse(row.external_flows_json),protocols:JSON.parse(row.protocols_json),blockers:JSON.parse(row.blockers_json),token_deltas_json:undefined,external_flows_json:undefined,protocols_json:undefined,blockers_json:undefined})),transactions:(rows.results??[]).map(row=>({...row,success:Boolean(row.success),tokenDeltas:JSON.parse(row.token_deltas_json),programIds:JSON.parse(row.program_ids_json),token_deltas_json:undefined,program_ids_json:undefined})),fillCandidates:fillRows.results??[],protocolSwapEvidence:(protocolEvidenceRows.results??[]).map(row=>({...row,instructionNames:JSON.parse(row.instruction_names_json),blockers:JSON.parse(row.blockers_json),instruction_names_json:undefined,blockers_json:undefined})),canAwardElo:false,note:"Normalized swap-shaped candidates reconcile exact raw input/output balance deltas with recognized protocols and instruction logs. They are not protocol-emitted fill events; transfer, rent, fee allocation, and historical pricing remain unresolved. No official P&L or ELO is calculated."};
});


/** Computes a provisional snapshot comparison and fails closed on missing evidence.
 * This is not official settlement: external flows and execution-level fills must be reconciled
 * before a winner can be certified or ELO can change. */
export const reconcileMatchSettlement = createServerFn({ method: "POST" }).validator(z.object({ token: z.string().min(24), matchId: z.string().uuid() })).handler(async ({ data }) => {
  const { DB, wallet } = await requireSession(data.token);
  const match = await DB.prepare("SELECT id,player_one,player_two,status,started_at,ends_at,verification_status FROM td_matches WHERE id = ? AND (player_one = ? OR player_two = ?)").bind(data.matchId,wallet,wallet).first<{id:string;player_one:string;player_two:string|null;status:string;started_at:string|null;ends_at:string|null;verification_status:string}>();
  if (!match || !match.player_two) throw new Error("Match not found for this wallet.");
  const snapshots = await DB.prepare("SELECT wallet,phase,observed_at,sol_balance,token_balances_json FROM td_match_valuations WHERE match_id = ?").bind(match.id).all<{wallet:string;phase:string;observed_at:number;sol_balance:number;token_balances_json:string}>();
  const poolCache = new Map<string, GeckoPoolChoice | null>();
  let quoteLookups = 0;
  const quoteBudget = 4;
  for (const snapshot of snapshots.results ?? []) {
    let tokenBalances: Array<{mint:string;amount:number}> = [];
    try { tokenBalances = JSON.parse(snapshot.token_balances_json) as Array<{mint:string;amount:number}>; } catch { /* snapshot stays incomplete */ }
    const mints = [...new Set(["So11111111111111111111111111111111111111112", ...tokenBalances.filter(t=>t.amount>0&&typeof t.mint==="string").map(t=>t.mint)])];
    for (const mint of mints) {
      const existing = await DB.prepare("SELECT accepted,attempts FROM td_match_historical_price_evidence WHERE match_id=? AND wallet=? AND phase=? AND mint=?")
        .bind(match.id,snapshot.wallet,snapshot.phase,mint).first<{accepted:number;attempts:number}>();
      if (existing?.accepted || (existing && existing.attempts >= 3)) continue;
      if (quoteLookups >= quoteBudget) continue;
      quoteLookups++;
      const quote = await fetchHistoricalTokenPrice(mint,snapshot.observed_at,poolCache);
      await DB.prepare("INSERT INTO td_match_historical_price_evidence (match_id,wallet,phase,mint,target_at,candle_at,price_usd,liquidity_usd,pool_address,source,accepted,attempts,reason) VALUES (?,?,?,?,?,?,?,?,?,'geckoterminal_ohlcv',?,?,?) ON CONFLICT(match_id,wallet,phase,mint) DO UPDATE SET target_at=excluded.target_at,candle_at=excluded.candle_at,price_usd=excluded.price_usd,liquidity_usd=excluded.liquidity_usd,pool_address=excluded.pool_address,source=excluded.source,accepted=excluded.accepted,attempts=td_match_historical_price_evidence.attempts+1,reason=excluded.reason")
        .bind(match.id,snapshot.wallet,snapshot.phase,mint,snapshot.observed_at,quote.candleAt,quote.priceUsd,quote.liquidityUsd,quote.poolAddress,quote.priceUsd!==null?1:0,(existing?.attempts??0)+1,quote.reason).run();
    }
    const evidence = await DB.prepare("SELECT mint,price_usd,accepted FROM td_match_historical_price_evidence WHERE match_id=? AND wallet=? AND phase=?")
      .bind(match.id,snapshot.wallet,snapshot.phase).all<{mint:string;price_usd:number|null;accepted:number}>();
    const priceByMint = new Map((evidence.results??[]).filter(e=>e.accepted&&e.price_usd!==null&&Number.isFinite(e.price_usd)&&e.price_usd>0).map(e=>[e.mint,e.price_usd!]));
    const solMint = "So11111111111111111111111111111111111111112";
    const tokenValues = tokenBalances.filter(t=>t.amount>0).map(t=>({mint:t.mint,amount:t.amount,priceUsd:priceByMint.get(t.mint)??null,valueUsd:priceByMint.has(t.mint)?t.amount*priceByMint.get(t.mint)!:null}));
    const unpriced = tokenValues.filter(t=>t.valueUsd===null).length + (priceByMint.has(solMint)?0:1);
    const complete = unpriced===0 && tokenBalances.length<=29 && Number.isFinite(snapshot.sol_balance) && snapshot.sol_balance>=0;
    const portfolioUsd = complete ? snapshot.sol_balance*priceByMint.get(solMint)! + tokenValues.reduce((sum,t)=>sum+(t.valueUsd??0),0) : null;
    const note = complete ? "Revalued with GeckoTerminal historical minute closes within 180 seconds of the captured snapshot. This values the captured holdings at that snapshot time; it does not by itself reconcile transfers or certify trade fills." : `Historical valuation incomplete: ${unpriced} assets unpriced, ${Math.max(0,tokenBalances.length-29)} assets beyond coverage cap, or historical candles unavailable. Retry reconciliation to continue the bounded backfill.`;
    await DB.prepare("INSERT INTO td_match_historical_valuations (match_id,wallet,phase,observed_at,portfolio_usd,priced_mints,unpriced_mints,complete,integrity_note,updated_at) VALUES (?,?,?,?,?,?,?,?,?,datetime('now')) ON CONFLICT(match_id,wallet,phase) DO UPDATE SET observed_at=excluded.observed_at,portfolio_usd=excluded.portfolio_usd,priced_mints=excluded.priced_mints,unpriced_mints=excluded.unpriced_mints,complete=excluded.complete,integrity_note=excluded.integrity_note,updated_at=datetime('now')")
      .bind(match.id,snapshot.wallet,snapshot.phase,snapshot.observed_at,portfolioUsd,priceByMint.size,unpriced,complete?1:0,note).run();
  }
  const historical = await DB.prepare("SELECT wallet,phase,observed_at,portfolio_usd,complete,priced_mints,unpriced_mints,integrity_note FROM td_match_historical_valuations WHERE match_id = ?").bind(match.id).all<{wallet:string;phase:string;observed_at:number;portfolio_usd:number|null;complete:number;priced_mints:number;unpriced_mints:number;integrity_note:string}>();
  const rows = historical.results ?? [];
  const get = (player:string,phase:string) => rows.find(r=>r.wallet===player&&r.phase===phase);
  const p1s=get(match.player_one,"start"), p1e=get(match.player_one,"end"), p2s=get(match.player_two,"start"), p2e=get(match.player_two,"end");
  const blockers:string[]=[];
  if(match.status!=="completed" || !match.ends_at || new Date(match.ends_at).getTime()>Date.now()) blockers.push("match_not_expired");
  for (const [player,phase] of [[match.player_one,"start"],[match.player_one,"end"],[match.player_two,"start"],[match.player_two,"end"]] as Array<[string,"start"|"end"]>) {
    const snapshot = rows.find(row=>row.wallet===player&&row.phase===phase);
    const target = phase==="start" ? (match.started_at ? Math.floor(new Date(match.started_at).getTime()/1000) : null) : (match.ends_at ? Math.floor(new Date(match.ends_at).getTime()/1000) : null);
    if (snapshot && target!==null && Math.abs(snapshot.observed_at-target)>120) blockers.push(`snapshot_outside_120_second_boundary:${phase}:${player===match.player_one?"player_one":"player_two"}`);
  }
  for(const [label,row] of [["player_one_start",p1s],["player_one_end",p1e],["player_two_start",p2s],["player_two_end",p2e]] as Array<[string,typeof p1s]>) {
    if(!row) blockers.push("missing_"+label);
    else if(!row.complete || row.portfolio_usd===null || !Number.isFinite(row.portfolio_usd)) blockers.push("incomplete_"+label);
  }
  const flags = await DB.prepare("SELECT flag_code,severity FROM td_match_integrity_flags WHERE match_id = ?").bind(match.id).all<{flag_code:string;severity:string}>();
  for(const f of flags.results??[]) if(f.severity==="block") blockers.push("integrity_block:"+f.flag_code);
  const ambiguous = await DB.prepare("SELECT COUNT(*) AS count FROM td_match_events WHERE match_id = ? AND success = 1 AND event_type IN ('token_activity','sol_activity','pump_fun_instruction_unclassified')").bind(match.id).first<{count:number}>();
  if((ambiguous?.count??0)>0) blockers.push("unclassified_wallet_activity");
  const flowEvidence = await DB.prepare("SELECT classification,COUNT(*) AS count FROM td_match_instruction_evidence WHERE match_id = ? AND classification IN ('external_sol_inflow_candidate','external_sol_outflow_candidate','external_token_inflow_candidate','external_token_outflow_candidate') GROUP BY classification").bind(match.id).all<{classification:string;count:number}>();
  for(const flow of flowEvidence.results??[]) if(flow.count>0) blockers.push("external_flow_requires_reconciliation:"+flow.classification);
  const lifecycle = await DB.prepare("SELECT COUNT(*) AS count FROM td_match_instruction_evidence WHERE match_id = ? AND classification = 'token_account_lifecycle'").bind(match.id).first<{count:number}>();
  if((lifecycle?.count??0)>0) blockers.push("token_account_rent_or_lifecycle_effects_unresolved");
  // PnL is portfolio mark-to-market, not inferred swap-fill PnL. Fees are already reflected in SOL balances; unresolved external flows, lifecycle effects, unclassified activity, failed transactions, and incomplete indexing block verification.
  const failedTx = await DB.prepare("SELECT COUNT(*) AS count FROM td_match_accounting_ledger WHERE match_id=? AND success=0").bind(match.id).first<{count:number}>();
  if ((failedTx?.count??0)>0) blockers.push("failed_transactions_in_match_window");
  const indexStates = await DB.prepare("SELECT wallet,exhausted FROM td_match_index_state WHERE match_id=? AND wallet IN (?,?)").bind(match.id,match.player_one,match.player_two).all<{wallet:string;exhausted:number}>();
  for (const player of [match.player_one,match.player_two]) { const state=(indexStates.results??[]).find(row=>row.wallet===player); if(!state || state.exhausted!==1) blockers.push("transaction_history_not_fully_indexed:"+ (player===match.player_one?"player_one":"player_two")); }
  const priceRows = await DB.prepare("SELECT COUNT(*) AS total,SUM(CASE WHEN accepted=0 THEN 1 ELSE 0 END) AS rejected FROM td_match_historical_price_evidence WHERE match_id = ?").bind(match.id).first<{total:number;rejected:number|null}>();
  if((priceRows?.total??0)===0) blockers.push("historical_price_source_provenance_missing");
  if((priceRows?.rejected??0)>0) blockers.push("one_or_more_historical_price_quotes_failed_quality_checks");
  if (rows.some(row=>!row.complete || row.portfolio_usd===null)) blockers.push("historical_price_backfill_incomplete");
  const valid=(row:typeof p1s):row is NonNullable<typeof row> => Boolean(row&&row.complete&&row.portfolio_usd!==null&&Number.isFinite(row.portfolio_usd));
  const r1=valid(p1s)&&valid(p1e)&&p1s.portfolio_usd!>0 ? ((p1e.portfolio_usd!-p1s.portfolio_usd!)/p1s.portfolio_usd!)*100 : null;
  const r2=valid(p2s)&&valid(p2e)&&p2s.portfolio_usd!>0 ? ((p2e.portfolio_usd!-p2s.portfolio_usd!)/p2s.portfolio_usd!)*100 : null;
  const status=blockers.length?"review_required":"verified";
  const winner= r1!==null&&r2!==null&&Math.abs(r1-r2)>1e-8 ? (r1>r2?match.player_one:match.player_two) : null;
  await DB.prepare("INSERT INTO td_match_settlements (match_id,player_one,player_two,start_one_usd,end_one_usd,start_two_usd,end_two_usd,return_one_pct,return_two_pct,provisional_winner,status,blockers_json,elo_applied,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0,datetime('now')) ON CONFLICT(match_id) DO UPDATE SET start_one_usd=excluded.start_one_usd,end_one_usd=excluded.end_one_usd,start_two_usd=excluded.start_two_usd,end_two_usd=excluded.end_two_usd,return_one_pct=excluded.return_one_pct,return_two_pct=excluded.return_two_pct,provisional_winner=excluded.provisional_winner,status=excluded.status,blockers_json=excluded.blockers_json,elo_applied=0,updated_at=datetime('now')").bind(match.id,match.player_one,match.player_two,p1s?.portfolio_usd??null,p1e?.portfolio_usd??null,p2s?.portfolio_usd??null,p2e?.portfolio_usd??null,r1,r2,winner,status,JSON.stringify([...new Set(blockers)])).run();
  if (status === "verified" && winner) await DB.prepare("UPDATE td_matches SET verification_status='verified',winner_wallet=? WHERE id=? AND status='completed'").bind(winner,match.id).run();
  await DB.prepare("UPDATE td_matches SET verification_status = 'review_required' WHERE id = ? AND verification_status != 'verified'").bind(match.id).run();
  const historicalPrices = await DB.prepare("SELECT wallet,phase,mint,target_at,candle_at,price_usd,liquidity_usd,pool_address,source,accepted,attempts,reason FROM td_match_historical_price_evidence WHERE match_id=? ORDER BY phase,wallet,mint LIMIT 200").bind(match.id).all<{wallet:string;phase:string;mint:string;target_at:number;candle_at:number|null;price_usd:number|null;liquidity_usd:number|null;pool_address:string|null;source:string;accepted:number;attempts:number;reason:string}>();
  return {matchId:match.id,status,historicalValuations:rows,historicalPriceEvidence:historicalPrices.results??[],priceBackfill:{lookupsThisRun:quoteLookups,budgetPerRun:quoteBudget},playerOne:{wallet:match.player_one,startUsd:p1s?.portfolio_usd??null,endUsd:p1e?.portfolio_usd??null,returnPct:r1},playerTwo:{wallet:match.player_two,startUsd:p2s?.portfolio_usd??null,endUsd:p2e?.portfolio_usd??null,returnPct:r2},provisionalWinner:winner,blockers:[...new Set(blockers)],eloApplied:false,message:"Historical snapshot revaluation uses timestamped GeckoTerminal minute candles where available. This is not an official result: protocol fill events, transfer/rent effects, fee allocation, and all portfolio assets must still be reconciled before a winner or ELO change can be awarded."};
});


/** Reconciles custom-room team PnL from timestamped historical portfolio snapshots.
 * This deliberately fails closed: team averages are not marked verified while any member's
 * indexing, historical pricing, boundary, transfer, lifecycle, or activity evidence is unresolved. */
export const reconcileCustomMatchSettlement = createServerFn({ method: "POST" })
  .validator(z.object({ token: z.string().min(24), matchId: z.string().uuid() }))
  .handler(async ({ data }) => {
    const { DB, wallet } = await requireSession(data.token);
    const match = await DB.prepare("SELECT id,status,mode,started_at,ends_at,max_players FROM td_custom_matches WHERE id=?")
      .bind(data.matchId).first<{id:string;status:string;mode:string;started_at:string|null;ends_at:string|null;max_players:number}>();
    if (!match) throw new Error("Custom match not found.");
    const members = await DB.prepare("SELECT wallet,team_number FROM td_custom_match_members WHERE match_id=? ORDER BY team_number,wallet")
      .bind(match.id).all<{wallet:string;team_number:number}>();
    const roster = members.results ?? [];
    if (!roster.some(m=>m.wallet===wallet)) throw new Error("Only room members can reconcile this match.");
    const blockers:string[]=[];
    if (match.status!=="completed" || !match.ends_at || new Date(match.ends_at).getTime()>Date.now()) blockers.push("match_not_expired");
    if (roster.length!==match.max_players) blockers.push("incomplete_roster");
    if (!match.started_at || !match.ends_at) blockers.push("match_boundaries_missing");
    const snapshots = await DB.prepare("SELECT wallet,phase,observed_at,sol_balance,token_balances_json FROM td_match_valuations WHERE match_id=? AND phase IN ('start','end')")
      .bind(match.id).all<{wallet:string;phase:string;observed_at:number;sol_balance:number;token_balances_json:string}>();
    const poolCache = new Map<string, GeckoPoolChoice | null>();
    let quoteLookups=0;
    for (const snapshot of snapshots.results??[]) {
      let tokenBalances:Array<{mint:string;amount:number}>=[];
      try { tokenBalances=JSON.parse(snapshot.token_balances_json) as Array<{mint:string;amount:number}>; } catch { blockers.push("invalid_snapshot_token_balances:"+snapshot.wallet+":"+snapshot.phase); }
      const mints=[...new Set(["So11111111111111111111111111111111111111112",...tokenBalances.filter(t=>t.amount>0&&typeof t.mint==="string").map(t=>t.mint)])];
      for(const mint of mints) {
        const existing=await DB.prepare("SELECT accepted,attempts FROM td_match_historical_price_evidence WHERE match_id=? AND wallet=? AND phase=? AND mint=?")
          .bind(match.id,snapshot.wallet,snapshot.phase,mint).first<{accepted:number;attempts:number}>();
        if(existing?.accepted || (existing&&existing.attempts>=3) || quoteLookups>=4) continue;
        quoteLookups++;
        const quote=await fetchHistoricalTokenPrice(mint,snapshot.observed_at,poolCache);
        await DB.prepare("INSERT INTO td_match_historical_price_evidence (match_id,wallet,phase,mint,target_at,candle_at,price_usd,liquidity_usd,pool_address,source,accepted,attempts,reason) VALUES (?,?,?,?,?,?,?,?,?,'geckoterminal_ohlcv',?,?,?) ON CONFLICT(match_id,wallet,phase,mint) DO UPDATE SET target_at=excluded.target_at,candle_at=excluded.candle_at,price_usd=excluded.price_usd,liquidity_usd=excluded.liquidity_usd,pool_address=excluded.pool_address,source=excluded.source,accepted=excluded.accepted,attempts=td_match_historical_price_evidence.attempts+1,reason=excluded.reason")
          .bind(match.id,snapshot.wallet,snapshot.phase,mint,snapshot.observed_at,quote.candleAt,quote.priceUsd,quote.liquidityUsd,quote.poolAddress,quote.priceUsd!==null?1:0,(existing?.attempts??0)+1,quote.reason).run();
      }
      const evidence=await DB.prepare("SELECT mint,price_usd,accepted FROM td_match_historical_price_evidence WHERE match_id=? AND wallet=? AND phase=?")
        .bind(match.id,snapshot.wallet,snapshot.phase).all<{mint:string;price_usd:number|null;accepted:number}>();
      const prices=new Map((evidence.results??[]).filter(e=>e.accepted&&e.price_usd!==null&&Number.isFinite(e.price_usd)&&e.price_usd>0).map(e=>[e.mint,e.price_usd!]));
      const solMint="So11111111111111111111111111111111111111112";
      const unpriced=tokenBalances.filter(t=>t.amount>0&&!prices.has(t.mint)).length+(prices.has(solMint)?0:1);
      const complete=unpriced===0&&tokenBalances.length<=29&&Number.isFinite(snapshot.sol_balance)&&snapshot.sol_balance>=0;
      const value=complete?snapshot.sol_balance*prices.get(solMint)!+tokenBalances.filter(t=>t.amount>0).reduce((sum,t)=>sum+t.amount*prices.get(t.mint)!,0):null;
      const note=complete?"Historical candle revaluation of captured portfolio; not execution-fill PnL.":"Historical pricing incomplete or snapshot coverage cap exceeded.";
      await DB.prepare("INSERT INTO td_match_historical_valuations (match_id,wallet,phase,observed_at,portfolio_usd,priced_mints,unpriced_mints,complete,integrity_note,updated_at) VALUES (?,?,?,?,?,?,?,?,?,datetime('now')) ON CONFLICT(match_id,wallet,phase) DO UPDATE SET observed_at=excluded.observed_at,portfolio_usd=excluded.portfolio_usd,priced_mints=excluded.priced_mints,unpriced_mints=excluded.unpriced_mints,complete=excluded.complete,integrity_note=excluded.integrity_note,updated_at=datetime('now')")
        .bind(match.id,snapshot.wallet,snapshot.phase,snapshot.observed_at,value,prices.size,unpriced,complete?1:0,note).run();
    }
    const hist=await DB.prepare("SELECT wallet,phase,observed_at,portfolio_usd,complete,unpriced_mints FROM td_match_historical_valuations WHERE match_id=?").bind(match.id)
      .all<{wallet:string;phase:string;observed_at:number;portfolio_usd:number|null;complete:number;unpriced_mints:number}>();
    const rows=hist.results??[];
    const returns:Array<{wallet:string;team:number;startUsd:number|null;endUsd:number|null;returnPct:number|null}>=[];
    for(const member of roster) {
      const start=rows.find(r=>r.wallet===member.wallet&&r.phase==="start");
      const end=rows.find(r=>r.wallet===member.wallet&&r.phase==="end");
      for(const [phase,row] of [["start",start],["end",end]] as const) {
        if(!row||!row.complete||row.portfolio_usd===null) blockers.push("missing_or_incomplete_snapshot:"+member.wallet+":"+phase);
        const boundary=phase==="start"?match.started_at:match.ends_at;
        if(row&&boundary&&Math.abs(row.observed_at-Math.floor(new Date(boundary).getTime()/1000))>120) blockers.push("snapshot_outside_120_second_boundary:"+member.wallet+":"+phase);
      }
      const pct=start?.complete&&end?.complete&&start.portfolio_usd!==null&&end.portfolio_usd!==null&&start.portfolio_usd>0?((end.portfolio_usd-start.portfolio_usd)/start.portfolio_usd)*100:null;
      returns.push({wallet:member.wallet,team:member.team_number,startUsd:start?.portfolio_usd??null,endUsd:end?.portfolio_usd??null,returnPct:pct});
      const index=await DB.prepare("SELECT exhausted FROM td_match_index_state WHERE match_id=? AND wallet=?").bind(match.id,member.wallet).first<{exhausted:number}>();
      if(!index||index.exhausted!==1) blockers.push("transaction_history_not_fully_indexed:"+member.wallet);
    }
    const failed=await DB.prepare("SELECT COUNT(*) AS count FROM td_match_accounting_ledger WHERE match_id=? AND success=0").bind(match.id).first<{count:number}>();
    if((failed?.count??0)>0) blockers.push("failed_transactions_in_match_window");
    const ambiguous=await DB.prepare("SELECT COUNT(*) AS count FROM td_match_events WHERE match_id=? AND success=1 AND event_type IN ('token_activity','sol_activity','pump_fun_instruction_unclassified')").bind(match.id).first<{count:number}>();
    if((ambiguous?.count??0)>0) blockers.push("unclassified_wallet_activity");
    const flows=await DB.prepare("SELECT classification,COUNT(*) AS count FROM td_match_instruction_evidence WHERE match_id=? AND classification IN ('external_sol_inflow_candidate','external_sol_outflow_candidate','external_token_inflow_candidate','external_token_outflow_candidate') GROUP BY classification").bind(match.id).all<{classification:string;count:number}>();
    for(const flow of flows.results??[]) if(flow.count>0) blockers.push("external_flow_requires_reconciliation:"+flow.classification);
    const lifecycle=await DB.prepare("SELECT COUNT(*) AS count FROM td_match_instruction_evidence WHERE match_id=? AND classification='token_account_lifecycle'").bind(match.id).first<{count:number}>();
    if((lifecycle?.count??0)>0) blockers.push("token_account_rent_or_lifecycle_effects_unresolved");
    const prices=await DB.prepare("SELECT COUNT(*) AS total,SUM(CASE WHEN accepted=0 THEN 1 ELSE 0 END) AS rejected FROM td_match_historical_price_evidence WHERE match_id=?").bind(match.id).first<{total:number;rejected:number|null}>();
    if(!prices?.total) blockers.push("historical_price_source_provenance_missing");
    if((prices?.rejected??0)>0) blockers.push("one_or_more_historical_price_quotes_failed_quality_checks");
    const teamScore=(team:number)=>{const values=returns.filter(r=>r.team===team);return values.length>0&&values.every(r=>r.returnPct!==null)?values.reduce((sum,r)=>sum+(r.returnPct??0),0)/values.length:null;};
    const teamOne=teamScore(1),teamTwo=teamScore(2);
    const status=blockers.length?"review_required":"verified";
    const unique=[...new Set(blockers)];
    const txCount=await DB.prepare("SELECT COUNT(*) AS count FROM td_match_accounting_ledger WHERE match_id=?").bind(match.id).first<{count:number}>();
    await DB.prepare("INSERT INTO td_custom_match_settlements (match_id,status,team_one_return_pct,team_two_return_pct,member_returns_json,blockers_json,indexed_transactions,updated_at) VALUES (?,?,?,?,?,?,?,datetime('now')) ON CONFLICT(match_id) DO UPDATE SET status=excluded.status,team_one_return_pct=excluded.team_one_return_pct,team_two_return_pct=excluded.team_two_return_pct,member_returns_json=excluded.member_returns_json,blockers_json=excluded.blockers_json,indexed_transactions=excluded.indexed_transactions,updated_at=datetime('now')")
      .bind(match.id,status,teamOne,teamTwo,JSON.stringify(returns),JSON.stringify(unique),txCount?.count??0).run();

    // Official ELO is only awarded for verified Classic percentage 1v1 matches.
    // The conditional claim prevents repeated polling from awarding rating more than once.
    let eloApplied = false;
    if (status === "verified" && match.mode === "head_to_head_percentage" && roster.length === 2 && returns.length === 2 && returns.every(r => r.returnPct !== null)) {
      const claim = await DB.prepare("UPDATE td_custom_match_settlements SET elo_applied=1,updated_at=datetime('now') WHERE match_id=? AND status='verified' AND elo_applied=0").bind(match.id).run();
      if ((claim.meta?.changes ?? 0) === 1) {
        const [one,two] = returns;
        const [userOne,userTwo] = await Promise.all([
          DB.prepare("SELECT rating FROM td_users WHERE wallet=?").bind(one.wallet).first<{rating:number}>(),
          DB.prepare("SELECT rating FROM td_users WHERE wallet=?").bind(two.wallet).first<{rating:number}>(),
        ]);
        const ratingOne = userOne?.rating ?? 1000;
        const ratingTwo = userTwo?.rating ?? 1000;
        const expectedOne = 1 / (1 + Math.pow(10, (ratingTwo-ratingOne)/400));
        const expectedTwo = 1 - expectedOne;
        const scoreOne = Math.abs((one.returnPct ?? 0) - (two.returnPct ?? 0)) < 1e-8 ? 0.5 : (one.returnPct! > two.returnPct! ? 1 : 0);
        const scoreTwo = 1 - scoreOne;
        const nextOne = Math.max(0, Math.round(ratingOne + 32 * (scoreOne-expectedOne)));
        const nextTwo = Math.max(0, Math.round(ratingTwo + 32 * (scoreTwo-expectedTwo)));
        const draw = scoreOne === 0.5;
        await DB.batch([
          DB.prepare("UPDATE td_users SET rating=?,wins=wins+?,losses=losses+?,draws=draws+? WHERE wallet=?").bind(nextOne,scoreOne===1?1:0,scoreOne===0?1:0,draw?1:0,one.wallet),
          DB.prepare("UPDATE td_users SET rating=?,wins=wins+?,losses=losses+?,draws=draws+? WHERE wallet=?").bind(nextTwo,scoreTwo===1?1:0,scoreTwo===0?1:0,draw?1:0,two.wallet),
        ]);
        eloApplied = true;
      } else {
        const existing = await DB.prepare("SELECT elo_applied FROM td_custom_match_settlements WHERE match_id=?").bind(match.id).first<{elo_applied:number}>();
        eloApplied = existing?.elo_applied === 1;
      }
    }
    return {matchId:match.id,status,teamOneReturnPct:teamOne,teamTwoReturnPct:teamTwo,members:returns,blockers:unique,priceLookupsThisRun:quoteLookups,indexedTransactions:txCount?.count??0,eloApplied,message:status==="verified"?(eloApplied?"Classic percentage result verified; ELO updated exactly once.":"All team members passed the configured historical portfolio reconciliation checks."):"Team scores remain unverified until all historical prices, snapshots, transaction history, transfers, and lifecycle effects are reconciled."};
  });

/** Returns chat messages only to a verified participant in this match. */
export const getMatchChatMessages = createServerFn({ method: "GET" })
  .validator(z.object({ token: z.string().min(24), matchId: z.string().uuid(), afterId: z.number().int().min(0).optional() }))
  .handler(async ({ data }) => {
    const { DB, wallet } = await requireSession(data.token);
    const match = await DB.prepare("SELECT id,player_one,player_two,status FROM td_matches WHERE id = ?").bind(data.matchId).first<{id:string;player_one:string;player_two:string|null;status:string}>();
    if (!match || !match.player_two) throw new Error("Chat is unavailable until both players have joined this match.");
    const rows = await DB.prepare("SELECT id,wallet,message,created_at FROM td_match_chat_messages WHERE match_id = ? AND id > ? ORDER BY id ASC LIMIT 100").bind(match.id, data.afterId ?? 0).all<{id:number;wallet:string;message:string;created_at:string}>();
    return { messages: rows.results ?? [], matchStatus: match.status };
  });

/** Inserts a plain-text chat message for an authenticated match participant. */
export const sendMatchChatMessage = createServerFn({ method: "POST" })
  .validator(z.object({ token: z.string().min(24), matchId: z.string().uuid(), message: z.string().trim().min(1).max(500) }))
  .handler(async ({ data }) => {
    const { DB, wallet } = await requireSession(data.token);
    const message = data.message.trim();
    if (!message) throw new Error("Enter a message before sending.");
    const match = await DB.prepare("SELECT id,player_one,player_two,status FROM td_matches WHERE id = ?").bind(data.matchId).first<{id:string;player_one:string;player_two:string|null;status:string}>();
    if (!match || !match.player_two) throw new Error("Chat is unavailable until both players have joined this match.");
    if (match.status === "completed" || match.status === "cancelled") throw new Error("Chat is closed because this match has ended.");
    await DB.prepare("INSERT INTO td_match_chat_messages (match_id,wallet,message) VALUES (?,?,?)").bind(match.id, wallet, message).run();
    const row = await DB.prepare("SELECT id,wallet,message,created_at FROM td_match_chat_messages WHERE match_id = ? AND wallet = ? ORDER BY id DESC LIMIT 1").bind(match.id, wallet).first<{id:number;wallet:string;message:string;created_at:string}>();
    return { message: row };
  });


const customMatchMode = z.enum(["head_to_head_percentage"]);
const customMatchVisibility = z.enum(["public", "private"]);

/** Public/private room browser. Private room passwords are never returned to clients. */
export const listCustomMatches = createServerFn({ method: "GET" }).handler(async () => {
  const { DB } = bindings();
  if (!DB) return { matches: [] };
  // Close abandoned open rooms so old records do not remain in the public browser.
  // Rooms stay joinable for 30 minutes; the match duration begins only after the room fills.
  await DB.prepare("UPDATE td_custom_matches SET status='completed',finished_at=datetime('now') WHERE status='open' AND datetime(created_at) < datetime('now','-30 minutes')").run();
  const rows = await DB.prepare(`
    SELECT m.id,m.creator_wallet,m.mode,m.visibility,m.max_players,m.duration_seconds,m.status,m.created_at,
      COUNT(mm.id) AS players_count
    FROM td_custom_matches m
    LEFT JOIN td_custom_match_members mm ON mm.match_id = m.id
    WHERE m.status = 'open'
      AND m.visibility = 'public'
      AND datetime(m.created_at) >= datetime('now','-30 minutes')
    GROUP BY m.id
    HAVING COUNT(mm.id) < m.max_players
    ORDER BY m.created_at DESC
    LIMIT 100
  `).all<{id:string;creator_wallet:string;mode:string;visibility:string;max_players:number;duration_seconds:number;status:string;created_at:string;players_count:number}>();
  return { matches: rows.results ?? [] };
});

export const getCustomMatchStatus = createServerFn({ method: "POST" })
  .validator(z.object({ token: z.string().min(24), matchId: z.string().uuid() }))
  .handler(async ({ data }) => {
    const { DB, wallet } = await requireSession(data.token);
    const match = await DB.prepare(
      "SELECT id,status,started_at,ends_at,mode,max_players,duration_seconds FROM td_custom_matches WHERE id=?"
    ).bind(data.matchId).first<{
      id: string; status: string; started_at: string | null; ends_at: string | null;
      mode: string; max_players: number; duration_seconds: number;
    }>();
    if (!match) throw new Error("This match does not exist.");
    const member = await DB.prepare(
      "SELECT team_number FROM td_custom_match_members WHERE match_id=? AND wallet=?"
    ).bind(match.id, wallet).first<{ team_number: number }>();
    if (!member) throw new Error("Join this match before viewing its status.");
    const members = await DB.prepare(
      "SELECT wallet,team_number FROM td_custom_match_members WHERE match_id=? ORDER BY team_number,id"
    ).bind(match.id).all<{ wallet: string; team_number: number }>();
    let currentStatus = match.status;
    let startedAt = match.started_at;
    let endsAt = match.ends_at;
    const currentMembers = members.results ?? [];

    // Self-heal a full room whose final join request was interrupted before
    // persisting the active state. This check is independent of Solana RPC.
    if (currentStatus === "open" && currentMembers.length >= match.max_players) {
      const now = new Date();
      const candidateStartedAt = now.toISOString();
      const candidateEndsAt = new Date(now.getTime() + match.duration_seconds * 1000).toISOString();
      await DB.prepare(
        "UPDATE td_custom_matches SET status='active',started_at=COALESCE(started_at,?),ends_at=COALESCE(ends_at,?) WHERE id=? AND status='open'"
      ).bind(candidateStartedAt, candidateEndsAt, match.id).run();
      const refreshed = await DB.prepare(
        "SELECT status,started_at,ends_at FROM td_custom_matches WHERE id=?"
      ).bind(match.id).first<{status:string;started_at:string|null;ends_at:string|null}>();
      currentStatus = refreshed?.status ?? currentStatus;
      startedAt = refreshed?.started_at ?? startedAt;
      endsAt = refreshed?.ends_at ?? endsAt;
    }

    return {
      customRoom: {
        status: currentStatus,
        startedAt,
        endsAt,
        durationSeconds: match.duration_seconds,
        mode: match.mode,
        maxPlayers: match.max_players,
        members: currentMembers,
      },
      team: member.team_number,
    };
  });

export const surrenderCustomMatch = createServerFn({ method: "POST" })
  .validator(z.object({ token: z.string().min(24), matchId: z.string().uuid() }))
  .handler(async ({ data }) => {
    const { DB, wallet } = await requireSession(data.token);
    const member = await DB.prepare("SELECT team_number FROM td_custom_match_members WHERE match_id=? AND wallet=?")
      .bind(data.matchId, wallet).first<{team_number:number}>();
    if (!member) throw new Error("You must be in this match to surrender.");
    const room = await DB.prepare("SELECT status,mode FROM td_custom_matches WHERE id=?")
      .bind(data.matchId).first<{status:string;mode:string}>();
    if (!room) throw new Error("Match not found.");
    if (room.status !== "active") throw new Error("Only an active match can be surrendered.");
    await DB.prepare("UPDATE td_custom_matches SET status='completed',ends_at=COALESCE(ends_at,datetime('now')) WHERE id=? AND status='active'")
      .bind(data.matchId).run();
    return { ok: true, status: "completed", surrenderedBy: wallet };
  });

export const createCustomMatch = createServerFn({ method: "POST" })
  .validator(z.object({
    token: z.string().min(24),
    mode: customMatchMode,
    visibility: customMatchVisibility,
    maxPlayers: z.number().int().refine((n) => [2,4,6,8].includes(n)),
    durationSeconds: z.number().int().min(900).max(86400),
    password: z.string().max(80).optional(),
  }))
  .handler(async ({ data }) => {
    const { DB, wallet } = await requireSession(data.token);
    if (data.mode !== "head_to_head_percentage" || data.maxPlayers !== 2) {
      throw new Error("TradeDuel currently supports Classic percentage 1v1 only.");
    }
    const password = data.password?.trim() ?? "";
    if (data.visibility === "private" && password.length < 4) throw new Error("Private matches need a password of at least 4 characters.");
    if (data.visibility === "public" && password) throw new Error("Public matches do not use passwords.");
    const id = crypto.randomUUID();
    const passwordHash = data.visibility === "private" ? await hash(password) : null;
    const team = data.mode === "head_to_head" ? 1 : 1;
    await DB.batch([
      DB.prepare("INSERT INTO td_custom_matches (id,creator_wallet,mode,visibility,max_players,duration_seconds,password_hash,status) VALUES (?,?,?,?,?,?,?,'open')")
        .bind(id,wallet,data.mode,data.visibility,data.maxPlayers,data.durationSeconds,passwordHash),
      DB.prepare("INSERT INTO td_custom_match_members (match_id,wallet,team_number) VALUES (?,?,?)").bind(id,wallet,team),
    ]);
    return { matchId:id, message: data.visibility === "private" ? "Private match created. Share the room ID and password with your friends." : "Public match created and listed in the match browser." };
  });

export const joinCustomMatch = createServerFn({ method: "POST" })
  .validator(z.object({ token:z.string().min(24), matchId:z.string().uuid(), password:z.string().max(80).optional() }))
  .handler(async ({ data }) => {
    const { DB, wallet } = await requireSession(data.token);
    const match = await DB.prepare("SELECT id,creator_wallet,mode,visibility,max_players,duration_seconds,password_hash,status FROM td_custom_matches WHERE id=?").bind(data.matchId)
      .first<{id:string;creator_wallet:string;mode:string;visibility:string;max_players:number;duration_seconds:number;password_hash:string|null;status:string}>();
    if (!match) throw new Error("This match does not exist.");
    const existing = await DB.prepare("SELECT team_number FROM td_custom_match_members WHERE match_id=? AND wallet=?").bind(match.id,wallet).first<{team_number:number}>();
    if (existing) return { matchId:match.id, team:existing.team_number, mode:match.mode, visibility:match.visibility, maxPlayers:match.max_players, durationSeconds:match.duration_seconds, status:match.status, message:"Already a member of this match." };
    if (match.mode !== "head_to_head_percentage" || match.max_players !== 2) throw new Error("Only Classic percentage 1v1 matches are currently available.");
    if (match.status !== "open") throw new Error("This match is no longer open for new players.");
    if (match.visibility === "private") {
      const provided = data.password?.trim() ?? "";
      if (!provided || !match.password_hash || await hash(provided) !== match.password_hash) throw new Error("Incorrect private match password.");
    }
    const counts = await DB.prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN team_number=1 THEN 1 ELSE 0 END) AS team_one FROM td_custom_match_members WHERE match_id=?").bind(match.id).first<{total:number;team_one:number|null}>();
    if ((counts?.total ?? 0) >= match.max_players) throw new Error("This match is full.");
    const teamSize = (match.mode === "head_to_head" || match.mode === "head_to_head_percentage") ? 1 : match.max_players / 2;
    const team = (counts?.team_one ?? 0) < teamSize ? 1 : 2;
    await DB.prepare("INSERT INTO td_custom_match_members (match_id,wallet,team_number) VALUES (?,?,?)").bind(match.id,wallet,team).run();
    const after = await DB.prepare("SELECT COUNT(*) AS total FROM td_custom_match_members WHERE match_id=?").bind(match.id).first<{total:number}>();
    if ((after?.total ?? 0) >= match.max_players) {
      const now = new Date();
      const startedAt = now.toISOString();
      const endsAt = new Date(now.getTime() + match.duration_seconds * 1000).toISOString();
      await DB.prepare("UPDATE td_custom_matches SET status='active',started_at=?,ends_at=? WHERE id=? AND status='open'")
        .bind(startedAt, endsAt, match.id).run();
    }
    const current = await DB.prepare("SELECT status FROM td_custom_matches WHERE id=?")
      .bind(match.id).first<{ status: string }>();
    return {
      matchId: match.id, team, mode: match.mode, visibility: match.visibility,
      maxPlayers: match.max_players, durationSeconds: match.duration_seconds,
      status: current?.status ?? match.status,
      message: (current?.status ?? match.status) === "active"
        ? "Lobby is full. The match has started."
        : team === 1 ? "Joined Team 1. Waiting for more players." : "Joined Team 2. Waiting for more players.",
    };
  });

export const getCustomMatchChat = createServerFn({ method: "GET" })
  .validator(z.object({ token:z.string().min(24), matchId:z.string().uuid(), channel:z.enum(["all","team"]), afterId:z.number().int().min(0).optional() }))
  .handler(async ({ data }) => {
    const { DB, wallet } = await requireSession(data.token);
    const member = await DB.prepare("SELECT team_number FROM td_custom_match_members WHERE match_id=? AND wallet=?").bind(data.matchId,wallet).first<{team_number:number}>();
    if (!member) throw new Error("Join this match before viewing its chat.");
    const rows = await DB.prepare(`
      SELECT c.id,c.wallet,c.channel,c.message,c.created_at,m.team_number
      FROM td_custom_match_chat c JOIN td_custom_match_members m ON m.match_id=c.match_id AND m.wallet=c.wallet
      WHERE c.match_id=? AND c.channel=? AND c.id>?
        AND (?='all' OR m.team_number=?)
      ORDER BY c.id ASC LIMIT 100
    `).bind(data.matchId,data.channel,data.afterId??0,data.channel,member.team_number).all<{id:number;wallet:string;channel:string;message:string;created_at:string;team_number:number}>();
    return { messages:rows.results??[], team:member.team_number };
  });

export const sendCustomMatchChat = createServerFn({ method: "POST" })
  .validator(z.object({ token:z.string().min(24), matchId:z.string().uuid(), channel:z.enum(["all","team"]), message:z.string().trim().min(1).max(500) }))
  .handler(async ({ data }) => {
    const { DB, wallet } = await requireSession(data.token);
    const member = await DB.prepare("SELECT team_number FROM td_custom_match_members WHERE match_id=? AND wallet=?").bind(data.matchId,wallet).first<{team_number:number}>();
    if (!member) throw new Error("Join this match before sending chat messages.");
    const match = await DB.prepare("SELECT status FROM td_custom_matches WHERE id=?").bind(data.matchId).first<{status:string}>();
    if (!match || match.status === "completed" || match.status === "cancelled") throw new Error("This match chat is closed.");
    await DB.prepare("INSERT INTO td_custom_match_chat (match_id,wallet,channel,message) VALUES (?,?,?,?)").bind(data.matchId,wallet,data.channel,data.message.trim()).run();
    const row = await DB.prepare("SELECT id,wallet,channel,message,created_at FROM td_custom_match_chat WHERE match_id=? AND wallet=? ORDER BY id DESC LIMIT 1").bind(data.matchId,wallet).first<{id:number;wallet:string;channel:string;message:string;created_at:string}>();
    return { message:row, team:member.team_number };
  });


/** Wallet profile API. Avatar data is resized client-side and bounded server-side. */
export const getMyProfile = createServerFn({ method: "GET" })
  .validator(z.object({ token: z.string().min(24) }))
  .handler(async ({ data }) => {
    const { DB, wallet } = await requireSession(data.token);
    const row = await DB.prepare("SELECT wallet,display_name,avatar_data_url FROM td_users WHERE wallet=?")
      .bind(wallet).first<{wallet:string;display_name:string|null;avatar_data_url:string|null}>();
    return { wallet, displayName: row?.display_name ?? "", avatarDataUrl: row?.avatar_data_url ?? null };
  });

export const updateMyProfile = createServerFn({ method: "POST" })
  .validator(z.object({
    token: z.string().min(24),
    displayName: z.string().trim().max(24).optional(),
    avatarDataUrl: z.string().max(180_000).nullable().optional(),
  }))
  .handler(async ({ data }) => {
    const { DB, wallet } = await requireSession(data.token);
    const displayName = (data.displayName ?? "").trim();
    if (displayName && !/^[\p{L}\p{N}_ .-]{2,24}$/u.test(displayName)) {
      throw new Error("Display names must be 2–24 letters, numbers, spaces, dots, underscores, or hyphens.");
    }
    if (data.avatarDataUrl !== undefined && data.avatarDataUrl !== null) {
      if (!/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(data.avatarDataUrl) || data.avatarDataUrl.length > 180_000) {
        throw new Error("Avatar must be a PNG, JPEG, or WebP image under the size limit.");
      }
    }
    await DB.prepare("INSERT INTO td_users (wallet,display_name,avatar_data_url,last_seen_at) VALUES (?,?,?,datetime('now')) ON CONFLICT(wallet) DO UPDATE SET display_name=excluded.display_name,avatar_data_url=COALESCE(?,td_users.avatar_data_url),last_seen_at=datetime('now')")
      .bind(wallet, displayName || null, data.avatarDataUrl ?? null, data.avatarDataUrl === undefined ? null : data.avatarDataUrl).run();
    const row = await DB.prepare("SELECT wallet,display_name,avatar_data_url FROM td_users WHERE wallet=?")
      .bind(wallet).first<{wallet:string;display_name:string|null;avatar_data_url:string|null}>();
    return { wallet, displayName: row?.display_name ?? "", avatarDataUrl: row?.avatar_data_url ?? null, message: "Profile saved." };
  });
