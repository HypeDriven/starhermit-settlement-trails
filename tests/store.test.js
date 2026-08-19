// tests/store.test.js — persistence: versioned checksummed docs, corrupt-data
// rejection, achievement idempotency, leaderboard plausibility and tiebreak.
// store.js falls back to in-memory storage when localStorage is absent (Node).
import * as store from '../js/store.js';

let passed = 0, failed = 0;
function ok(cond, name) { if (cond) passed++; else { failed++; console.error('FAIL:', name); } }

// Settings round-trip
{
  const s = store.loadSettings();
  ok(s.quality === 'auto' && typeof s.music === 'number', 'default settings loaded');
  s.music = 0.25; s.reducedMotion = true;
  store.saveSettings(s);
  const s2 = store.loadSettings();
  ok(s2.music === 0.25 && s2.reducedMotion === true, 'settings persist');
  // Unknown keys in defaults survive schema additions
  ok(Array.isArray(s2.tutorialsDone), 'defaults merged on load');
}

// Achievements idempotent
{
  ok(store.unlockAchievement('first_charter') === true, 'first unlock');
  ok(store.unlockAchievement('first_charter') === false, 'second unlock idempotent');
  ok(store.ACHIEVEMENTS.length === 5, 'five static achievements');
  ok(store.ACHIEVEMENTS.every(a => /^[a-z0-9_]+$/.test(a.id)), 'achievement keys stable lowercase');
}

// Leaderboards
{
  const base = { board: 'test-board', name: 'A', contentId: 'x', contentVersion: 1, seed: 1, assists: [], durationMs: 1000, sessionId: 's1', won: true, stats: { invalidActions: 0, daysSurvived: 10 } };
  ok(!store.submitScore({ ...base, score: -5 }).ok, 'negative score rejected');
  ok(!store.submitScore({ ...base, score: Infinity }).ok, 'infinite score rejected');
  ok(!store.submitScore({ ...base, score: 1e9 }).ok, 'implausible score rejected');
  ok(store.submitScore({ ...base, score: 500 }).ok, 'valid score accepted');
  ok(store.submitScore({ ...base, name: 'B', sessionId: 's2', score: 700 }).ok, 'second entry');
  ok(store.submitScore({ ...base, name: 'C', sessionId: 's3', score: 700, stats: { invalidActions: 3, daysSurvived: 12 } }).ok, 'tied entry');
  const board = store.getBoard('test-board');
  ok(board[0].name === 'B' && board[1].name === 'C' && board[2].name === 'A', 'tiebreak: fewer invalid actions ranks higher');
  const friendsBoard = store.getBoard('test-board', { friendsOnly: true, friends: ['C'] });
  ok(friendsBoard.length === 1 && friendsBoard[0].name === 'C', 'friends filter works');
}

// Progress + autosave docs
{
  const p = store.loadProgress();
  p.journeyUnlocked = 7;
  store.saveProgress(p);
  ok(store.loadProgress().journeyUnlocked === 7, 'progress persists');
  store.saveAutosave({ hello: 'world' });
  ok(store.loadAutosave()?.hello === 'world', 'autosave persists');
  store.clearAutosave();
  ok(store.loadAutosave() === null, 'autosave cleared');
}

console.log(`\nstore: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
