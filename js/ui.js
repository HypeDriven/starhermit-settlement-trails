// ui.js — semantic HTML shell over the canvas: screens, HUD, toolbox, orders,
// inspector, tutorial card, settings, help, scoreboards, focus management and
// live-region announcements. UI state is kept separate from simulation state.

import { BUILDINGS, BUILD_ORDER, TERRAIN_NAME, INVALID_REASONS } from './rules.js';
import { ACHIEVEMENTS } from './store.js';

const TOOL_ICONS = { road: '🛤', house: '🏠', farm: '🌾', lumber: '🪓', well: '💧', market: '⚖️', demolish: '✖️', inspect: '🔍' };

function $(id) { return document.getElementById(id); }
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
export function costText(cost) {
  const parts = [];
  if (cost.coins) parts.push(cost.coins + '🪙');
  if (cost.wood) parts.push(cost.wood + '🪵');
  return parts.join(' ') || 'free';
}

export class UI {
  constructor() {
    this.screens = ['screen-title', 'screen-picker', 'screen-game', 'screen-pause',
      'screen-results', 'screen-settings', 'screen-help', 'screen-scores'];
    this.overlayStack = [];
    this.lastFocus = null;
    this.handlers = {};
    this.currentTool = null;
    this._toastTimer = null;
  }

  bind(handlers) {
    this.handlers = handlers;
    $('btn-play').addEventListener('click', () => handlers.onQuickPlay());
    $('btn-daily').addEventListener('click', () => handlers.onMode('daily'));
    $('btn-journey').addEventListener('click', () => handlers.onMode('journey'));
    $('btn-practice').addEventListener('click', () => handlers.onMode('practice'));
    $('btn-challenge').addEventListener('click', () => handlers.onMode('challenge'));
    $('btn-learn').addEventListener('click', () => handlers.onMode('learn'));
    $('btn-scores').addEventListener('click', () => this.showScores());
    $('btn-help').addEventListener('click', () => this.showHelp());
    $('btn-settings').addEventListener('click', () => this.showSettings());
    $('btn-resume').addEventListener('click', () => handlers.onResumeSave());
    $('btn-pause').addEventListener('click', () => handlers.onPause());
    $('btn-resume-game').addEventListener('click', () => handlers.onResume());
    $('btn-pause-settings').addEventListener('click', () => this.showSettings());
    $('btn-pause-help').addEventListener('click', () => this.showHelp());
    $('btn-restart').addEventListener('click', () => handlers.onRestart());
    $('btn-quit').addEventListener('click', () => handlers.onQuit());
    $('btn-retry').addEventListener('click', () => handlers.onRestart());
    $('btn-next').addEventListener('click', () => handlers.onNextStage());
    $('btn-results-scores').addEventListener('click', () => this.showScores());
    $('btn-results-home').addEventListener('click', () => handlers.onQuit());
    $('btn-settings-close').addEventListener('click', () => this.closeOverlay('screen-settings'));
    $('btn-help-close').addEventListener('click', () => this.closeOverlay('screen-help'));
    $('btn-scores-close').addEventListener('click', () => this.closeOverlay('screen-scores'));
    $('btn-speed').addEventListener('click', () => handlers.onCycleSpeed());
    $('btn-undo').addEventListener('click', () => handlers.onUndo());
    $('btn-hint').addEventListener('click', () => handlers.onHint());
    $('rail-left-toggle').addEventListener('click', () => $('rail-left').classList.toggle('open'));
    $('rail-right-toggle').addEventListener('click', () => $('rail-right').classList.toggle('open'));
    document.querySelectorAll('[data-back]').forEach(b =>
      b.addEventListener('click', () => this.show('screen-title')));
    document.querySelectorAll('.tab').forEach(t =>
      t.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach(x => { x.classList.remove('active'); x.setAttribute('aria-selected', 'false'); });
        t.classList.add('active'); t.setAttribute('aria-selected', 'true');
        this.handlers.onBoardTab(t.dataset.board);
      }));
  }

  // ---- screens ----------------------------------------------------------------
  show(id) {
    for (const s of this.screens) $(s).classList.toggle('active', s === id);
    this.overlayStack = [];
    const first = $(id).querySelector('button, [tabindex]');
    if (first) first.focus({ preventScroll: true });
  }

  showOverlay(id) {
    this.lastFocus = document.activeElement;
    $(id).classList.add('active');
    this.overlayStack.push(id);
    const first = $(id).querySelector('button');
    if (first) first.focus({ preventScroll: true });
  }

  closeOverlay(id) {
    $(id).classList.remove('active');
    this.overlayStack = this.overlayStack.filter(s => s !== id);
    // Focus restoration after every modal.
    if (this.lastFocus && document.contains(this.lastFocus)) this.lastFocus.focus({ preventScroll: true });
    if (this.handlers.onOverlayClosed) this.handlers.onOverlayClosed(id);
  }

  get topOverlay() { return this.overlayStack[this.overlayStack.length - 1] || null; }

  // ---- title -------------------------------------------------------------------
  setTitleInfo({ profileName, dailyDone, journeyUnlocked, journeyTotal, hasSave }) {
    $('profile-line').textContent = `Signed in as ${profileName}`;
    $('daily-status').textContent = dailyDone ? '✓ done' : '';
    $('journey-status').textContent = `${journeyUnlocked}/${journeyTotal}`;
    $('btn-resume').classList.toggle('hidden', !hasSave);
  }

  // ---- picker ---------------------------------------------------------------------
  showPicker(title, bodyBuilder) {
    $('picker-heading').textContent = title;
    const body = $('picker-body');
    body.innerHTML = '';
    bodyBuilder(body);
    this.show('screen-picker');
  }

  stageGrid(stages, progress, onPick) {
    return (body) => {
      const grid = el('div', 'stage-grid');
      stages.forEach((st, i) => {
        const unlocked = i <= progress.journeyUnlocked;
        const card = el('button', 'stage-card');
        card.disabled = !unlocked;
        const stars = progress.journeyStars[st.id] || 0;
        card.innerHTML = '';
        card.appendChild(el('div', null, `${i + 1}. ${st.name.replace(/^Mastery: /, '')}`));
        if (st.mastery) card.appendChild(el('div', 'mastery', 'MASTERY'));
        card.appendChild(el('div', 'stars', unlocked ? ('★'.repeat(stars) + '☆'.repeat(3 - stars)) : '🔒'));
        card.appendChild(el('div', 'muted', st.blurb));
        if (unlocked) card.addEventListener('click', () => onPick(i));
        grid.appendChild(card);
      });
      body.appendChild(grid);
    };
  }

  setupCard(def, { ranked, expected, onStart }) {
    return (body) => {
      const card = el('div', 'setup-card');
      card.appendChild(el('h3', null, def.name));
      card.appendChild(el('p', null, def.blurb || ''));
      const goals = [];
      if (def.goals.population) goals.push(`${def.goals.population} residents`);
      if (def.goals.orders) goals.push(`${def.goals.orders} trade orders`);
      if (def.goals.coins) goals.push(`${def.goals.coins} coins`);
      card.appendChild(el('p', null, `Objectives: ${goals.join(', ')} within ${def.goals.days} days.`));
      card.appendChild(el('p', 'muted', `Solo · ~${expected || '5–10'} min · ${ranked ? 'Ranked' : 'Unranked'} · Tools: ${def.mechanics.map(m => BUILDINGS[m].name).join(', ')}`));
      if (def.roadLimit) card.appendChild(el('p', 'muted', `Road limit: ${def.roadLimit} tiles.`));
      const start = el('button', 'btn primary', 'Start');
      start.addEventListener('click', onStart);
      card.appendChild(start);
      body.appendChild(card);
    };
  }

  // ---- game HUD -------------------------------------------------------------------
  buildToolbox(mechanics, allowDemolish = true) {
    const box = $('toolbox');
    box.innerHTML = '';
    const mkTool = (id, label, cost, title) => {
      const b = el('button', 'tool');
      b.dataset.tool = id;
      b.setAttribute('aria-pressed', 'false');
      b.title = title || label;
      b.appendChild(el('span', 'ico', TOOL_ICONS[id] || '🔨'));
      b.appendChild(el('span', 'nm', label));
      b.appendChild(el('span', 'cost', cost ? costText(cost) : ''));
      b.addEventListener('click', () => this.handlers.onTool(id));
      box.appendChild(b);
      return b;
    };
    mkTool('inspect', 'Inspect', null, 'Inspect tiles (I)');
    for (const t of BUILD_ORDER) {
      if (!mechanics.includes(t)) continue;
      mkTool(t, BUILDINGS[t].name, BUILDINGS[t].cost, BUILDINGS[t].desc);
    }
    if (allowDemolish) mkTool('demolish', 'Demolish', null, 'Demolish (X) — half refund');
  }

  setTool(id) {
    this.currentTool = id;
    document.querySelectorAll('.tool').forEach(b =>
      b.setAttribute('aria-pressed', String(b.dataset.tool === id)));
  }

  updateToolboxAffordability(state) {
    document.querySelectorAll('.tool').forEach(b => {
      const t = b.dataset.tool;
      if (BUILDINGS[t]) {
        const cost = BUILDINGS[t].cost;
        const afford = Object.keys(cost).every(r => (state.resources[r] || 0) >= cost[r]);
        b.disabled = !afford;
      }
    });
    $('btn-undo').classList.toggle('hidden', !this.handlers.hasUndo || !this.handlers.hasUndo());
  }

  updateHUD(state, scoreFn) {
    $('res-coins').textContent = state.resources.coins;
    $('res-wood').textContent = state.resources.wood;
    $('res-food').textContent = state.resources.food;
    let pop = 0, cap = 0;
    for (const c of state.cells) if (c && c.type === 'house') { pop += c.pop || 0; cap += 4; }
    $('res-pop').textContent = `${pop}/${cap}`;
    $('hud-day').textContent = `Day ${state.tick} / ${state.goals.days}`;
    this.updateToolboxAffordability(state);
  }

  setModePill(text) { $('hud-mode').textContent = text; }

  setObjectives(state) {
    const parts = [];
    const goals = state.goals;
    let pop = 0;
    for (const c of state.cells) if (c && c.type === 'house') pop += c.pop || 0;
    if (goals.population) {
      parts.push(`<div class="${pop >= goals.population ? 'done' : ''}">👥 Population ${pop} / ${goals.population}</div>`);
    }
    if (goals.orders) {
      parts.push(`<div class="${state.stats.ordersCompleted >= goals.orders ? 'done' : ''}">📦 Orders ${state.stats.ordersCompleted} / ${goals.orders}</div>`);
    }
    if (goals.coins) {
      parts.push(`<div class="${state.resources.coins >= goals.coins ? 'done' : ''}">🪙 Coins ${state.resources.coins} / ${goals.coins}</div>`);
    }
    parts.push(`<div>⏳ ${Math.max(0, goals.days - state.tick)} days left</div>`);
    $('objective-progress').innerHTML = parts.join('');
  }

  setObjectiveText(text) { $('objective-text').textContent = text; }

  updateOrders(state, onFulfill) {
    const list = $('orders-list');
    list.innerHTML = '';
    if (!state.orders.length) {
      list.appendChild(el('li', 'muted', 'No open orders. New orders arrive every few days.'));
      return;
    }
    for (const o of state.orders) {
      const li = el('li');
      const can = (state.resources[o.want.res] || 0) >= o.want.n;
      const left = o.expiresTick - state.tick;
      const label = el('span', null, `${o.want.n} ${o.want.res === 'food' ? '🌾' : '🪵'} → ${o.reward} 🪙`);
      li.appendChild(label);
      const btn = el('button', 'btn small', 'Deliver');
      btn.disabled = !can;
      btn.title = can ? 'Fulfil this order' : 'Not enough goods yet';
      btn.addEventListener('click', () => onFulfill(o.id));
      const wrap = el('span');
      wrap.appendChild(el('span', 'exp', `${left}d `));
      wrap.appendChild(btn);
      li.appendChild(wrap);
      list.appendChild(li);
    }
  }

  updateEventLog(events) {
    const ol = $('event-log');
    ol.innerHTML = '';
    for (const ev of events.slice(-8).reverse()) {
      ol.appendChild(el('li', null, `[D${ev.tick}] ${ev.text}`));
    }
  }

  // ---- inspector ------------------------------------------------------------------
  inspect(state, x, y, extra) {
    const body = $('inspector-body');
    body.innerHTML = '';
    if (x == null) { body.appendChild(el('p', 'muted', 'Select a tile or building.')); return; }
    const t = state.terrain[y * state.grid.w + x];
    const b = state.cells[y * state.grid.w + x];
    body.appendChild(el('h3', null, `Tile ${x},${y}`));
    body.appendChild(el('p', null, `Terrain: ${TERRAIN_NAME[t]}`));
    if (b) {
      const def = BUILDINGS[b.type];
      body.appendChild(el('p', null, `${def.name}`));
      if (b.type === 'house') {
        body.appendChild(el('p', null, `Residents: ${b.pop || 0}/4 · Happiness: ${Math.round((b.happy ?? 0) * 100)}%`));
        if (extra) {
          const needs = [];
          needs.push(`${extra.road ? '✅' : '❌'} road`);
          needs.push(`${extra.water ? '✅' : '❌'} water`);
          needs.push(`${extra.food ? '✅' : '❌'} food`);
          needs.push(`${extra.market ? '✅' : '➖'} market`);
          body.appendChild(el('p', null, needs.join(' · ')));
        }
      }
    } else if (extra && extra.error) {
      body.appendChild(el('p', null, INVALID_REASONS[extra.error] || extra.error));
    }
  }

  // ---- tutorial ---------------------------------------------------------------------
  setTutorialStep(step, idx, total) {
    const card = $('tutorial-card');
    if (!step) { card.classList.add('hidden'); return; }
    card.classList.remove('hidden');
    card.innerHTML = '';
    card.appendChild(el('h3', null, `Lesson ${idx + 1}/${total}`));
    card.appendChild(el('p', null, step.text));
  }

  // ---- feedback ------------------------------------------------------------------------
  toast(msg, isErr = false) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    t.classList.toggle('err', isErr);
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => t.classList.add('hidden'), 2600);
    this.announce(msg);
  }

  announce(msg) { $('board-sr').textContent = msg; }
  alert(msg) { $('alert-sr').textContent = msg; }

  countdown(text) {
    const c = $('countdown');
    if (text == null) { c.classList.add('hidden'); return; }
    c.classList.remove('hidden');
    c.textContent = text;
  }

  setSpeedButton(speed, paused) {
    $('btn-speed').textContent = paused ? '⏸' : ['⏸', '▶', '▶▶', '▶▶▶'][speed] || '▶';
    $('btn-speed').setAttribute('aria-label', paused ? 'Resume time' : `Speed ${speed}`);
  }

  // ---- results ---------------------------------------------------------------------------
  showResults({ won, state, score, mode, isDaily, rankInfo, newAchievements, onNextAvailable }) {
    $('results-heading').textContent = won ? '🎉 Charter fulfilled!' : '⏳ Charter expired';
    const reasons = {
      'objectives-complete': 'Every objective complete — the settlement thrives.',
      'out-of-time': 'The charter ran out of days before objectives were met.',
    };
    $('results-sub').textContent = reasons[state.endReason] || '';
    const box = $('score-breakdown');
    box.innerHTML = '';
    const names = {
      population: 'Population', wellbeing: 'Wellbeing', trade: 'Trade',
      treasury: 'Treasury', services: 'Service balance', swiftness: 'Swiftness bonus',
    };
    for (const k in score.components) {
      const row = el('div', 'row');
      row.appendChild(el('span', null, names[k] || k));
      row.appendChild(el('b', null, String(score.components[k])));
      box.appendChild(row);
    }
    const total = el('div', 'row total');
    total.appendChild(el('span', null, 'Total'));
    total.appendChild(el('b', null, String(score.total)));
    box.appendChild(total);
    const ach = $('results-achievements');
    ach.innerHTML = '';
    for (const a of newAchievements || []) {
      ach.appendChild(el('span', 'ach-badge', `🏅 ${a.name}`));
    }
    $('results-compare').textContent = rankInfo || '';
    $('btn-next').classList.toggle('hidden', !(won && onNextAvailable));
    this.showOverlay('screen-results');
  }

  // ---- scores -------------------------------------------------------------------------------
  showScores() {
    this.handlers.onBoardTab(document.querySelector('.tab.active')?.dataset.board || 'global');
    this.showOverlay('screen-scores');
  }

  renderScores(entries, meName, note) {
    const ol = $('scores-list');
    ol.innerHTML = '';
    if (!entries.length) {
      ol.appendChild(el('li', 'muted', 'No scores yet — be the first!'));
    }
    for (const e of entries) {
      const li = el('li', e.name === meName ? 'me' : null,
        `${e.name} — ${e.score} (day ${e.elapsedTicks}, seed ${e.seed.toString(16).slice(0, 6)})`);
      ol.appendChild(li);
    }
    $('scores-note').textContent = note || '';
  }

  // ---- settings ------------------------------------------------------------------------------
  showSettings() {
    this.handlers.onBuildSettings($('settings-body'));
    this.showOverlay('screen-settings');
  }

  // ---- help ------------------------------------------------------------------------------------
  showHelp() {
    this.handlers.onBuildHelp($('help-body'));
    this.showOverlay('screen-help');
  }

  settingsRow(labelText, control) {
    const row = el('div', 'set-row');
    const label = el('label', null, labelText);
    if (control.id) label.htmlFor = control.id;
    row.appendChild(label);
    row.appendChild(control);
    return row;
  }

  helpContent(bindings) {
    const frag = document.createDocumentFragment();
    const add = (h, ...paras) => {
      frag.appendChild(el('h3', null, h));
      for (const p of paras) {
        const d = el('div', 'rule-card');
        d.innerHTML = p;
        frag.appendChild(d);
      }
    };
    add('Goal',
      'Grow your settlement to meet the charter objectives before the final day. Residents move into <b>happy</b> homes and leave unhappy ones.',
      'A happy home has three things: a <b>road</b> connected to the Village Hall, <b>water</b> from a Well within 2 tiles, and <b>food</b> in the town stockpile. A nearby Market adds comfort and tax income.');
    add('Buildings',
      ...BUILD_ORDER.map(t => `<span class="ico">${TOOL_ICONS[t]}</span><b>${BUILDINGS[t].name}</b> (${costText(BUILDINGS[t].cost)}) — ${BUILDINGS[t].desc}`));
    add('Trade orders',
      'Every few days a trade order arrives: deliver the requested goods before it expires to earn coins. Coins fund expansion.');
    add('Controls',
      `Pointer/touch: pick a tool, tap a tile. Drag pans the map, scroll zooms.`,
      `Keyboard: arrows move the cursor, <kbd>${bindings.confirm}</kbd> build/inspect, <kbd>${bindings.cancel}</kbd> cancel or pause, <kbd>${bindings.undo}</kbd> undo, <kbd>${bindings.hint}</kbd> hint, <kbd>${bindings.speed}</kbd> change speed, <kbd>${bindings.cameraReset}</kbd> reset camera, <kbd>1–7</kbd> tools.`,
      'Gamepad: stick/d-pad moves the cursor, A confirms, B cancels, Start pauses.');
    return frag;
  }
}
