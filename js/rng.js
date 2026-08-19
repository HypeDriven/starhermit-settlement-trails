// rng.js — deterministic seeded random streams.
// Separate streams for rules / decoration / audiovisual variants so cosmetic
// randomness never affects rules outcomes.

// FNV-1a string hash -> uint32. Used to derive numeric seeds from content ids.
export function hashString(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// mulberry32 — small, fast, deterministic PRNG.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A named random stream with serializable position, so full state snapshots
// (including RNG position) are possible.
export class RngStream {
  constructor(seed, name = 'stream', counter = 0) {
    this.seed = seed >>> 0;
    this.name = name;
    this.counter = counter >>> 0;
  }
  // Stateless-by-counter: value depends only on (seed, counter).
  _next() {
    const fn = mulberry32((this.seed + Math.imul(this.counter, 0x9e3779b1)) >>> 0);
    this.counter = (this.counter + 1) >>> 0;
    return fn();
  }
  float() { return this._next(); }
  int(lo, hi) { // inclusive both ends
    return lo + Math.floor(this._next() * (hi - lo + 1));
  }
  pick(arr) { return arr[this.int(0, arr.length - 1)]; }
  chance(p) { return this._next() < p; }
  shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = this.int(0, i);
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }
  fork(name) {
    return new RngStream((this.seed ^ hashString(name)) >>> 0, this.name + '/' + name);
  }
  snapshot() { return { seed: this.seed, name: this.name, counter: this.counter }; }
  static fromSnapshot(s) { return new RngStream(s.seed, s.name, s.counter); }
}

// Stable JSON stringify (sorted keys) for state hashing.
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
}

export function stateHash(obj) {
  return hashString(stableStringify(obj)).toString(16).padStart(8, '0');
}
