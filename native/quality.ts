// The look per graphics level: the browser build's four presets and budgets
// (js/gfx.js TABLE / BUDGETS, each tuned to hold 60 FPS on the weakest GPU
// its Auto gave it) keyed by the runtime's quality tier (frame().quality),
// with the particle pool scaled within the tier by the level
// (frame().levelIndex, at most 2×), as the browser build scaled it by its
// hardware level. The runtime owns the rest of what the old Settings →
// Graphics section did: Auto and the level choice, render scale and the
// pixel-ratio cap, adaptive resolution, the frame-rate limit and readout, the
// GPU summary. The old section's per-category overrides are not offered (the
// runtime's Options choose a level).
import type { QualityTier } from "starhermit:engine";
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
  bloomRes: number;
  aoRes: number;
}
export interface Look {
  preset: QualityTier;
  shadows: 0 | 1024 | 2048 | 4096;
  ao: "off" | "on" | "high";
  bloom: boolean;
  grade: boolean;
  antialias: AntialiasMode;
  particles: "off" | "low" | "high";
  /** PBR materials, room-environment reflections, ground grain, water normals, sky gradient, window glow, kerbs, plinth. */
  detailed: boolean;
  waterAnimated: boolean;
  budget: Budget;
}

/** gfx.js TABLE. */
const TABLE: Record<QualityTier, Omit<Look, "preset" | "budget">> = {
  low: { shadows: 0, ao: "off", bloom: false, grade: false, antialias: "off", particles: "off", detailed: false, waterAnimated: true },
  balanced: { shadows: 1024, ao: "off", bloom: true, grade: true, antialias: "fxaa", particles: "low", detailed: true, waterAnimated: true },
  high: { shadows: 2048, ao: "on", bloom: true, grade: true, antialias: "smaa", particles: "high", detailed: true, waterAnimated: true },
  ultra: { shadows: 4096, ao: "high", bloom: true, grade: true, antialias: "msaa", particles: "high", detailed: true, waterAnimated: true },
};
/** gfx.js BUDGETS. */
const BUDGETS: Record<QualityTier, Budget> = {
  low: { texture: 64, segments: 1, particles: 600, clouds: 3, smokeMs: 400, bloomRes: 0.5, aoRes: 0.5 },
  balanced: { texture: 128, segments: 1, particles: 2000, clouds: 4, smokeMs: 320, bloomRes: 0.5, aoRes: 0.5 },
  high: { texture: 256, segments: 1.5, particles: 2000, clouds: 5, smokeMs: 260, bloomRes: 0.5, aoRes: 0.5 },
  ultra: { texture: 512, segments: 2, particles: 3000, clouds: 7, smokeMs: 200, bloomRes: 1, aoRes: 1 },
};
export const PARTICLE_MAX = 4000;
const PARTICLE_SHARE = { off: 0, low: 0.3, high: 1 };
/** The first level index of each tier. */
const TIER_FLOOR: Record<QualityTier, number> = { low: 0, balanced: 2, high: 4, ultra: 7 };

/** The look for a quality tier at a level index (0 … 9). */
export function lookFor(preset: QualityTier, levelIndex: number): Look {
  const b = { ...BUDGETS[preset] };
  const k = Math.min(2, Math.pow(1.64, Math.max(0, levelIndex - TIER_FLOOR[preset])));
  b.particles = Math.min(PARTICLE_MAX, Math.round(b.particles * k));
  return { preset, ...TABLE[preset], budget: b };
}
/** gfx.js particlePool: the live particle pool for the look. */
export function particlePool(l: Look): number { return Math.round(l.budget.particles * PARTICLE_SHARE[l.particles]); }
