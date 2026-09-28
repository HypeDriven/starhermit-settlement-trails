// tests/gfx.test.js — graphics quality model (js/gfx.js): GPU detection,
// preset resolution, overrides, render-scale clamp and preset-clears-overrides.
import test from 'node:test';
import assert from 'node:assert/strict';
import { detectPreset, resolve, choosePreset, presetTier, describe, PRESETS, CATEGORIES } from '../js/gfx.js';
import { GFX_STRINGS, gfxLocale } from '../js/gfx-strings.js';

test('detectPreset maps GPU strings to tiers', () => {
  assert.equal(detectPreset('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)'), 'low');
  assert.equal(detectPreset('llvmpipe (LLVM 15.0.7, 256 bits)'), 'low');
  assert.equal(detectPreset('ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 Direct3D11 vs_5_0 ps_5_0)'), 'high');
  assert.equal(detectPreset('Apple M2'), 'high');
  assert.equal(detectPreset('ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11)'), 'balanced');
  assert.equal(detectPreset('Adreno (TM) 650'), 'balanced');
  assert.equal(detectPreset(''), 'balanced');
  // Touch/mobile devices cap Auto at Balanced.
  assert.equal(detectPreset('Apple M2', { mobile: true }), 'balanced');
  assert.equal(detectPreset('SwiftShader', { mobile: true }), 'low');
});

test('resolve: auto uses the detected preset, explicit preset wins', () => {
  const a = resolve({}, 'low');
  assert.equal(a.preset, 'low');
  assert.equal(a.auto, true);
  assert.equal(a.post, false, 'Low renders without a post chain');
  assert.equal(a.shadows, 'off');
  const h = resolve({ preset: 'high' }, 'low');
  assert.equal(h.preset, 'high');
  assert.equal(h.auto, false);
  assert.equal(h.shadows, 'medium');
  assert.equal(h.post, true);
  assert.equal(resolve({ preset: 'bogus' }, 'nope').preset, 'balanced');
});

test('resolve: per-category overrides and invalid tiers', () => {
  const r = resolve({ preset: 'low', bloom: 'on', shadows: 'high', ao: 'nonsense' }, 'low');
  assert.equal(r.bloom, 'on');
  assert.equal(r.shadows, 'high');
  assert.equal(r.ao, 'off', 'invalid tier falls back to the preset');
  assert.equal(r.post, true, 'an override that needs post enables the chain');
  for (const p of PRESETS) for (const cat of Object.keys(CATEGORIES)) {
    assert.ok(CATEGORIES[cat].includes(presetTier(p, cat)), `${p}.${cat} is a valid tier`);
  }
});

test('resolve: render scale is clamped to 50–200 %', () => {
  assert.equal(resolve({ preset: 'high', render_scale: 5 }, 'low').scale, 2);
  assert.equal(resolve({ preset: 'high', render_scale: 0.1 }, 'low').scale, 0.5);
  assert.equal(resolve({ preset: 'ultra', render_scale: 1 }, 'low').scale, 1.25);
  assert.equal(resolve({ preset: 'high' }, 'low').adaptive, true);
  assert.equal(resolve({ preset: 'high', adaptive: false, show_fps: true }, 'low').showFps, true);
});

test('choosing a preset clears overrides but keeps scale and toggles', () => {
  const s = choosePreset({ preset: 'low', bloom: 'on', shadows: 'high', render_scale: 1.5, show_fps: true }, 'ultra');
  assert.equal(s.preset, 'ultra');
  assert.equal(s.bloom, undefined);
  assert.equal(s.shadows, undefined);
  assert.equal(s.render_scale, 1.5);
  assert.equal(s.show_fps, true);
  assert.equal(choosePreset({ preset: 'high' }, 'auto').preset, 'auto');
  assert.equal(resolve(choosePreset({}, 'auto'), 'low').auto, true);
});

test('describe summarises cost', () => {
  const d = describe(resolve({ preset: 'high' }, 'low'), [1280, 800]);
  assert.match(d, /2048² shadows/);
  assert.match(d, /SMAA/);
  assert.match(d, /1280×800 px/);
  assert.match(describe(resolve({ preset: 'low' }, 'low')), /no shadows/);
});

test('every locale has every graphics string', () => {
  const need = ['en-US', 'en-GB', 'es-419', 'es-ES', 'de-DE', 'fr-FR', 'fr-CA', 'pt-BR', 'it-IT'];
  const base = GFX_STRINGS['en-US'];
  for (const loc of need) {
    const L = GFX_STRINGS[loc];
    assert.ok(L, loc);
    for (const k of Object.keys(base)) {
      assert.ok(L[k], `${loc}.${k}`);
      if (typeof base[k] === 'object') for (const kk of Object.keys(base[k])) assert.ok(L[k][kk], `${loc}.${k}.${kk}`);
    }
    assert.match(L.auto, /\{tier\}/);
    assert.match(L.fromPreset, /\{tier\}/);
  }
  assert.equal(gfxLocale('es-MX'), 'es-419');
  assert.equal(gfxLocale('fr-CA'), 'fr-CA');
  assert.equal(gfxLocale('en-AU'), 'en-GB');
  assert.equal(gfxLocale('ja-JP'), 'en-US');
});
