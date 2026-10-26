import { useCallback, useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { createWalletChallenge, getMyMatches, getQueueStatus, joinMatchmakingQueue, leaveMatchmakingQueue, verifyWalletChallenge } from "@/lib/api/arena.functions";

type StandardWallet = {
  name: string;
  icon?: string;
  features: Record<string, any>;
};
declare global {
  interface Window {
    __tdStandardWallets?: StandardWallet[];
  }
}
function discoverStandardWallets(): StandardWallet[] {
  if (typeof window === "undefined") return [];
  if (!window.__tdStandardWallets) {
    window.__tdStandardWallets = [];
    const register = (wallet: StandardWallet) => {
      if (wallet && !window.__tdStandardWallets!.some((item) => item.name === wallet.name)) {
        window.__tdStandardWallets!.push(wallet);
      }
    };
    window.addEventListener("wallet-standard:register-wallet", ((event: Event) => {
      const callback = (event as CustomEvent).detail;
      if (typeof callback === "function") callback(register);
    }) as EventListener);
    window.dispatchEvent(new CustomEvent("wallet-standard:app-ready", { detail: register }));
  }
  return window.__tdStandardWallets;
}
type SolanaWalletProvider = {
  isPhantom?: boolean;
  isSolflare?: boolean;
  isBackpack?: boolean;
  isGlow?: boolean;
  publicKey?: { toString(): string };
  connect: (options?: { onlyIfTrusted?: boolean }) => Promise<{ publicKey?: { toString(): string } } | void>;
  disconnect?: () => Promise<void>;
  signMessage: (message: Uint8Array, display?: "utf8") => Promise<{ signature: Uint8Array } | Uint8Array>;
};
declare global {
  interface Window {
    solana?: SolanaWalletProvider;
    phantom?: { solana?: SolanaWalletProvider };
    solflare?: SolanaWalletProvider;
    backpack?: { solana?: SolanaWalletProvider } | SolanaWalletProvider;
    glow?: SolanaWalletProvider;
  }
}
type WalletChoice = { name: string; provider?: SolanaWalletProvider; standardWallet?: StandardWallet };
function getWalletChoices(): WalletChoice[] {
  if (typeof window === "undefined") return [];
  const choices: WalletChoice[] = [];
  const candidates: Array<{ name: string; provider?: SolanaWalletProvider }> = [
    { name: "Phantom", provider: window.phantom?.solana ?? (window.solana?.isPhantom ? window.solana : undefined) },
    { name: "Solflare", provider: window.solflare ?? (window.solana?.isSolflare ? window.solana : undefined) },
    { name: "Backpack", provider: (window.backpack && "solana" in window.backpack ? window.backpack.solana : window.backpack as SolanaWalletProvider | undefined) ?? (window.solana?.isBackpack ? window.solana : undefined) },
    { name: "Glow", provider: window.glow ?? (window.solana?.isGlow ? window.solana : undefined) },
    { name: "Other Solana wallet", provider: window.solana },
  ];
  for (const candidate of candidates) {
    if (candidate.provider?.connect && candidate.provider?.signMessage && !choices.some((item) => item.name.toLowerCase() === candidate.name.toLowerCase())) choices.push({ name: candidate.name, provider: candidate.provider });
  }
  for (const wallet of discoverStandardWallets()) {
    if (wallet.features["standard:connect"] && wallet.features["solana:signMessage"] && !choices.some((item) => item.name.toLowerCase() === wallet.name.toLowerCase())) choices.push({ name: wallet.name, standardWallet: wallet });
  }
  return choices;
}
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
  const [walletProviderName, setWalletProviderName] = useState("");
  const [isWalletProviderAvailable, setIsWalletProviderAvailable] = useState<boolean | null>(null);
  const [walletPickerOpen, setWalletPickerOpen] = useState(false);
  const [walletChoices, setWalletChoices] = useState<WalletChoice[]>([]);

  useEffect(() => {
    const availableWallets = getWalletChoices();
    setWalletChoices(availableWallets);
    setIsWalletProviderAvailable(availableWallets.length > 0);
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

  const connectWallet = async (choice: WalletChoice) => {
    setWalletPickerOpen(false);
    setBusy(true); setNotice(`Waiting for ${choice.name} approval…`);
    try {
      let publicKey = "";
      let signature: Uint8Array | null = null;
      if (choice.provider) {
        const provider = choice.provider;
        const connected = await provider.connect();
        publicKey = (connected && "publicKey" in connected ? connected.publicKey : undefined)?.toString() ?? provider.publicKey?.toString() ?? "";
        if (!publicKey) throw new Error("The wallet did not return a public address. Disconnect and try again.");
        const challenge = await createWalletChallenge({ data: { wallet: publicKey } });
        const signed = await provider.signMessage(new TextEncoder().encode(challenge.message), "utf8");
        signature = signed instanceof Uint8Array ? signed : signed.signature;
        const verified = await verifyWalletChallenge({ data: { wallet: publicKey, nonce: challenge.nonce, signature: toBase64(signature) } });
        window.sessionStorage.setItem(TOKEN_KEY, verified.token); window.sessionStorage.setItem(WALLET_KEY, verified.wallet);
        setToken(verified.token); setWallet(verified.wallet); setWalletProviderName(choice.name); setNotice("Wallet ownership verified. No transaction was sent.");
        return;
      }
      const candidate = choice.standardWallet;
      const connectFeature = candidate?.features["standard:connect"];
      const signFeature = candidate?.features["solana:signMessage"];
      if (!candidate || !connectFeature?.connect || !signFeature?.signMessage) throw new Error("This wallet does not expose the required connection and message-signing features.");
      const connected = await connectFeature.connect();
      const account = connected?.accounts?.find((item: any) => item?.chains?.some((chain: string) => chain.startsWith("solana:"))) ?? connected?.accounts?.[0];
      if (!account?.address) throw new Error("The wallet did not return a Solana address.");
      publicKey = account.address;
      const challenge = await createWalletChallenge({ data: { wallet: publicKey } });
      const signedResults = await signFeature.signMessage({ account, message: new TextEncoder().encode(challenge.message) });
      signature = signedResults?.[0]?.signature;
      if (!signature) throw new Error("The selected wallet did not return a message signature.");
      const verified = await verifyWalletChallenge({ data: { wallet: publicKey, nonce: challenge.nonce, signature: toBase64(signature) } });
      window.sessionStorage.setItem(TOKEN_KEY, verified.token); window.sessionStorage.setItem(WALLET_KEY, verified.wallet);
      setToken(verified.token); setWallet(verified.wallet); setWalletProviderName(choice.name); setNotice("Wallet ownership verified. No transaction was sent.");
    } catch (e) { setNotice(e instanceof Error ? e.message : "Wallet connection failed. Try again."); }
    finally { setBusy(false); }
  };

  const disconnect = async () => {
    try { await getWalletProvider()?.provider.disconnect?.(); } catch { /* local session still clears */ }
    window.sessionStorage.removeItem(TOKEN_KEY); window.sessionStorage.removeItem(WALLET_KEY);
    setWallet(""); setToken(""); setWalletProviderName(""); setQueueStatus("idle"); setMatches([]); setNotice("Disconnected. Your wallet remains under your control.");
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
    {wallet ? <div className="td-connected-wallet"><span className="td-player-icon"><img src="/brand-mark-exact.png" alt=""/></span><div><span className="td-mini-label">CONNECTED {walletProviderName || "SOLANA"} WALLET</span><strong>{shortWallet(wallet)}</strong><small>Signed ownership verified · no transaction sent</small></div><button className="td-text-button" onClick={disconnect} disabled={busy}>Disconnect</button></div> : <div className="td-wallet-connect-copy"><h3>Bring your wallet.</h3><p>Connect a compatible Solana wallet and sign a one-time message. TradeDuel never asks for your seed phrase or private key.</p><button className="td-primary-action" onClick={() => { setWalletChoices(getWalletChoices()); setWalletPickerOpen(true); }} disabled={busy}>{busy ? "Please wait…" : "Choose a Solana wallet ↗"}</button>{isWalletProviderAvailable === false && <small>No compatible wallet detected yet. Choose a wallet below, install it, then reload this page.</small>}</div>}
    {!wallet && walletPickerOpen && <div role="dialog" aria-modal="true" aria-labelledby="td-wallet-picker-title" style={{ position: "fixed", inset: 0, zIndex: 1000, background: "rgba(5, 7, 15, 0.78)", display: "flex", alignItems: "center", justifyContent: "center", padding: "20px" }} onClick={(event) => { if (event.target === event.currentTarget) setWalletPickerOpen(false); }}>
      <div style={{ width: "100%", maxWidth: "420px", border: "1px solid rgba(167, 139, 250, 0.35)", borderRadius: "16px", padding: "22px", background: "#11101b", color: "#f7f5ff", boxShadow: "0 24px 80px rgba(0,0,0,0.45)" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px" }}>
          <div><span className="td-mini-label">WALLET CONNECTION</span><h3 id="td-wallet-picker-title" style={{ margin: "8px 0 4px" }}>Choose your wallet</h3></div>
          <button type="button" className="td-text-button" aria-label="Close wallet selector" onClick={() => setWalletPickerOpen(false)}>Close ✕</button>
        </div>
        <p style={{ color: "#b9b5ca", fontSize: "13px", lineHeight: 1.5 }}>Select a detected wallet. TradeDuel asks you to sign a message to verify ownership; it will not send a transaction.</p>
        {walletChoices.length > 0 ? <div style={{ display: "grid", gap: "8px", marginTop: "16px" }}>{walletChoices.map((choice) => <button type="button" key={choice.name} className="td-secondary-action" style={{ width: "100%", textAlign: "left", padding: "12px 14px" }} onClick={() => void connectWallet(choice)} disabled={busy}>{choice.name}<span style={{ float: "right" }}>↗</span></button>)}</div> : <p style={{ fontSize: "13px", color: "#b9b5ca" }}>No compatible wallet was detected in this browser.</p>}
        <div style={{ borderTop: "1px solid rgba(255,255,255,0.1)", marginTop: "18px", paddingTop: "14px" }}>
          <span className="td-mini-label">GET A WALLET</span>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "12px", marginTop: "8px", fontSize: "13px" }}>
            <a href="https://phantom.app/" target="_blank" rel="noreferrer">Phantom ↗</a>
            <a href="https://solflare.com/" target="_blank" rel="noreferrer">Solflare ↗</a>
            <a href="https://backpack.app/" target="_blank" rel="noreferrer">Backpack ↗</a>
            <a href="https://glow.app/" target="_blank" rel="noreferrer">Glow ↗</a>
          </div>
        </div>
      </div>
    </div>}
    {!wallet && <div className="td-pump-wallet-help"><span className="td-mini-label">USING A PUMP.FUN WALLET?</span><p>If your pump.fun email or Google wallet offers private-key export, import it directly into the official Phantom app or extension, then connect that imported account here. TradeDuel never needs your private key.</p><div className="td-pump-wallet-links"><a href="https://help.phantom.com/articles/import-your-privy-fomo-pump-fun-wallet-into-phantom" target="_blank" rel="noreferrer">Official Phantom import guide ↗</a></div><small>Never paste your private key or recovery phrase into TradeDuel or share it with anyone. Check that the address shown in Phantom exactly matches your Pump.fun trading wallet.</small></div>}
    {wallet && <div className="td-queue-setup"><div className="td-config-field"><label htmlFor="td-game-mode">GAME MODE</label><select id="td-game-mode" value={gameMode} onChange={e=>setGameMode(e.target.value as typeof gameMode)} disabled={busy||queueStatus!=="idle"}><option value="standard">Standard</option><option value="one_position">One Position</option><option value="exposure_cap">Exposure Cap</option><option value="equal_start">Equal Start</option></select><small>{gameMode === "standard" ? "Standard head-to-head format. Trading performance and ELO are not scored in this alpha." : gameMode === "one_position" ? "Proposed rule: only one open position per player. Enforcement is not live yet." : gameMode === "exposure_cap" ? "Proposed rule: apply the same maximum position exposure to both players. Enforcement is not live yet." : "Proposed rule: compare normalized returns from an equal starting allocation. Enforcement is not live yet."}</small></div><div className="td-config-field"><label htmlFor="td-duration">MATCH DURATION</label><select id="td-duration" value={duration} onChange={e=>setDuration(Number(e.target.value))} disabled={busy||queueStatus!=="idle"}><option value={900}>15 minutes</option><option value={1800}>30 minutes</option><option value={3600}>1 hour</option><option value={7200}>2 hours</option><option value={14400}>4 hours</option><option value={28800}>8 hours</option><option value={86400}>1 day</option></select><small>Timer begins when an opponent is paired. Longer durations are for matchmaking queue testing; verified trading results are not scored yet.</small></div></div>}
    {wallet && <div className="td-queue-controls"><div><span className="td-mini-label">MATCHMAKING QUEUE</span><p>Queue pairing is available for alpha testing. Mode rules and verified trade scoring are still in development.</p></div>{queueStatus === "waiting" ? <button className="td-secondary-action" onClick={leaveQueue} disabled={busy}>Leave queue</button> : <button className="td-primary-action" onClick={joinQueue} disabled={busy || queueStatus === "matched"}>{busy ? "Please wait…" : queueStatus === "matched" ? "Match found" : "Find an opponent"}</button>}</div>}
    <p className="td-wallet-notice" role="status">{notice}</p>
    {matches.length > 0 && <div className="td-my-matches"><span className="td-mini-label">YOUR MATCH HISTORY</span>{matches.map((match) => <div className="td-my-match" key={match.id}><span><strong>{shortWallet(match.player_one)}</strong> <em>vs</em> <strong>{match.player_two ? shortWallet(match.player_two) : "Waiting for opponent"}</strong></span><span className="td-status-pill">{match.status.toUpperCase()}</span><small>{match.verification_status === "verified" ? "Verified" : "Unverified alpha match · no ELO impact"}</small><Link className="td-match-open-link" to="/match/$matchId" params={{matchId:match.id}}>Open match ↗</Link></div>)}</div>}
  </div>;
}
