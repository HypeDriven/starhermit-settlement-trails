// rules.js — pure deterministic rules engine for Settlement Trails.
// No rendering, no DOM, no timers. State is plain JSON-serializable data.
// All transitions happen through validate()/apply()/advanceDay().

import { RngStream, stateHash } from './rng.js';

export const RULES_VERSION = 1;

// ---- Terrain -------------------------------------------------------------
export const TERRAIN = { GRASS: 0, FOREST: 1, HILL: 2, WATER: 3, ROCK: 4 };
export const TERRAIN_NAME = ['grass', 'forest', 'hill', 'water', 'rock'];

// ---- Buildings -----------------------------------------------------------
export const BUILDINGS = {
  hall:   { name: 'Village Hall', cost: {}, unique: true, terrain: [TERRAIN.GRASS, TERRAIN.HILL],
            desc: 'The heart of the settlement. Roads must connect back to it.' },
  road:   { name: 'Road',         cost: { coins: 4 }, terrain: [TERRAIN.GRASS, TERRAIN.HILL, TERRAIN.FOREST],
            desc: 'Connects buildings to the village hall. Cuts through forest.' },
  house:  { name: 'House',        cost: { coins: 15, wood: 4 }, terrain: [TERRAIN.GRASS, TERRAIN.HILL, TERRAIN.FOREST],
            needsRoad: true, capacity: 4,
            desc: 'Houses up to 4 residents. Needs road, water and food. Clears forest.' },
  farm:   { name: 'Farm',         cost: { coins: 20, wood: 6 }, terrain: [TERRAIN.GRASS],
            desc: 'Produces 4 food per day, +1 beside water.' },
  lumber: { name: 'Lumber Hut',   cost: { coins: 12 }, terrain: [TERRAIN.GRASS, TERRAIN.HILL],
            needsForest: true,
            desc: 'Produces wood each day. Must border forest.' },
  well:   { name: 'Well',         cost: { coins: 10, wood: 4 }, terrain: [TERRAIN.GRASS, TERRAIN.HILL, TERRAIN.FOREST],
            radius: 2, desc: 'Supplies water to houses within 2 tiles. Clears forest.' },
  market: { name: 'Market',       cost: { coins: 30, wood: 12 }, terrain: [TERRAIN.GRASS, TERRAIN.HILL, TERRAIN.FOREST],
            needsRoad: true, radius: 3,
            desc: 'Serves homes within 3 tiles, raising happiness and taxes. Clears forest.' },
};
export const BUILD_ORDER = ['road', 'house', 'farm', 'lumber', 'well', 'market'];

export const ORDER_TYPES = ['food', 'wood'];
export const MAX_ORDERS = 3;
export const ORDER_TTL = 6;          // days an order stays open
export const ORDER_EVERY = 3;        // new order cadence
export const MAX_EVENTS = 60;

// ---- State creation --------------------------------------------------------
export function createGame(content) {
  // content: { id, version, seed, grid:{w,h}, terrain:number[], hall:{x,y},
  //   start:{coins,wood,food}, goals:{population?,orders?,coins?,days}, mechanics:[types] }
  const w = content.grid.w, h = content.grid.h;
  const cells = new Array(w * h).fill(null);
  const hallIdx = content.hall.y * w + content.hall.x;
  cells[hallIdx] = { type: 'hall' };
  const state = {
    version: RULES_VERSION,
    contentId: content.id,
    contentVersion: content.version,
    seed: content.seed >>> 0,
    tick: 0,
    grid: { w, h },
    terrain: content.terrain.slice(),
    cells,
    resources: { coins: content.start.coins, wood: content.start.wood, food: content.start.food },
    orders: [],
    orderSeq: 0,
    rng: new RngStream((content.seed ^ 0x51e57) >>> 0, 'rules').snapshot(),
    goals: { ...content.goals },
    mechanics: content.mechanics.slice(),
    roadLimit: content.roadLimit || 0,
    stats: { invalidActions: 0, buildingsPlaced: 0, demolished: 0, ordersCompleted: 0, daysSurvived: 0 },
    status: 'active',       // active | won | lost
    endReason: null,
    events: [{ tick: 0, kind: 'start', text: 'Settlement founded.' }],
  };
  return state;
}

// ---- Helpers ---------------------------------------------------------------
export function idx(state, x, y) { return y * state.grid.w + x; }
export function inBounds(state, x, y) { return x >= 0 && y >= 0 && x < state.grid.w && y < state.grid.h; }
export function terrainAt(state, x, y) { return state.terrain[idx(state, x, y)]; }
export function buildingAt(state, x, y) { return state.cells[idx(state, x, y)]; }

export function neighbors4(state, x, y) {
  const out = [];
  if (x > 0) out.push([x - 1, y]);
  if (x < state.grid.w - 1) out.push([x + 1, y]);
  if (y > 0) out.push([x, y - 1]);
  if (y < state.grid.h - 1) out.push([x, y + 1]);
  return out;
}

export function chebyshev(x1, y1, x2, y2) {
  return Math.max(Math.abs(x1 - x2), Math.abs(y1 - y2));
}

function rngOf(state) { return RngStream.fromSnapshot(state.rng); }

// Set of occupied cell indices connected to the hall's network.
// Connectivity flows: hall → adjacent roads/buildings; roads → adjacent
// roads/buildings; buildings → adjacent roads only (so buildings cannot chain
// onto each other without roads, but a boxed-in hall can still grow outward
// by extending roads from already-connected buildings).
export function connectedRoads(state) {
  const { w } = state.grid;
  const connected = new Set();
  const queue = [];
  for (let i = 0; i < state.cells.length; i++) {
    if (state.cells[i] && state.cells[i].type === 'hall') { connected.add(i); queue.push(i); }
  }
  while (queue.length) {
    const ci = queue.shift();
    const cx = ci % w, cy = (ci / w) | 0;
    const fromType = state.cells[ci].type;
    for (const [nx, ny] of neighbors4(state, cx, cy)) {
      const ni = ny * w + nx;
      if (connected.has(ni)) continue;
      const nb = state.cells[ni];
      if (!nb) continue;
      if (fromType !== 'hall' && fromType !== 'road' && nb.type !== 'road') continue;
      connected.add(ni); queue.push(ni);
    }
  }
  return connected;
}

// Is (x,y) adjacent to the hall or a connected road? (building placement rule)
export function isRoadConnected(state, x, y, connected) {
  const conn = connected || connectedRoads(state);
  for (const [nx, ny] of neighbors4(state, x, y)) {
    const b = state.cells[ny * state.grid.w + nx];
    if (b && (b.type === 'hall' || (b.type === 'road' && conn.has(ny * state.grid.w + nx)))) return true;
  }
  return false;
}

// Would placing at (x,y) touch any connected network cell? (road extension rule)
export function extendsNetwork(state, x, y, connected) {
  const conn = connected || connectedRoads(state);
  for (const [nx, ny] of neighbors4(state, x, y)) {
    const b = state.cells[ny * state.grid.w + nx];
    if (b && conn.has(ny * state.grid.w + nx)) return true;
  }
  return false;
}

export function adjacentForestCount(state, x, y) {
  let n = 0;
  for (const [nx, ny] of neighbors4(state, x, y)) {
    if (terrainAt(state, nx, ny) === TERRAIN.FOREST) n++;
  }
  return n;
}

export function adjacentWaterCount(state, x, y) {
  let n = 0;
  for (const [nx, ny] of neighbors4(state, x, y)) {
    if (terrainAt(state, nx, ny) === TERRAIN.WATER) n++;
  }
  return n;
}

export function findBuildings(state, type) {
  const out = [];
  for (let i = 0; i < state.cells.length; i++) {
    if (state.cells[i] && state.cells[i].type === type) {
      out.push({ x: i % state.grid.w, y: (i / state.grid.w) | 0, b: state.cells[i] });
    }
  }
  return out;
}

// ---- Needs / happiness -------------------------------------------------------
// Recomputes per-house happiness and returns summary. Mutates nothing; returns
// { houses: Map(idx -> {needs, happy}), served, total, avgHappy }.
export function evaluateHouses(state) {
  const conn = connectedRoads(state);
  const wells = findBuildings(state, 'well');
  const markets = findBuildings(state, 'market');
  const houses = findBuildings(state, 'house');
  const housesInfo = new Map();
  let served = 0, happySum = 0;
  const hasFood = state.resources.food > 0 || state.stats.foodShortage !== true;
  for (const hs of houses) {
    const road = isRoadConnected(state, hs.x, hs.y, conn);
    const water = wells.some(wl => chebyshev(hs.x, hs.y, wl.x, wl.y) <= BUILDINGS.well.radius);
    const market = markets.some(mk => chebyshev(hs.x, hs.y, mk.x, mk.y) <= BUILDINGS.market.radius);
    const needCount = (road ? 1 : 0) + (water ? 1 : 0) + (hasFood ? 1 : 0);
    let happy = needCount / 3;
    if (market) happy = Math.min(1, happy + 0.2);
    if (road && water && hasFood) served++;
    housesInfo.set(hs.y * state.grid.w + hs.x, { road, water, food: hasFood, market, happy });
    happySum += happy;
  }
  return {
    houses: housesInfo,
    total: houses.length,
    served,
    avgHappy: houses.length ? happySum / houses.length : 0,
  };
}

export function totalPopulation(state) {
  let pop = 0;
  for (const c of state.cells) if (c && c.type === 'house') pop += c.pop || 0;
  return pop;
}

export function totalCapacity(state) {
  let cap = 0;
  for (const c of state.cells) if (c && c.type === 'house') cap += BUILDINGS.house.capacity;
  return cap;
}

// ---- Legality -----------------------------------------------------------------
export function canAfford(state, type) {
  const cost = BUILDINGS[type].cost;
  for (const res in cost) if ((state.resources[res] || 0) < cost[res]) return false;
  return true;
}

// Returns null when legal, otherwise a reason code.
export function placementError(state, x, y, type) {
  const def = BUILDINGS[type];
  if (!def) return 'unknown-building';
  if (state.status !== 'active') return 'game-over';
  if (!state.mechanics.includes(type)) return 'building-disabled';
  if (!inBounds(state, x, y)) return 'out-of-bounds';
  if (buildingAt(state, x, y)) return 'occupied';
  const t = terrainAt(state, x, y);
  if (!def.terrain.includes(t)) return 'terrain';
  if (def.unique && findBuildings(state, type).length > 0) return 'hall-unique';
  if (def.needsForest && adjacentForestCount(state, x, y) === 0) return 'not-adjacent-forest';
  if (def.needsRoad && !isRoadConnected(state, x, y)) return 'no-road-connection';
  if (!canAfford(state, type)) return 'insufficient-funds';
  if (type === 'road' && state.roadLimit > 0 && findBuildings(state, 'road').length >= state.roadLimit) {
    return 'road-limit';
  }
  return null;
}

export const INVALID_REASONS = {
  'unknown-building': 'Unknown building type.',
  'game-over': 'The game has ended.',
  'building-disabled': 'That building is not available in this scenario.',
  'out-of-bounds': 'Outside the map.',
  'occupied': 'That tile is already occupied.',
  'terrain': 'This building cannot be placed on that terrain.',
  'hall-unique': 'Only one Village Hall can exist.',
  'not-adjacent-forest': 'Lumber Huts must border a forest tile.',
  'no-road-connection': 'Must touch a road connected to the Village Hall.',
  'insufficient-funds': 'Not enough resources.',
  'not-demolishable': 'The Village Hall cannot be demolished.',
  'empty-tile': 'There is nothing to demolish here.',
  'order-missing': 'That trade order is no longer available.',
  'order-expired': 'That trade order has expired.',
  'insufficient-resources': 'You lack the goods this order requires.',
  'bad-command': 'Malformed command.',
  'road-limit': 'This scenario limits how many roads may exist at once.',
  'undo-unavailable': 'Undo is not available in this mode.',
};

export function demolishError(state, x, y) {
  if (state.status !== 'active') return 'game-over';
  if (!inBounds(state, x, y)) return 'out-of-bounds';
  const b = buildingAt(state, x, y);
  if (!b) return 'empty-tile';
  if (b.type === 'hall') return 'not-demolishable';
  return null;
}

export function fulfillError(state, orderId) {
  if (state.status !== 'active') return 'game-over';
  const order = state.orders.find(o => o.id === orderId);
  if (!order) return 'order-missing';
  if (order.expiresTick < state.tick) return 'order-expired';
  const res = order.want.res;
  if ((state.resources[res] || 0) < order.want.n) return 'insufficient-resources';
  return null;
}

// Full legal-action listing — used by hints, tutorials and keyboard targeting.
// Returns { placements: [{x,y,type}], demolish: [{x,y}], fulfill: [orderId] }.
export function legalActions(state) {
  const placements = [];
  if (state.status === 'active') {
    for (const type of state.mechanics) {
      if (type === 'hall') continue;
      if (!canAfford(state, type)) continue;
      for (let y = 0; y < state.grid.h; y++) {
        for (let x = 0; x < state.grid.w; x++) {
          if (placementError(state, x, y, type) === null) placements.push({ x, y, type });
        }
      }
    }
  }
  const demolish = [];
  for (let y = 0; y < state.grid.h; y++) {
    for (let x = 0; x < state.grid.w; x++) {
      if (demolishError(state, x, y) === null) demolish.push({ x, y });
    }
  }
  const fulfill = state.orders
    .filter(o => fulfillError(state, o.id) === null)
    .map(o => o.id);
  return { placements, demolish, fulfill };
}

// Suggested next move for the hint system (simple priority heuristic).
export function suggestAction(state) {
  const legal = legalActions(state);
  const pop = totalPopulation(state);
  const houses = findBuildings(state, 'house');
  const evald = evaluateHouses(state);
  const prio = [];
  if (legal.fulfill.length) prio.push({ kind: 'fulfill', orderId: legal.fulfill[0] });
  // Priority: houses need water -> well; low food -> farm; low wood -> lumber;
  // no houses -> house+road; else expand.
  const unserved = houses.filter(hs => {
    const info = evald.houses.get(hs.y * state.grid.w + hs.x);
    return info && !info.water;
  });
  const order = [];
  if (unserved.length && state.mechanics.includes('well')) order.push('well');
  if (state.resources.food < Math.max(4, pop) && state.mechanics.includes('farm')) order.push('farm');
  if (state.resources.wood < 8 && state.mechanics.includes('lumber')) order.push('lumber');
  if (houses.length === 0 || pop < (state.goals.population || 0)) {
    if (state.mechanics.includes('house')) order.push('house');
  }
  if (state.mechanics.includes('market') && houses.length >= 3) order.push('market');
  order.push('road');
  for (const t of order) {
    const p = legal.placements.find(pl => pl.type === t);
    if (p) return { kind: 'place', ...p };
  }
  if (legal.placements.length) return { kind: 'place', ...legal.placements[0] };
  return null;
}

// ---- Command validation / application -----------------------------------------
let cmdSeqCheck = null; // not used; commands carry their own ids (session layer)

export function validate(state, cmd) {
  if (!cmd || typeof cmd !== 'object' || typeof cmd.type !== 'string') {
    return { ok: false, reason: 'bad-command' };
  }
  switch (cmd.type) {
    case 'place': {
      if (!Number.isInteger(cmd.x) || !Number.isInteger(cmd.y) || typeof cmd.building !== 'string') {
        return { ok: false, reason: 'bad-command' };
      }
      const err = placementError(state, cmd.x, cmd.y, cmd.building);
      return err ? { ok: false, reason: err } : { ok: true };
    }
    case 'demolish': {
      if (!Number.isInteger(cmd.x) || !Number.isInteger(cmd.y)) return { ok: false, reason: 'bad-command' };
      const err = demolishError(state, cmd.x, cmd.y);
      return err ? { ok: false, reason: err } : { ok: true };
    }
    case 'fulfill': {
      if (typeof cmd.orderId !== 'string') return { ok: false, reason: 'bad-command' };
      const err = fulfillError(state, cmd.orderId);
      return err ? { ok: false, reason: err } : { ok: true };
    }
    default:
      return { ok: false, reason: 'bad-command' };
  }
}

function clone(state) { return JSON.parse(JSON.stringify(state)); }

function pushEvent(state, ev) {
  state.events.push(ev);
  if (state.events.length > MAX_EVENTS) state.events.splice(0, state.events.length - MAX_EVENTS);
}

// Apply a validated command. Returns { state, events } — a NEW state.
export function apply(state, cmd) {
  const v = validate(state, cmd);
  const next = clone(state);
  if (!v.ok) {
    next.stats.invalidActions++;
    pushEvent(next, { tick: next.tick, kind: 'invalid', reason: v.reason, text: INVALID_REASONS[v.reason] || 'Invalid action.' });
    return { state: next, ok: false, reason: v.reason };
  }
  if (cmd.type === 'place') {
    const def = BUILDINGS[cmd.building];
    for (const res in def.cost) next.resources[res] -= def.cost[res];
    const cell = { type: cmd.building };
    if (cmd.building === 'house') { cell.pop = 0; }
    const ci = idx(next, cmd.x, cmd.y);
    if (next.terrain[ci] === TERRAIN.FOREST) next.terrain[ci] = TERRAIN.GRASS; // clearing
    next.cells[ci] = cell;
    next.stats.buildingsPlaced++;
    pushEvent(next, { tick: next.tick, kind: 'place', x: cmd.x, y: cmd.y, building: cmd.building, text: `${def.name} built.` });
  } else if (cmd.type === 'demolish') {
    const b = buildingAt(next, cmd.x, cmd.y);
    const def = BUILDINGS[b.type];
    for (const res in def.cost) next.resources[res] += Math.floor(def.cost[res] / 2);
    next.cells[idx(next, cmd.x, cmd.y)] = null;
    next.stats.demolished++;
    pushEvent(next, { tick: next.tick, kind: 'demolish', x: cmd.x, y: cmd.y, building: b.type, text: `${def.name} demolished (half refund).` });
  } else if (cmd.type === 'fulfill') {
    const oi = next.orders.findIndex(o => o.id === cmd.orderId);
    const order = next.orders[oi];
    next.resources[order.want.res] -= order.want.n;
    next.resources.coins += order.reward;
    next.orders.splice(oi, 1);
    next.stats.ordersCompleted++;
    pushEvent(next, { tick: next.tick, kind: 'fulfill', orderId: order.id, reward: order.reward, text: `Trade order complete: +${order.reward} coins.` });
  }
  checkTerminal(next);
  return { state: next, ok: true };
}

// ---- Day advance ----------------------------------------------------------------
function makeOrder(state, rng) {
  const day = state.tick;
  const res = ORDER_TYPES[rng.int(0, ORDER_TYPES.length - 1)];
  const base = res === 'food' ? 6 : 4;
  const n = base + rng.int(0, 3) + Math.floor(day / 5);
  const reward = n * (res === 'food' ? 4 : 4) + rng.int(2, 8);
  return {
    id: 'ord-' + (state.orderSeq++),
    want: { res, n },
    reward,
    createdTick: day,
    expiresTick: day + ORDER_TTL,
  };
}

export function advanceDay(state) {
  if (state.status !== 'active') return state;
  const next = clone(state);
  next.tick++;
  next.stats.daysSurvived = next.tick;
  const rng = rngOf(next);

  // Production
  let foodMade = 0, woodMade = 0, taxes = 0;
  const evalBefore = evaluateHouses(next);
  for (let i = 0; i < next.cells.length; i++) {
    const c = next.cells[i];
    if (!c) continue;
    const x = i % next.grid.w, y = (i / next.grid.w) | 0;
    if (c.type === 'farm') {
      let f = 4 + (adjacentWaterCount(next, x, y) > 0 ? 1 : 0);
      foodMade += f;
    } else if (c.type === 'lumber') {
      woodMade += Math.min(4, 2 + Math.max(0, adjacentForestCount(next, x, y) - 1));
    } else if (c.type === 'market') {
      let servedHere = 0;
      for (const hs of findBuildings(next, 'house')) {
        if (chebyshev(hs.x, hs.y, x, y) <= BUILDINGS.market.radius) servedHere++;
      }
      taxes += servedHere * 2;
    }
  }
  next.resources.food += foodMade;
  next.resources.wood += woodMade;
  next.resources.coins += taxes;

  // Consumption: 1 food per 2 residents (rounded up)
  const pop = totalPopulation(next);
  const need = Math.ceil(pop / 2);
  let shortage = false;
  if (pop > 0) {
    if (next.resources.food >= need) {
      next.resources.food -= need;
    } else {
      next.resources.food = 0;
      shortage = true;
    }
  }
  next.stats.foodShortage = shortage;

  // Happiness + population drift
  const evald = evaluateHouses(next);
  for (const hs of findBuildings(next, 'house')) {
    const info = evald.houses.get(hs.y * next.grid.w + hs.x);
    const cell = next.cells[hs.y * next.grid.w + hs.x];
    cell.happy = Math.round(info.happy * 100) / 100;
    if (shortage) cell.happy = Math.max(0, cell.happy - 0.34);
    if (cell.happy >= 0.66 && !shortage && cell.pop < BUILDINGS.house.capacity) {
      cell.pop++;
    } else if ((cell.happy < 0.34 || shortage) && cell.pop > 0) {
      cell.pop--;
      pushEvent(next, { tick: next.tick, kind: 'leave', x: hs.x, y: hs.y, text: 'A resident left an unhappy home.' });
    }
  }

  // Orders: expire + generate
  const before = next.orders.length;
  next.orders = next.orders.filter(o => o.expiresTick >= next.tick);
  if (next.orders.length < before) {
    pushEvent(next, { tick: next.tick, kind: 'expired', text: 'A trade order expired.' });
  }
  if (next.tick % ORDER_EVERY === 1 && next.orders.length < MAX_ORDERS) {
    const order = makeOrder(next, rng);
    next.orders.push(order);
    pushEvent(next, { tick: next.tick, kind: 'order', orderId: order.id, text: `New trade order: ${order.want.n} ${order.want.res} for ${order.reward} coins.` });
  }
  next.rng = rng.snapshot();

  if (foodMade || woodMade || taxes) {
    pushEvent(next, { tick: next.tick, kind: 'produce', food: foodMade, wood: woodMade, coins: taxes,
      text: `Day ${next.tick}: +${foodMade} food, +${woodMade} wood, +${taxes} coin taxes.` });
  }
  if (shortage) pushEvent(next, { tick: next.tick, kind: 'shortage', text: 'Food shortage! Residents are going hungry.' });

  checkTerminal(next);
  return next;
}

// ---- Goals / terminal -------------------------------------------------------------
export function goalsMet(state) {
  const g = state.goals;
  if (g.population && totalPopulation(state) < g.population) return false;
  if (g.orders && state.stats.ordersCompleted < g.orders) return false;
  if (g.coins && state.resources.coins < g.coins) return false;
  return true;
}

function checkTerminal(state) {
  if (state.status !== 'active') return;
  if (goalsMet(state)) {
    state.status = 'won';
    state.endReason = 'objectives-complete';
    pushEvent(state, { tick: state.tick, kind: 'won', text: 'All objectives complete!' });
    return;
  }
  if (state.tick >= state.goals.days) {
    state.status = 'lost';
    state.endReason = 'out-of-time';
    pushEvent(state, { tick: state.tick, kind: 'lost', text: 'The charter expired before objectives were met.' });
  }
}

// ---- Scoring ---------------------------------------------------------------------
export function score(state) {
  const pop = totalPopulation(state);
  const evald = evaluateHouses(state);
  const balance = evald.total ? evald.served / evald.total : 0;
  const daysLeft = Math.max(0, state.goals.days - state.tick);
  const components = {
    population: pop * 10,
    wellbeing: Math.round(evald.avgHappy * 100),
    trade: state.stats.ordersCompleted * 40,
    treasury: Math.max(0, state.resources.coins),
    services: Math.round(balance * 50),
    swiftness: state.status === 'won' ? daysLeft * 15 : 0,
  };
  const total = Object.values(components).reduce((a, b) => a + b, 0);
  return { components, total, won: state.status === 'won' };
}

// Tiebreak comparison: returns negative if a ranks above b.
export function compareResults(a, b) {
  if (a.score.total !== b.score.total) return b.score.total - a.score.total;
  const ap = a.won ? 1 : 0, bp = b.won ? 1 : 0;
  if (ap !== bp) return bp - ap;
  if (a.stats.invalidActions !== b.stats.invalidActions) return a.stats.invalidActions - b.stats.invalidActions;
  if (a.elapsedTicks !== b.elapsedTicks) return a.elapsedTicks - b.elapsedTicks;
  return String(a.sessionId).localeCompare(String(b.sessionId));
}

// ---- Serialization ------------------------------------------------------------------
export function serialize(state) { return JSON.stringify(state); }

export function deserialize(json) {
  const s = typeof json === 'string' ? JSON.parse(json) : json;
  if (!s || typeof s !== 'object') throw new Error('bad state');
  if (s.version !== RULES_VERSION) throw new Error('unsupported rules version: ' + s.version);
  // Minimal structural validation
  if (!Number.isInteger(s.tick) || !s.grid || !Array.isArray(s.cells) || !Array.isArray(s.terrain)) {
    throw new Error('corrupt state');
  }
  if (s.cells.length !== s.grid.w * s.grid.h) throw new Error('corrupt cells');
  return s;
}

export function hash(state) {
  // Hash excludes the cosmetic event log so hash comparison focuses on rules truth.
  const { events, ...rest } = state;
  return stateHash(rest);
}
