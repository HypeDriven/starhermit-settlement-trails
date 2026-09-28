// gfx.js — graphics quality model: presets, per-category overrides, GPU
// detection and a cost summary. Pure (no three.js) so the settings panel, the
// renderer and the unit tests agree on what a setting means.

export const PRESETS = ['low', 'balanced', 'high', 'ultra'];

// Category → allowed tiers, cheapest first.
export const CATEGORIES = {
  shadows: ['off', 'low', 'medium', 'high'],
  ao: ['off', 'on', 'high'],
  bloom: ['off', 'on'],
  grade: ['off', 'on'],
  antialias: ['off', 'fxaa', 'smaa', 'msaa'],
  particles: ['off', 'low', 'high'],
  detail: ['plain', 'detailed'],
  water: ['static', 'animated'],
};

// Each preset is a row of tiers, a render scale (multiplies the device pixel
// ratio) and a device-pixel-ratio cap. Low matches the pre-upgrade low tier:
// flat Lambert shading, no shadows, no post chain, 1× pixels.
const TABLE = {
  low:      { scale: 1,    dprCap: 1,   shadows: 'off',    ao: 'off',  bloom: 'off', grade: 'off', antialias: 'off',  particles: 'off',  detail: 'plain',    water: 'animated' },
  balanced: { scale: 1,    dprCap: 1.5, shadows: 'low',    ao: 'off',  bloom: 'on',  grade: 'on',  antialias: 'fxaa', particles: 'low',  detail: 'detailed', water: 'animated' },
  high:     { scale: 1,    dprCap: 2,   shadows: 'medium', ao: 'on',   bloom: 'on',  grade: 'on',  antialias: 'smaa', particles: 'high', detail: 'detailed', water: 'animated' },
  ultra:    { scale: 1.25, dprCap: 2,   shadows: 'high',   ao: 'high', bloom: 'on',  grade: 'on',  antialias: 'msaa', particles: 'high', detail: 'detailed', water: 'animated' },
};

export const SHADOW_MAP = { off: 0, low: 1024, medium: 2048, high: 4096 };
export const PARTICLE_POOL = { off: 0, low: 600, high: 2000 };

/** Best preset for this GPU, from the unmasked renderer string when exposed. */
export function detectPreset(gpu, { mobile = false } = {}) {
  const g = String(gpu || '').toLowerCase();
  let p = 'balanced';
  if (/swiftshader|llvmpipe|softpipe|software|basic render|microsoft basic/.test(g)) p = 'low';
  else if (/nvidia|geforce|rtx|gtx|quadro|radeon rx|radeon pro|amd radeon(?! graphics)|apple m\d/.test(g)) p = 'high';
  // Touch/mobile devices never auto-select above Balanced.
  if (mobile && PRESETS.indexOf(p) > PRESETS.indexOf('balanced')) p = 'balanced';
  return p;
}

/**
 * Resolve saved settings into concrete tiers.
 * `saved`: { preset: 'auto'|preset, render_scale, adaptive, show_fps, <category>: 'preset'|tier }.
 */
export function resolve(saved, detected) {
  const s = saved || {};
  const auto = !PRESETS.includes(s.preset);
  const preset = auto ? (PRESETS.includes(detected) ? detected : 'balanced') : s.preset;
  const row = TABLE[preset];
  const userScale = clamp(Number(s.render_scale) || 1, 0.5, 2);
  const out = { preset, auto, userScale, scale: row.scale * userScale, dprCap: row.dprCap };
  for (const [cat, tiers] of Object.entries(CATEGORIES)) {
    out[cat] = tiers.includes(s[cat]) ? s[cat] : row[cat];
  }
  out.adaptive = s.adaptive !== false;
  out.showFps = !!s.show_fps;
  // The composer runs only when something needs it; Low renders directly.
  out.post = out.ao !== 'off' || out.bloom === 'on' || out.grade === 'on' || out.antialias !== 'off';
  return out;
}

/** Apply a preset choice: the preset replaces all per-category overrides. */
export function choosePreset(saved, preset) {
  const s = { ...(saved || {}) };
  for (const cat of Object.keys(CATEGORIES)) delete s[cat];
  s.preset = PRESETS.includes(preset) ? preset : 'auto';
  return s;
}

/** The preset's own tier for a category (for "From preset (…)" labels). */
export function presetTier(preset, cat) {
  return TABLE[preset]?.[cat];
}

/** Short cost summary, e.g. "2048² shadows · AO · bloom · SMAA · 1280×800 px". */
export function describe(r, pixels) {
  const parts = [
    r.shadows === 'off' ? 'no shadows' : `${SHADOW_MAP[r.shadows]}² shadows`,
    r.ao === 'off' ? null : r.ao === 'high' ? 'full AO' : 'AO',
    r.bloom === 'on' ? 'bloom' : null,
    r.grade === 'on' ? 'grade' : null,
    r.antialias === 'off' ? 'no AA' : r.antialias.toUpperCase(),
    r.particles === 'off' ? null : `${PARTICLE_POOL[r.particles]} particles`,
    pixels && pixels[0] > 1 ? `${pixels[0]}×${pixels[1]} px` : null,
  ];
  return parts.filter(Boolean).join(' · ');
}

function clamp(v, a, b) {
  return Math.min(b, Math.max(a, v));
}
