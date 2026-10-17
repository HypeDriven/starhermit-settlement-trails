// Key extraction for the i18n coverage test (also handy for listing keys):
// literal T('…') / N('…') calls in js/, data-i18n markup in index.html, and
// the display fields of the content and rules tables.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { JOURNEY_STAGES, TUTORIALS, CHALLENGES, dailyContent, practiceContent } from '../js/content.js';
import { BUILDINGS, TERRAIN_NAME, INVALID_REASONS } from '../js/rules.js';
import { ACHIEVEMENTS } from '../js/store.js';

const ROOT = new URL('..', import.meta.url).pathname;
const SKIP = new Set(['i18n.js', 'gfx-strings.js', 'sh-strings.js']);
const unescape = (s) => s.replace(/\\(['"\\`])/g, '$1');
const MASTERY_TAIL = ' Prove your mastery under tighter limits.';

export function sourceKeys() {
  const keys = new Set();
  const ternary = /(?<![\w.$])T\([^'"\n()]*?\?\s*'((?:[^'\\\n]|\\.)*)'\s*:\s*'((?:[^'\\\n]|\\.)*)'/g;
  const call = /(?<![\w.$])(?:T|N)\(\s*(?:'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)")/g;
  const dir = join(ROOT, 'js');
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.js') || SKIP.has(f)) continue;
    const src = readFileSync(join(dir, f), 'utf8');
    for (const m of src.matchAll(call)) keys.add(unescape(m[1] ?? m[2]));
    for (const m of src.matchAll(ternary)) { keys.add(unescape(m[1])); keys.add(unescape(m[2])); }
  }
  const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
  for (const m of html.matchAll(/data-i18n(?:-aria|-title)?="([^"]+)"/g)) keys.add(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
  return keys;
}

export function contentKeys() {
  const keys = new Set();
  const add = (...v) => v.forEach((s) => { if (typeof s === 'string' && s) keys.add(s); });
  for (const s of JOURNEY_STAGES) add(s.blurb.endsWith(MASTERY_TAIL) ? s.blurb.slice(0, -MASTERY_TAIL.length) : s.blurb);
  add(MASTERY_TAIL.trim());
  for (const t of TUTORIALS) { add(t.name); for (const st of t.steps) add(st.text); }
  for (const c of CHALLENGES) add(c.name, c.blurb);
  add(dailyContent('2026-01-01').blurb, practiceContent('normal', 1).blurb);
  for (const b of Object.values(BUILDINGS)) add(b.name, b.desc);
  TERRAIN_NAME.forEach((t) => add(t));
  Object.values(INVALID_REASONS).forEach((s) => add(s));
  for (const a of ACHIEVEMENTS) add(a.name);
  return keys;
}

export const ALL = new Set([...sourceKeys(), ...contentKeys()]);
