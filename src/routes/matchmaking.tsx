import { createFileRoute } from "@tanstack/react-router";
import { SiteShell, PageHero } from "@/components/site-shell";
import { CustomMatchBrowser } from "@/components/custom-match-browser";
import { WalletArena } from "@/components/wallet-arena";

export const Route = createFileRoute("/matchmaking")({
  head: () => ({
    meta: [
      { title: "Matchmaking | TradeDuel" },
      {
        name: "description",
        content: "Choose a TradeDuel game mode, find a public match, or create a private lobby.",
      },
    ],
  }),
  component: Matchmaking,
});

function Matchmaking() {
  return (
    <SiteShell active="matchmaking">
      <PageHero
        eyebrow="MATCHMAKING"
        title="Choose your"
        accent="arena."
        description="Choose your ruleset, pick your team size, then jump into a public duel or create a password-protected private arena."
      />
      <section className="td-match-layout" style={{ display: "block", "--td-accent":"var(--td-purple-accent)", "--td-border":"var(--td-purple-border)", "--td-panel":"var(--td-purple-panel)", "--td-text":"var(--td-purple-text)", "--td-accent-soft":"var(--td-purple-accent-soft)", "--td-bg":"var(--td-purple-bg)", "--td-muted":"var(--td-purple-muted)" } as React.CSSProperties}>
        <WalletArena authOnly />
        <div className="td-trading-hero" aria-label="Animated trading duel illustration"><div className="td-trading-grid" /><div className="td-hero-panel td-hero-panel-left"><span>PORTFOLIO / A</span><div className="td-hero-chart"><i/><i/><i/><i/><i/><i/><i/><i/><i/><i/><i/><i/></div><div className="td-hero-line"/></div><div className="td-hero-panel td-hero-panel-right"><span>PORTFOLIO / B</span><div className="td-hero-chart td-hero-chart-cyan"><i/><i/><i/><i/><i/><i/><i/><i/><i/><i/><i/><i/></div><div className="td-hero-line td-hero-line-cyan"/></div><div className="td-hero-versus">VS</div><div className="td-hero-footer"><b>● LIVE MARKETS</b><span>REAL-TIME DUELS</span><span>SOLANA</span></div></div><CustomMatchBrowser />
      </section>
    </SiteShell>
  );
}
