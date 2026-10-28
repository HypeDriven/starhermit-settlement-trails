// store.js — durable local persistence: settings, journey progress, achievements,
// leaderboards, autosave snapshots. Documents are versioned and checksummed.
// No credentials or tokens are ever stored here.

import { stateHash } from './rng.js';

const PREFIX = 'settlement-trails.';
const STORE_VERSION = 1;

function key(name) { return PREFIX + name; }

function wrap(doc) {
  const body = { version: STORE_VERSION, updatedAt: Date.now(), data: doc };
  body.checksum = stateHash(body.data);
  return body;
}

function unwrap(raw) {
  try {
    const body = JSON.parse(raw);
    if (!body || body.version !== STORE_VERSION) return null;
    if (stateHash(body.data) !== body.checksum) return null; // corrupt/tampered
    return body;
  } catch { return null; }
}

// The storage the docs live in: browser localStorage when there is one, else an in-memory map.
// The engine client (native/platform.ts) swaps in its own (the engine save holds every doc).
const memoryFallback = new Map();
const memoryKV = {
  getItem: (k) => (memoryFallback.has(k) ? memoryFallback.get(k) : null),
  setItem: (k, v) => { memoryFallback.set(k, String(v)); },
  removeItem: (k) => { memoryFallback.delete(k); },
};
let kv = memoryKV;
try {
  if (typeof localStorage !== 'undefined') {
    const k = key('__probe');
    localStorage.setItem(k, '1'); localStorage.removeItem(k);
    kv = localStorage;
  }
} catch { kv = memoryKV; }
/** Replace the storage backend ({ getItem, setItem, removeItem }). */
export function setBackend(backend) { kv = backend || memoryKV; }

const clone = (v) => JSON.parse(JSON.stringify(v));

function readDoc(name, defaults) {
  const raw = kv.getItem(key(name));
  if (!raw) return clone(defaults);
  const body = unwrap(raw);
  if (!body) return clone(defaults);
  return { ...clone(defaults), ...body.data };
}

function writeDoc(name, doc) {
  kv.setItem(key(name), JSON.stringify(wrap(doc)));
}

// ---- Settings ------------------------------------------------------------------
export const DEFAULT_SETTINGS = {
  music: 0.6, effects: 0.8, ambience: 0.5, voice: 0.0,
  muteAll: false,
  graphics: {},              // gfx.js saved model: { preset, render_scale, adaptive, show_fps, <category> }
  reducedMotion: false,
  highContrast: false,
  colorPalette: 'default',   // default | deuteranopia | protanopia | tritanopia
  textSize: 'normal',        // normal | large
  leftHanded: false,
  holdToPan: false,
  haptics: true,
  cameraShake: true,
  tutorialsDone: [],
  dayLength: 'normal',       // timing assistance: normal | relaxed
};

export const loadSettings = () => migrateSettings(readDoc('settings', DEFAULT_SETTINGS));

// Pre-graphics-panel saves carried a single `quality` tier (auto|low|medium|high).
export function migrateSettings(s) {
  if (!s.graphics || typeof s.graphics !== 'object') s.graphics = {};
  if ('quality' in s) {
    const q = s.quality;
    if (q && q !== 'auto' && !s.graphics.preset) s.graphics.preset = q === 'medium' ? 'balanced' : q;
    delete s.quality;
  }
  return s;
}
export const saveSettings = (s) => writeDoc('settings', s);

// ---- Progress --------------------------------------------------------------------
export const DEFAULT_PROGRESS = {
  journeyUnlocked: 0,            // highest unlocked stage index
  journeyStars: {},              // stageId -> 1..3
  journeyWon: {},
  totals: { gamesPlayed: 0, gamesWon: 0, buildingsPlaced: 0, ordersFulfilled: 0 },
  daily: { lastPlayed: null, streak: 0, best: {} },  // dateISO -> score
};

export const loadProgress = () => readDoc('progress', DEFAULT_PROGRESS);
export const saveProgress = (p) => writeDoc('progress', p);

// ---- Achievements -------------------------------------------------------------------
export const ACHIEVEMENTS = [
  { id: 'first_charter', name: 'First Charter', desc: 'Complete your first settlement.' },
  { id: 'master_mechanics', name: 'Town Planner', desc: 'Complete all five lessons.' },
  { id: 'streak_3', name: 'Steady Trails', desc: 'Win the Daily Trail three days in a row.' },
  { id: 'mastery_30', name: 'Beyond the Hills', desc: 'Complete Journey stage 30.' },
  { id: 'century_builder', name: 'Century Builder', desc: 'Place 100 buildings across all games.' },
];

export const loadAchievements = () => readDoc('achievements', { unlocked: {} });
export function unlockAchievement(id) {
  const a = loadAchievements();
  if (a.unlocked[id]) return false; // idempotent
  a.unlocked[id] = Date.now();
  writeDoc('achievements', a);
  return true;
}

// ---- Leaderboards (local stand-in for hosted boards) -----------------------------------
// Every submission carries ruleset, content version, seed, assists and duration.
export function loadBoards() { return readDoc('boards', { entries: [] }); }

export function submitScore({ board, name, score, contentId, contentVersion, seed, assists, durationMs, sessionId, won, stats, scoreComponents }) {
  const boards = loadBoards();
  const entry = {
    board, name, score, contentId, contentVersion, seed,
    assists, durationMs, sessionId, won,
    invalidActions: stats?.invalidActions ?? 0,
    elapsedTicks: stats?.daysSurvived ?? 0,
    when: Date.now(),
  };
  // Plausibility: reject impossible claims (negative/huge scores, zero-day wins).
  if (!Number.isFinite(score) || score < 0 || score > 100000) return { ok: false, reason: 'implausible' };
  boards.entries.push(entry);
  // Keep top 200 per board.
  const byBoard = {};
  for (const e of boards.entries) (byBoard[e.board] = byBoard[e.board] || []).push(e);
  boards.entries = [];
  for (const b in byBoard) {
    // Spec §2 tie-break: score, primary objective completion (won), fewer
    // invalid actions, lower elapsed time, then stable session identifier.
    byBoard[b].sort((x, y) => y.score - x.score || (y.won ? 1 : 0) - (x.won ? 1 : 0) ||
      x.invalidActions - y.invalidActions ||
      x.elapsedTicks - y.elapsedTicks || String(x.sessionId).localeCompare(String(y.sessionId)));
    boards.entries.push(...byBoard[b].slice(0, 200));
  }
  writeDoc('boards', boards);
  const rank = boards.entries.filter(e => e.board === board).findIndex(e => e.sessionId === sessionId) + 1;
  return { ok: true, rank };
}

export function getBoard(board, { friendsOnly = false, friends = [] } = {}) {
  const boards = loadBoards();
  let entries = boards.entries.filter(e => e.board === board);
  if (friendsOnly) entries = entries.filter(e => friends.includes(e.name));
  return entries.slice(0, 50);
}

// ---- Cloud-save mirror (hosted mode) -----------------------------------------------
// One portable doc holding every durable local doc. The platform cloud slot is
// a mirror: localStorage remains the offline cache and the standalone source.

export function exportSaveDoc() {
  return {
    kind: 'settlement-trails-save',
    version: STORE_VERSION,
    exportedAt: Date.now(),
    settings: loadSettings(),
    progress: loadProgress(),
    achievements: loadAchievements(),
    boards: loadBoards(),
    autosave: loadAutosave(),
  };
}

const n0 = (v) => (Number.isFinite(v) ? v : 0);
const boardKey = (e) => `${e.board}|${e.sessionId}|${e.score}|${e.when}`;

/**
 * Merge two save docs (this device's `local`, the cloud's `remote`) so neither
 * side's progress is lost: the furthest journey unlock, best stars per stage,
 * every win, the larger totals, the best daily score per date and the later
 * streak, every achievement (earliest unlock), the union of both local boards,
 * every finished lesson. Preferences and the in-progress autosave are this
 * device's (the cloud's autosave only when this device has none).
 */
export function mergeSaveDocs(local, remote) {
  const lp = { ...clone(DEFAULT_PROGRESS), ...(local.progress || {}) };
  const rp = { ...clone(DEFAULT_PROGRESS), ...(remote.progress || {}) };
  const stars = { ...(rp.journeyStars || {}) };
  for (const [id, n] of Object.entries(lp.journeyStars || {})) stars[id] = Math.max(n0(stars[id]), n0(n));
  const totals = {};
  for (const k of new Set([...Object.keys(rp.totals || {}), ...Object.keys(lp.totals || {})])) totals[k] = Math.max(n0(rp.totals?.[k]), n0(lp.totals?.[k]));
  const best = { ...(rp.daily?.best || {}) };
  for (const [d, v] of Object.entries(lp.daily?.best || {})) best[d] = Math.max(n0(best[d]), n0(v));
  const la = lp.daily?.lastPlayed || '', ra = rp.daily?.lastPlayed || '';
  const daily = {
    lastPlayed: (la > ra ? la : ra) || null,
    streak: la === ra ? Math.max(n0(lp.daily?.streak), n0(rp.daily?.streak)) : n0((la > ra ? lp : rp).daily?.streak),
    best,
  };
  const progress = {
    ...rp, ...lp,
    journeyUnlocked: Math.max(n0(lp.journeyUnlocked), n0(rp.journeyUnlocked)),
    journeyStars: stars,
    journeyWon: { ...(rp.journeyWon || {}), ...(lp.journeyWon || {}) },
    totals, daily,
  };
  const unlocked = { ...(remote.achievements?.unlocked || {}) };
  for (const [id, at] of Object.entries(local.achievements?.unlocked || {})) unlocked[id] = unlocked[id] ? Math.min(unlocked[id], at) : at;
  const seen = new Set();
  const entries = [...(local.boards?.entries || []), ...(remote.boards?.entries || [])]
    .filter((e) => { const k = boardKey(e); if (seen.has(k)) return false; seen.add(k); return true; });
  const settings = { ...DEFAULT_SETTINGS, ...(remote.settings || {}), ...(local.settings || {}) };
  settings.tutorialsDone = [...new Set([...(remote.settings?.tutorialsDone || []), ...(local.settings?.tutorialsDone || [])])];
  return {
    kind: 'settlement-trails-save', version: STORE_VERSION, exportedAt: Date.now(),
    settings, progress, achievements: { unlocked }, boards: { entries },
    autosave: local.autosave || remote.autosave || null,
  };
}

/**
 * Merge a cloud doc into the local docs (mergeSaveDocs) and write the result.
 * Returns false when the doc is unusable, otherwise true.
 */
export function mergeSaveDoc(doc) {
  if (!doc || typeof doc !== 'object') return false;
  if (doc.kind !== 'settlement-trails-save' || doc.version !== STORE_VERSION) return false;
  const merged = mergeSaveDocs(exportSaveDoc(), doc);
  saveSettings(merged.settings);
  saveProgress(merged.progress);
  writeDoc('achievements', merged.achievements);
  // Same top-200-per-board ordering as submitScore.
  const byBoard = {};
  for (const e of merged.boards.entries) (byBoard[e.board] = byBoard[e.board] || []).push(e);
  const entries = [];
  for (const b in byBoard) {
    byBoard[b].sort((x, y) => y.score - x.score || (y.won ? 1 : 0) - (x.won ? 1 : 0) ||
      x.invalidActions - y.invalidActions || x.elapsedTicks - y.elapsedTicks || String(x.sessionId).localeCompare(String(y.sessionId)));
    entries.push(...byBoard[b].slice(0, 200));
  }
  writeDoc('boards', { entries });
  if (merged.autosave) saveAutosave(merged.autosave);
  return true;
}

// Replaces the local docs with a cloud doc (kept for tools/tests). Returns false when unusable.
export function importSaveDoc(doc) {
  if (!doc || typeof doc !== 'object') return false;
  if (doc.kind !== 'settlement-trails-save' || doc.version !== STORE_VERSION) return false;
  if (doc.settings && typeof doc.settings === 'object') saveSettings({ ...DEFAULT_SETTINGS, ...doc.settings });
  if (doc.progress && typeof doc.progress === 'object') saveProgress({ ...DEFAULT_PROGRESS, ...doc.progress });
  if (doc.achievements && typeof doc.achievements === 'object') {
    writeDoc('achievements', { unlocked: {}, ...doc.achievements });
  }
  if (doc.boards && Array.isArray(doc.boards.entries)) writeDoc('boards', { entries: doc.boards.entries });
  // The cloud doc is the whole mirror: no autosave there means the run ended (or was
  // abandoned) elsewhere, so drop the stale local one instead of resuming/pushing it.
  if (doc.autosave) saveAutosave(doc.autosave);
  else clearAutosave();
  return true;
}

// ---- Autosave ---------------------------------------------------------------------------
export function saveAutosave(snap) { writeDoc('autosave', snap); }
export function loadAutosave() {
  const raw = kv.getItem(key('autosave'));
  if (!raw) return null;
  const body = unwrap(raw);
  return body ? body.data : null;
}
export function clearAutosave() {
  kv.removeItem(key('autosave'));
}

// ---- Game options (engine client) -----------------------------------------------------
// The browser build's settings that are still the game's own on the StarHermit
// runtime (volumes, mute, graphics, reduced motion, contrast, text size and the
// language are the runtime's Options there), and every key the browser build
// kept in the account's settings KV (js/platform.js SYNCED_SETTINGS).
export const OPTION_KEYS = ['colorPalette', 'cameraShake', 'dayLength', 'leftHanded', 'haptics'];
export const BROWSER_KEYS = ['music', 'effects', 'ambience', 'voice', 'muteAll', 'graphics', 'reducedMotion', 'highContrast', 'colorPalette',
  'textSize', 'leftHanded', 'holdToPan', 'haptics', 'cameraShake', 'dayLength'];
export const PALETTES = ['default', 'deuteranopia', 'protanopia', 'tritanopia'];
/** A valid value for a game option, or undefined. */
export function pickOption(k, v) {
  switch (k) {
    case 'colorPalette': return typeof v === 'string' && PALETTES.includes(v) ? v : undefined;
    case 'dayLength': return v === 'normal' || v === 'relaxed' ? v : undefined;
    case 'cameraShake': case 'leftHanded': case 'haptics': return typeof v === 'boolean' ? v : undefined;
    default: return undefined;
  }
}
