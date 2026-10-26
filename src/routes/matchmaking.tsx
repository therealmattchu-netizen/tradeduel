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
      <section className="td-match-layout" style={{ display: "block", "--td-accent":"#a56bff", "--td-border":"#302052", "--td-panel":"#0d0a1c", "--td-text":"#f4efff", "--td-accent-soft":"rgba(151,76,255,.16)", "--td-bg":"#070612", "--td-muted":"#b2a4d0" } as React.CSSProperties}>
        <WalletArena authOnly />
        <CustomMatchBrowser />
      </section>
    </SiteShell>
  );
}
