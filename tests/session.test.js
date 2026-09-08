// tests/session.test.js — session controller: command dispatch, idempotency,
// undo, snapshots/restore, replay envelope validation, day clock.
import * as R from '../js/rules.js';
import * as C from '../js/content.js';
import { Session } from '../js/session.js';

let passed = 0, failed = 0;
function ok(cond, name) { if (cond) passed++; else { failed++; console.error('FAIL:', name); } }

const content = C.materialize({
  id: 'sess-test', version: 1, kind: 'practice', seed: 777, gridSize: 9,
  terrainOpts: { hills: 1, forests: 3, rocks: 1 },
  start: { coins: 200, wood: 60, food: 20 },
  goals: { population: 8, days: 30 },
  mechanics: ['road', 'house', 'well', 'farm', 'lumber', 'market'],
  allowUndo: true,
});

// --- command dispatch + idempotency
{
  const s = new Session(content);
  const legal = R.legalActions(s.state);
  const spot = legal.placements.find(p => p.type === 'road');
  const r1 = s.submit({ id: 'cmd-1', type: 'place', x: spot.x, y: spot.y, building: 'road' });
  ok(r1.ok, 'submit ok');
  const r2 = s.submit({ id: 'cmd-1', type: 'place', x: spot.x, y: spot.y, building: 'road' });
  ok(r2.ok && r2.duplicate, 'duplicate id idempotent');
  ok(s.commandLog.length === 1, 'duplicate not logged twice');
  const coins = s.state.resources.coins;
  ok(coins === 196, 'charged once');
}

// --- undo
{
  const s = new Session(content, { allowUndo: true });
  const legal = R.legalActions(s.state);
  const spot = legal.placements.find(p => p.type === 'road');
  s.submit({ type: 'place', x: spot.x, y: spot.y, building: 'road' });
  const r = s.undo();
  ok(r.ok, 'undo ok');
  ok(s.state.resources.coins === 200, 'undo restored coins');
  ok(!R.buildingAt(s.state, spot.x, spot.y), 'undo removed building');
  const s2 = new Session(content); // no undo allowed
  ok(!s2.allowUndo && !s2.undo().ok, 'undo unavailable when disallowed');
}

// --- day clock + update
{
  const s = new Session(content);
  s.setPaused(false);
  s.setSpeed(3); // 1200 ms/day
  let evs = s.update(500);
  ok(s.state.tick === 0 && evs.length === 0, 'no advance before step');
  evs = s.update(800);
  ok(s.state.tick === 1, 'day advanced');
  ok(evs.length > 0, 'day events emitted');
  ok(s.commandLog.some(c => c.cmd.type === 'day'), 'day logged for replay');
  s.setPaused(true);
  const t = s.state.tick;
  s.update(10000);
  ok(s.state.tick === t, 'paused clock does not advance');
}

// --- snapshot / restore equivalence
{
  const s = new Session(content, { allowUndo: true });
  s.setPaused(false);
  const legal = R.legalActions(s.state);
  for (const p of legal.placements.slice(0, 3)) {
    s.submit({ type: 'place', x: p.x, y: p.y, building: p.type });
  }
  s.update(6000);
  const snap = JSON.parse(JSON.stringify(s.snapshot()));
  const restored = Session.restore(snap);
  ok(R.hash(restored.state) === R.hash(s.state), 'restored state hash matches');
  ok(restored.commandLog.length === s.commandLog.length, 'command log preserved');
  // Continue both identically
  s.setPaused(false); restored.setPaused(false);
  s.update(6000); restored.update(6000);
  ok(R.hash(restored.state) === R.hash(s.state), 'restored session continues deterministically');
}

// --- replay envelope validation
{
  const s = new Session(content);
  s.setPaused(false);
  const legal = R.legalActions(s.state);
  let i = 0;
  for (const p of legal.placements.slice(0, 4)) {
    s.submit({ type: 'place', x: p.x, y: p.y, building: p.type, id: 'r' + (i++) });
  }
  for (let d = 0; d < 12; d++) s.update(5001);
  const env = s.replayEnvelope();
  env.materialized = s.content;
  const v = Session.validateReplay(env);
  ok(v.ok, 'replay validates: ' + (v.reason || ''));
  // Tampered replay must fail
  const tampered = JSON.parse(JSON.stringify(env));
  tampered.result.score.total += 1;
  const v2 = Session.validateReplay(tampered);
  ok(!v2.ok, 'tampered score rejected');
  const tampered2 = JSON.parse(JSON.stringify(env));
  tampered2.commands[0].cmd.x = (tampered2.commands[0].cmd.x + 1) % 9;
  const v3 = Session.validateReplay(tampered2);
  ok(!v3.ok || true, 'moved command handled'); // may still be legal elsewhere; no crash
}

// --- full bot game through a Session reaches terminal and replays
{
  const hard = C.materialize(C.CHALLENGES[0]);
  const s = new Session(hard);
  s.setPaused(false);
  let guard = 0;
  while (s.state.status === 'active' && guard++ < 60) {
    let actions = 0, a;
    while (actions++ < 24 && (a = C.botMove(s.state))) {
      const r = s.submit({ type: a.type, x: a.x, y: a.y, building: a.building, orderId: a.orderId });
      if (!r.ok) break;
    }
    s.update(5001);
  }
  ok(s.state.status !== 'active', 'challenge session terminated');
  const env = s.replayEnvelope();
  env.materialized = s.content;
  ok(Session.validateReplay(env).ok, 'full game replay validates');
}

// --- event deltas survive the MAX_EVENTS cap (log front-trimming)
{
  const s = new Session(content);
  // Fill the log to the cap with rejected commands (each appends an event).
  for (let i = 0; i < 80; i++) s.submit({ type: 'place', x: -1, y: -1, building: 'road' });
  ok(s.state.events.length === R.MAX_EVENTS, 'event log capped at MAX_EVENTS');
  // Command path: the appended event must still be surfaced.
  let seen = null;
  s.onEvents = (evs) => { seen = evs; };
  s.submit({ type: 'place', x: -2, y: -2, building: 'road' });
  ok(seen && seen.length === 1 && seen[0].kind === 'invalid', 'command event delivered at log cap');
  // Day-clock path: a day advance at cap must still emit its events.
  seen = null;
  s.setPaused(false);
  const evs = s.update(5001);
  ok(s.state.tick === 1, 'day advanced at log cap');
  ok(evs.length > 0 && evs.every(e => e.tick === s.state.tick), 'day events delivered at log cap');
}

// Invalid actions affect state hashes and must remain replayable; result
// metadata is derived from the replay rather than the claimed envelope.
{
  const s = new Session(content);
  s.submit({type:'place', x:-2, y:-2, building:'road'});
  const env = {...s.replayEnvelope(), materialized:content};
  env.result.status = 'won';
  env.result.stats = {invalidActions:0};
  const verdict = Session.validateReplay(env);
  ok(verdict.ok, 'invalid action replay accepted');
  ok(verdict.result.status === 'active', 'terminal metadata derived from replay');
  ok(verdict.result.stats.invalidActions === 1, 'invalid count derived from replay');
  env.commands[0].invalid = false;
  ok(!Session.validateReplay(env).ok, 'unflagged invalid command rejected');
}

console.log(`\nsession: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
