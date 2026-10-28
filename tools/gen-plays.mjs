// Writes the native play scripts (tests/native/*.play) from the game's own
// greedy bot (js/content.js botMove, the one the content validator proves
// every shipped stage with): each day the bot's moves are played on the real
// UI — the tool by a digit key (or a finger on the toolbox), the cursor by
// the arrow keys, Enter (or a finger on the cursor's tile) to build, Deliver
// for trade orders — then the script waits for the next day's HUD line, so
// the day clock never has to line up with the moves (days without moves run
// at speed 3, days with moves at speed 1: 5 s for the moves). The rules are
// deterministic, so the node simulation and the runtime agree on every day.
//   node tools/gen-plays.mjs            (writes the committed scripts)
// tests/native.mjs writes today's Daily (.daily.play) at test time.
import { writeFileSync } from 'node:fs';
import * as R from '../js/rules.js';
import * as C from '../js/content.js';

const OUT = new URL('../tests/native/', import.meta.url).pathname;

/** The bot's plan for a stage, day by day: [{ tick, moves: [{ a, before }] }] and the final state (lessons: their placement steps first). */
export function planStage(def, label = def.id) {
  const content = C.materialize(def);
  let st = R.createGame(content);
  const steps = content.steps || [];
  let si = 0, sc = 0;
  const lessonHit = (a) => {
    const step = steps[si];
    if (!step) return;
    const req = step.require;
    if ((req.type === 'place' && a.type === 'place' && a.building === req.building) || (req.type === 'fulfill' && a.type === 'fulfill')) {
      if (++sc >= (req.count || step.count || 1)) { si++; sc = 0; }
    }
  };
  const guided = (s) => {
    const step = steps[si];
    if (!step || step.require.type !== 'place') return null;
    const type = step.require.building;
    const legal = R.legalActions(s).placements.filter((p) => p.type === type);
    if (!legal.length) return null;
    const hall = R.findBuildings(s, 'hall')[0];
    const conn = R.connectedRoads(s);
    const ok = type === 'road' ? legal.filter((p) => R.extendsNetwork(s, p.x, p.y, conn)) : legal;
    const pool = ok.length ? ok : legal;
    pool.sort((p, q) => R.chebyshev(p.x, p.y, hall.x, hall.y) - R.chebyshev(q.x, q.y, hall.x, hall.y) || p.y - q.y || p.x - q.x);
    return { type: 'place', building: type, x: pool[0].x, y: pool[0].y };
  };
  const days = [];
  let guard = 0;
  while (st.status === 'active' && guard++ < 200) {
    const moves = [];
    let s2 = st, n = 0, a;
    while (n++ < 24 && s2.status === 'active' && (a = guided(s2) || C.botMove(s2))) {
      const r = R.apply(s2, a);
      if (!r.ok) throw new Error(`${label}: bot made an illegal move ${JSON.stringify(a)}: ${r.reason}`);
      moves.push({ a, before: s2 });
      s2 = r.state;
      lessonHit(a);
    }
    days.push({ tick: st.tick, moves });
    st = s2;
    if (st.status !== 'active') break;
    st = R.advanceDay(st);
    const step = steps[si];
    if (step && step.require.type === 'goal' && step.require.population && R.totalPopulation(st) >= step.require.population) si++;
  }
  if (st.status !== 'won') throw new Error(`${label}: the bot did not win (${st.status} at day ${st.tick})`);
  if (steps.length && si < steps.length) console.warn(`${label}: lesson steps left undone (${si}/${steps.length})`);
  return { content, days, state: st, tools: ['inspect', ...R.BUILD_ORDER.filter((t) => content.mechanics.includes(t)), 'demolish'] };
}

/** One stage played by the bot. `input`: 'keys' (digits + Enter), 'toolbox' (tools by finger, Enter) or 'touch' (toolbox and tile touches). */
export function playStage(def, lines, { input = 'keys', deliver = 'click', label = def.id, drawer = false } = {}) {
  const { content, days: plan, state, tools } = planStage(def, label);
  let cursor = { ...content.hall };
  let tool = 'inspect';
  let speed = 1;
  const days = content.goals.days;
  lines.push(`# ${label}: ${def.name}`);
  lines.push(`until 900 Day 0 / ${days}`);
  lines.push('frames 10');
  for (const { tick, moves } of plan) {
    if (tick > 0) lines.push(`until 1200 Day ${tick} / ${days}`);
    const want = moves.length ? 1 : 3;
    while (speed !== want && tick > 0) { lines.push('key Space 1'); speed = speed % 3 + 1; }
    for (const { a, before: sb } of moves) {
      if (a.type === 'fulfill') {
        const o = sb.orders.find((x) => x.id === a.orderId);
        const same = sb.orders.filter((x) => x.want.n === o.want.n && x.want.res === o.want.res);
        const nth = same.length > 1 ? ` #${same.indexOf(o) + 1}` : '';
        if (drawer) { lines.push('touch Toggle objectives panel'); lines.push('frames 5'); }
        lines.push(`${deliver} Deliver ${o.want.n} ${o.want.res}${nth}`);
        lines.push('frames 5');
        if (drawer) { lines.push('touch Toggle objectives panel'); lines.push('frames 5'); }
        continue;
      }
      const t = a.type === 'place' ? a.building : 'demolish';
      if (tool !== t) {
        const i = tools.indexOf(t);
        if (input !== 'keys') { lines.push(`touch ${toolLabel(t)}`); lines.push('frames 3'); }
        else lines.push(`key Digit${i + 1} 1`);
        tool = t;
      }
      while (cursor.x < a.x) { lines.push('key ArrowRight 1'); cursor.x++; }
      while (cursor.x > a.x) { lines.push('key ArrowLeft 1'); cursor.x--; }
      while (cursor.y < a.y) { lines.push('key ArrowDown 1'); cursor.y++; }
      while (cursor.y > a.y) { lines.push('key ArrowUp 1'); cursor.y--; }
      if (input === 'touch') { lines.push(`touch Cursor: Tile ${a.x},${a.y},`); lines.push('frames 3'); }
      else lines.push('key Enter 1');
    }
  }
  lines.push('until 600 Charter fulfilled!');
  lines.push('frames 10');
  return state;
}
const TOOL_NAMES = { road: 'Road', house: 'House', farm: 'Farm', lumber: 'Lumber Hut', well: 'Well', market: 'Market', demolish: 'Demolish', inspect: 'Inspect' };
const toolLabel = (t) => `${TOOL_NAMES[t]} (`.replace('Demolish (', 'Demolish,').replace('Inspect (', 'Inspect,');

/** Today's Daily played by keys on a desktop (tests/native.mjs writes it at test time). */
export function dailyScript(def) {
  const lines = [`# Generated by tools/gen-plays.mjs at test time: today's Daily (${def.daily}) played by the bot with keys.`, '# viewport 1280x800@1',
    'until 600 Daily Trail', 'frames 30', 'click =Daily Trail', 'until 300 Objectives:', 'frames 10', 'click Start Daily Trail', 'frames 10'];
  playStage(def, lines, { label: 'daily' });
  lines.push('expect Total', 'save daily-results');
  return lines.join('\n') + '\n';
}

function journeyKeys() {
  const lines = ['# Generated by tools/gen-plays.mjs: Journey stages 1-3 on a desktop by keys (1-9 pick a tool, arrows move the cursor, Enter builds), each to its results; ▶ Play starts the first unlocked stage.',
    '# viewport 1280x800@1', 'until 600 Daily Trail', 'frames 30', 'click =▶ Play', 'frames 10'];
  for (let i = 0; i < 3; i++) {
    playStage(C.JOURNEY_STAGES[i], lines, { label: `journey-${i + 1}` });
    if (i === 0) lines.push('save journey-1-results');
    lines.push('expect Total');
    if (i < 2) lines.push('click =Next stage →');
  }
  lines.push('click =Home', 'until 300 Daily Trail', 'frames 10', 'expect 3/44');
  return lines.join('\n') + '\n';
}

function learnPhone() {
  const lines = ['# Generated by tools/gen-plays.mjs: Learn lessons 1-2 on a DPR-3 phone by finger (the toolbox, then a finger on the cursor\'s tile; the arrows only move the cursor there).',
    '# viewport 390x844@3', 'until 600 Daily Trail', 'frames 30', 'touch =Learn', 'until 300 Roads & Homes', 'frames 10', 'touch Roads & Homes', 'frames 30', 'save learn-phone'];
  playStage(C.TUTORIALS[0], lines, { input: 'touch', deliver: 'touch', drawer: true, label: 'learn-1' });
  lines.push('save learn-phone-results', 'expect Total', 'touch =Home', 'until 300 Daily Trail', 'frames 10', 'touch =Learn', 'until 300 Water & Wells', 'frames 10', 'touch Water & Wells', 'frames 30');
  playStage(C.TUTORIALS[1], lines, { input: 'touch', deliver: 'touch', drawer: true, label: 'learn-2' });
  lines.push('expect Total', 'touch =Home', 'until 300 Daily Trail', 'frames 10', 'touch =Learn', 'until 300 Roads & Homes', 'frames 10', 'expect ✅');
  return lines.join('\n') + '\n';
}

function marketLand() {
  const lines = ['# Generated by tools/gen-plays.mjs: lesson 5 (Markets & Trade) on a DPR-3 phone held sideways: the toolbox is a column at the side (tools by finger, building by the arrows and Enter: the lesson card covers the far side of the board), the objectives drawer opens for each Deliver.',
    '# viewport 844x390@3', 'until 600 Daily Trail', 'frames 30', 'touch =Learn', 'until 300 Markets & Trade', 'frames 10', 'touch Markets & Trade', 'frames 30', 'save market-land'];
  playStage(C.TUTORIALS[4], lines, { input: 'toolbox', deliver: 'touch', drawer: true, label: 'learn-5' });
  lines.push('save market-land-results', 'expect Total');
  return lines.join('\n') + '\n';
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  writeFileSync(OUT + 'journey-keys.play', journeyKeys());
  writeFileSync(OUT + 'learn-phone.play', learnPhone());
  writeFileSync(OUT + 'market-land.play', marketLand());
  console.log('wrote', OUT);
}
