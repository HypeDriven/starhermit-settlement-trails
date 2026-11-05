// The look per graphics level. The engine owns its effects: shadows and their
// map size, ambient occlusion, bloom, the grade and anti-aliasing come from
// levelSettings(). The game keeps its art (js/gfx.js BUDGETS and the rest of
// its TABLE) keyed by the runtime's quality tier, with the particle pool scaled
// within the tier by the level's particle budget (at most 2×). The runtime owns
// the rest of what the old Settings → Graphics section did: Auto and the level
// choice, render scale and the pixel-ratio cap, adaptive resolution, the
// frame-rate limit and readout, the GPU summary. The old section's
// per-category overrides are not offered (the runtime's Options choose a level).
import { levelSettings, type GraphicsLevel, type LevelSettings, type QualityTier } from "starhermit:engine";
import type { AntialiasMode } from "starhermit:scene";

export interface Budget {
  /** Procedural ground texture size in px (the water normal map: half; Detail on). */
  texture: number;
  /** Round-part segment multiplier (tree cones, trunks, logs, wells). */
  segments: number;
  /** Particle pool at Particles "high" (low: 30 %). */
  particles: number;
  /** Drifting low-poly clouds. */
  clouds: number;
  /** Chimney-smoke interval at Particles high (ms). */
  smokeMs: number;
}
export interface Look {
  preset: QualityTier;
  /** The level's shadow map size, 0 = off. */
  shadows: number;
  ao: { resolution: number; samples: number; denoiseSamples: number } | null;
  /** The level's bloom resolution, null = off. */
  bloom: number | null;
  grade: boolean;
  antialias: AntialiasMode;
  particles: "off" | "low" | "high";
  /** PBR materials, room-environment reflections, ground grain, water normals, sky gradient, window glow, kerbs, plinth. */
  detailed: boolean;
  waterAnimated: boolean;
  budget: Budget;
}

type Art = Pick<Look, "particles" | "detailed" | "waterAnimated">;
/** gfx.js TABLE: the game's art columns. */
const ART: Record<QualityTier, Art> = {
  low: { particles: "off", detailed: false, waterAnimated: true },
  balanced: { particles: "low", detailed: true, waterAnimated: true },
  high: { particles: "high", detailed: true, waterAnimated: true },
  ultra: { particles: "high", detailed: true, waterAnimated: true },
};
/** gfx.js BUDGETS. */
const BUDGETS: Record<QualityTier, Budget> = {
  low: { texture: 64, segments: 1, particles: 600, clouds: 3, smokeMs: 400 },
  balanced: { texture: 128, segments: 1, particles: 2000, clouds: 4, smokeMs: 320 },
  high: { texture: 256, segments: 1.5, particles: 2000, clouds: 5, smokeMs: 260 },
  ultra: { texture: 512, segments: 2, particles: 3000, clouds: 7, smokeMs: 200 },
};
export const PARTICLE_MAX = 4000;
const PARTICLE_SHARE = { off: 0, low: 0.3, high: 1 };
/** Each tier's anchor level: its budgets are at this level's particle count. */
const ANCHOR: Record<QualityTier, GraphicsLevel> = { low: "quantum", balanced: "molecular", high: "terrestrial", ultra: "galactic" };

/** The look for a graphics level's settings. */
export function lookFor(s: LevelSettings = levelSettings()): Look {
  const preset = s.quality;
  const b = { ...BUDGETS[preset] };
  const k = Math.min(2, s.particles / levelSettings(ANCHOR[preset]).particles);
  b.particles = Math.min(PARTICLE_MAX, Math.round(b.particles * k));
  return {
    preset, ...ART[preset],
    shadows: s.shadows ? s.shadowMapSize : 0,
    ao: s.ao && { resolution: s.ao.resolution, samples: s.ao.samples, denoiseSamples: s.ao.denoiseSamples },
    bloom: s.bloom ? s.bloom.resolution : null,
    grade: s.grade,
    antialias: s.antialias,
    budget: b,
  };
}
/** gfx.js particlePool: the live particle pool for the look. */
export function particlePool(l: Look): number { return Math.round(l.budget.particles * PARTICLE_SHARE[l.particles]); }
