import { createFileRoute } from "@tanstack/react-router";
import { SiteShell, PageHero } from "@/components/site-shell";
import { CustomMatchBrowser } from "@/components/custom-match-browser";

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
        description="One matchmaking hub for 1v1 duels, 2v2 team duos, and 3v3 or 4v4 team battles. Join public rooms or invite friends to a password-protected private lobby."
      />
      <section className="td-match-layout" style={{ display: "block" }}>
        <CustomMatchBrowser />
      </section>
    </SiteShell>
  );
}
