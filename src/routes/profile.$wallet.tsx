import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { getPublicPlayerProfile } from "@/lib/api/arena.functions";
import { SiteShell, PageHero } from "@/components/site-shell";

export const Route = createFileRoute("/profile/$wallet")({
  head: () => ({ meta: [{ title: "Player profile | TradeDuel" }] }),
  component: PlayerProfile,
});

function short(wallet: string) {
  return wallet && wallet.length > 12 ? wallet.slice(0, 5) + "…" + wallet.slice(-5) : wallet || "Unknown player";
}

function PlayerProfile() {
  const { wallet } = Route.useParams();
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError("");
    void getPublicPlayerProfile({ data: { wallet } })
      .then((result) => { if (alive) setData(result); })
      .catch((reason) => { if (alive) setError(reason instanceof Error ? reason.message : "Could not load this player's profile."); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [wallet]);

  const profile = data?.profile;
  const matches = data?.recentMatches ?? [];

  return (
    <SiteShell active="leaderboard">
      <PageHero eyebrow="TRADER PROFILE" title={profile?.displayName || short(wallet)} accent="profile." description="Public TradeDuel profile and match history." />
      <section className="td-data-panel">
        {loading ? <p>Loading profile…</p> : error ? <div role="alert"><h2>Profile unavailable</h2><p>{error}</p><button type="button" onClick={() => { setLoading(true); setError(""); void getPublicPlayerProfile({ data: { wallet } }).then(setData).catch((reason) => setError(reason instanceof Error ? reason.message : "Could not load this player's profile.")).finally(() => setLoading(false)); }}>Try again</button></div> : !profile ? <div><h2>Profile not found</h2><p>This wallet has not created a TradeDuel profile yet.</p><code>{wallet}</code></div> : <>
          <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
            {profile.avatarDataUrl ? <img src={profile.avatarDataUrl} alt="" style={{ width: 84, height: 84, borderRadius: "50%", objectFit: "cover" }} /> : <img src="/brand-mark.svg" alt="" style={{ width: 84, height: 84 }} />}
            <div><h2 style={{ margin: "0 0 6px" }}>{profile.displayName || short(profile.wallet)}</h2><code>{profile.wallet}</code><p><strong>{profile.rating} ELO</strong></p></div>
          </div>
          <div className="td-spectator-stats td-global-stats">
            <div><strong>{profile.wins}</strong><span>WINS</span></div>
            <div><strong>{profile.losses}</strong><span>LOSSES</span></div>
            <div><strong>{profile.draws}</strong><span>DRAWS</span></div>
          </div>
          <h2 id="match-history">Match history</h2>
          <p style={{ opacity: 0.75 }}>Completed matches are listed here. Returns and ELO are shown as verified only when an official result has been recorded.</p>
          {matches.length ? matches.map((match: any) => {
            const recorded = Boolean(match.elo_recorded);
            const result = match.outcome || (match.status === "completed" ? "unverified" : "pending");
            const date = match.settled_at ? new Date(match.settled_at.includes("Z") ? match.settled_at : match.settled_at + "Z").toLocaleString() : "Date unavailable";
            return <article key={match.match_id} style={{ padding: "14px 0", borderBottom: "1px solid var(--td-border)", display: "grid", gridTemplateColumns: "minmax(0,1fr) auto", gap: 12, alignItems: "center" }}>
              <div>
                <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                  <strong style={{ color: result === "draw" ? "var(--td-warning)" : result === "win" ? "var(--td-success)" : result === "loss" ? "var(--td-danger)" : "var(--td-warning)" }}>{result === "unverified" ? "COMPLETED · UNVERIFIED" : result.toUpperCase()}</strong>
                  <span>{match.return_pct == null ? "Return not verified" : (match.return_pct >= 0 ? "+" : "") + Number(match.return_pct).toFixed(2) + "% portfolio return"}</span>
                </div>
                <div style={{ marginTop: 5 }}>vs. {match.opponent_wallet ? <Link to="/profile/$wallet" params={{ wallet: match.opponent_wallet }}>{match.opponent_display_name || short(match.opponent_wallet)}</Link> : <span>Opponent unavailable</span>}</div>
                <small style={{ opacity: 0.7 }}>Match {String(match.match_id).slice(0, 8)} · {date}</small>
              </div>
              <div style={{ textAlign: "right" }}>
                {recorded && match.elo_delta != null && match.elo_before != null && match.elo_after != null ? <>
                  <strong style={{ display: "block", fontSize: 18, color: match.elo_delta > 0 ? "var(--td-success)" : match.elo_delta < 0 ? "var(--td-danger)" : "var(--td-warning)" }}>{match.elo_delta > 0 ? "+" : ""}{match.elo_delta} ELO</strong>
                  <small>{match.elo_before} → {match.elo_after}</small>
                </> : <><strong style={{ display: "block" }}>Not recorded</strong><small>Official ELO pending</small></>}
              </div>
            </article>;
          }) : <p>No matches recorded for this player yet.</p>}
        </>}
        <p style={{ marginTop: 20 }}><a href="#match-history">View this player's match history</a> · <Link to="/match-history">My match history</Link> · <Link to="/matchmaking">Matchmaking</Link></p>
      </section>
    </SiteShell>
  );
}
