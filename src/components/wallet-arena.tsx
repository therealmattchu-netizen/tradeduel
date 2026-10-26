import { useCallback, useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { createWalletChallenge, getMyMatches, getQueueStatus, joinMatchmakingQueue, leaveMatchmakingQueue, verifyWalletChallenge } from "@/lib/api/arena.functions";

type PhantomProvider = {
  isPhantom?: boolean;
  publicKey?: { toString(): string };
  connect: (options?: { onlyIfTrusted?: boolean }) => Promise<{ publicKey: { toString(): string } }>;
  disconnect: () => Promise<void>;
  signMessage: (message: Uint8Array, display?: "utf8") => Promise<{ signature: Uint8Array } | Uint8Array>;
  on?: (event: string, callback: (...args: unknown[]) => void) => void;
  off?: (event: string, callback: (...args: unknown[]) => void) => void;
};
declare global { interface Window { solana?: PhantomProvider; phantom?: { solana?: PhantomProvider } } }
const TOKEN_KEY = "td_session_token";
const WALLET_KEY = "td_session_wallet";
function shortWallet(wallet: string) { return `${wallet.slice(0, 4)}…${wallet.slice(-4)}`; }
function toBase64(bytes: Uint8Array) { let binary = ""; for (const b of bytes) binary += String.fromCharCode(b); return btoa(binary); }

type ArenaMatch = { id: string; player_one: string; player_two: string | null; status: string; format: string; started_at: string | null; ends_at: string | null; verification_status: string };

export function WalletArena() {
  const [wallet, setWallet] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [queueStatus, setQueueStatus] = useState<"idle" | "waiting" | "matched">("idle");
  const [gameMode, setGameMode] = useState<"standard" | "one_position" | "exposure_cap" | "equal_start">("standard");
  const [duration, setDuration] = useState(900);
  const [notice, setNotice] = useState("Connect your wallet to enter the matchmaking queue.");
  const [matches, setMatches] = useState<ArenaMatch[]>([]);
  const [isPhantomInstalled, setIsPhantomInstalled] = useState<boolean | null>(null);

  useEffect(() => {
    setIsPhantomInstalled(Boolean(window.phantom?.solana?.isPhantom || window.solana?.isPhantom));
    const savedToken = window.sessionStorage.getItem(TOKEN_KEY) || "";
    const savedWallet = window.sessionStorage.getItem(WALLET_KEY) || "";
    if (savedToken && savedWallet) { setToken(savedToken); setWallet(savedWallet); setNotice("Wallet session restored in this tab."); }
  }, []);

  const loadMatches = useCallback(async (sessionToken: string) => {
    try { const result = await getMyMatches({ data: { token: sessionToken } }); setMatches(result.matches as ArenaMatch[]); }
    catch { /* session may have expired; keep the page usable */ }
  }, []);
  useEffect(() => {
    if (!token) return;
    let alive = true;
    void loadMatches(token);
    // Restore the server-side queue state when a saved wallet session returns,
    // including after a page refresh. The queue row may still be waiting/matched
    // even though the component's local state has reset to idle.
    void getQueueStatus({ data: { token } }).then((result) => {
      if (!alive) return;
      setQueueStatus(result.status);
      if (result.status === "waiting") setNotice("You're still in the matchmaking queue.");
      else if (result.status === "matched") setNotice("Opponent found. This alpha match does not score trading performance or change ELO.");
    }).catch(() => { /* expired sessions are handled when the user takes an action */ });
    return () => { alive = false; };
  }, [token, loadMatches]);
  useEffect(() => {
    if (!token || queueStatus !== "waiting") return;
    let alive = true;
    const poll = async () => { try { const result = await getQueueStatus({ data: { token } }); if (!alive) return; setQueueStatus(result.status); if (result.status === "matched") { setNotice("Opponent found. This alpha match does not score trading performance or change ELO."); await loadMatches(token); } } catch { /* retry on next poll */ } };
    void poll(); const interval = window.setInterval(() => void poll(), 5000);
    return () => { alive = false; window.clearInterval(interval); };
  }, [token, queueStatus, loadMatches]);

  const connect = async () => {
    setBusy(true); setNotice("Waiting for wallet approval…");
    try {
      const provider = window.phantom?.solana ?? window.solana;
      if (!provider?.isPhantom) { window.open("https://phantom.app/", "_blank", "noopener,noreferrer"); throw new Error("Install the official Phantom wallet extension, then reload this page."); }
      const connected = await provider.connect();
      const publicKey = connected.publicKey.toString();
      const challenge = await createWalletChallenge({ data: { wallet: publicKey } });
      const signed = await provider.signMessage(new TextEncoder().encode(challenge.message), "utf8");
      const signature = signed instanceof Uint8Array ? signed : signed.signature;
      const verified = await verifyWalletChallenge({ data: { wallet: publicKey, nonce: challenge.nonce, signature: toBase64(signature) } });
      window.sessionStorage.setItem(TOKEN_KEY, verified.token); window.sessionStorage.setItem(WALLET_KEY, verified.wallet);
      setToken(verified.token); setWallet(verified.wallet); setNotice("Wallet ownership verified. No transaction was sent.");
    } catch (e) { setNotice(e instanceof Error ? e.message : "Wallet connection failed. Try again."); }
    finally { setBusy(false); }
  };

  const disconnect = async () => {
    try { await (window.phantom?.solana ?? window.solana)?.disconnect(); } catch { /* local session still clears */ }
    window.sessionStorage.removeItem(TOKEN_KEY); window.sessionStorage.removeItem(WALLET_KEY);
    setWallet(""); setToken(""); setQueueStatus("idle"); setMatches([]); setNotice("Disconnected. Your wallet remains under your control.");
  };

  const joinQueue = async () => {
    if (!token) { await connect(); return; }
    setBusy(true); setNotice("Joining matchmaking queue…");
    try { const result = await joinMatchmakingQueue({ data: { token, format: gameMode, durationSeconds: duration } }); setQueueStatus(result.status === "matched" ? "matched" : "waiting"); setNotice(result.message); await loadMatches(token); }
    catch (e) { setNotice(e instanceof Error ? e.message : "Could not join the queue."); }
    finally { setBusy(false); }
  };
  const leaveQueue = async () => {
    if (!token) return;
    setBusy(true);
    try { await leaveMatchmakingQueue({ data: { token } }); setQueueStatus("idle"); setNotice("You left the matchmaking queue."); }
    catch (e) { setNotice(e instanceof Error ? e.message : "Could not leave the queue."); }
    finally { setBusy(false); }
  };

  return <div className="td-wallet-arena">
    <div className="td-wallet-topline"><span className="td-mini-label">WALLET AUTHENTICATION</span><span className={`td-wallet-state ${wallet ? "is-connected" : ""}`}><i/>{wallet ? "VERIFIED SESSION" : "NOT CONNECTED"}</span></div>
    {wallet ? <div className="td-connected-wallet"><span className="td-player-icon"><img src="/brand-mark-exact.png" alt=""/></span><div><span className="td-mini-label">CONNECTED PHANTOM WALLET</span><strong>{shortWallet(wallet)}</strong><small>Signed ownership verified · no transaction sent</small></div><button className="td-text-button" onClick={disconnect} disabled={busy}>Disconnect</button></div> : <div className="td-wallet-connect-copy"><h3>Bring your wallet.</h3><p>Sign a one-time message to prove ownership. TradeDuel never asks for your seed phrase or private key.</p><button className="td-primary-action" onClick={connect} disabled={busy}>{busy ? "Please wait…" : "Connect Phantom wallet ↗"}</button>{isPhantomInstalled === false && <small>Phantom not detected. The official wallet download will open in a new tab.</small>}</div>}
    {!wallet && <div className="td-pump-wallet-help"><span className="td-mini-label">USING A PUMP.FUN WALLET?</span><p>You can track its public address now, but to enter matchmaking you must prove you control it. If your Pump.fun wallet supports private-key export, you can import it into Phantom on your own device, then connect that same address here.</p><div className="td-pump-wallet-links"><a href="https://help.phantom.com/articles/import-your-privy-fomo-pump-fun-wallet-into-phantom-41408635409683" target="_blank" rel="noreferrer">Official Phantom import guide ↗</a><Link to="/tracker">Track a public address ↗</Link></div><small>Never paste your private key or recovery phrase into TradeDuel or share it with anyone. Check that the address shown in Phantom exactly matches your Pump.fun trading wallet.</small></div>}
    {wallet && <div className="td-queue-setup"><div className="td-config-field"><label htmlFor="td-game-mode">GAME MODE</label><select id="td-game-mode" value={gameMode} onChange={e=>setGameMode(e.target.value as typeof gameMode)} disabled={busy||queueStatus!=="idle"}><option value="standard">Standard</option><option value="one_position">One Position</option><option value="exposure_cap">Exposure Cap</option><option value="equal_start">Equal Start</option></select><small>{gameMode === "standard" ? "Standard head-to-head format. Trading performance and ELO are not scored in this alpha." : gameMode === "one_position" ? "Proposed rule: only one open position per player. Enforcement is not live yet." : gameMode === "exposure_cap" ? "Proposed rule: apply the same maximum position exposure to both players. Enforcement is not live yet." : "Proposed rule: compare normalized returns from an equal starting allocation. Enforcement is not live yet."}</small></div><div className="td-config-field"><label htmlFor="td-duration">MATCH DURATION</label><select id="td-duration" value={duration} onChange={e=>setDuration(Number(e.target.value))} disabled={busy||queueStatus!=="idle"}><option value={900}>15 minutes</option><option value={1800}>30 minutes</option><option value={3600}>1 hour</option><option value={7200}>2 hours</option><option value={14400}>4 hours</option><option value={28800}>8 hours</option><option value={86400}>1 day</option></select><small>Timer begins when an opponent is paired. Longer durations are for matchmaking queue testing; verified trading results are not scored yet.</small></div></div>}
    {wallet && <div className="td-queue-controls"><div><span className="td-mini-label">MATCHMAKING QUEUE</span><p>Queue pairing is available for alpha testing. Mode rules and verified trade scoring are still in development.</p></div>{queueStatus === "waiting" ? <button className="td-secondary-action" onClick={leaveQueue} disabled={busy}>Leave queue</button> : <button className="td-primary-action" onClick={joinQueue} disabled={busy || queueStatus === "matched"}>{busy ? "Please wait…" : queueStatus === "matched" ? "Match found" : "Find an opponent"}</button>}</div>}
    <p className="td-wallet-notice" role="status">{notice}</p>
    {matches.length > 0 && <div className="td-my-matches"><span className="td-mini-label">YOUR MATCH HISTORY</span>{matches.map((match) => <div className="td-my-match" key={match.id}><span><strong>{shortWallet(match.player_one)}</strong> <em>vs</em> <strong>{match.player_two ? shortWallet(match.player_two) : "Waiting for opponent"}</strong></span><span className="td-status-pill">{match.status.toUpperCase()}</span><small>{match.verification_status === "verified" ? "Verified" : "Unverified alpha match · no ELO impact"}</small><Link className="td-match-open-link" to="/match/$matchId" params={{matchId:match.id}}>Open match ↗</Link></div>)}</div>}
  </div>;
}
