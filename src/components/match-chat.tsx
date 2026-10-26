import { useCallback, useEffect, useRef, useState } from "react";
import { getMatchChatMessages, sendMatchChatMessage } from "@/lib/api/arena.functions";

type ChatMessage = { id: number; wallet: string; message: string; created_at: string };

function shortAddress(address: string) {
  return address.length > 12 ? `${address.slice(0, 5)}…${address.slice(-4)}` : address;
}

export function MatchChat({ matchId, wallet }: { matchId: string; wallet: string }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const latestId = useRef(0);
  const listRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async (initial = false) => {
    const token = window.sessionStorage.getItem("td_session_token") || "";
    if (!token) { setError("Reconnect your wallet to use match chat."); return; }
    try {
      const result = await getMatchChatMessages({ data: { token, matchId, afterId: initial ? 0 : latestId.current } });
      const incoming = result.messages as ChatMessage[];
      if (incoming.length) {
        latestId.current = Math.max(latestId.current, ...incoming.map((message) => message.id));
        setMessages((previous) => {
          const byId = new Map(previous.map((message) => [message.id, message]));
          incoming.forEach((message) => byId.set(message.id, message));
          return [...byId.values()].sort((a, b) => a.id - b.id).slice(-100);
        });
      }
      setError("");
      setLoaded(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Chat could not be loaded.");
      setLoaded(true);
    }
  }, [matchId]);

  useEffect(() => {
    let alive = true;
    const load = async () => { if (alive) await refresh(true); };
    void load();
    const timer = window.setInterval(() => { if (alive) void refresh(false); }, 2500);
    return () => { alive = false; window.clearInterval(timer); };
  }, [refresh]);

  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [messages.length]);

  const send = async (event: React.FormEvent) => {
    event.preventDefault();
    const message = draft.trim();
    if (!message || sending) return;
    const token = window.sessionStorage.getItem("td_session_token") || "";
    if (!token) { setError("Reconnect your wallet to send messages."); return; }
    setSending(true);
    setError("");
    try {
      const result = await sendMatchChatMessage({ data: { token, matchId, message } });
      if (result.message) {
        const sent = result.message as ChatMessage;
        latestId.current = Math.max(latestId.current, sent.id);
        setMessages((previous) => [...previous.filter((item) => item.id !== sent.id), sent].sort((a, b) => a.id - b.id).slice(-100));
      }
      setDraft("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Message could not be sent.");
    } finally {
      setSending(false);
    }
  };

  return <section className="td-data-panel" style={{ marginTop: "18px", padding: "20px", border: "1px solid rgba(167,139,250,.24)", borderRadius: "16px", background: "rgba(17,16,27,.82)" }}>
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px", marginBottom: "14px" }}>
      <div><span className="td-mini-label">PLAYER COMMUNICATION</span><h2 style={{ margin: "6px 0 0", fontSize: "20px" }}>Match chat</h2></div>
      <span className="td-status-pill">PRIVATE TO PLAYERS</span>
    </div>
    <div ref={listRef} aria-live="polite" style={{ display: "flex", flexDirection: "column", gap: "10px", minHeight: "150px", maxHeight: "320px", overflowY: "auto", padding: "12px", borderRadius: "12px", border: "1px solid rgba(255,255,255,.08)", background: "rgba(0,0,0,.18)" }}>
      {!messages.length && <p style={{ color: "#b9b5ca", fontSize: "13px", margin: "auto 0" }}>{loaded ? "No messages yet. Say hello to your opponent." : "Loading chat…"}</p>}
      {messages.map((message) => <div key={message.id} style={{ alignSelf: message.wallet === wallet ? "flex-end" : "flex-start", maxWidth: "88%", padding: "10px 12px", borderRadius: "12px", background: message.wallet === wallet ? "rgba(124,58,237,.24)" : "rgba(255,255,255,.06)", border: message.wallet === wallet ? "1px solid rgba(167,139,250,.32)" : "1px solid rgba(255,255,255,.08)" }}>
        <div style={{ display: "flex", gap: "10px", alignItems: "center", marginBottom: "4px" }}><strong style={{ fontSize: "11px", color: message.wallet === wallet ? "#c4b5fd" : "#d8d2e5" }}>{message.wallet === wallet ? "YOU" : shortAddress(message.wallet)}</strong><time style={{ fontSize: "10px", color: "#928ba8" }}>{new Date(message.created_at.replace(" ", "T") + (message.created_at.includes("Z") ? "" : "Z")).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time></div>
        <p style={{ margin: 0, fontSize: "13px", lineHeight: 1.5, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{message.message}</p>
      </div>)}
    </div>
    <form onSubmit={send} style={{ display: "flex", gap: "8px", marginTop: "12px" }}>
      <input aria-label="Chat message" value={draft} onChange={(event) => setDraft(event.target.value)} maxLength={500} placeholder="Message your opponent…" disabled={sending} style={{ flex: 1, minWidth: 0, padding: "12px 13px", borderRadius: "10px", color: "#f7f5ff", background: "#0d0b16", border: "1px solid rgba(167,139,250,.24)" }} />
      <button type="submit" className="td-primary-action" disabled={sending || !draft.trim()}>{sending ? "Sending…" : "Send ↗"}</button>
    </form>
    <div style={{ display: "flex", justifyContent: "space-between", gap: "12px", marginTop: "8px" }}><small style={{ color: "#928ba8" }}>Plain-text messages · 500 character limit</small><small style={{ color: "#928ba8" }}>{draft.length}/500</small></div>
    {error && <p role="status" style={{ color: "#fca5a5", fontSize: "12px", marginBottom: 0 }}>{error}</p>}
  </section>;
}
