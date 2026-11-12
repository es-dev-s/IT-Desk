/**
 * A short, soft two-note chime made with WebAudio (no asset to load).
 * Browsers only allow audio after a user gesture, so the context is created
 * lazily and resumed on the first pointer/key press.
 */
let ctx: AudioContext | null = null;
let unlocked = false;

function context() {
  if (typeof window === "undefined") return null;
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  ctx ??= new Ctor();
  return ctx;
}

export function unlockAudioOnGesture() {
  if (unlocked || typeof window === "undefined") return () => {};
  const unlock = () => {
    unlocked = true;
    void context()?.resume();
    window.removeEventListener("pointerdown", unlock);
    window.removeEventListener("keydown", unlock);
  };
  window.addEventListener("pointerdown", unlock);
  window.addEventListener("keydown", unlock);
  return () => {
    window.removeEventListener("pointerdown", unlock);
    window.removeEventListener("keydown", unlock);
  };
}

const CHIME_KEY = "itdesk.chime.last";

/** Plays once per notification id across tabs (the first tab to claim it wins). */
export function playChime(id?: number) {
  try {
    if (id !== undefined) {
      if (localStorage.getItem(CHIME_KEY) === String(id)) return;
      localStorage.setItem(CHIME_KEY, String(id));
    }
  } catch {
    /* storage blocked: just play */
  }
  const ac = context();
  if (!ac) return;
  if (ac.state === "suspended") {
    // Works right after a click (e.g. "Test"); silently skipped before any gesture.
    void ac.resume().then(() => (ac.state === "running" ? tones(ac) : undefined)).catch(() => {});
    return;
  }
  tones(ac);
}

function tones(ac: AudioContext) {
  const now = ac.currentTime;
  [
    { f: 880, t: 0 },
    { f: 1318.5, t: 0.11 },
  ].forEach(({ f, t }) => {
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = "sine";
    osc.frequency.value = f;
    gain.gain.setValueAtTime(0.0001, now + t);
    gain.gain.exponentialRampToValueAtTime(0.12, now + t + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + t + 0.42);
    osc.connect(gain).connect(ac.destination);
    osc.start(now + t);
    osc.stop(now + t + 0.45);
  });
}
