import { createFileRoute } from "@tanstack/react-router";
import { SiteShell, PageHero } from "@/components/site-shell";

export const Route = createFileRoute("/faq")({
  head: () => ({ meta: [{ title: "FAQ | TradeDuel" }, { name: "description", content: "Answers about TradeDuel wallets, live matches, scoring, ratings, and player safety." }] }),
  component: FAQ,
});

const questions = [
  ["What is TradeDuel?", "TradeDuel is a Solana trading arena where players can join public matches or create private lobbies, follow portfolio performance, and review match results backed by on-chain and pricing evidence."],
  ["Which wallets can I connect?", "TradeDuel supports compatible Solana wallets including Phantom, Solflare, and Backpack. Availability depends on the wallet extension or app being installed and enabled."],
  ["Does connecting my wallet send a transaction?", "No. TradeDuel verifies wallet ownership with a signed message. That signature does not send a transaction or give TradeDuel custody of your assets."],
  ["How does live portfolio performance update?", "The match room refreshes live match and wallet activity frequently, with new portfolio observations targeted about every five seconds when RPC and price providers respond. Solana confirmation, provider latency, and token-price availability can delay updates; no website can guarantee zero-latency prices."],
  ["How are match results and ELO calculated?", "Match results compare eligible portfolio performance over the match window. Settlement checks the available start/end valuations and transaction evidence before applying a rating change. If evidence is incomplete or inconsistent, the result remains pending review instead of awarding an unverified rating change."],
  ["When will I see an ELO change?", "After a match ends, TradeDuel retries settlement automatically. The rating update appears as soon as the server can verify the required evidence and finalize the result. Delayed or incomplete evidence can postpone settlement."],
  ["Can I create a private match?", "Yes. Matchmaking lets you browse public rooms or create a private lobby with a password. Choose the available format, team size, and duration when setting up the match."],
  ["Can I play in duos or squads?", "Available room formats include head-to-head, Duo 2v2, and team battles. The available options depend on the lobby configuration."],
  ["Does TradeDuel ever need my seed phrase or private key?", "Never. Do not share your seed phrase or private key with TradeDuel, a website form, or a support account. Import wallet keys only inside the official wallet app or extension."],
  ["Are token prices and portfolio values exact?", "Portfolio values are estimates based on available token balances and current market quotes. Thin liquidity, missing quotes, transfers, and price movement can affect estimates. The platform must not treat incomplete estimates or detected swap candidates as verified profit and loss."],
  ["Does TradeDuel involve user-to-user wagers?", "TradeDuel is designed around skill-based competition, not user-to-user wagers or pooled stakes. Never send funds to another player because of a match."],
  ["Does TradeDuel guarantee profits?", "No. TradeDuel does not guarantee profits or provide investment advice. Crypto assets are volatile, and trading can result in substantial or total loss."],
];

function FAQ() {
  return <SiteShell active="faq">
    <PageHero variant="faq" eyebrow="HELP / FAQ" title="Good questions." accent="Clear answers." description="Wallets, live matches, scoring, and what to expect when you enter the arena." />
    <section className="td-faq-list">{questions.map(([q, a], i) => <details className="td-faq-item" key={q}><summary><span className="td-faq-number">{String(i + 1).padStart(2, "0")}</span><span>{q}</span><span className="td-faq-plus">+</span></summary><p>{a}</p></details>)}</section>
    <section className="td-faq-bottom"><p><a href="/elo">Explore ELO, match durations, and formats ↗</a></p><p className="td-overline">BUILT AROUND TRUST</p><h2>Clear rules.<br />Verifiable results.</h2><p>Wallet safety comes first. Competitive results should only count when the evidence and rules can support them.</p></section>
  </SiteShell>;
}
