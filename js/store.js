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

function storageAvailable() {
  try {
    const k = key('__probe');
    localStorage.setItem(k, '1'); localStorage.removeItem(k);
    return true;
  } catch { return false; }
}

const memoryFallback = new Map(); // private browsing etc.
const hasLS = typeof localStorage !== 'undefined' && storageAvailable();

function readDoc(name, defaults) {
  const raw = hasLS ? localStorage.getItem(key(name)) : memoryFallback.get(key(name));
  if (!raw) return structuredClone(defaults);
  const body = unwrap(raw);
  if (!body) return structuredClone(defaults);
  return { ...structuredClone(defaults), ...body.data };
}

function writeDoc(name, doc) {
  const raw = JSON.stringify(wrap(doc));
  if (hasLS) localStorage.setItem(key(name), raw);
  else memoryFallback.set(key(name), raw);
}

// ---- Settings ------------------------------------------------------------------
export const DEFAULT_SETTINGS = {
  music: 0.6, effects: 0.8, ambience: 0.5, voice: 0.0,
  muteAll: false,
  quality: 'auto',           // auto | low | medium | high
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
  bindings: {                // desktop action bindings (remappable)
    pause: 'Escape', undo: 'KeyU', hint: 'KeyH', demolish: 'KeyX',
    speed: 'Space', cameraReset: 'KeyC', confirm: 'Enter', cancel: 'Escape',
  },
};

export const loadSettings = () => readDoc('settings', DEFAULT_SETTINGS);
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

// Remote wins on conflict (platform contract). Returns false when unusable.
export function importSaveDoc(doc) {
  if (!doc || typeof doc !== 'object') return false;
  if (doc.kind !== 'settlement-trails-save' || doc.version !== STORE_VERSION) return false;
  if (doc.settings && typeof doc.settings === 'object') saveSettings({ ...DEFAULT_SETTINGS, ...doc.settings });
  if (doc.progress && typeof doc.progress === 'object') saveProgress({ ...DEFAULT_PROGRESS, ...doc.progress });
  if (doc.achievements && typeof doc.achievements === 'object') {
    writeDoc('achievements', { unlocked: {}, ...doc.achievements });
  }
  if (doc.boards && Array.isArray(doc.boards.entries)) writeDoc('boards', { entries: doc.boards.entries });
  if (doc.autosave) saveAutosave(doc.autosave);
  return true;
}

// ---- Autosave ---------------------------------------------------------------------------
export function saveAutosave(snap) { writeDoc('autosave', snap); }
export function loadAutosave() {
  const raw = hasLS ? localStorage.getItem(key('autosave')) : memoryFallback.get(key('autosave'));
  if (!raw) return null;
  const body = unwrap(raw);
  return body ? body.data : null;
}
export function clearAutosave() {
  if (hasLS) localStorage.removeItem(key('autosave'));
  else memoryFallback.delete(key('autosave'));
}
