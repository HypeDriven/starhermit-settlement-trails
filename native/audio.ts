// Sound, as the browser build's js/audio.js: the authored one-shots
// (sfx/<name>.opus, sfx/manifest.json: audio.js SFX_SAMPLES) per logical
// event and rules event, the adaptive two-layer music bed (a soft sine pad on
// the A minor – G – F – G-ish chord loop, a new chord every 4 s, and a light
// triangle arpeggio every 0.5 s that fades in with the charter's progress)
// and the quiet wind ambience (low-passed noise, the cutoff swaying ±150 Hz
// around 400 Hz at 0.07 Hz). The browser build ran the music and the ambience
// live (oscillators on timers, a looping noise buffer); here the pad (16 s),
// the arpeggio (48 s: the chord and the arpeggio step line up again) and two
// LFO periods of the wind are rendered natively into clips
// (OfflineAudioContext) and looped on the music bus — the runtime has no
// ambience bus; the wind plays at the old ambience-to-music bus ratio
// (0.4 / 0.5). The runtime's Options own the volumes and the mute. Every clip
// loads at the start; a cue whose clip is still loading is skipped; the loops
// start once the mixer runs and the player has pressed something.
import { context, createClip, loadClip, OfflineAudioContext, play as playClip, type AudioBuffer, type AudioClip, type Sound } from "starhermit:audio";

/** audio.js SFX_SAMPLES. */
const SAMPLES: Record<string, string> = {
  ui: "ui-click", select: "ui-select", place: "build-place", "place-road": "road-place", demolish: "demolish-crash",
  invalid: "invalid-buzz", coin: "coin-chime", fulfill: "order-fulfill", order: "order-new", day: "day-tick", grow: "plant-grow",
  leave: "settler-leave", shortage: "shortage-warn", win: "victory-fanfare", lose: "defeat-drone", achievement: "achievement-unlock",
  pause: "pause-tap", hint: "hint-sparkle",
};
export type Sfx = keyof typeof SAMPLES;
const clips = new Map<string, AudioClip>();
let suspended = false;

/** Loads every clip and starts the loops' renders (onStart). */
export function loadSfx(): void {
  for (const name of new Set(Object.values(SAMPLES))) {
    loadClip(`sfx/${name}.opus`).then((c) => { clips.set(name, c); }, (e: unknown) => { console.warn(`sfx ${name}: ${e instanceof Error ? e.message : String(e)}`); });
  }
  const failed = (e: unknown): void => { console.warn(`audio render: ${String(e)}`); };
  renderPad().then((c) => { padClip = c; }, failed);
  renderArp().then((c) => { arpClip = c; }, failed);
  renderWind().then((c) => { ambClip = c; }, failed);
}
/** audio.js play(name). */
export function play(name: Sfx): void {
  if (suspended) return;
  const file = SAMPLES[name];
  if (!file) return;
  const clip = clips.get(file);
  if (!clip) return;
  try { playClip(clip, { bus: "effects" }); } catch { /* the mixer is full this frame: skip it */ }
}
/** audio.js playEvent: rules events to sounds. */
export function playEvent(ev: { kind: string; building?: string }): void {
  switch (ev.kind) {
    case "place": play(ev.building === "road" ? "place-road" : "place"); break;
    case "demolish": play("demolish"); break;
    case "fulfill": play("fulfill"); break;
    case "order": play("order"); break;
    case "invalid": play("invalid"); break;
    case "leave": play("leave"); break;
    case "shortage": play("shortage"); break;
    case "won": play("win"); break;
    case "lost": play("lose"); break;
    default: break;
  }
}

// -- synthesis ----------------------------------------------------------------------------------
const RATE = 22050;
const CHORDS = [[220.0, 261.6, 329.6], [196.0, 246.9, 293.7], [174.6, 220.0, 261.6], [196.0, 233.1, 311.1]];
/** A loop of n samples from a render that rang on past it: the tail wraps round onto the start. */
function looped(r: AudioBuffer, n: number): AudioClip {
  const d = r.getChannelData(0), out = d.slice(0, n);
  for (let i = n; i < d.length; i++) out[i - n] = out[i - n]! + d[i]!;
  return createClip([out], RATE);
}

// The pad: each chord's three sines (±0.2 % detune) swell to 0.12 over 1.6 s and fall to silence by 4.4 s,
// a chord every 4 s, through the pad gain 0.16; wrapped round the 16-second loop.
async function renderPad(): Promise<AudioClip> {
  const off = new OfflineAudioContext(1, Math.round(16.4 * RATE), RATE);
  const master = off.createGain();
  master.gain.value = 0.16;
  master.connect(off.destination);
  CHORDS.forEach((chord, ci) => {
    chord.forEach((f0, k) => {
      const t = ci * 4;
      const osc = off.createOscillator(), env = off.createGain();
      osc.frequency.value = f0 * (1 + ((ci * 3 + k) % 5 - 2) * 0.0008);
      env.gain.setValueAtTime(0, t);
      env.gain.linearRampToValueAtTime(0.12, t + 1.6);
      env.gain.linearRampToValueAtTime(0.0001, t + 4.4);
      env.gain.setValueAtTime(0, t + 4.4);
      osc.connect(env).connect(master);
      osc.start(t);
      osc.stop(t + 4.4);
    });
  });
  return looped(await off.startRendering(), 16 * RATE);
}

// The arpeggio: every 0.5 s a triangle note an octave above the current chord's next tone (0.09, 20 ms attack,
// exponential fall over 0.48 s) at the layer's full level 0.14 (the voice gain follows the intensity).
// One oscillator and gain a pitch, the notes as its gain's automation: 96 notes would pass a context's node bound.
async function renderArp(): Promise<AudioClip> {
  const off = new OfflineAudioContext(1, Math.round(48.6 * RATE), RATE);
  const master = off.createGain();
  master.gain.value = 0.14;
  master.connect(off.destination);
  const voices = new Map<number, ReturnType<typeof off.createGain>>();
  for (let step = 0; step < 96; step++) {
    const t = step * 0.5;
    const f = CHORDS[Math.floor(t / 4) % 4]![step % 3]! * 2;
    let env = voices.get(f);
    if (!env) {
      const osc = off.createOscillator();
      osc.type = "triangle";
      osc.frequency.value = f;
      env = off.createGain();
      env.gain.value = 0;
      osc.connect(env).connect(master);
      osc.start();
      voices.set(f, env);
    }
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(0.09, t + 0.02);
    env.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
    env.gain.setValueAtTime(0, t + 0.6);
  }
  return looped(await off.startRendering(), 48 * RATE);
}

// The wind: brown noise over a 40 Hz high-pass (the old one-pole pink-ish noise had no sub-bass), a 400 Hz
// low-pass (Q as the old one, linear 1) whose cutoff an 0.07 Hz LFO moves ±150 Hz, level matched to the old bed;
// two LFO periods, so a settled render of the periodic noise and LFO loops seamlessly.
const WIND_GAIN = 0.2146; // 0.35 on the old noise: rms .0402 as the old bed
async function renderWind(): Promise<AudioClip> {
  const n = Math.round((2 / 0.07) * RATE), settle = RATE;
  const off = new OfflineAudioContext(1, settle + n, RATE);
  const noise = off.createNoise({ color: "brown", seed: 0xa0d10, seconds: n / RATE });
  const hp = off.createBiquadFilter();
  hp.type = "highpass";
  hp.frequency.value = 40;
  const lp = off.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = 400;
  lp.Q.value = 0;
  const lfo = off.createOscillator(), depth = off.createGain();
  lfo.frequency.value = 0.07;
  depth.gain.value = 150;
  lfo.connect(depth).connect(lp.frequency);
  const g = off.createGain();
  g.gain.value = WIND_GAIN;
  noise.connect(hp).connect(lp).connect(g).connect(off.destination);
  noise.start();
  lfo.start();
  const r = await off.startRendering();
  return createClip([r.getChannelData(0).slice(settle)], RATE);
}

// -- playback ---------------------------------------------------------------------------------
/** The ambience bus sat at 0.4 against music's 0.5. */
const AMB_GAIN = 0.4 / 0.5;
let padClip: AudioClip | null = null, arpClip: AudioClip | null = null, ambClip: AudioClip | null = null;
let padVoice: Sound | null = null, arpVoice: Sound | null = null, ambVoice: Sound | null = null;
let started = false;
let intensity = 0;
let arpLevel = -1;
/** audio.js start(): the music and the ambience from the first press on (as the old AudioContext unlock). */
export function start(): void { started = true; }
/** audio.js setIntensity: the arpeggio layer eases toward the charter's progress (0–1). */
export function setIntensity(x: number): void { intensity = Math.max(0, Math.min(1, x)); }
/** A hidden window silences the loops (audio.js suspend / resume). */
export function setSuspended(on: boolean): void {
  if (on === suspended) return;
  suspended = on;
  try {
    padVoice?.fade(on ? 0 : 1, 0.2);
    ambVoice?.fade(on ? 0 : AMB_GAIN, 0.2);
    arpVoice?.fade(on ? 0 : intensity, 0.2);
  } catch { /* gone */ }
}

/** Each frame: the loops, once the mixer runs and the player has pressed something. */
export function update(): void {
  if (context.state !== "running" || !started) return;
  try {
    if (padClip && !padVoice) padVoice = playClip(padClip, { bus: "music", gain: suspended ? 0 : 1, loop: true });
    if (ambClip && !ambVoice) ambVoice = playClip(ambClip, { bus: "music", gain: suspended ? 0 : AMB_GAIN, loop: true });
    if (arpClip && !arpVoice) { arpVoice = playClip(arpClip, { bus: "music", gain: 0, loop: true }); arpLevel = 0; }
  } catch (e) { console.warn(`audio: ${String(e)}`); return; }
  if (arpVoice && !suspended && Math.abs(intensity - arpLevel) > 0.02) {
    arpLevel = intensity;
    try { arpVoice.fade(intensity, 0.8); } catch { /* gone */ }
  }
}
