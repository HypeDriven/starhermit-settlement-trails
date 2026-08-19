// audio.js — WebAudio procedural audio: independent buses (music/effects/
// ambience/voice), short original transients tied to logical events, quiet
// ambience and an adaptive two-layer music bed. Pitch variants are seeded.

import { RngStream } from './rng.js';

export class AudioEngine {
  constructor(settings) {
    this.settings = settings;
    this.ctx = null;
    this.buses = {};
    this.started = false;
    this.ambNodes = null;
    this.musicNodes = null;
    this.rng = new RngStream(0xa0d10, 'audio');
    this.intensity = 0; // 0..1 adaptive music intensity
  }

  // Must be called from a user gesture.
  start() {
    if (this.started) return;
    try {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    } catch { return; }
    const mk = (name) => {
      const g = this.ctx.createGain();
      g.connect(this.ctx.destination);
      this.buses[name] = g;
      return g;
    };
    mk('music'); mk('effects'); mk('ambience'); mk('voice');
    this.applySettings(this.settings);
    this._startAmbience();
    this._startMusic();
    this.started = true;
  }

  applySettings(s) {
    this.settings = s;
    if (!this.ctx) return;
    const mute = s.muteAll ? 0 : 1;
    this.buses.music.gain.value = s.music * 0.5 * mute;
    this.buses.effects.gain.value = s.effects * mute;
    this.buses.ambience.gain.value = s.ambience * 0.4 * mute;
    this.buses.voice.gain.value = s.voice * mute;
  }

  suspend() { if (this.ctx && this.ctx.state === 'running') this.ctx.suspend(); }
  resume() { if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume(); }

  // ---- primitives ----------------------------------------------------------
  _env(bus, t0, a, d, peak = 1) {
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(peak, t0 + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + a + d);
    g.connect(this.buses[bus]);
    return g;
  }

  _osc(type, freq, t0, dur, bus, peak = 0.5, detune = 0) {
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t0);
    o.detune.value = detune;
    const g = this._env(bus, t0, 0.005, dur, peak);
    o.connect(g);
    o.start(t0);
    o.stop(t0 + dur + 0.05);
    return o;
  }

  _noise(t0, dur, bus, peak = 0.3, filterFreq = 1200, q = 1) {
    const len = Math.max(1, Math.floor(this.ctx.sampleRate * dur));
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const f = this.ctx.createBiquadFilter();
    f.type = 'bandpass'; f.frequency.value = filterFreq; f.Q.value = q;
    const g = this._env(bus, t0, 0.003, dur, peak);
    src.connect(f); f.connect(g);
    src.start(t0);
    return src;
  }

  // ---- event mapping ---------------------------------------------------------
  // variant: integer seed for pitch randomization (replay-consistent).
  play(name, variant = 0) {
    if (!this.started || !this.ctx || this.ctx.state !== 'running') return;
    const rng = new RngStream((0xa0d10 + variant * 7919) >>> 0, 'fx');
    const t = this.ctx.currentTime;
    const pv = 1 + (rng.float() - 0.5) * 0.12; // pitch variant
    switch (name) {
      case 'ui': this._osc('triangle', 660 * pv, t, 0.07, 'effects', 0.18); break;
      case 'select': this._osc('sine', 520 * pv, t, 0.06, 'effects', 0.2); break;
      case 'place':
        this._noise(t, 0.12, 'effects', 0.35, 900 * pv, 1.2);
        this._osc('triangle', 180 * pv, t, 0.12, 'effects', 0.3);
        break;
      case 'place-road': this._noise(t, 0.09, 'effects', 0.25, 500 * pv, 1); break;
      case 'demolish': this._noise(t, 0.2, 'effects', 0.4, 300 * pv, 0.8); break;
      case 'invalid': this._osc('square', 140, t, 0.12, 'effects', 0.15); this._osc('square', 110, t + 0.09, 0.14, 'effects', 0.15); break;
      case 'coin': case 'fulfill':
        this._osc('sine', 880 * pv, t, 0.1, 'effects', 0.25);
        this._osc('sine', 1320 * pv, t + 0.07, 0.14, 'effects', 0.2);
        break;
      case 'order': this._osc('triangle', 700 * pv, t, 0.12, 'effects', 0.2); this._osc('triangle', 940 * pv, t + 0.1, 0.12, 'effects', 0.16); break;
      case 'day': this._noise(t, 0.06, 'effects', 0.1, 2000, 2); break;
      case 'grow': this._osc('sine', 620 * pv, t, 0.09, 'effects', 0.15); break;
      case 'leave': this._osc('sine', 300, t, 0.15, 'effects', 0.18); break;
      case 'shortage': this._osc('sawtooth', 220, t, 0.25, 'effects', 0.14); break;
      case 'win':
        [523, 659, 784, 1047].forEach((f, i) => this._osc('triangle', f, t + i * 0.13, 0.3, 'effects', 0.25));
        break;
      case 'lose':
        [392, 330, 262].forEach((f, i) => this._osc('triangle', f, t + i * 0.18, 0.35, 'effects', 0.22));
        break;
      case 'achievement':
        [784, 988, 1175, 1568].forEach((f, i) => this._osc('sine', f, t + i * 0.09, 0.25, 'effects', 0.2));
        break;
      case 'pause': this._osc('sine', 440, t, 0.08, 'effects', 0.12); break;
      case 'hint': this._osc('sine', 990, t, 0.12, 'effects', 0.15); break;
      default: break;
    }
  }

  // Map rules events to sounds.
  playEvent(ev) {
    const v = ev.tick || 0;
    switch (ev.kind) {
      case 'place': this.play(ev.building === 'road' ? 'place-road' : 'place', v); break;
      case 'demolish': this.play('demolish', v); break;
      case 'fulfill': this.play('fulfill', v); break;
      case 'order': this.play('order', v); break;
      case 'invalid': this.play('invalid', v); break;
      case 'leave': this.play('leave', v); break;
      case 'shortage': this.play('shortage', v); break;
      case 'won': this.play('win', v); break;
      case 'lost': this.play('lose', v); break;
      default: break;
    }
  }

  // ---- ambience -----------------------------------------------------------------
  _startAmbience() {
    const ctx = this.ctx;
    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) { // pink-ish noise
      last = 0.98 * last + 0.02 * (Math.random() * 2 - 1);
      d[i] = last * 2;
    }
    const src = ctx.createBufferSource();
    src.buffer = buf; src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass'; f.frequency.value = 400;
    const g = ctx.createGain(); g.gain.value = 0.35;
    src.connect(f); f.connect(g); g.connect(this.buses.ambience);
    src.start();
    // Slow LFO on the filter for a wind-like feel.
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.07;
    const lg = ctx.createGain(); lg.gain.value = 150;
    lfo.connect(lg); lg.connect(f.frequency);
    lfo.start();
    this.ambNodes = { src, lfo };
  }

  // ---- adaptive music ---------------------------------------------------------------
  // Two layers: a soft pad (always) and a light arpeggio (fades in with intensity).
  _startMusic() {
    const ctx = this.ctx;
    this.musicNodes = { padGain: ctx.createGain(), arpGain: ctx.createGain(), step: 0 };
    this.musicNodes.padGain.gain.value = 0.16;
    this.musicNodes.arpGain.gain.value = 0.0;
    this.musicNodes.padGain.connect(this.buses.music);
    this.musicNodes.arpGain.connect(this.buses.music);
    const chords = [
      [220.0, 261.6, 329.6], [196.0, 246.9, 293.7],
      [174.6, 220.0, 261.6], [196.0, 233.1, 311.1],
    ];
    let chordIdx = 0;
    const padInterval = () => {
      if (!this.ctx || this.ctx.state !== 'running') return;
      const t = ctx.currentTime;
      const chord = chords[chordIdx % chords.length];
      chordIdx++;
      for (const f of chord) {
        const o = ctx.createOscillator();
        o.type = 'sine'; o.frequency.value = f * (1 + (this.rng.float() - 0.5) * 0.004);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(0.12, t + 1.6);
        g.gain.linearRampToValueAtTime(0.0001, t + 4.4);
        o.connect(g); g.connect(this.musicNodes.padGain);
        o.start(t); o.stop(t + 4.6);
      }
    };
    padInterval();
    this._padTimer = setInterval(padInterval, 4000);
    this._arpTimer = setInterval(() => {
      if (!this.ctx || this.ctx.state !== 'running') return;
      const t = ctx.currentTime;
      const chord = chords[(chordIdx - 1 + chords.length) % chords.length];
      const f = chord[this.musicNodes.step % chord.length] * 2;
      this.musicNodes.step++;
      const o = ctx.createOscillator();
      o.type = 'triangle'; o.frequency.value = f;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.09, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
      o.connect(g); g.connect(this.musicNodes.arpGain);
      o.start(t); o.stop(t + 0.6);
      // Adaptive: ease arp layer toward intensity.
      const target = 0.14 * this.intensity;
      this.musicNodes.arpGain.gain.setTargetAtTime(target, t, 0.8);
    }, 500);
  }

  setIntensity(x) { this.intensity = Math.max(0, Math.min(1, x)); }

  dispose() {
    clearInterval(this._padTimer);
    clearInterval(this._arpTimer);
    if (this.ctx) this.ctx.close().catch(() => {});
    this.started = false;
  }
}
