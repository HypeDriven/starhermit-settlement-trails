// Sound, as the browser build's js/audio.js: the authored one-shots
// (sfx/<name>.opus, sfx/manifest.json: audio.js SFX_SAMPLES) per logical
// event and rules event, the adaptive two-layer music bed (a soft sine pad on
// the A minor – G – F – G-ish chord loop, a new chord every 4 s, and a light
// triangle arpeggio every 0.5 s that fades in with the charter's progress)
// and the quiet wind ambience (pink-ish noise low-passed at 400 Hz, the
// cutoff swaying ±150 Hz at 0.07 Hz). The browser build ran the music and the
// ambience live (oscillators on timers, a looping noise buffer); here the pad
// (16 s), the arpeggio (48 s: the chord and the arpeggio step line up again)
// and two LFO periods of the wind are rendered into clips, a slice a frame
// (createClip), and looped on the music bus — the runtime has no ambience
// bus; the wind plays at the old ambience-to-music bus ratio (0.4 / 0.5). The
// synthesized transients audio.js played while a sample decoded are not
// ported (a live synthesis graph makes clip loads fail on the web runtime): a
// clip still loading is silent. The runtime's Options own the volumes and the
// mute. Clips load once the mixer runs (natively at once, in a browser after
// the first press), one at a time.
import { context, createClip, loadClip, play as playClip, type AudioClip, type Sound } from "starhermit:audio";

/** audio.js SFX_SAMPLES. */
const SAMPLES: Record<string, string> = {
  ui: "ui-click", select: "ui-select", place: "build-place", "place-road": "road-place", demolish: "demolish-crash",
  invalid: "invalid-buzz", coin: "coin-chime", fulfill: "order-fulfill", order: "order-new", day: "day-tick", grow: "plant-grow",
  leave: "settler-leave", shortage: "shortage-warn", win: "victory-fanfare", lose: "defeat-drone", achievement: "achievement-unlock",
  pause: "pause-tap", hint: "hint-sparkle",
};
export type Sfx = keyof typeof SAMPLES;
const clips = new Map<string, AudioClip>();
const queue: string[] = [];
let loading = false;
let wantClips = false;
let suspended = false;

/** Asks for the clips; they load once the mixer runs (see update). */
export function loadSfx(): void { wantClips = true; }
/** audio.js play(name). */
export function play(name: Sfx): void {
  if (suspended) return;
  const file = SAMPLES[name];
  if (!file) return;
  const clip = clips.get(file);
  if (!clip) return;
  try { playClip(clip, { bus: "effects" }); } catch { clips.delete(file); if (!queue.includes(file)) queue.push(file); }
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
const SINE_N = 4096;
const SINE = new Float32Array(SINE_N + 1);
for (let i = 0; i <= SINE_N; i++) SINE[i] = Math.sin((i / SINE_N) * 2 * Math.PI);
const CHORDS = [[220.0, 261.6, 329.6], [196.0, 246.9, 293.7], [174.6, 220.0, 261.6], [196.0, 233.1, 311.1]];
const jobs: (() => void)[] = [];

// The pad: each chord's three sines (±0.2 % detune) swell to 0.12 over 1.6 s and fall to silence by 4.4 s,
// a chord every 4 s, through the pad gain 0.16; wrapped round the 16-second loop.
const PAD_N = 16 * RATE;
const pad = new Float32Array(PAD_N);
let padReady = false;
CHORDS.forEach((chord, ci) => {
  chord.forEach((f0, k) => {
    const f = f0 * (1 + ((ci * 3 + k) % 5 - 2) * 0.0008);
    const start = ci * 4 * RATE, len = Math.round(4.6 * RATE), up = 1.6 * RATE, down = 4.4 * RATE;
    const PARTS = 6;
    for (let part = 0; part < PARTS; part++) {
      const i0 = Math.floor((len * part) / PARTS), i1 = Math.floor((len * (part + 1)) / PARTS);
      jobs.push(() => {
        let ph = ((f * i0) / RATE) % 1;
        for (let i = i0; i < i1; i++) {
          const e = i < up ? 0.12 * (i / up) : i < down ? 0.12 + (0.0001 - 0.12) * ((i - up) / (down - up)) : 0;
          const j = (start + i) % PAD_N;
          pad[j] = pad[j]! + SINE[(ph * SINE_N) | 0]! * e * 0.16;
          ph += f / RATE;
          if (ph >= 1) ph -= 1;
        }
      });
    }
  });
});
jobs.push(() => { padReady = true; });

// The arpeggio: every 0.5 s a triangle note an octave above the current chord's next tone (0.09, 20 ms attack,
// exponential fall over 0.5 s) at the layer's full level 0.14 (the voice gain follows the intensity).
const ARP_N = 48 * RATE;
const arp = new Float32Array(ARP_N);
let arpReady = false;
for (let q = 0; q < 96; q += 2) {
  const from = q;
  jobs.push(() => {
    for (let step = from; step < from + 2; step++) {
      const t = step * 0.5;
      const chord = CHORDS[Math.floor(t / 4) % 4]!;
      const f = chord[step % 3]! * 2;
      const start = Math.round(t * RATE), len = Math.round(0.6 * RATE), aN = Math.round(0.02 * RATE);
      const fall = Math.pow(0.0001 / 0.09, 1 / Math.round(0.48 * RATE));
      let ph = 0, env = 0.09;
      for (let i = 0; i < len; i++) {
        let e: number;
        if (i < aN) e = 0.09 * (i / aN);
        else { e = env; env *= fall; }
        const w = 1 - 4 * Math.abs(ph - 0.5);
        const j = (start + i) % ARP_N;
        arp[j] = arp[j]! + w * e * 0.14;
        ph += f / RATE;
        if (ph >= 1) ph -= 1;
      }
    }
  });
}
jobs.push(() => { arpReady = true; });

// The wind: a one-pole pink-ish noise (×2), a 400 Hz low-pass whose cutoff an 0.07 Hz LFO moves ±150 Hz, at 0.35;
// two LFO periods so the loop is seamless (rendered twice round so the filter's state joins up).
const AMB_N = Math.round((2 / 0.07) * RATE);
const amb = new Float32Array(AMB_N);
let ambReady = false;
{
  let seed = 0xa0d10;
  const rnd = (): number => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  let last = 0, x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  const SLICE = 40000;
  for (let a = 0; a < 2 * AMB_N; a += SLICE) {
    const from = a;
    jobs.push(() => {
      const to = Math.min(2 * AMB_N, from + SLICE);
      let b0 = 0, b1 = 0, b2 = 0, a1 = 0, a2 = 0;
      for (let i = from; i < to; i++) {
        if ((i & 63) === 0 || i === from) {
          const t = (i % AMB_N) / RATE;
          const fc = 400 + 150 * Math.sin(2 * Math.PI * 0.07 * t);
          const w = (2 * Math.PI * fc) / RATE, cw = Math.cos(w), al = Math.sin(w) / (2 * 1);
          const a0 = 1 + al;
          b0 = (1 - cw) / 2 / a0; b1 = (1 - cw) / a0; b2 = (1 - cw) / 2 / a0; a1 = -2 * cw / a0; a2 = (1 - al) / a0;
        }
        last = 0.98 * last + 0.02 * (rnd() * 2 - 1);
        const x = last * 2;
        const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
        x2 = x1; x1 = x; y2 = y1; y1 = y;
        if (i >= AMB_N) amb[i - AMB_N] = y * 0.35;
      }
    });
  }
  jobs.push(() => { ambReady = true; });
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

/** Each frame: a synthesis job, the clips once the mixer runs (one at a time), then the loops. */
export function update(): void {
  if (jobs.length) {
    try { jobs.shift()!(); } catch (e) { console.warn(`audio render: ${String(e)}`); }
  }
  if (context.state !== "running") return;
  if (wantClips) {
    wantClips = false;
    for (const n of Object.values(SAMPLES)) if (!queue.includes(n)) queue.push(n);
  }
  if (!loading && queue.length) {
    const name = queue.shift()!;
    if (!clips.has(name)) {
      loading = true;
      loadClip(`sfx/${name}.opus`).then((c) => { clips.set(name, c); loading = false; }, (e: unknown) => {
        console.warn(`sfx ${name}: ${e instanceof Error ? e.message : String(e)}`);
        loading = false;
      });
    }
    return;
  }
  if (loading || !started) return;
  // one clip operation a frame
  try {
    if (padReady && !padClip) { padClip = createClip([pad], RATE); return; }
    if (ambReady && !ambClip) { ambClip = createClip([amb], RATE); return; }
    if (arpReady && !arpClip) { arpClip = createClip([arp], RATE); return; }
    if (padClip && !padVoice) { padVoice = playClip(padClip, { bus: "music", gain: suspended ? 0 : 1, loop: true }); return; }
    if (ambClip && !ambVoice) { ambVoice = playClip(ambClip, { bus: "music", gain: suspended ? 0 : AMB_GAIN, loop: true }); return; }
    if (arpClip && !arpVoice) { arpVoice = playClip(arpClip, { bus: "music", gain: 0, loop: true }); arpLevel = 0; return; }
  } catch (e) { console.warn(`audio: ${String(e)}`); return; }
  if (arpVoice && !suspended && Math.abs(intensity - arpLevel) > 0.02) {
    arpLevel = intensity;
    try { arpVoice.fade(intensity, 0.8); } catch { /* gone */ }
  }
}
