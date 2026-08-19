// tests/rules.test.js — Node test runner (no deps).
// Covers legal actions, invalid-action reasons, scoring components, terminal
// states, serialization, replay determinism, content validation, and fuzzing.
import * as R from '../js/rules.js';
import * as C from '../js/content.js';
import { hashString } from '../js/rng.js';

let passed = 0, failed = 0;
const failures = [];
function ok(cond, name) {
  if (cond) { passed++; } else { failed++; failures.push(name); console.error('FAIL:', name); }
}
function eq(a, b, name) { ok(JSON.stringify(a) === JSON.stringify(b), `${name} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }
function section(name) { console.log('\n== ' + name); }

// Fixture: small deterministic content.
function fixture(over = {}) {
  const def = {
    id: 'test-1', version: 1, kind: 'practice', seed: 12345, gridSize: 8,
    terrainOpts: { hills: 1, forests: 2, rocks: 0 },
    start: { coins: 100, wood: 30, food: 10 },
    goals: { population: 4, days: 40 },
    mechanics: ['road', 'house', 'well', 'farm', 'lumber', 'market'],
    ...over,
  };
  return C.materialize(def);
}

section('state creation & serialization');
{
  const content = fixture();
  const s = R.createGame(content);
  eq(s.tick, 0, 'tick starts at 0');
  eq(s.status, 'active', 'status active');
  ok(R.buildingAt(s, content.hall.x, content.hall.y)?.type === 'hall', 'hall placed');
  const json = R.serialize(s);
  const s2 = R.deserialize(json);
  eq(R.hash(s2), R.hash(s), 'serialize/deserialize round-trip hash');
  let threw = false;
  try { R.deserialize(JSON.stringify({ version: 999 })); } catch (e) { threw = true; }
  ok(threw, 'deserialize rejects wrong version');
}

section('placement legality & reasons');
{
  const content = fixture();
  let s = R.createGame(content);
  const hall = content.hall;
  // Out of bounds
  let v = R.validate(s, { type: 'place', x: -1, y: 0, building: 'road' });
  eq(v.reason, 'out-of-bounds', 'oob reason');
  // Occupied (hall tile)
  v = R.validate(s, { type: 'place', x: hall.x, y: hall.y, building: 'road' });
  eq(v.reason, 'occupied', 'occupied reason');
  // Find a grass neighbor of hall
  const nb = R.neighbors4(s, hall.x, hall.y).find(([x, y]) =>
    R.placementError(s, x, y, 'road') === null);
  ok(nb, 'a legal road spot exists next to hall');
  // House without road → no-road-connection (find a grass tile not adjacent to hall)
  let houseRejected = null;
  for (let y = 0; y < 8 && !houseRejected; y++) for (let x = 0; x < 8 && !houseRejected; x++) {
    if (R.placementError(s, x, y, 'house') === 'no-road-connection') houseRejected = [x, y];
  }
  ok(houseRejected, 'house rejected without road connection');
  // Insufficient funds
  const poor = R.createGame(fixture({ start: { coins: 0, wood: 0, food: 0 } }));
  const pv = R.validate(poor, { type: 'place', x: nb[0], y: nb[1], building: 'road' });
  eq(pv.reason, 'insufficient-funds', 'insufficient-funds reason');
  // Building disabled
  const limited = R.createGame(fixture({ mechanics: ['road'] }));
  const lv = R.validate(limited, { type: 'place', x: nb[0], y: nb[1], building: 'house' });
  eq(lv.reason, 'building-disabled', 'building-disabled reason');
  // Bad command shapes
  eq(R.validate(s, null).reason, 'bad-command', 'null command rejected');
  eq(R.validate(s, { type: 'nope' }).reason, 'bad-command', 'unknown type rejected');
  eq(R.validate(s, { type: 'place', x: 1.5, y: 0, building: 'road' }).reason, 'bad-command', 'non-integer coords rejected');
  // Apply road, then house next to it becomes legal
  const r1 = R.apply(s, { type: 'place', x: nb[0], y: nb[1], building: 'road' });
  ok(r1.ok, 'road placement ok');
  eq(r1.state.resources.coins, 100 - 4, 'road cost deducted');
  eq(r1.state.stats.invalidActions, 0, 'no invalid counted');
  // Original state unchanged (immutability)
  eq(s.resources.coins, 100, 'original state untouched');
  // Invalid apply increments counter
  const bad = R.apply(r1.state, { type: 'place', x: nb[0], y: nb[1], building: 'road' });
  ok(!bad.ok, 'double place rejected');
  eq(bad.state.stats.invalidActions, 1, 'invalid action counted');
}

section('demolish & refund');
{
  const content = fixture();
  let s = R.createGame(content);
  const hall = content.hall;
  const nb = R.neighbors4(s, hall.x, hall.y).find(([x, y]) => R.placementError(s, x, y, 'road') === null);
  s = R.apply(s, { type: 'place', x: nb[0], y: nb[1], building: 'road' }).state;
  eq(R.demolishError(s, hall.x, hall.y), 'not-demolishable', 'hall protected');
  eq(R.demolishError(s, 0, 0) === null || R.demolishError(s, 0, 0) === 'empty-tile', true, 'empty tile reason');
  const before = s.resources.coins;
  const r = R.apply(s, { type: 'demolish', x: nb[0], y: nb[1] });
  ok(r.ok, 'demolish ok');
  eq(r.state.resources.coins, before + 2, 'half refund');
  ok(!R.buildingAt(r.state, nb[0], nb[1]), 'tile cleared');
}

section('day advance: production, consumption, orders');
{
  const content = fixture();
  let s = R.createGame(content);
  const hall = content.hall;
  // Build: road, farm, lumber near forest, house
  const spots = R.legalActions(s).placements;
  const farmSpot = spots.find(p => p.type === 'farm');
  const lumberSpot = spots.find(p => p.type === 'lumber');
  const roadSpot = spots.find(p => p.type === 'road');
  s = R.apply(s, { type: 'place', ...roadSpot, building: 'road' }).state;
  if (farmSpot) s = R.apply(s, { type: 'place', x: farmSpot.x, y: farmSpot.y, building: 'farm' }).state;
  if (lumberSpot) s = R.apply(s, { type: 'place', x: lumberSpot.x, y: lumberSpot.y, building: 'lumber' }).state;
  const food0 = s.resources.food, wood0 = s.resources.wood;
  s = R.advanceDay(s);
  eq(s.tick, 1, 'tick advanced');
  if (farmSpot) ok(s.resources.food > food0, 'farm produced food');
  if (lumberSpot) ok(s.resources.wood > wood0, 'lumber produced wood');
  // Orders appear on tick % 3 == 1
  ok(s.orders.length > 0, 'order generated at tick 1');
  const order = s.orders[0];
  // Give resources and fulfill
  s.resources[order.want.res] = order.want.n;
  const coinsBefore = s.resources.coins;
  const fr = R.apply(s, { type: 'fulfill', orderId: order.id });
  ok(fr.ok, 'fulfill ok');
  eq(fr.state.resources.coins, coinsBefore + order.reward, 'reward paid');
  eq(fr.state.stats.ordersCompleted, 1, 'order counted');
  // Fulfill missing order
  eq(R.fulfillError(fr.state, 'ord-999'), 'order-missing', 'missing order reason');
}

section('needs, happiness, population');
{
  const content = fixture();
  let s = R.createGame(content);
  // Build road + house via legal actions
  const road = R.legalActions(s).placements.find(p => p.type === 'road');
  s = R.apply(s, { type: 'place', x: road.x, y: road.y, building: 'road' }).state;
  const house = R.legalActions(s).placements.find(p => p.type === 'house');
  s = R.apply(s, { type: 'place', x: house.x, y: house.y, building: 'house' }).state;
  // House without well: not fully served
  let evald = R.evaluateHouses(s);
  eq(evald.total, 1, 'one house');
  eq(evald.served, 0, 'unserved without well');
  // Build well in range
  const well = R.legalActions(s).placements.find(p => p.type === 'well' &&
    R.chebyshev(p.x, p.y, house.x, house.y) <= 2);
  ok(well, 'well spot near house exists');
  s = R.apply(s, { type: 'place', x: well.x, y: well.y, building: 'well' }).state;
  evald = R.evaluateHouses(s);
  eq(evald.served, 1, 'served with well+road+food');
  // Population grows over days with food
  for (let i = 0; i < 6; i++) s = R.advanceDay(s);
  ok(R.totalPopulation(s) > 0, 'population grew');
}

section('goals & terminal states');
{
  const content = fixture({ goals: { population: 1, days: 5 }, start: { coins: 200, wood: 60, food: 30 } });
  let s = R.createGame(content);
  const road = R.legalActions(s).placements.find(p => p.type === 'road');
  s = R.apply(s, { type: 'place', x: road.x, y: road.y, building: 'road' }).state;
  const house = R.legalActions(s).placements.find(p => p.type === 'house');
  s = R.apply(s, { type: 'place', x: house.x, y: house.y, building: 'house' }).state;
  const well = R.legalActions(s).placements.find(p => p.type === 'well' &&
    R.chebyshev(p.x, p.y, house.x, house.y) <= 2);
  s = R.apply(s, { type: 'place', x: well.x, y: well.y, building: 'well' }).state;
  let guard = 0;
  while (s.status === 'active' && guard++ < 10) s = R.advanceDay(s);
  eq(s.status, 'won', 'won when population goal met');
  eq(s.endReason, 'objectives-complete', 'win reason');
  // Commands after end rejected
  eq(R.validate(s, { type: 'place', x: 0, y: 0, building: 'road' }).reason, 'game-over', 'game-over after win');
  // Losing: impossible goal
  const doom = R.createGame(fixture({ goals: { population: 99, days: 3 } }));
  let g = 0;
  while (doom.status === 'active' && g++ < 10) { /* advance */ Object.assign(doom, R.advanceDay(doom)); }
  eq(doom.status, 'lost', 'lost when days expire');
  eq(doom.endReason, 'out-of-time', 'lose reason');
}

section('scoring components & tiebreak');
{
  const content = fixture();
  const s = R.createGame(content);
  const sc = R.score(s);
  ok('population' in sc.components && 'wellbeing' in sc.components && 'trade' in sc.components &&
     'treasury' in sc.components && 'services' in sc.components && 'swiftness' in sc.components,
     'all score components present');
  eq(typeof sc.total, 'number', 'total numeric');
  const a = { score: { total: 100 }, won: true, stats: { invalidActions: 0 }, elapsedTicks: 10, sessionId: 'b' };
  const b = { score: { total: 100 }, won: true, stats: { invalidActions: 1 }, elapsedTicks: 10, sessionId: 'a' };
  ok(R.compareResults(a, b) < 0, 'tiebreak: fewer invalid actions wins');
  const c = { ...a, sessionId: 'a' };
  ok(R.compareResults(c, a) < 0, 'tiebreak: stable session id last');
}

section('replay determinism');
{
  const content = fixture();
  function run(commands, days) {
    let s = R.createGame(content);
    for (const c of commands) s = R.apply(s, c).state;
    for (let i = 0; i < days; i++) s = R.advanceDay(s);
    return R.hash(s);
  }
  const legal = R.legalActions(R.createGame(fixture())).placements;
  const cmds = legal.slice(0, 5).map(p => ({ type: 'place', x: p.x, y: p.y, building: p.type }));
  const h1 = run(cmds, 12), h2 = run(cmds, 12);
  eq(h1, h2, 'same seed + commands → identical hash');
  const h3 = run(cmds, 13);
  ok(h1 !== h3, 'different length run → different hash');
}

section('legal action API & hints');
{
  const s = R.createGame(fixture());
  const legal = R.legalActions(s);
  ok(Array.isArray(legal.placements) && legal.placements.length > 0, 'placements listed');
  ok(Array.isArray(legal.demolish) && Array.isArray(legal.fulfill), 'demolish/fulfill listed');
  const hint = R.suggestAction(s);
  ok(hint && hint.kind, 'hint produced');
  // Hint must itself be legal
  if (hint.kind === 'place') {
    ok(R.validate(s, { type: 'place', x: hint.x, y: hint.y, building: hint.type ?? hint.building }).ok ||
       R.placementError(s, hint.x, hint.y, hint.type) === null, 'hint is legal');
  }
}

section('road limit challenge rule');
{
  const content = fixture({ roadLimit: 1 });
  let s = R.createGame(content);
  const roads = R.legalActions(s).placements.filter(p => p.type === 'road');
  ok(roads.length > 0, 'first road legal');
  s = R.apply(s, { type: 'place', x: roads[0].x, y: roads[0].y, building: 'road' }).state;
  const v = R.validate(s, { type: 'place', x: roads[1]?.x ?? 0, y: roads[1]?.y ?? 0, building: 'road' });
  ok(!v.ok, 'second road blocked');
  eq(v.reason, 'road-limit', 'road-limit reason');
}

section('fuzz: malformed commands never hang or corrupt');
{
  const content = fixture();
  let s = R.createGame(content);
  const junk = [
    undefined, null, 42, 'str', [], {}, { type: 1 }, { type: 'place' },
    { type: 'place', x: 1e9, y: -1e9, building: 'road' },
    { type: 'place', x: 0, y: 0, building: '<script>' },
    { type: 'demolish', x: NaN, y: 0 },
    { type: 'fulfill', orderId: null },
    { type: 'fulfill', orderId: {} },
  ];
  for (const cmd of junk) {
    const r = R.apply(s, cmd);
    ok(typeof r.ok === 'boolean' && r.state && Number.isInteger(r.state.tick), 'survived junk: ' + JSON.stringify(cmd));
    s = r.state;
  }
  // Random command storm
  let seed = 999;
  const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const types = ['road', 'house', 'farm', 'well', 'lumber', 'market', 'hall', 'xyz'];
  for (let i = 0; i < 300; i++) {
    const cmd = rand() < 0.7
      ? { type: 'place', x: Math.floor(rand() * 10) - 1, y: Math.floor(rand() * 10) - 1, building: types[Math.floor(rand() * types.length)] }
      : (rand() < 0.5 ? { type: 'demolish', x: Math.floor(rand() * 8), y: Math.floor(rand() * 8) }
                      : { type: 'fulfill', orderId: 'ord-' + Math.floor(rand() * 5) });
    s = R.apply(s, cmd).state;
    s = R.advanceDay(s);
    ok(Number.isFinite(s.resources.coins) && Number.isFinite(s.resources.food) && Number.isFinite(s.resources.wood),
       'resources finite after storm step ' + i);
    if (s.status !== 'active') break;
  }
}

section('content validation: tutorials, journey, challenges, daily');
{
  const groups = [
    ['tutorials', C.TUTORIALS],
    ['journey', C.JOURNEY_STAGES],
    ['challenges', C.CHALLENGES],
  ];
  for (const [label, defs] of groups) {
    for (const def of defs) {
      const r = C.validateContent(def);
      ok(r.ok, `${label}:${def.id} valid & solvable — ${r.issues.join('; ')}`);
    }
  }
  // Daily for a few dates
  for (const d of ['2026-01-01', '2026-08-19', '2026-12-31']) {
    const r = C.validateContent(C.dailyContent(d));
    ok(r.ok, `daily ${d} valid & solvable — ${r.issues.join('; ')}`);
  }
  // 40+ journey stages
  ok(C.JOURNEY_STAGES.length >= 40, 'at least 40 journey stages');
  // Five themes
  eq(Object.keys(C.THEMES).length, 5, 'five visual themes');
  // Mastery stages exist
  ok(C.JOURNEY_STAGES.some(s => s.mastery), 'mastery stages present');
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.error('Failures:', failures.length); process.exit(1); }
