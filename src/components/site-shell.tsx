import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { PlayerProfileMenu } from "@/components/player-profile-menu";

export function SwordsMark({ size = 30 }: { size?: number }) {
  return <img className="td-swords-mark" src="/brand-mark-exact.png" width={size} height={size} alt="" aria-hidden="true" />;
}

export function SiteShell({ children, active }: { children: ReactNode; active?: string }) {
  return <main className="td-site td-inner-site">
    <header className="td-nav td-nav-inner">
      <Link className="td-brand" to="/" aria-label="TradeDuel home"><span className="td-mark"><SwordsMark size={31} /></span><img className="td-wordmark" src="/brand-wordmark.svg" alt="TradeDuel" /></Link>
      <nav className="td-nav-links" aria-label="Main navigation">
        <Link className={active === "matchmaking" ? "td-current" : ""} to="/matchmaking">Matchmaking</Link>
        <Link className={active === "spectate" ? "td-current" : ""} to="/spectate">Spectate</Link>
        <Link className={active === "tracker" ? "td-current" : ""} to="/tracker">Wallet Tracker</Link>
        <Link className={active === "leaderboard" ? "td-current" : ""} to="/leaderboard">Leaderboard</Link>
        <Link className={active === "elo" ? "td-current" : ""} to="/elo">ELO & Rules</Link>
        <Link className={active === "about" ? "td-current" : ""} to="/about">About</Link>
        <Link className={active === "faq" ? "td-current" : ""} to="/faq">FAQ</Link>
        <Link className="td-nav-cta" to="/matchmaking">Enter the arena <span>↗</span></Link>
      </nav>
      <PlayerProfileMenu />
    </header>
    <div className="td-inner-content">{children}</div>
    <footer className="td-footer"><Link className="td-brand" to="/"><span className="td-mark"><SwordsMark size={27} /></span><img className="td-wordmark" src="/brand-wordmark.svg" alt="TradeDuel" /></Link><p>Competitive trading arena. Built around transparent rules.</p><span className="td-footer-note">NOT FINANCIAL ADVICE. CRYPTO TRADING INVOLVES RISK.</span></footer>
  </main>;
}

export function PageHero({ eyebrow, title, accent, description }: { eyebrow: string; title: string; accent?: string; description: string }) {
  return <section className="td-page-hero"><p className="td-overline">{eyebrow}</p><h1>{title}{accent && <><br/><span>{accent}</span></>}</h1><p>{description}</p><div className="td-page-rule"><span/><span/><span/></div></section>;
}
