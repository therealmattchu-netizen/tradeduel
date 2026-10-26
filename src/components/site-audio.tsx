import { useCallback, useEffect, useRef, useState } from "react";
import { useRouterState } from "@tanstack/react-router";

type AudioPrefs = { music: boolean; effects: boolean };
type Scene = "duel" | "lobby";
const PREF_KEY = "tradeduel-audio-prefs-v1";

function readPrefs(): AudioPrefs {
  try {
    const value = localStorage.getItem(PREF_KEY);
    if (value) {
      const parsed = JSON.parse(value) as Partial<AudioPrefs>;
      return { music: parsed.music !== false, effects: parsed.effects !== false };
    }
  } catch { /* Use defaults when storage is unavailable. */ }
  return { music: true, effects: true };
}

export function SiteAudio() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const [prefs, setPrefs] = useState<AudioPrefs>({ music: true, effects: true });
  const [started, setStarted] = useState(false);
  const audioRef = useRef<AudioContext | null>(null);
  const masterRef = useRef<GainNode | null>(null);
  const musicGainRef = useRef<GainNode | null>(null);
  const prefsRef = useRef(prefs);
  const sceneRef = useRef<Scene>("lobby");
  const lastPathRef = useRef(pathname);
  const sequenceTimerRef = useRef<number | null>(null);
  const sequenceIndexRef = useRef(0);

  const scene: Scene = /\/match\/[^/]+/.test(pathname) ? "duel" : "lobby";

  useEffect(() => {
    const initial = readPrefs();
    setPrefs(initial);
    prefsRef.current = initial;
  }, []);

  const ensureAudio = useCallback(() => {
    if (typeof window === "undefined" || !window.AudioContext) return null;
    if (!audioRef.current) {
      const ctx = new window.AudioContext();
      const master = ctx.createGain();
      master.gain.value = 0.82;
      master.connect(ctx.destination);
      const musicGain = ctx.createGain();
      musicGain.gain.value = 0;
      musicGain.connect(master);
      audioRef.current = ctx;
      masterRef.current = master;
      musicGainRef.current = musicGain;
      setStarted(true);
    }
    if (audioRef.current.state === "suspended") void audioRef.current.resume();
    return audioRef.current;
  }, []);

  const playTone = useCallback((frequency: number, duration: number, volume: number, type: OscillatorType = "sine", endFrequency?: number) => {
    const ctx = ensureAudio();
    if (!ctx || !prefsRef.current.effects) return;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(frequency, ctx.currentTime);
    if (endFrequency) osc.frequency.exponentialRampToValueAtTime(endFrequency, ctx.currentTime + duration);
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(volume, ctx.currentTime + Math.min(0.018, duration / 4));
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + duration);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + duration + 0.01);
  }, [ensureAudio]);

  const playMatchFound = useCallback(() => {
    if (!prefsRef.current.effects) return;
    // A three-note, rising match-confirmation chime.
    playTone(784, 0.18, 0.14, "sine", 988);
    window.setTimeout(() => playTone(1046.5, 0.22, 0.14, "sine", 1318.5), 110);
    window.setTimeout(() => playTone(1568, 0.36, 0.12, "sine", 1760), 230);
    // Use an installed browser voice so no external audio file is required.
    if ("speechSynthesis" in window && typeof SpeechSynthesisUtterance !== "undefined") {
      window.setTimeout(() => {
        if (!prefsRef.current.effects) return;
        window.speechSynthesis.cancel();
        const announcement = new SpeechSynthesisUtterance("Match found.");
        announcement.lang = "en-CA";
        announcement.rate = 0.92;
        announcement.pitch = 1.02;
        announcement.volume = 0.85;
        window.speechSynthesis.speak(announcement);
      }, 420);
    }
  }, [playTone]);

  const playNavigation = useCallback((kind: "page" | "duel") => {
    if (!prefsRef.current.effects) return;
    if (kind === "duel") {
      // Bright, two-note arrival chime for entering a match.
      playTone(880, 0.22, 0.13, "sine", 1046.5);
      window.setTimeout(() => playTone(1318.5, 0.32, 0.105, "sine", 1568), 90);
    } else {
      // Soft, quick UI tick for normal page navigation.
      playTone(680, 0.075, 0.055, "triangle", 510);
    }
  }, [playTone]);

  useEffect(() => {
    prefsRef.current = prefs;
    try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch { /* Session-only preferences are fine. */ }
    const ctx = audioRef.current;
    if (ctx && musicGainRef.current) {
      musicGainRef.current.gain.setTargetAtTime(prefs.music ? (sceneRef.current === "duel" ? 0.22 : 0.15) : 0, ctx.currentTime, 0.45);
    }
  }, [prefs]);

  // Synthesized looping melodies: cheerful plucked major-key notes in the lobby;
  // tense minor-key arpeggios with a low pulse during a duel.
  useEffect(() => {
    sceneRef.current = scene;
    const ctx = ensureAudio();
    if (!ctx || !musicGainRef.current) return;
    if (sequenceTimerRef.current !== null) window.clearTimeout(sequenceTimerRef.current);
    sequenceIndexRef.current = 0;
    musicGainRef.current.gain.setTargetAtTime(prefsRef.current.music ? (scene === "duel" ? 0.22 : 0.15) : 0, ctx.currentTime, 0.8);

    const lobbyNotes = [261.63, 329.63, 392, 523.25, 392, 329.63, 293.66, 392, 440, 523.25, 440, 392];
    const duelNotes = [110, 164.81, 146.83, 220, 130.81, 196, 123.47, 185, 110, 164.81, 207.65, 164.81];
    const step = () => {
      const current = audioRef.current;
      if (!current || current.state !== "running") {
        sequenceTimerRef.current = window.setTimeout(step, 500);
        return;
      }
      const i = sequenceIndexRef.current % (scene === "duel" ? duelNotes.length : lobbyNotes.length);
      const now = current.currentTime;
      if (prefsRef.current.music) {
        if (scene === "lobby") {
          const note = lobbyNotes[i];
          const osc = current.createOscillator();
          const filter = current.createBiquadFilter();
          const gain = current.createGain();
          osc.type = "triangle";
          osc.frequency.setValueAtTime(note, now);
          filter.type = "lowpass";
          filter.frequency.value = 1500;
          gain.gain.setValueAtTime(0.0001, now);
          gain.gain.exponentialRampToValueAtTime(0.12, now + 0.025);
          gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.42);
          osc.connect(filter);
          filter.connect(gain);
          gain.connect(musicGainRef.current!);
          osc.start(now);
          osc.stop(now + 0.44);
          if (i % 3 === 0) {
            const bass = current.createOscillator();
            const bassGain = current.createGain();
            bass.type = "sine";
            bass.frequency.value = note / 2;
            bassGain.gain.setValueAtTime(0.0001, now);
            bassGain.gain.exponentialRampToValueAtTime(0.055, now + 0.03);
            bassGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.5);
            bass.connect(bassGain);
            bassGain.connect(musicGainRef.current!);
            bass.start(now);
            bass.stop(now + 0.52);
          }
        } else {
          const note = duelNotes[i];
          const osc = current.createOscillator();
          const filter = current.createBiquadFilter();
          const gain = current.createGain();
          osc.type = "sawtooth";
          osc.frequency.setValueAtTime(note, now);
          filter.type = "lowpass";
          filter.frequency.value = 430;
          gain.gain.setValueAtTime(0.0001, now);
          gain.gain.exponentialRampToValueAtTime(0.105, now + 0.035);
          gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.48);
          osc.connect(filter);
          filter.connect(gain);
          gain.connect(musicGainRef.current!);
          osc.start(now);
          osc.stop(now + 0.5);
          if (i % 2 === 0) {
            const sub = current.createOscillator();
            const subGain = current.createGain();
            sub.type = "sine";
            sub.frequency.setValueAtTime(55, now);
            sub.frequency.exponentialRampToValueAtTime(43, now + 0.32);
            subGain.gain.setValueAtTime(0.0001, now);
            subGain.gain.exponentialRampToValueAtTime(0.16, now + 0.025);
            subGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.38);
            sub.connect(subGain);
            subGain.connect(musicGainRef.current!);
            sub.start(now);
            sub.stop(now + 0.4);
          }
        }
      }
      sequenceIndexRef.current += 1;
      sequenceTimerRef.current = window.setTimeout(step, scene === "duel" ? 360 : 300);
    };
    sequenceTimerRef.current = window.setTimeout(step, 100);
    return () => {
      if (sequenceTimerRef.current !== null) window.clearTimeout(sequenceTimerRef.current);
    };
  }, [scene, ensureAudio]);

  useEffect(() => {
    const onMatchFound = () => playMatchFound();
    const onChatMessage = () => {
      if (!prefsRef.current.effects) return;
      // Quiet, short two-tone notification for incoming opponent chat.
      playTone(660, 0.07, 0.045, "triangle", 590);
      window.setTimeout(() => playTone(880, 0.09, 0.04, "sine", 760), 75);
    };
    window.addEventListener("tradeduel:match-found", onMatchFound);
    window.addEventListener("tradeduel:chat-message", onChatMessage);
    return () => {
      window.removeEventListener("tradeduel:match-found", onMatchFound);
      window.removeEventListener("tradeduel:chat-message", onChatMessage);
    };
  }, [playMatchFound, playTone]);

  // Start/resume audio on the first user gesture, then sound route changes.
  useEffect(() => {
    const onFirstGesture = () => { ensureAudio(); };
    const onClick = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const control = target.closest("button, [role='button'], a");
      if (!control || control.hasAttribute("data-audio-silent")) return;
      const isAudioControl = control.closest("[aria-label='Audio settings']");
      if (isAudioControl) return;
      const isLink = control instanceof HTMLAnchorElement || control.getAttribute("role") === "link";
      if (isLink) return; // Navigation chime plays after the route changes.
      if (prefsRef.current.effects) playTone(620, 0.085, 0.045, "triangle", 470);
    };
    document.addEventListener("pointerdown", onFirstGesture, { once: true, capture: true });
    document.addEventListener("click", onClick, true);
    return () => {
      document.removeEventListener("pointerdown", onFirstGesture, true);
      document.removeEventListener("click", onClick, true);
    };
  }, [ensureAudio, playTone]);

  useEffect(() => {
    if (lastPathRef.current !== pathname) {
      const enteringDuel = scene === "duel" && !/\/match\/[^/]+/.test(lastPathRef.current);
      lastPathRef.current = pathname;
      if (started) playNavigation(enteringDuel ? "duel" : "page");
    }
  }, [pathname, scene, started, playNavigation]);

  function toggle(key: keyof AudioPrefs) {
    ensureAudio();
    setPrefs((current) => ({ ...current, [key]: !current[key] }));
  }

  return (
    <aside aria-label="Audio settings" style={{ position: "fixed", right: 16, bottom: 16, zIndex: 1000, display: "flex", alignItems: "center", gap: 6, padding: 7, border: "1px solid var(--td-border)", background: "var(--td-panel)", color: "var(--td-text)", borderRadius: 8, boxShadow: "0 6px 24px var(--td-shadow)" }}>
      <span style={{ fontSize: 10, letterSpacing: "0.12em", color: "var(--td-muted)", padding: "0 4px" }}>{scene === "duel" ? "DUEL AUDIO" : "LOBBY AUDIO"}</span>
      <button type="button" aria-pressed={prefs.music} onClick={() => toggle("music")} style={{ border: "1px solid var(--td-border)", background: prefs.music ? "var(--td-accent-soft)" : "transparent", color: "var(--td-text)", padding: "7px 9px", borderRadius: 5, fontSize: 11, cursor: "pointer" }}>{prefs.music ? "Music on" : "Music off"}</button>
      <button type="button" aria-pressed={prefs.effects} onClick={() => toggle("effects")} style={{ border: "1px solid var(--td-border)", background: prefs.effects ? "var(--td-accent-soft)" : "transparent", color: "var(--td-text)", padding: "7px 9px", borderRadius: 5, fontSize: 11, cursor: "pointer" }}>{prefs.effects ? "SFX on" : "SFX off"}</button>
      <button type="button" onClick={() => { const ctx = ensureAudio(); if (!ctx) return; const oscillator = ctx.createOscillator(); const gain = ctx.createGain(); oscillator.type = "sine"; oscillator.frequency.setValueAtTime(740, ctx.currentTime); oscillator.frequency.exponentialRampToValueAtTime(520, ctx.currentTime + 0.09); gain.gain.setValueAtTime(0.0001, ctx.currentTime); gain.gain.exponentialRampToValueAtTime(0.075, ctx.currentTime + 0.01); gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.15); oscillator.connect(gain); gain.connect(ctx.destination); oscillator.start(); oscillator.stop(ctx.currentTime + 0.16); }} style={{ border: "1px solid var(--td-border)", background: "transparent", color: "var(--td-text)", padding: "7px 9px", borderRadius: 5, fontSize: 11, cursor: "pointer" }}>Test sound</button>
      {!started && <span style={{ fontSize: 9, color: "var(--td-muted)" }}>Click to enable</span>}
    </aside>
  );
}
