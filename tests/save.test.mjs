// The engine client's save model (node --test): every store.js document lives
// in a swappable key/value backend whose export is the engine save; the
// browser build's cloud document (the same export, written by the JS SDK) is
// merged in as a foreign save; two devices' saves merge on a conflict; the old
// account settings KV yields the game's own options.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as store from '../js/store.js';

const backend = () => {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m };
};

test('documents round-trip through a swapped backend; the export is the whole save', () => {
  const kv = backend();
  store.setBackend(kv);
  const p = store.loadProgress();
  p.journeyUnlocked = 4; p.journeyStars['journey-0'] = 3;
  store.saveProgress(p);
  store.unlockAchievement('first_charter');
  const doc = store.exportSaveDoc();
  assert.equal(doc.kind, 'settlement-trails-save');
  assert.equal(doc.progress.journeyUnlocked, 4);
  // a fresh device imports it
  store.setBackend(backend());
  assert.equal(store.loadProgress().journeyUnlocked, 0);
  assert.ok(store.importSaveDoc(JSON.parse(JSON.stringify(doc))));
  assert.equal(store.loadProgress().journeyStars['journey-0'], 3);
  assert.ok(store.loadAchievements().unlocked.first_charter);
});

test('the browser build\'s cloud document merges into this device\'s save (foreign save)', () => {
  store.setBackend(backend());
  const p = store.loadProgress();
  p.journeyUnlocked = 2; p.journeyStars = { 'journey-0': 1, 'journey-1': 3 }; p.totals.gamesPlayed = 5;
  store.saveProgress(p);
  const s = store.loadSettings(); s.tutorialsDone = ['learn-1']; s.colorPalette = 'tritanopia'; store.saveSettings(s);
  store.saveAutosave({ mode: 'journey', content: { id: 'journey-2' }, sessionId: 'local' });
  const old = {
    kind: 'settlement-trails-save', version: 1, exportedAt: 1,
    settings: { ...store.DEFAULT_SETTINGS, tutorialsDone: ['learn-2'], music: 0.1 },
    progress: { journeyUnlocked: 6, journeyStars: { 'journey-0': 3 }, journeyWon: { 'journey-5': true },
      totals: { gamesPlayed: 3, gamesWon: 3, buildingsPlaced: 40, ordersFulfilled: 2 }, daily: { lastPlayed: '2026-10-01', streak: 2, best: { '2026-10-01': 900 } } },
    achievements: { unlocked: { streak_3: 5 } },
    boards: { entries: [{ board: 'global', name: 'Old', score: 700, sessionId: 'old-1', when: 1, won: true, invalidActions: 0, elapsedTicks: 20 }] },
    autosave: { mode: 'daily', content: { id: 'remote' }, sessionId: 'remote' },
  };
  assert.ok(store.mergeSaveDoc(JSON.parse(JSON.stringify(old))));
  const pr = store.loadProgress();
  assert.equal(pr.journeyUnlocked, 6);
  assert.deepEqual(pr.journeyStars, { 'journey-0': 3, 'journey-1': 3 });
  assert.equal(pr.totals.gamesPlayed, 5);
  assert.equal(pr.totals.buildingsPlaced, 40);
  assert.equal(pr.daily.best['2026-10-01'], 900);
  assert.ok(store.loadAchievements().unlocked.streak_3);
  assert.deepEqual(store.loadSettings().tutorialsDone.sort(), ['learn-1', 'learn-2']);
  assert.equal(store.loadSettings().colorPalette, 'tritanopia', 'this device\'s preferences win');
  assert.equal(store.getBoard('global')[0].name, 'Old');
  assert.equal(store.loadAutosave().sessionId, 'local', 'this device\'s settlement in progress stays');
  assert.equal(store.mergeSaveDoc({ kind: 'something-else' }), false);
});

test('two devices\' saves merge without losing either side', () => {
  const a = { kind: 'settlement-trails-save', version: 1, progress: { journeyUnlocked: 3, journeyStars: { x: 2 }, totals: { gamesPlayed: 1 } }, achievements: { unlocked: { a: 10 } }, boards: { entries: [] }, settings: { tutorialsDone: ['learn-1'] } };
  const b = { kind: 'settlement-trails-save', version: 1, progress: { journeyUnlocked: 1, journeyStars: { x: 3, y: 1 }, totals: { gamesPlayed: 4 } }, achievements: { unlocked: { a: 5, b: 7 } }, boards: { entries: [] }, settings: { tutorialsDone: ['learn-3'] } };
  const m = store.mergeSaveDocs(a, b);
  assert.equal(m.progress.journeyUnlocked, 3);
  assert.deepEqual(m.progress.journeyStars, { x: 3, y: 1 });
  assert.equal(m.progress.totals.gamesPlayed, 4);
  assert.deepEqual(m.achievements.unlocked, { a: 5, b: 7 });
  assert.deepEqual(m.settings.tutorialsDone.sort(), ['learn-1', 'learn-3']);
});

test('the old account settings KV: only the game\'s own options are taken, validated', () => {
  assert.deepEqual(store.OPTION_KEYS, ['colorPalette', 'cameraShake', 'dayLength', 'leftHanded', 'haptics']);
  assert.equal(store.pickOption('colorPalette', 'protanopia'), 'protanopia');
  assert.equal(store.pickOption('colorPalette', 'pink'), undefined);
  assert.equal(store.pickOption('dayLength', 'relaxed'), 'relaxed');
  assert.equal(store.pickOption('haptics', 'yes'), undefined);
  assert.equal(store.pickOption('music', 0.5), undefined, 'volumes are the runtime\'s');
  for (const k of store.OPTION_KEYS) assert.ok(store.BROWSER_KEYS.includes(k));
});
