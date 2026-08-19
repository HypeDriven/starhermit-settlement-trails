// main.js — bootstrap: capability detection, module wiring, game state machine,
// input routing (pointer/keyboard/gamepad), autosave, lifecycle, analytics.

import * as R from './rules.js';
import * as C from './content.js';
import { Session } from './session.js';
import * as store from './store.js';
import { Platform } from './platform.js';
import { AudioEngine } from './audio.js';
import { UI } from './ui.js';

const state = {
  platform: null,
  settings: null,
  progress: null,
  audio: null,
  ui: null,
  view: null,          // TownRenderer (null when WebGL unavailable)
  session: null,
  def: null,           // active content def
  mode: null,
  cursor: { x: 0, y: 0 },
  tool: 'inspect',
  tutorial: null,      // { steps, idx, progress }
  screen: 'title',
  lastFrame: 0,
  visible: true,
  autosaveTimer: 0,
  gamepadPrev: {},
  gamepadCursorTimer: 0,
  houseNeedsCache: null,
  dayLengthMs: 1,      // timing assistance multiplier
};

const $ = (id) => document.getElementById(id);

// ---- boot ------------------------------------------------------------------------
async function boot() {
  state.platform = await new Platform().init();
  state.settings = store.loadSettings();
  state.progress = store.loadProgress();
  applySettingsToDom();

  state.audio = new AudioEngine(state.settings);
  state.ui = new UI();
  state.ui.bind(uiHandlers());

  // WebGL capability detection with graceful fallback message.
  try {
    const mod = await import('./render.js');
    state.view = new mod.TownRenderer($('canvas-wrap'), state.settings);
    state.view.onTileHover = onTileHover;
    state.view.onTileTap = onTileTap;
    state.view.onContextLost = onContextLost;
  } catch (e) {
    console.error('WebGL unavailable:', e);
    $('compat-warning').classList.remove('hidden');
  }

  refreshTitle();
  wireLifecycle();
  wireKeyboard();
  requestAnimationFrame(frame);
  state.platform.track('start', { mode: 'boot' });
}

function refreshTitle() {
  const today = state.platform.utcToday();
  state.ui.setTitleInfo({
    profileName: state.platform.profile?.name || 'Guest',
    dailyDone: !!(state.progress.daily.best[today]),
    journeyUnlocked: Math.min(state.progress.journeyUnlocked, C.JOURNEY_STAGES.length),
    journeyTotal: C.JOURNEY_STAGES.length,
    hasSave: !!store.loadAutosave(),
  });
}

// ---- settings ----------------------------------------------------------------------
function applySettingsToDom() {
  const s = state.settings;
  document.documentElement.dataset.motion = s.reducedMotion ? 'reduced' : 'full';
  document.documentElement.dataset.contrast = s.highContrast ? 'high' : 'normal';
  document.documentElement.dataset.textSize = s.textSize === 'large' ? 'large' : 'normal';
  state.dayLengthMs = s.dayLength === 'relaxed' ? 0.6 : 1; // timing assistance: slower days
  state.audio?.applySettings(s);
  state.view?.applySettings(s);
}

function buildSettings(body) {
  const s = state.settings;
  body.innerHTML = '';
  const ui = state.ui;
  const save = () => { store.saveSettings(state.settings); applySettingsToDom(); state.platform.track('settings_change', {}); };

  const slider = (id, label, key) => {
    const input = document.createElement('input');
    input.type = 'range'; input.min = 0; input.max = 1; input.step = 0.05;
    input.value = s[key]; input.id = id;
    input.addEventListener('input', () => { s[key] = parseFloat(input.value); save(); });
    return ui.settingsRow(label, input);
  };
  const toggle = (id, label, key) => {
    const input = document.createElement('input');
    input.type = 'checkbox'; input.checked = !!s[key]; input.id = id;
    input.addEventListener('change', () => { s[key] = input.checked; save(); });
    return ui.settingsRow(label, input);
  };
  const select = (id, label, key, options) => {
    const sel = document.createElement('select');
    sel.id = id;
    for (const [v, name] of options) {
      const o = document.createElement('option');
      o.value = v; o.textContent = name;
      if (s[key] === v) o.selected = true;
      sel.appendChild(o);
    }
    sel.addEventListener('change', () => { s[key] = sel.value; save(); });
    return ui.settingsRow(label, sel);
  };

  const g1 = document.createElement('div'); g1.className = 'set-group';
  g1.innerHTML = '<h3>Audio</h3>';
  g1.append(
    slider('set-music', 'Music', 'music'),
    slider('set-fx', 'Effects', 'effects'),
    slider('set-amb', 'Ambience', 'ambience'),
    toggle('set-mute', 'Mute all audio', 'muteAll'),
  );
  const g2 = document.createElement('div'); g2.className = 'set-group';
  g2.innerHTML = '<h3>Graphics</h3>';
  g2.append(
    select('set-quality', 'Quality tier', 'quality', [['auto', 'Auto'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High']]),
    toggle('set-motion', 'Reduced motion', 'reducedMotion'),
    toggle('set-contrast', 'High contrast', 'highContrast'),
    select('set-palette', 'Color palette', 'colorPalette', [['default', 'Default'], ['deuteranopia', 'Deuteranopia-safe'], ['protanopia', 'Protanopia-safe'], ['tritanopia', 'Tritanopia-safe']]),
    toggle('set-shake', 'Camera shake', 'cameraShake'),
  );
  const g3 = document.createElement('div'); g3.className = 'set-group';
  g3.innerHTML = '<h3>Accessibility & controls</h3>';
  g3.append(
    select('set-text', 'Text size', 'textSize', [['normal', 'Normal'], ['large', 'Large']]),
    select('set-daylen', 'Day length (timing assistance)', 'dayLength', [['normal', 'Normal'], ['relaxed', 'Relaxed (slower days)']]),
    toggle('set-left', 'Left-handed controls', 'leftHanded'),
    toggle('set-haptics', 'Haptics', 'haptics'),
  );
  const replayBtn = document.createElement('button');
  replayBtn.className = 'btn';
  replayBtn.textContent = 'Replay tutorials';
  replayBtn.addEventListener('click', () => {
    state.settings.tutorialsDone = [];
    save();
    state.ui.closeOverlay('screen-settings');
    showLearnPicker();
  });
  g3.appendChild(replayBtn);
  const g4 = document.createElement('div'); g4.className = 'set-group';
  g4.innerHTML = '<h3>Privacy</h3>';
  const consent = document.createElement('input');
  consent.type = 'checkbox'; consent.id = 'set-analytics';
  consent.checked = !!state.platform.consent.analytics;
  consent.addEventListener('change', () => { state.platform.consent.analytics = consent.checked; });
  g4.appendChild(ui.settingsRow('Share anonymous usage statistics', consent));

  body.append(g1, g2, g3, g4);
}

// ---- mode pickers ----------------------------------------------------------------------
function uiHandlers() {
  return {
    onQuickPlay: () => {
      // Returning player: at most two deliberate actions to the playfield.
      const idx = Math.min(state.progress.journeyUnlocked, C.JOURNEY_STAGES.length - 1);
      startGame(C.JOURNEY_STAGES[idx], 'journey');
    },
    onMode: (mode) => {
      if (mode === 'journey') showJourneyPicker();
      else if (mode === 'learn') showLearnPicker();
      else if (mode === 'practice') showPracticePicker();
      else if (mode === 'challenge') showChallengePicker();
      else if (mode === 'daily') showDailySetup();
    },
    onResumeSave: () => resumeAutosave(),
    onPause: () => pauseGame(),
    onResume: () => resumeGame(),
    onRestart: () => { if (state.def) { state.ui.closeOverlay('screen-pause'); state.ui.closeOverlay('screen-results'); startGame(state.def, state.mode); state.platform.track('retry', { mode: state.mode }); } },
    onQuit: () => quitToTitle(),
    onNextStage: () => {
      if (state.mode === 'journey' && state.def.stageIndex != null) {
        const next = C.JOURNEY_STAGES[state.def.stageIndex + 1];
        if (next) { state.ui.closeOverlay('screen-results'); startGame(next, 'journey'); return; }
      }
      state.ui.closeOverlay('screen-results');
      quitToTitle();
    },
    onCycleSpeed: () => {
      if (!state.session) return;
      const s = state.session;
      s.setSpeed((s.speed % 3) + 1);
      s.setPaused(false);
      state.ui.setSpeedButton(s.speed, false);
    },
    onUndo: () => {
      if (!state.session) return;
      const r = state.session.undo();
      if (r.ok) { syncAll(); state.audio.play('ui'); } else state.ui.toast('Nothing to undo.', true);
    },
    hasUndo: () => !!state.session && state.session.allowUndo && state.session.undoStack.length > 0,
    onHint: () => showHint(),
    onTool: (tool) => setTool(tool),
    onBoardTab: (board) => renderBoard(board),
    onBuildSettings: buildSettings,
    onBuildHelp: (body) => { body.innerHTML = ''; body.appendChild(state.ui.helpContent(state.settings.bindings)); },
    onOverlayClosed: (id) => {
      if (id === 'screen-pause' && state.session && !state.session.finished) {
        // Closing pause overlay via backdrop path: resume.
      }
    },
  };
}

function showJourneyPicker() {
  state.ui.showPicker('Journey', state.ui.stageGrid(C.JOURNEY_STAGES, state.progress, (i) => {
    startGame(C.JOURNEY_STAGES[i], 'journey');
  }));
}

function showLearnPicker() {
  state.ui.showPicker('Learn', (body) => {
    for (const t of C.TUTORIALS) {
      const done = state.settings.tutorialsDone.includes(t.id);
      const card = document.createElement('button');
      card.className = 'stage-card';
      card.innerHTML = `<div>${done ? '✅' : '▶️'} ${t.name}</div><div class="muted">${t.steps.length} steps</div>`;
      card.addEventListener('click', () => startGame(t, 'learn'));
      body.appendChild(card);
    }
  });
}

function showPracticePicker() {
  state.ui.showPicker('Practice', (body) => {
    for (const d of ['relaxed', 'normal', 'hard']) {
      const def = C.practiceContent(d, 0xC0FFEE);
      const card = document.createElement('div');
      card.className = 'setup-card';
      card.innerHTML = `<h3>${d[0].toUpperCase() + d.slice(1)}</h3>
        <p>Population ${def.goals.population} in ${def.goals.days} days. Unranked, undo enabled.</p>`;
      const b = document.createElement('button');
      b.className = 'btn primary'; b.textContent = 'Start';
      b.addEventListener('click', () => startGame(C.practiceContent(d), 'practice'));
      card.appendChild(b);
      body.appendChild(card);
    }
  });
}

function showChallengePicker() {
  state.ui.showPicker('Challenges', (body) => {
    for (const ch of C.CHALLENGES) {
      const b = state.ui.setupCard(ch, { ranked: false, expected: '5–8', onStart: () => startGame(ch, 'challenge') });
      b(body);
    }
  });
}

function showDailySetup() {
  const today = state.platform.utcToday();
  const def = C.dailyContent(today);
  state.ui.showPicker('Daily Trail', state.ui.setupCard(def, {
    ranked: true,
    expected: '5–10',
    onStart: () => startGame(def, 'daily'),
  }));
}

// ---- game lifecycle ----------------------------------------------------------------------
function startGame(def, mode) {
  const content = C.materialize(def);
  state.def = def;
  state.mode = mode;
  state.session = new Session(content, {
    mode,
    allowUndo: mode === 'practice' || !!content.allowUndo,
    onEvents: handleEvents,
    onTerminal: handleTerminal,
  });
  state.tool = 'inspect';
  state.tutorial = content.steps ? { steps: content.steps, idx: 0, count: 0 } : null;
  state.houseNeedsCache = null;

  if (state.view) {
    state.view.loadContent(content, C.THEMES[content.theme] || C.THEMES.meadow);
    state.view.syncState(state.session.state);
    state.view.resetCamera();
    state.view.clearGhost();
    const hall = content.hall;
    state.cursor = { x: hall.x, y: hall.y };
    state.view.setCursor(state.cursor.x, state.cursor.y);
  }
  state.ui.show('screen-game');
  // Canvas container only has size once the screen is visible.
  requestAnimationFrame(() => { state.view?.resize(); state.view?.resetCamera(); });
  state.ui.buildToolbox(content.mechanics, true);
  state.ui.setTool('inspect');
  state.ui.setModePill(modeLabel(mode));
  state.ui.setObjectiveText(def.blurb || content.name);
  updateTutorialCard();
  syncAll();
  $('rail-left').classList.toggle('open', window.innerWidth >= 1024);
  $('rail-right').classList.remove('open');

  state.platform.startActivity(mode);
  state.platform.track('start', { mode });

  // Countdown (skipped under reduced motion), then play.
  state.session.setPaused(true);
  if (state.settings.reducedMotion) {
    state.session.setPaused(false);
    state.ui.setSpeedButton(1, false);
    state.audio.start(); // best effort; may need a gesture first
  } else {
    let n = 3;
    state.ui.countdown(String(n));
    const tick = () => {
      n--;
      if (n <= 0) {
        state.ui.countdown(null);
        state.session.setPaused(false);
        state.ui.setSpeedButton(1, false);
      } else {
        state.ui.countdown(String(n));
        setTimeout(tick, 700);
      }
    };
    setTimeout(tick, 700);
  }
  state.ui.announce(`${content.name}. ${def.blurb || ''}`);
}

function modeLabel(mode) {
  return { journey: 'Journey', learn: 'Lesson', daily: 'Daily', practice: 'Practice', challenge: 'Challenge' }[mode] || mode;
}

function pauseGame() {
  if (!state.session || state.session.finished) return;
  state.session.setPaused(true);
  state.ui.setSpeedButton(state.session.speed, true);
  state.ui.showOverlay('screen-pause');
  state.audio.play('pause');
}

function resumeGame() {
  state.ui.closeOverlay('screen-pause');
  if (state.session && !state.session.finished) {
    state.session.setPaused(false);
    state.ui.setSpeedButton(state.session.speed, false);
  }
}

function quitToTitle() {
  // Autosave active games so a returning player can resume.
  if (state.session && !state.session.finished && state.session.state.status === 'active') {
    store.saveAutosave(state.session.snapshot());
  }
  if (state.session?.finished) store.clearAutosave();
  state.session = null;
  state.platform.endActivity();
  state.ui.closeOverlay('screen-pause');
  state.ui.closeOverlay('screen-results');
  state.ui.show('screen-title');
  refreshTitle();
}

function resumeAutosave() {
  const snap = store.loadAutosave();
  if (!snap) return;
  try {
    state.def = snap.content;
    state.mode = snap.mode;
    state.session = Session.restore(snap, { onEvents: handleEvents, onTerminal: handleTerminal });
    const content = snap.content;
    state.tutorial = content.steps ? { steps: content.steps, idx: content.steps.length, count: 0 } : null;
    if (state.view) {
      state.view.loadContent(content, C.THEMES[content.theme] || C.THEMES.meadow);
      state.view.syncState(state.session.state);
      state.view.resetCamera();
    }
    state.ui.show('screen-game');
    requestAnimationFrame(() => { state.view?.resize(); state.view?.resetCamera(); });
    state.ui.buildToolbox(content.mechanics, true);
    state.ui.setModePill(modeLabel(state.mode));
    state.ui.setObjectiveText(content.blurb || content.name);
    syncAll();
    // "While you were away" summary: simulation was paused; nothing advanced.
    state.ui.toast('Welcome back — your settlement is exactly as you left it.');
    state.platform.startActivity(state.mode);
  } catch (e) {
    console.error('autosave restore failed', e);
    store.clearAutosave();
    state.ui.toast('Saved game could not be loaded (version mismatch).', true);
  }
}

// ---- input: pointer ----------------------------------------------------------------------
function onTileHover(cell) {
  if (!state.session || !state.view) return;
  if (!cell) { state.view.setHover(null); state.view.clearGhost(); return; }
  state.view.setHover(cell.x, cell.y);
  if (state.tool && state.tool !== 'inspect' && state.tool !== 'demolish') {
    const err = R.placementError(state.session.state, cell.x, cell.y, state.tool);
    state.view.setGhost(cell.x, cell.y, state.tool, err === null);
  } else {
    state.view.clearGhost();
  }
}

function onTileTap(x, y) {
  state.audio.start(); // user gesture: unlock audio
  if (!state.session || state.session.finished) return;
  state.audio.play('select');
  if (x == null) { setTool('inspect'); return; }
  state.cursor = { x, y };
  if (state.view) state.view.setCursor(x, y);
  const st = state.session.state;
  if (state.tool === 'inspect') {
    inspectTile(x, y);
    return;
  }
  if (state.tool === 'demolish') {
    const err = R.demolishError(st, x, y);
    if (err) {
      state.ui.toast(R.INVALID_REASONS[err], true);
      state.audio.play('invalid');
      return;
    }
    const r = state.session.submit({ type: 'demolish', x, y });
    if (r.ok) { state.audio.play('demolish'); }
    return;
  }
  // placement
  const err = R.placementError(st, x, y, state.tool);
  if (err) {
    state.ui.toast(R.INVALID_REASONS[err] || 'Cannot build here.', true);
    state.audio.play('invalid');
    state.ui.alert(`Cannot build: ${R.INVALID_REASONS[err]}`);
    inspectTile(x, y, { error: err });
    return;
  }
  const r = state.session.submit({ type: 'place', x, y, building: state.tool });
  if (r.ok) {
    afterPlayerAction('place', state.tool);
    if (state.view) state.view.kick(0.4);
  }
}

function inspectTile(x, y, extra = {}) {
  const st = state.session.state;
  const evald = R.evaluateHouses(st);
  const info = evald.houses.get(y * st.grid.w + x);
  state.ui.inspect(st, x, y, info || extra);
  $('rail-right').classList.add('open');
}

function setTool(tool) {
  state.tool = tool;
  state.ui.setTool(tool);
  if (state.view) state.view.clearGhost();
}

// ---- input: keyboard ----------------------------------------------------------------------
function wireKeyboard() {
  document.addEventListener('keydown', (e) => {
    if (e.repeat) return;
    const inGame = $('screen-game').classList.contains('active');
    const overlay = state.ui.topOverlay;
    const b = state.settings.bindings;
    if (e.code === 'Escape') {
      if (overlay === 'screen-settings') return state.ui.closeOverlay('screen-settings');
      if (overlay === 'screen-help') return state.ui.closeOverlay('screen-help');
      if (overlay === 'screen-scores') return state.ui.closeOverlay('screen-scores');
      if (overlay === 'screen-pause') return resumeGame();
      if (overlay === 'screen-results') return;
      if (inGame) {
        if (state.tool !== 'inspect') { setTool('inspect'); return; }
        pauseGame();
      }
      return;
    }
    if (!inGame || overlay) return;
    const cur = state.cursor;
    const move = (dx, dy) => {
      if (!state.session) return;
      cur.x = Math.max(0, Math.min(state.session.state.grid.w - 1, cur.x + dx));
      cur.y = Math.max(0, Math.min(state.session.state.grid.h - 1, cur.y + dy));
      if (state.view) { state.view.setCursor(cur.x, cur.y); onTileHover(cur); }
      e.preventDefault();
    };
    switch (e.code) {
      case 'ArrowUp': case 'KeyW': return move(0, -1);
      case 'ArrowDown': case 'KeyS': return move(0, 1);
      case 'ArrowLeft': return move(state.settings.leftHanded ? 1 : -1, 0);
      case 'ArrowRight': return move(state.settings.leftHanded ? -1 : 1, 0);
      case b.confirm: case 'NumpadEnter': onTileTap(cur.x, cur.y); return;
      case b.undo: return uiHandlers().onUndo();
      case b.hint: return showHint();
      case b.speed: return uiHandlers().onCycleSpeed();
      case b.cameraReset: return state.view?.resetCamera();
      case 'KeyI': return setTool('inspect');
      case b.demolish: return setTool('demolish');
      default: break;
    }
    // Number keys select tools.
    const n = parseInt(e.key, 10);
    if (n >= 1 && n <= 9) {
      const tools = ['inspect', ...R.BUILD_ORDER.filter(t => state.session?.state.mechanics.includes(t)), 'demolish'];
      if (tools[n - 1]) setTool(tools[n - 1]);
    }
  });
}

// ---- input: gamepad -------------------------------------------------------------------------
function pollGamepad(dt) {
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  const gp = pads && pads[0];
  if (!gp || !state.session || state.ui.topOverlay) return;
  const pressed = (i) => gp.buttons[i] && gp.buttons[i].pressed;
  const edge = (name, val) => {
    const was = state.gamepadPrev[name];
    state.gamepadPrev[name] = val;
    return val && !was;
  };
  // Cursor move with axes (rate-limited) or d-pad edges.
  state.gamepadCursorTimer -= dt;
  const ax = gp.axes[0] || 0, ay = gp.axes[1] || 0;
  let dx = 0, dy = 0;
  if (Math.abs(ax) > 0.5) dx = Math.sign(ax);
  if (Math.abs(ay) > 0.5) dy = Math.sign(ay);
  if (edge('left', pressed(14))) dx = -1;
  if (edge('right', pressed(15))) dx = 1;
  if (edge('up', pressed(12))) dy = -1;
  if (edge('down', pressed(13))) dy = 1;
  if ((dx || dy) && state.gamepadCursorTimer <= 0) {
    state.gamepadCursorTimer = 180;
    const cur = state.cursor;
    cur.x = Math.max(0, Math.min(state.session.state.grid.w - 1, cur.x + dx));
    cur.y = Math.max(0, Math.min(state.session.state.grid.h - 1, cur.y + dy));
    if (state.view) { state.view.setCursor(cur.x, cur.y); onTileHover(cur); }
  }
  if (edge('a', pressed(0))) onTileTap(state.cursor.x, state.cursor.y);
  if (edge('b', pressed(1))) setTool('inspect');
  if (edge('start', pressed(9))) pauseGame();
  if (edge('lb', pressed(4))) cycleTool(-1);
  if (edge('rb', pressed(5))) cycleTool(1);
}

function cycleTool(dir) {
  const tools = ['inspect', ...R.BUILD_ORDER.filter(t => state.session?.state.mechanics.includes(t)), 'demolish'];
  const i = tools.indexOf(state.tool);
  setTool(tools[(i + dir + tools.length) % tools.length]);
}

// ---- tutorial ---------------------------------------------------------------------------------
function afterPlayerAction(cmdType, building) {
  state.platform.track('tutorial_step', { mode: state.mode, step: state.tutorial?.idx ?? -1 });
  advanceTutorial({ type: cmdType, building });
  syncAll();
}

function advanceTutorial(action) {
  const t = state.tutorial;
  if (!t || t.idx >= t.steps.length) return;
  const step = t.steps[t.idx];
  const req = step.require;
  let hit = false;
  if (req.type === 'place' && action.type === 'place' && req.building === action.building) hit = true;
  if (req.type === 'fulfill' && action.type === 'fulfill') hit = true;
  if (hit) {
    t.count++;
    if (t.count >= (req.count || 1)) {
      t.idx++;
      t.count = 0;
      state.audio.play('achievement');
      updateTutorialCard();
      if (t.idx >= t.steps.length) completeTutorial();
    }
  }
}

function checkTutorialGoals() {
  const t = state.tutorial;
  if (!t || t.idx >= t.steps.length || !state.session) return;
  const step = t.steps[t.idx];
  if (step.require.type === 'goal') {
    const pop = R.totalPopulation(state.session.state);
    if (step.require.population && pop >= step.require.population) {
      t.idx++;
      updateTutorialCard();
      if (t.idx >= t.steps.length) completeTutorial();
    }
  }
}

function updateTutorialCard() {
  const t = state.tutorial;
  if (!t) { state.ui.setTutorialStep(null); return; }
  state.ui.setTutorialStep(t.steps[t.idx] || null, t.idx, t.steps.length);
}

function completeTutorial() {
  if (!state.def?.id?.startsWith('learn-')) return;
  if (!state.settings.tutorialsDone.includes(state.def.id)) {
    state.settings.tutorialsDone.push(state.def.id);
    store.saveSettings(state.settings);
  }
  if (state.settings.tutorialsDone.length >= C.TUTORIALS.length) {
    unlockAch('master_mechanics');
  }
}

// ---- events / sync ------------------------------------------------------------------------------
function handleEvents(events, st) {
  for (const ev of events) {
    state.audio.playEvent(ev);
    if (ev.kind === 'invalid') state.ui.toast(ev.text, true);
    if (ev.kind === 'shortage') state.ui.alert(ev.text);
    if (ev.kind === 'order') state.ui.toast(ev.text);
    if (ev.kind === 'won' || ev.kind === 'lost') state.audio.play(ev.kind === 'won' ? 'win' : 'lose');
  }
  syncAll();
}

function syncAll() {
  const st = state.session?.state;
  if (!st) return;
  state.ui.updateHUD(st);
  state.ui.setObjectives(st);
  state.ui.updateOrders(st, (orderId) => {
    const r = state.session.submit({ type: 'fulfill', orderId });
    if (r.ok) afterPlayerAction('fulfill');
    else state.ui.toast(R.INVALID_REASONS[r.reason] || 'Cannot fulfil.', true);
  });
  state.ui.updateEventLog(st.events);
  if (state.view) {
    state.view.houseNeeds = R.evaluateHouses(st).houses;
    state.view.syncState(st);
  }
  state.audio.setIntensity(Math.min(1, st.tick / st.goals.days));
}

// ---- terminal / results ---------------------------------------------------------------------------
function handleTerminal(st) {
  const score = R.score(st);
  const won = st.status === 'won';
  store.clearAutosave();

  // Progress
  const p = state.progress;
  p.totals.gamesPlayed++;
  if (won) p.totals.gamesWon++;
  p.totals.buildingsPlaced += st.stats.buildingsPlaced;
  p.totals.ordersFulfilled += st.stats.ordersCompleted;
  const newAch = [];
  if (won) { if (store.unlockAchievement('first_charter')) newAch.push(store.ACHIEVEMENTS[0]); }
  if (p.totals.buildingsPlaced >= 100) { if (store.unlockAchievement('century_builder')) newAch.push(store.ACHIEVEMENTS[4]); }

  let nextAvailable = false;
  if (state.mode === 'journey' && won) {
    const idx = state.def.stageIndex;
    p.journeyWon[state.def.id] = true;
    p.journeyUnlocked = Math.max(p.journeyUnlocked, Math.min(idx + 1, C.JOURNEY_STAGES.length - 1));
    nextAvailable = idx + 1 < C.JOURNEY_STAGES.length;
    // Stars: 1 win, +1 under par days, +1 over par score
    let stars = 1;
    if (state.def.par && st.tick <= state.def.par.days) stars++;
    if (state.def.par && score.total >= state.def.par.score) stars++;
    p.journeyStars[state.def.id] = Math.max(p.journeyStars[state.def.id] || 0, stars);
    if (idx >= 29 && store.unlockAchievement('mastery_30')) newAch.push(store.ACHIEVEMENTS[3]);
  }
  if (state.mode === 'daily') {
    const today = state.platform.utcToday();
    const prev = p.daily.best[today];
    if (!prev || score.total > prev) p.daily.best[today] = score.total;
    if (won) {
      const yesterday = new Date(state.platform.now() - 86400000).toISOString().slice(0, 10);
      p.daily.streak = p.daily.lastPlayed === yesterday || p.daily.lastPlayed === today ? p.daily.streak + (p.daily.lastPlayed === today ? 0 : 1) : 1;
      p.daily.lastPlayed = today;
      if (p.daily.streak >= 3 && store.unlockAchievement('streak_3')) newAch.push(store.ACHIEVEMENTS[2]);
    }
  }
  store.saveProgress(p);
  if (newAch.length) state.audio.play('achievement');

  // Score submission: include ruleset, content version, seed, assists, duration.
  // Practice is unranked by design and never touches boards.
  let rankInfo = '';
  if (state.mode !== 'practice') {
    const assists = state.settings.dayLength !== 'normal' ? ['relaxed-time'] : [];
    const board = state.mode === 'daily' ? 'daily-' + state.platform.utcToday() : 'global';
    const submission = {
      board,
      name: state.platform.profile?.name || 'Guest',
      score: score.total,
      contentId: state.def.id,
      contentVersion: state.def.version,
      seed: state.session.content.seed,
      assists,
      durationMs: Math.round(state.session.elapsedActiveMs),
      sessionId: state.session.sessionId,
      won,
      stats: st.stats,
    };
    const res = store.submitScore(submission);
    if (res.ok && res.rank) rankInfo = `Local board rank: #${res.rank}`;
    // Hosted submission with replay envelope for validation; casual label if unavailable.
    const envelope = state.session.replayEnvelope();
    envelope.materialized = state.session.content;
    const replayCheck = Session.validateReplay(envelope);
    if (!replayCheck.ok) console.warn('replay self-check failed:', replayCheck);
    if (state.platform.hosted) {
      state.platform.submitHostedScore({ ...submission, replay: envelope, validated: replayCheck.ok })
        .then(r => { if (!r.ok) rankInfo += ' (hosted board unavailable — casual)'; });
    }
  }
  state.platform.track('round_end', { mode: state.mode, result: st.status });
  state.platform.endActivity();

  state.ui.showResults({
    won, state: st, score, mode: state.mode,
    rankInfo, newAchievements: newAch,
    onNextAvailable: nextAvailable,
  });
  state.ui.announce(won ? `Victory! Total score ${score.total}.` : `Charter failed. Score ${score.total}.`);
}

function unlockAch(id) {
  if (store.unlockAchievement(id)) {
    const a = store.ACHIEVEMENTS.find(x => x.id === id);
    if (a) state.ui.toast(`🏅 Achievement: ${a.name}`);
    state.audio.play('achievement');
  }
}

// ---- hint -------------------------------------------------------------------------------------------
function showHint() {
  if (!state.session || state.session.finished) return;
  const hint = R.suggestAction(state.session.state);
  if (!hint) { state.ui.toast('Nothing useful to do — wait for the next day.'); return; }
  state.audio.play('hint');
  if (hint.kind === 'place') {
    const def = R.BUILDINGS[hint.type || hint.building];
    state.ui.toast(`💡 Try a ${def.name} at (${hint.x}, ${hint.y}).`);
    if (state.view) {
      state.view.setCursor(hint.x, hint.y);
      state.cursor = { x: hint.x, y: hint.y };
    }
  } else if (hint.kind === 'fulfill') {
    state.ui.toast('💡 You can fulfil a trade order from the orders panel.');
  }
}

// ---- scoreboards --------------------------------------------------------------------------------------
function renderBoard(boardTab) {
  let board = 'global', note = 'All local scores.';
  if (boardTab === 'daily') { board = 'daily-' + state.platform.utcToday(); note = 'Today’s shared seed.'; }
  if (boardTab === 'friends') {
    const friends = state.platform.friends.length ? state.platform.friends : [state.platform.profile?.name || 'Guest'];
    const entries = store.getBoard('global', { friendsOnly: true, friends });
    state.ui.renderScores(entries, state.platform.profile?.name, state.platform.friends.length ? 'Friends only.' : 'No friends yet — showing your own scores.');
    return;
  }
  state.ui.renderScores(store.getBoard(board), state.platform.profile?.name, note);
}

// ---- autosave -------------------------------------------------------------------------------------------
function maybeAutosave() {
  if (state.session && !state.session.finished && state.session.state.status === 'active') {
    store.saveAutosave(state.session.snapshot());
  }
}

// ---- lifecycle -------------------------------------------------------------------------------------------
function wireLifecycle() {
  document.addEventListener('visibilitychange', () => {
    state.visible = !document.hidden;
    if (document.hidden) {
      // Backgrounding pauses solo simulation and audio.
      if (state.session && !state.session.finished) {
        state.session.setPaused(true);
        state.ui.setSpeedButton(state.session.speed, true);
      }
      state.audio.suspend();
      maybeAutosave();
    } else {
      state.audio.resume();
      state.lastFrame = performance.now();
    }
  });
  window.addEventListener('beforeunload', maybeAutosave);
  // First gesture unlocks audio.
  const unlock = () => { state.audio.start(); document.removeEventListener('pointerdown', unlock); };
  document.addEventListener('pointerdown', unlock);
}

function onContextLost() {
  // Attempt rebuild from retained CPU descriptors (content + state are held).
  console.warn('WebGL context lost; attempting recovery');
  try {
    if (state.session && state.view) {
      state.view.loadContent(state.session.content, C.THEMES[state.session.content.theme] || C.THEMES.meadow);
      state.view.syncState(state.session.state);
    }
  } catch (e) {
    $('compat-warning').classList.remove('hidden');
  }
}

// ---- frame loop ---------------------------------------------------------------------------------------------
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(100, now - (state.lastFrame || now));
  state.lastFrame = now;
  if (!state.visible) return;

  pollGamepad(dt);

  if (state.session && !state.session.finished) {
    const dayEvents = state.session.update(dt * state.dayLengthMs);
    if (dayEvents.length) {
      handleEvents(dayEvents, state.session.state);
      checkTutorialGoals();
      maybeAutosave();
    }
  }
  if (state.view && $('screen-game').classList.contains('active')) {
    state.view.update(dt, true);
  }
}

// ---- go --------------------------------------------------------------------------------------------------------
// ---- automation hook for smoke tests (?auto=kind:index&bot=1) --------------------
// Also serves as a deep link: ?auto=daily jumps straight into today's challenge.
function automationHook() {
  // Debug/testing handle (no gameplay effect).
  window.__ST = state;
  const params = new URLSearchParams(location.search);
  const auto = params.get('auto');
  if (!auto) return;
  const [kind, arg] = auto.split(':');
  let def = null;
  if (kind === 'journey') def = C.JOURNEY_STAGES[parseInt(arg || '0', 10)];
  else if (kind === 'learn') def = C.TUTORIALS[parseInt(arg || '0', 10)];
  else if (kind === 'challenge') def = C.CHALLENGES.find(c => c.id === 'ch-' + arg);
  else if (kind === 'practice') def = C.practiceContent(arg || 'normal', 0xBEEF);
  else if (kind === 'daily') def = C.dailyContent(state.platform.utcToday());
  if (!def) return;
  startGame(def, kind);
  if (params.get('bot')) {
    state.botTimer = setInterval(() => {
      const s = state.session;
      if (!s || s.finished) { clearInterval(state.botTimer); return; }
      if (s.state.status !== 'active') return;
      let actions = 0, a;
      while (actions++ < 24 && (a = C.botMove(s.state))) {
        const cmd = { type: a.type, x: a.x, y: a.y, building: a.building, orderId: a.orderId };
        const r = s.submit(cmd);
        if (!r.ok) break;
      }
      syncAll();
    }, 120);
  }
}

boot().then(() => automationHook()).catch(e => {
  console.error('boot failed', e);
  document.body.insertAdjacentHTML('beforeend', '<div class="panel" style="position:fixed;inset:20% 10% auto;z-index:99">Failed to start: ' + e.message + '</div>');
});
