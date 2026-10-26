import { useEffect, useRef, useState } from "react";
import { useRouterState } from "@tanstack/react-router";

type AudioPrefs = { music: boolean; effects: boolean };
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
  const musicNodesRef = useRef<OscillatorNode[]>([]);
  const musicGainRef = useRef<GainNode | null>(null);
  const prefsRef = useRef(prefs);
  const sceneRef = useRef<"duel" | "lobby">("lobby");

  const scene: "duel" | "lobby" = /\/match\/[^/]+/.test(pathname) ? "duel" : "lobby";

  useEffect(() => {
    const initial = readPrefs();
    setPrefs(initial);
    prefsRef.current = initial;
  }, []);

  useEffect(() => {
    prefsRef.current = prefs;
    try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch { /* Settings still work for this session. */ }
    if (musicGainRef.current && audioRef.current) {
      const target = prefs.music ? (sceneRef.current === "duel" ? 0.018 : 0.012) : 0;
      musicGainRef.current.gain.setTargetAtTime(target, audioRef.current.currentTime, 0.8);
    }
  }, [prefs]);

  useEffect(() => {
    sceneRef.current = scene;
    if (musicGainRef.current && audioRef.current) {
      musicGainRef.current.gain.setTargetAtTime(prefsRef.current.music ? (scene === "duel" ? 0.018 : 0.012) : 0, audioRef.current.currentTime, 1.4);
    }
  }, [scene]);

  function ensureAudio() {
    if (typeof window === "undefined") return null;
    const AudioContextClass = window.AudioContext;
    if (!AudioContextClass) return null;
    if (!audioRef.current) {
      const ctx = new AudioContextClass();
      audioRef.current = ctx;
      const master = ctx.createGain();
      master.gain.value = 1;
      master.connect(ctx.destination);
      const musicGain = ctx.createGain();
      musicGain.gain.value = prefsRef.current.music ? (sceneRef.current === "duel" ? 0.018 : 0.012) : 0;
      musicGain.connect(master);
      musicGainRef.current = musicGain;
      const notes = sceneRef.current === "duel" ? [55, 82.41, 110] : [65.41, 98, 130.81];
      const oscillators = notes.map((frequency, index) => {
        const osc = ctx.createOscillator();
        const filter = ctx.createBiquadFilter();
        const voiceGain = ctx.createGain();
        osc.type = index === 0 ? "sine" : "triangle";
        osc.frequency.value = frequency;
        filter.type = "lowpass";
        filter.frequency.value = sceneRef.current === "duel" ? 180 : 240;
        voiceGain.gain.value = index === 0 ? 0.35 : 0.16;
        osc.connect(filter);
        filter.connect(voiceGain);
        voiceGain.connect(musicGain);
        osc.start();
        return osc;
      });
      musicNodesRef.current = oscillators;
      setStarted(true);
    }
    if (audioRef.current.state === "suspended") void audioRef.current.resume();
    return audioRef.current;
  }

  useEffect(() => {
    const onFirstGesture = () => { ensureAudio(); };
    const onClick = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const button = target.closest("button, [role='button'], a[data-audio-click]");
      if (!button || button.hasAttribute("data-audio-silent") || !prefsRef.current.effects) return;
      const ctx = ensureAudio();
      if (!ctx) return;
      const oscillator = ctx.createOscillator();
      const gain = ctx.createGain();
      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(620, ctx.currentTime);
      oscillator.frequency.exponentialRampToValueAtTime(420, ctx.currentTime + 0.055);
      gain.gain.setValueAtTime(0.0001, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.022, ctx.currentTime + 0.008);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.075);
      oscillator.connect(gain);
      gain.connect(ctx.destination);
      oscillator.start();
      oscillator.stop(ctx.currentTime + 0.08);
    };
    document.addEventListener("pointerdown", onFirstGesture, { once: true, capture: true });
    document.addEventListener("click", onClick, true);
    return () => {
      document.removeEventListener("pointerdown", onFirstGesture, true);
      document.removeEventListener("click", onClick, true);
    };
  }, []);

  function toggle(key: keyof AudioPrefs) {
    setPrefs((current) => ({ ...current, [key]: !current[key] }));
    ensureAudio();
  }

  return (
    <aside aria-label="Audio settings" style={{ position: "fixed", right: 16, bottom: 16, zIndex: 1000, display: "flex", alignItems: "center", gap: 6, padding: 7, border: "1px solid var(--td-border)", background: "var(--td-panel)", color: "var(--td-text)", borderRadius: 8, boxShadow: "0 6px 24px rgba(0,0,0,.22)" }}>
      <span style={{ fontSize: 10, letterSpacing: "0.12em", color: "var(--td-muted)", padding: "0 4px" }}>{scene === "duel" ? "DUEL AUDIO" : "LOBBY AUDIO"}</span>
      <button type="button" aria-pressed={prefs.music} onClick={() => toggle("music")} style={{ border: "1px solid var(--td-border)", background: prefs.music ? "var(--td-accent-soft)" : "transparent", color: "var(--td-text)", padding: "7px 9px", borderRadius: 5, fontSize: 11, cursor: "pointer" }}>{prefs.music ? "Music on" : "Music off"}</button>
      <button type="button" aria-pressed={prefs.effects} onClick={() => toggle("effects")} style={{ border: "1px solid var(--td-border)", background: prefs.effects ? "var(--td-accent-soft)" : "transparent", color: "var(--td-text)", padding: "7px 9px", borderRadius: 5, fontSize: 11, cursor: "pointer" }}>{prefs.effects ? "SFX on" : "SFX off"}</button>
      {!started && <span style={{ fontSize: 9, color: "var(--td-muted)" }}>Click to enable</span>}
    </aside>
  );
}
