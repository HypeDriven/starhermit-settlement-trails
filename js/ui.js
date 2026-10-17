// ui.js — semantic HTML shell over the canvas: screens, HUD, toolbox, orders,
// inspector, tutorial card, settings, help, scoreboards, focus management and
// live-region announcements. UI state is kept separate from simulation state.

import { BUILDINGS, BUILD_ORDER, TERRAIN_NAME } from './rules.js';
import { ACHIEVEMENTS } from './store.js';
import { T, N } from './i18n.js';
import { contentName, contentBlurb, buildingName, buildingDesc, invalidText, eventText } from './names.js';

/** Matches the CSS portrait-phone layout where both rails are bottom drawers in the same spot. */
export const PORTRAIT_DRAWERS = '(max-width: 700px) and (orientation: portrait)';
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
  return parts.join(' ') || T('free');
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
    $('btn-center').addEventListener('click', () => handlers.onCenter());
    // Portrait phones stack both drawers in the same spot: opening one closes the other.
    const toggleRail = (id, other) => {
      const open = $(id).classList.toggle('open');
      if (open && matchMedia(PORTRAIT_DRAWERS).matches) $(other).classList.remove('open');
    };
    $('rail-left-toggle').addEventListener('click', () => toggleRail('rail-left', 'rail-right'));
    $('rail-right-toggle').addEventListener('click', () => toggleRail('rail-right', 'rail-left'));
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
  setTitleInfo({ profileName, sync, dailyDone, journeyUnlocked, journeyTotal, hasSave }) {
    $('profile-line').textContent = T('Signed in as {name}', { name: profileName }) + (sync ? ` · ${sync}` : '');
    $('daily-status').textContent = dailyDone ? T('✓ done') : '';
    $('journey-status').textContent = `${journeyUnlocked}/${journeyTotal}`;
    $('btn-resume').classList.toggle('hidden', !hasSave);
  }

  // ---- picker ---------------------------------------------------------------------
  showPicker(title, bodyBuilder, rebuild = false) {
    $('picker-heading').textContent = title;
    const body = $('picker-body');
    body.innerHTML = '';
    bodyBuilder(body);
    if (!rebuild) this.show('screen-picker');
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
        card.appendChild(el('div', null, `${i + 1}. ${contentName(st, { bare: true })}`));
        if (st.mastery) card.appendChild(el('div', 'mastery', T('MASTERY')));
        card.appendChild(el('div', 'stars', unlocked ? ('★'.repeat(stars) + '☆'.repeat(3 - stars)) : '🔒'));
        card.appendChild(el('div', 'muted', contentBlurb(st)));
        if (unlocked) card.addEventListener('click', () => onPick(i));
        grid.appendChild(card);
      });
      body.appendChild(grid);
    };
  }

  setupCard(def, { ranked, expected, onStart }) {
    return (body) => {
      const card = el('div', 'setup-card');
      card.appendChild(el('h3', null, contentName(def)));
      card.appendChild(el('p', null, contentBlurb(def)));
      const goals = [];
      if (def.goals.population) goals.push(T('{n} residents', { n: def.goals.population }));
      if (def.goals.orders) goals.push(T('{n} trade orders', { n: def.goals.orders }));
      if (def.goals.coins) goals.push(T('{n} coins', { n: def.goals.coins }));
      card.appendChild(el('p', null, T('Objectives: {list} within {days} days.', { list: goals.join(', '), days: def.goals.days })));
      card.appendChild(el('p', 'muted', T('Solo · ~{min} min · {ranked} · Tools: {tools}', {
        min: expected || '5–10', ranked: T(ranked ? 'Ranked' : 'Unranked'), tools: def.mechanics.map(buildingName).join(', '),
      })));
      if (def.roadLimit) card.appendChild(el('p', 'muted', T('Road limit: {n} tiles.', { n: def.roadLimit })));
      const start = el('button', 'btn primary', T('Start'));
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
    this._toolbox = [mechanics, allowDemolish];
    mkTool('inspect', T('Inspect'), null, T('Inspect tiles (I)'));
    for (const t of BUILD_ORDER) {
      if (!mechanics.includes(t)) continue;
      mkTool(t, buildingName(t), BUILDINGS[t].cost, buildingDesc(t));
    }
    if (allowDemolish) mkTool('demolish', T('Demolish'), null, T('Demolish (X) — half refund'));
    if (this.currentTool) this.setTool(this.currentTool);
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
    $('hud-day').textContent = T('Day {day} / {days}', { day: state.tick, days: state.goals.days });
    this.updateToolboxAffordability(state);
  }

  setModePill(text) { $('hud-mode').textContent = text; }

  setObjectives(state) {
    const parts = [];
    const goals = state.goals;
    let pop = 0;
    for (const c of state.cells) if (c && c.type === 'house') pop += c.pop || 0;
    if (goals.population) {
      parts.push(`<div class="${pop >= goals.population ? 'done' : ''}">👥 ${T('Population {n} / {goal}', { n: pop, goal: goals.population })}</div>`);
    }
    if (goals.orders) {
      parts.push(`<div class="${state.stats.ordersCompleted >= goals.orders ? 'done' : ''}">📦 ${T('Orders {n} / {goal}', { n: state.stats.ordersCompleted, goal: goals.orders })}</div>`);
    }
    if (goals.coins) {
      parts.push(`<div class="${state.resources.coins >= goals.coins ? 'done' : ''}">🪙 ${T('Coins {n} / {goal}', { n: state.resources.coins, goal: goals.coins })}</div>`);
    }
    parts.push(`<div>⏳ ${T('{n} days left', { n: Math.max(0, goals.days - state.tick) })}</div>`);
    $('objective-progress').innerHTML = parts.join('');
  }

  setObjectiveText(text) { $('objective-text').textContent = text; }

  updateOrders(state, onFulfill) {
    const list = $('orders-list');
    list.innerHTML = '';
    if (!state.orders.length) {
      list.appendChild(el('li', 'muted', T('No open orders. New orders arrive every few days.')));
      return;
    }
    for (const o of state.orders) {
      const li = el('li');
      const can = (state.resources[o.want.res] || 0) >= o.want.n;
      const left = o.expiresTick - state.tick;
      const label = el('span', null, `${o.want.n} ${o.want.res === 'food' ? '🌾' : '🪵'} → ${o.reward} 🪙`);
      li.appendChild(label);
      const btn = el('button', 'btn small', T('Deliver'));
      btn.disabled = !can;
      btn.title = T(can ? 'Fulfil this order' : 'Not enough goods yet');
      btn.addEventListener('click', () => onFulfill(o.id));
      const wrap = el('span');
      wrap.appendChild(el('span', 'exp', T('{n}d', { n: left }) + ' '));
      wrap.appendChild(btn);
      li.appendChild(wrap);
      list.appendChild(li);
    }
  }

  updateEventLog(events) {
    const ol = $('event-log');
    ol.innerHTML = '';
    for (const ev of events.slice(-8).reverse()) {
      ol.appendChild(el('li', null, `[${T('D{n}', { n: ev.tick })}] ${eventText(ev)}`));
    }
  }

  // ---- inspector ------------------------------------------------------------------
  inspect(state, x, y, extra) {
    this._inspect = [state, x, y, extra];
    const body = $('inspector-body');
    body.innerHTML = '';
    if (x == null) { body.appendChild(el('p', 'muted', T('Select a tile or building.'))); return; }
    const t = state.terrain[y * state.grid.w + x];
    const b = state.cells[y * state.grid.w + x];
    body.appendChild(el('h3', null, T('Tile {x},{y}', { x, y })));
    body.appendChild(el('p', null, T('Terrain: {terrain}', { terrain: T(TERRAIN_NAME[t]) })));
    if (b) {
      body.appendChild(el('p', null, buildingName(b.type)));
      if (b.type === 'house') {
        body.appendChild(el('p', null, T('Residents: {n}/4 · Happiness: {pct}%', { n: b.pop || 0, pct: Math.round((b.happy ?? 0) * 100) })));
        if (extra) {
          const needs = [];
          needs.push(`${extra.road ? '✅' : '❌'} ${T('road')}`);
          needs.push(`${extra.water ? '✅' : '❌'} ${T('water')}`);
          needs.push(`${extra.food ? '✅' : '❌'} ${T('food')}`);
          needs.push(`${extra.market ? '✅' : '➖'} ${T('market')}`);
          body.appendChild(el('p', null, needs.join(' · ')));
        }
      }
    } else if (extra && extra.error) {
      body.appendChild(el('p', null, invalidText(extra.error)));
    }
  }

  // ---- tutorial ---------------------------------------------------------------------
  setTutorialStep(step, idx, total) {
    this._tutorial = [step, idx, total];
    const card = $('tutorial-card');
    if (!step) { card.classList.add('hidden'); return; }
    card.classList.remove('hidden');
    card.innerHTML = '';
    card.appendChild(el('h3', null, T('Lesson {n}/{total}', { n: idx + 1, total })));
    card.appendChild(el('p', null, T(step.text)));
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
    this._speed = [speed, paused];
    $('btn-speed').setAttribute('aria-label', paused ? T('Resume time') : T('Speed {n}', { n: speed }));
  }

  // ---- results ---------------------------------------------------------------------------
  showResults(view, refresh = false) {
    const { won, state, score, rankInfo, newAchievements, onNextAvailable } = view;
    this._results = view;
    $('results-heading').textContent = T(won ? '🎉 Charter fulfilled!' : '⏳ Charter expired');
    const reasons = {
      'objectives-complete': N('Every objective complete — the settlement thrives.'),
      'out-of-time': N('The charter ran out of days before objectives were met.'),
    };
    $('results-sub').textContent = reasons[state.endReason] ? T(reasons[state.endReason]) : '';
    const box = $('score-breakdown');
    box.innerHTML = '';
    const names = {
      population: N('Population'), wellbeing: N('Wellbeing'), trade: N('Trade'),
      treasury: N('Treasury'), services: N('Service balance'), swiftness: N('Swiftness bonus'),
    };
    for (const k in score.components) {
      const row = el('div', 'row');
      row.appendChild(el('span', null, names[k] ? T(names[k]) : k));
      row.appendChild(el('b', null, String(score.components[k])));
      box.appendChild(row);
    }
    const total = el('div', 'row total');
    total.appendChild(el('span', null, T('Total')));
    total.appendChild(el('b', null, String(score.total)));
    box.appendChild(total);
    const ach = $('results-achievements');
    ach.innerHTML = '';
    for (const a of newAchievements || []) {
      ach.appendChild(el('span', 'ach-badge', `🏅 ${T(a.name)}`));
    }
    $('results-compare').textContent = typeof rankInfo === 'function' ? rankInfo() : rankInfo || '';
    $('btn-next').classList.toggle('hidden', !(won && onNextAvailable));
    if (!refresh) this.showOverlay('screen-results');
  }

  /** Language change: re-render what the UI built from its last inputs (toolbox, inspector, lesson card, results, speed label). */
  relabel() {
    if (this._toolbox) this.buildToolbox(...this._toolbox);
    if (this._inspect) this.inspect(...this._inspect);
    if (this._tutorial) this.setTutorialStep(...this._tutorial);
    if (this._speed) this.setSpeedButton(...this._speed);
    if (this._results && $('screen-results').classList.contains('active')) this.showResults(this._results, true);
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
      ol.appendChild(el('li', 'muted', T('No scores yet — be the first!')));
    }
    for (const e of entries) {
      const parts = [];
      if (e.rank != null) parts.push(`#${e.rank}`);
      parts.push(`${e.name} — ${e.score}`);
      const meta = [];
      if (e.elapsedTicks != null) meta.push(T('day {n}', { n: e.elapsedTicks }));
      if (e.seed != null) meta.push(T('seed {seed}', { seed: (e.seed >>> 0).toString(16).slice(0, 6) }));
      if (meta.length) parts.push(`(${meta.join(', ')})`);
      ol.appendChild(el('li', e.name === meName ? 'me' : null, parts.join(' ')));
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
    // Markup tokens: **bold** and [[key]] are applied after translation (no HTML in the dictionaries).
    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const md = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/\[\[(.+?)\]\]/g, '<kbd>$1</kbd>');
    add(T('Goal'),
      md(T('Grow your settlement to meet the charter objectives before the final day. Residents move into **happy** homes and leave unhappy ones.')),
      md(T('A happy home has three things: a **road** connected to the Village Hall, **water** from a Well within 2 tiles, and **food** in the town stockpile. A nearby Market adds comfort and tax income.')));
    add(T('Buildings'),
      ...BUILD_ORDER.map(t => `<span class="ico">${TOOL_ICONS[t]}</span><b>${esc(buildingName(t))}</b> (${esc(costText(BUILDINGS[t].cost))}) — ${esc(buildingDesc(t))}`));
    add(T('Trade orders'),
      esc(T('Every few days a trade order arrives: deliver the requested goods before it expires to earn coins. Coins fund expansion.')));
    add(T('Controls'),
      esc(T('Pointer/touch: pick a tool, tap a tile. Drag pans the map, scroll zooms.')),
      md(T('Keyboard: arrows move the cursor, [[{confirm}]] build/inspect, [[{cancel}]] cancel or pause, [[{undo}]] undo, [[{hint}]] hint, [[{speed}]] change speed, [[{camera}]] reset camera, [[1–7]] tools.', {
        confirm: bindings.confirm, cancel: bindings.cancel, undo: bindings.undo, hint: bindings.hint, speed: bindings.speed, camera: bindings.cameraReset,
      })),
      esc(T('Gamepad: stick/d-pad moves the cursor, A confirms, B cancels, Start pauses.')));
    return frag;
  }
}
