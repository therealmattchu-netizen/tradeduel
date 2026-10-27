import { createFileRoute } from "@tanstack/react-router";
import { SiteShell, PageHero } from "@/components/site-shell";

export const Route = createFileRoute("/faq")({
  head: () => ({ meta: [{ title: "FAQ | TradeDuel" }, { name: "description", content: "Answers about TradeDuel wallets, matches, scoring, and player safety." }] }),
  component: FAQ,
});

const questions = [
  ["What can I use on TradeDuel today?", "You can connect a compatible Solana wallet, verify ownership with a signed message, enter the practice matchmaking queue, and use the match room and player chat when paired. Official trading-performance scoring and ELO changes are not enabled yet."],
  ["Which wallets can I connect?", "TradeDuel supports compatible Solana wallets including Phantom, Solflare, and Backpack. Wallet availability depends on the wallet extension being installed and enabled in your browser."],
  ["Does connecting my wallet send a transaction?", "No. TradeDuel asks you to sign a one-time message to verify wallet ownership. That signature does not send a transaction or give TradeDuel custody of your assets."],
  ["Will players wager SOL against each other?", "TradeDuel is designed around skill-based competition, not user-to-user wagers or pooled stakes. Never send funds to another player because of a match."],
  ["Does TradeDuel ever need my seed phrase or private key?", "No. Never share your seed phrase or private key with TradeDuel, a website form, or a support account. Import wallet keys only inside the official wallet app or extension."],
  ["How are match scores calculated?", "Official scores are not enabled yet. Before competitive results can be published, the scoring system must consistently account for eligible trades, fees, prices, external transfers, and match timing."],
  ["Will there be a leaderboard and ELO?", "The site includes information about the intended rating approach, but official ELO changes are not active. Ratings should only change after a result can be verified under published rules."],
  ["Which match lengths and formats are available?", "The match setup currently offers duration and format selections for queue pairing. Some advanced rules—such as one-position limits, exposure caps, and equal-start scoring—are not enforced as competitive rules."],
  ["When will official competitive scoring be available?", "We will share an announcement through TradeDuel's official channels when verified scoring and match rules are ready. Until then, treat matchmaking as practice and do not assume a match has an official winner."],
  ["Does TradeDuel guarantee profits?", "No. TradeDuel does not guarantee profits or provide investment advice. Crypto assets can be highly volatile, and trading can result in substantial or total loss."],
];

function FAQ() {
  return <SiteShell active="faq">
    <PageHero eyebrow="HELP / FAQ" title="Good questions." accent="Clear answers." description="Wallets, matches, scoring, and what to expect when you enter the arena." />
    <section className="td-faq-list">{questions.map(([q, a], i) => <details className="td-faq-item" key={q}><summary><span className="td-faq-number">{String(i + 1).padStart(2, "0")}</span><span>{q}</span><span className="td-faq-plus">+</span></summary><p>{a}</p></details>)}</section>
    <section className="td-faq-bottom"><p><a href="/elo">Explore ELO, match durations, and formats ↗</a></p><p className="td-overline">BUILT AROUND TRUST</p><h2>Clear rules.<br />Verifiable results.</h2><p>Wallet safety comes first. Competitive results should only count when the evidence and rules can support them.</p></section>
  </SiteShell>;
}
