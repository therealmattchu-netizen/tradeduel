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
  }
}
type WalletChoice = { name: string; provider?: SolanaWalletProvider; standardWallet?: StandardWallet };
function getWalletChoices(): WalletChoice[] {
  if (typeof window === "undefined") return [];
  const choices: WalletChoice[] = [];
  const seenProviders: SolanaWalletProvider[] = [];

  // Bind legacy provider buttons to their wallet-specific namespaces first.
  // In particular, never use window.solana as a Phantom fallback: another
  // extension can own that shared namespace and open the wrong wallet.
  const candidates: Array<{ name: string; provider?: SolanaWalletProvider }> = [
    // The wallet-specific namespace is the identity boundary. Do not require
    // an optional isPhantom flag: some compatible Phantom builds omit it.
    { name: "Phantom", provider: window.phantom?.solana },
    { name: "Solflare", provider: window.solflare },
    { name: "Backpack", provider: (window.backpack && "solana" in window.backpack ? window.backpack.solana as SolanaWalletProvider | undefined : window.backpack as SolanaWalletProvider | undefined) },
  ];
  for (const candidate of candidates) {
    const provider = candidate.provider;
    if (!provider?.connect || !provider.signMessage) continue;
    if (seenProviders.includes(provider)) continue;
    seenProviders.push(provider);
    choices.push({ name: candidate.name, provider });
  }

  // Wallet Standard entries are the fallback for wallets without an identified
  // wallet-specific legacy namespace. Match by their registered names and never
  // overwrite the explicit Phantom provider above.
  for (const wallet of discoverStandardWallets()) {
    const name = wallet.name.trim();
    if (!name || !wallet.features["standard:connect"] || !wallet.features["solana:signMessage"]) continue;
    // Keep the Wallet Standard Phantom registration as a valid identity-specific
    // route when Phantom does not expose its legacy namespace.
    if (choices.some((item) => item.name.toLowerCase() === name.toLowerCase())) continue;
    choices.push({ name, standardWallet: wallet });
  }
  // Show explicit install fallbacks rather than routing one wallet's button
  // through another extension's generic provider.
  if (!choices.some((item) => item.name.toLowerCase() === "phantom")) choices.push({ name: "Phantom" });
  if (!choices.some((item) => item.name.toLowerCase() === "backpack")) choices.push({ name: "Backpack" });
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
      else if (result.status === "matched") setNotice("Opponent found. This match does not score trading performance or change ELO.");
    }).catch(() => { /* expired sessions are handled when the user takes an action */ });
    return () => { alive = false; };
  }, [token, loadMatches]);
  useEffect(() => {
    if (!token || queueStatus !== "waiting") return;
    let alive = true;
    const poll = async () => { try { const result = await getQueueStatus({ data: { token } }); if (!alive) return; setQueueStatus(result.status); if (result.status === "matched") { setNotice("Opponent found. This match does not score trading performance or change ELO."); await loadMatches(token); } } catch { /* retry on next poll */ } };
    void poll(); const interval = window.setInterval(() => void poll(), 5000);
    return () => { alive = false; window.clearInterval(interval); };
  }, [token, queueStatus, loadMatches]);

  const connectWallet = async (choice: WalletChoice) => {
    setBusy(true); setNotice(`Waiting for ${choice.name} approval…`);
    try {
      let publicKey = "";
      let signature: Uint8Array | null = null;
      if (choice.provider) {
        const provider = choice.provider;
        const connected = await provider.connect();
        // Some injected providers resolve connect() without returning a key;
        // read the provider's publicKey after the user approves the connection.
        publicKey = (connected && typeof connected === "object" && "publicKey" in connected ? connected.publicKey : undefined)?.toString() ?? provider.publicKey?.toString() ?? "";
        if (!publicKey) throw new Error(`${choice.name} opened but did not return an address. Approve the connection in the wallet popup, then retry. If it is already connected, unlock the wallet and try again.`);
        const challenge = await createWalletChallenge({ data: { wallet: publicKey } });
        const signed = await provider.signMessage(new TextEncoder().encode(challenge.message), "utf8");
        signature = signed instanceof Uint8Array ? signed : signed.signature;
        const verified = await verifyWalletChallenge({ data: { wallet: publicKey, nonce: challenge.nonce, signature: toBase64(signature) } });
        window.sessionStorage.setItem(TOKEN_KEY, verified.token); window.sessionStorage.setItem(WALLET_KEY, verified.wallet);
        setToken(verified.token); setWallet(verified.wallet); setWalletProviderName(choice.name); setNotice("Wallet ownership verified. No transaction was sent.");
        setWalletPickerOpen(false);
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
      setWalletPickerOpen(false);
    } catch (e) {
      const message = e instanceof Error ? e.message : "Wallet connection failed. Try again.";
      setNotice(`${choice.name}: ${message}`);
      // Leave the selector open so the user can retry or choose another wallet.
      setWalletPickerOpen(true);
    }
    finally { setBusy(false); }
  };

  const disconnect = async () => {
    // Clear the TradeDuel session locally. The selected provider may be a Wallet Standard wallet.
    window.sessionStorage.removeItem(TOKEN_KEY); window.sessionStorage.removeItem(WALLET_KEY);
    setWallet(""); setToken(""); setWalletProviderName(""); setQueueStatus("idle"); setMatches([]); setNotice("Disconnected. Your wallet remains under your control.");
  };

  const joinQueue = async () => {
    if (!token) { setWalletChoices(getWalletChoices()); setWalletPickerOpen(true); return; }
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
        {walletChoices.length > 0 ? <div style={{ display: "grid", gap: "8px", marginTop: "16px" }}>{walletChoices.map((choice) => <button type="button" key={choice.name} className="td-secondary-action" style={{ width: "100%", textAlign: "left", padding: "12px 14px" }} onClick={() => {
          // Resolve Phantom at click time from Phantom's own namespace. Never use
          // a cached choice or Wallet Standard entry for this button; those can
          // be supplied/misidentified by another extension.
          if (choice.name === "Phantom") {
            // Phantom can expose its provider through either the namespaced
            // window.phantom.solana API or the legacy window.solana API.
            // The legacy API is accepted only when it positively identifies
            // itself as Phantom, so Backpack cannot capture this button.
            const namespacedPhantom = window.phantom?.solana;
            const legacySolana = window.solana;
            const backpackProvider = window.backpack && "solana" in window.backpack
              ? window.backpack.solana as SolanaWalletProvider | undefined
              : window.backpack as SolanaWalletProvider | undefined;
            const isBackpackProvider = (provider: SolanaWalletProvider | undefined) =>
              Boolean(provider && (provider.isBackpack === true || provider === backpackProvider));
            const phantomProvider =
              namespacedPhantom?.isPhantom === true && !isBackpackProvider(namespacedPhantom)
                ? namespacedPhantom
                : legacySolana?.isPhantom === true && !isBackpackProvider(legacySolana)
                  ? legacySolana
                  : undefined;
            if (phantomProvider) {
              void connectWallet({ name: "Phantom", provider: phantomProvider });
              return;
            }
            // If Phantom exposes only Wallet Standard, use the exact registered
            // wallet identity rather than a shared injected provider namespace.
            const standardPhantom = discoverStandardWallets().find(
              (wallet) => wallet.name.trim().toLowerCase() === "phantom" &&
                Boolean(wallet.features["standard:connect"]) &&
                Boolean(wallet.features["solana:signMessage"]),
            );
            if (standardPhantom) {
              void connectWallet({ name: "Phantom", standardWallet: standardPhantom });
              return;
            }
            window.open("https://phantom.app/download", "_blank", "noopener,noreferrer");
            setNotice(namespacedPhantom || legacySolana
              ? "A Solana wallet provider is present, but it did not identify itself as Phantom (or matched Backpack). TradeDuel blocked it to avoid opening the wrong wallet. Check that the Phantom extension is enabled, then reload."
              : "Phantom's provider was not detected in this browser. Enable/install the Phantom extension, then reload TradeDuel.");
            return;
          }
          if (choice.name === "Backpack" && !choice.provider && !choice.standardWallet) {
            window.open("https://backpack.app/", "_blank", "noopener,noreferrer");
            setNotice("Backpack's provider was not detected. Open or install Backpack, then reload TradeDuel.");
            return;
          }
          if (choice.name === "Backpack" && choice.provider) {
            const provider = choice.provider;
            if (provider.isBackpack === false || provider.isPhantom === true || provider.isSolflare === true) {
              setNotice("The injected provider does not identify itself as Backpack. TradeDuel blocked it to avoid opening the wrong wallet.");
              return;
            }
          }
          void connectWallet(choice);
        }} disabled={busy}>{choice.name}{!choice.provider && !choice.standardWallet && (choice.name === "Backpack" || choice.name === "Phantom") ? " · Install / reload" : ""}<span style={{ float: "right" }}>↗</span></button>)}</div> : <p style={{ fontSize: "13px", color: "#b9b5ca" }}>No compatible wallet was detected in this browser.</p>}
        <div style={{ borderTop: "1px solid rgba(255,255,255,0.1)", marginTop: "18px", paddingTop: "14px" }}>
          <span className="td-mini-label">GET A WALLET</span>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "12px", marginTop: "8px", fontSize: "13px" }}>
            <a href="https://phantom.app/" target="_blank" rel="noreferrer">Phantom ↗</a>
            <a href="https://solflare.com/" target="_blank" rel="noreferrer">Solflare ↗</a>
            <a href="https://backpack.app/" target="_blank" rel="noreferrer">Backpack ↗</a>
          </div>
        </div>
      </div>
    </div>}
    {!wallet && <div className="td-pump-wallet-help" style={{ marginTop: "20px", padding: "20px", border: "1px solid rgba(167, 139, 250, 0.28)", borderRadius: "16px", background: "linear-gradient(135deg, rgba(124, 58, 237, 0.12), rgba(15, 12, 28, 0.72))" }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: "12px" }}>
        <div style={{ flex: "0 0 42px", width: "42px", height: "42px", borderRadius: "12px", display: "grid", placeItems: "center", background: "rgba(167, 139, 250, 0.16)", fontSize: "22px" }}>↗</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <span className="td-mini-label">PUMP.FUN WALLET SETUP</span>
          <h3 style={{ margin: "6px 0 8px", fontSize: "18px" }}>Connect your existing Pump.fun wallet</h3>
          <p style={{ margin: "0 0 14px", color: "#c9c4d8", fontSize: "13px", lineHeight: 1.6 }}>Export your Pump.fun Solana private key, then import it into a wallet provider below. After importing, return here and connect that same account. Your public address should match your Pump.fun wallet exactly.</p>
        </div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: "10px", marginTop: "8px" }}>
        <a href="https://help.phantom.com/articles/import-your-privy-fomo-pump-fun-wallet-into-phantom-41408635409683" target="_blank" rel="noreferrer" style={{ display: "block", padding: "13px", border: "1px solid rgba(167, 139, 250, 0.3)", borderRadius: "12px", color: "inherit", textDecoration: "none", background: "rgba(255,255,255,0.035)" }}>
          <strong style={{ display: "block", fontSize: "13px", marginBottom: "5px" }}>Phantom ↗</strong><span style={{ display: "block", color: "#b9b5ca", fontSize: "12px", lineHeight: 1.45 }}>Official Pump.fun wallet import walkthrough</span>
        </a>
        <a href="https://help.solflare.com/en/articles/6134229-how-to-import-your-solana-wallet-into-solflare-using-a-private-key-desktop" target="_blank" rel="noreferrer" style={{ display: "block", padding: "13px", border: "1px solid rgba(167, 139, 250, 0.3)", borderRadius: "12px", color: "inherit", textDecoration: "none", background: "rgba(255,255,255,0.035)" }}>
          <strong style={{ display: "block", fontSize: "13px", marginBottom: "5px" }}>Solflare ↗</strong><span style={{ display: "block", color: "#b9b5ca", fontSize: "12px", lineHeight: 1.45 }}>Official private-key import instructions</span>
        </a>
        <a href="https://support.backpack.exchange/wallet/get-started/import-recover-wallet" target="_blank" rel="noreferrer" style={{ display: "block", padding: "13px", border: "1px solid rgba(167, 139, 250, 0.3)", borderRadius: "12px", color: "inherit", textDecoration: "none", background: "rgba(255,255,255,0.035)" }}>
          <strong style={{ display: "block", fontSize: "13px", marginBottom: "5px" }}>Backpack ↗</strong><span style={{ display: "block", color: "#b9b5ca", fontSize: "12px", lineHeight: 1.45 }}>Official guide to importing or recovering a wallet</span>
        </a>
      </div>
      <div style={{ marginTop: "14px", padding: "11px 12px", borderRadius: "10px", background: "rgba(245, 158, 11, 0.08)", border: "1px solid rgba(245, 158, 11, 0.22)" }}>
        <strong style={{ display: "block", fontSize: "12px", marginBottom: "4px" }}>Security reminder</strong>
        <small style={{ color: "#d8d2e5", fontSize: "12px", lineHeight: 1.55 }}>Only enter your private key inside the official wallet app or extension you chose. Never paste it into TradeDuel, a website form, or a chat. Verify the imported public address matches Pump.fun before connecting.</small>
      </div>
    </div>}
    {wallet && <div className="td-queue-setup"><div className="td-config-field"><label htmlFor="td-game-mode">GAME MODE</label><select id="td-game-mode" value={gameMode} onChange={e=>setGameMode(e.target.value as typeof gameMode)} disabled={busy||queueStatus!=="idle"}><option value="standard">Standard</option><option value="one_position">One Position</option><option value="exposure_cap">Exposure Cap</option><option value="equal_start">Equal Start</option></select><small>{gameMode === "standard" ? "Standard head-to-head format. Trading performance and ELO are not scored in this format yet." : gameMode === "one_position" ? "One open position per player. This rule is not currently enforced." : gameMode === "exposure_cap" ? "The same maximum position exposure for both players. This rule is not currently enforced." : "Compare normalized returns from an equal starting allocation. This rule is not currently enforced."}</small></div><div className="td-config-field"><label htmlFor="td-duration">MATCH DURATION</label><select id="td-duration" value={duration} onChange={e=>setDuration(Number(e.target.value))} disabled={busy||queueStatus!=="idle"}><option value={900}>15 minutes</option><option value={1800}>30 minutes</option><option value={3600}>1 hour</option><option value={7200}>2 hours</option><option value={14400}>4 hours</option><option value={28800}>8 hours</option><option value={86400}>1 day</option></select><small>The timer begins when an opponent is paired. Verified trading results are not scored yet.</small></div></div>}
    {wallet && <div className="td-queue-controls"><div><span className="td-mini-label">MATCHMAKING QUEUE</span><p>Queue pairing is available. Mode rules and verified trade scoring are not enabled yet.</p></div>{queueStatus === "waiting" ? <button className="td-secondary-action" onClick={leaveQueue} disabled={busy}>Leave queue</button> : <button className="td-primary-action" onClick={joinQueue} disabled={busy || queueStatus === "matched"}>{busy ? "Please wait…" : queueStatus === "matched" ? "Match found" : "Find an opponent"}</button>}</div>}
    <p className="td-wallet-notice" role="status">{notice}</p>
    {matches.length > 0 && <div className="td-my-matches"><span className="td-mini-label">YOUR MATCH HISTORY</span>{matches.map((match) => <div className="td-my-match" key={match.id}><span><strong>{shortWallet(match.player_one)}</strong> <em>vs</em> <strong>{match.player_two ? shortWallet(match.player_two) : "Waiting for opponent"}</strong></span><span className="td-status-pill">{match.status.toUpperCase()}</span><small>{match.verification_status === "verified" ? "Verified" : "Unverified practice match · no ELO impact"}</small><Link className="td-match-open-link" to="/match/$matchId" params={{matchId:match.id}}>Open match ↗</Link></div>)}</div>}
  </div>;
}
