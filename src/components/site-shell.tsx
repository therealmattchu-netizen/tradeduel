import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { PlayerProfileMenu } from "@/components/player-profile-menu";

export function SwordsMark({ size = 30 }: { size?: number }) {
  return <img className="td-swords-mark" src="/brand-mark.svg" width={size} height={size} alt="" aria-hidden="true" />;
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

export function PageHero({ eyebrow, title, accent, description, variant = "arena" }: { eyebrow: string; title: string; accent?: string; description: string; variant?: "arena" | "leaderboard" | "faq" | "elo" | "about" | "spectate" | "matchmaking" | "tracker" }) {
  return <section className={`td-page-hero td-page-hero--${variant}`}>
    <div className="td-page-hero-copy"><p className="td-overline">{eyebrow}</p><h1>{title}{accent && <><br/><span>{accent}</span></>}</h1><p>{description}</p><div className="td-page-rule"><span/><span/><span/></div></div>
    <div className="td-page-hero-visual" aria-hidden="true">
      {variant === "leaderboard" ? <div className="td-hero-podium"><div className="td-podium-crown">✦</div><div className="td-podium-bars"><i/><i/><i/></div><div className="td-podium-labels"><span>02</span><b>01</b><span>03</span></div><div className="td-hero-data-stamp">GLOBAL RANK · ELO</div></div>
      : variant === "faq" ? <div className="td-hero-dialogue"><div className="td-dialogue-bubble td-dialogue-bubble-a"><b>Q.</b><span/><span/></div><div className="td-dialogue-bubble td-dialogue-bubble-b"><b>A.</b><span/><span/><span/></div><div className="td-dialogue-orbit">?</div><small>HELP CENTER / ANSWERS</small></div>
      : variant === "elo" ? <div className="td-hero-rating"><div className="td-rating-ring"><div className="td-rating-center"><small>RATING</small><strong>970</strong><span>ELO</span></div></div><div className="td-rating-change"><span>+24</span><i/></div><div className="td-rating-axis"><span>BRONZE</span><span>GOLD</span><span>ELITE</span></div></div>
      : variant === "about" ? <div className="td-hero-constellation"><div className="td-constellation-line line-a"/><div className="td-constellation-line line-b"/><div className="td-constellation-line line-c"/>{Array.from({length:9},(_,i)=><i key={i} className={`td-star td-star-${i+1}`}/>)}<div className="td-constellation-core"><span>TD</span></div><small>BUILT ON TRANSPARENCY</small></div>
      : variant === "spectate" ? <div className="td-hero-radar"><div className="td-radar-ring"/><div className="td-radar-ring"/><div className="td-radar-ring"/><i className="td-radar-sweep"/><span className="td-radar-node node-a"/><span className="td-radar-node node-b"/><span className="td-radar-node node-c"/><b>LIVE<br/>FEED</b><small>SPECTATOR SIGNAL</small></div>
      : variant === "matchmaking" ? <div className="td-hero-matchup"><div className="td-matchup-card card-a"><small>PLAYER A</small><div className="td-matchup-bars">{Array.from({length:7},(_,i)=><i key={i} style={{height:`${28+((i*23+17)%64)}%`}}/>)}</div><b>PORTFOLIO A</b></div><div className="td-matchup-vs">VS</div><div className="td-matchup-card card-b"><small>PLAYER B</small><div className="td-matchup-bars">{Array.from({length:7},(_,i)=><i key={i} style={{height:`${30+((i*19+9)%60)}%`}}/>)}</div><b>PORTFOLIO B</b></div><small className="td-matchup-foot">HEAD-TO-HEAD · SOLANA</small></div>
      : variant === "tracker" ? <div className="td-hero-wallet"><div className="td-wallet-orbit"/><div className="td-wallet-chip"><span>◎</span><b>WALLET</b><small>PUBLIC ADDRESS</small></div><div className="td-wallet-flow">{Array.from({length:12},(_,i)=><i key={i} style={{height:`${20+((i*29+13)%70)}%`}}/>)}</div><small>ON-CHAIN ACTIVITY</small></div>
      : <div className="td-hero-arena td-hero-arena--clean"><SwordsMark size={31}/><small>TRADEDUEL · LIVE ARENA</small></div>}
    </div>
  </section>;
}
