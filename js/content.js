// content.js — versioned content: terrain generation, journey stages, tutorials,
// daily challenge, challenge modes, themes, and an offline validator that proves
// basic legality, reachable goals, bounded duration, and absence of soft locks.

import { RngStream, hashString } from './rng.js';
import * as R from './rules.js';

export const CONTENT_VERSION = 1;

// ---- Terrain generation -----------------------------------------------------
// Produces { w, h, terrain[], hall:{x,y} } deterministically from a seed.
// Signature setting: a river crossing the map and a hill region.
export function generateTerrain(seed, w, h, opts = {}) {
  const rng = new RngStream(seed >>> 0, 'terrain');
  const terrain = new Array(w * h).fill(R.TERRAIN.GRASS);

  // River: walks from one edge to the opposite, 1 tile wide.
  const vertical = rng.chance(0.5);
  if (vertical) {
    let x = rng.int(Math.floor(w * 0.25), Math.floor(w * 0.75));
    for (let y = 0; y < h; y++) {
      terrain[y * w + x] = R.TERRAIN.WATER;
      x = Math.max(1, Math.min(w - 2, x + rng.int(-1, 1)));
    }
  } else {
    let y = rng.int(Math.floor(h * 0.25), Math.floor(h * 0.75));
    for (let x = 0; x < w; x++) {
      terrain[y * w + x] = R.TERRAIN.WATER;
      y = Math.max(1, Math.min(h - 2, y + rng.int(-1, 1)));
    }
  }

  // Hills: a couple of blobs.
  const hillBlobs = opts.hills ?? 2;
  for (let b = 0; b < hillBlobs; b++) {
    const cx = rng.int(1, w - 2), cy = rng.int(1, h - 2), rad = rng.int(1, 2);
    for (let y = cy - rad; y <= cy + rad; y++) {
      for (let x = cx - rad; x <= cx + rad; x++) {
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        if (R.chebyshev(x, y, cx, cy) <= rad && terrain[y * w + x] === R.TERRAIN.GRASS) {
          terrain[y * w + x] = R.TERRAIN.HILL;
        }
      }
    }
  }

  // Forests: several clumps.
  const clumps = opts.forests ?? 4;
  for (let c = 0; c < clumps; c++) {
    const cx = rng.int(1, w - 2), cy = rng.int(1, h - 2), rad = rng.int(1, 2);
    for (let y = cy - rad; y <= cy + rad; y++) {
      for (let x = cx - rad; x <= cx + rad; x++) {
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        if (terrain[y * w + x] !== R.TERRAIN.WATER && rng.chance(0.7)) {
          terrain[y * w + x] = R.TERRAIN.FOREST;
        }
      }
    }
  }

  // Rocks: a few unbuildable accents.
  const rocks = opts.rocks ?? 2;
  for (let r = 0; r < rocks; r++) {
    const x = rng.int(0, w - 1), y = rng.int(0, h - 1);
    if (terrain[y * w + x] === R.TERRAIN.GRASS) terrain[y * w + x] = R.TERRAIN.ROCK;
  }

  // Hall: on grass near map centre, not water/forest/rock.
  let hall = null;
  const cx0 = w >> 1, cy0 = h >> 1;
  outer:
  for (let rad = 0; rad < Math.max(w, h); rad++) {
    for (let y = cy0 - rad; y <= cy0 + rad; y++) {
      for (let x = cx0 - rad; x <= cx0 + rad; x++) {
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        if (R.chebyshev(x, y, cx0, cy0) !== rad) continue;
        if (terrain[y * w + x] === R.TERRAIN.GRASS) { hall = { x, y }; break outer; }
      }
    }
  }
  if (!hall) { terrain[cy0 * w + cx0] = R.TERRAIN.GRASS; hall = { x: cx0, y: cy0 }; }

  // Guarantee working room: the 8 tiles around the hall are always open grass,
  // so the road network can never be walled in by river/forest/rock.
  for (let y = hall.y - 1; y <= hall.y + 1; y++) {
    for (let x = hall.x - 1; x <= hall.x + 1; x++) {
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      terrain[y * w + x] = R.TERRAIN.GRASS;
    }
  }

  return { w, h, terrain, hall };
}

// ---- Mechanics tiers (introduce one concept at a time) -----------------------
const TIER_MECHANICS = [
  ['road', 'house'],                                    // tier 0: settle
  ['road', 'house', 'well'],                            // tier 1: water
  ['road', 'house', 'well', 'farm'],                    // tier 2: food
  ['road', 'house', 'well', 'farm', 'lumber'],          // tier 3: wood
  ['road', 'house', 'well', 'farm', 'lumber', 'market'],// tier 4: trade
];

function tierForStage(n) {
  if (n < 6) return 0;
  if (n < 12) return 1;
  if (n < 20) return 2;
  if (n < 30) return 3;
  return 4;
}

// ---- Journey stages -----------------------------------------------------------
// 44 authored stages: each pins seed, size, resources, goals and mechanics.
function makeStage(n) {
  const tier = tierForStage(n);
  const mastery = (n % 10 === 9); // every 10th is a mastery stage combining known concepts
  const size = 8 + Math.min(4, Math.floor(n / 8));  // 8..12
  const seed = hashString('journey-' + n);
  const tierBump = mastery ? Math.min(4, tier + 1) : tier;
  const mech = TIER_MECHANICS[tierBump];
  const popGoal = 5 + Math.floor(n * 0.8) + (mastery ? 3 : 0);
  const days = 30 + Math.floor(n / 2); // tighter relative to goal later
  const stage = {
    id: 'journey-' + n,
    version: CONTENT_VERSION,
    kind: 'journey',
    stageIndex: n,
    name: stageName(n, tierBump, mastery),
    seed,
    gridSize: size,
    terrainOpts: { hills: 1 + (n % 3), forests: 3 + (n % 4), rocks: 1 + (n % 3) },
    start: {
      coins: 60 + Math.max(0, 30 - n),
      // Pre-lumber stages must carry enough wood for their whole housing goal.
      wood: tierBump < 3 ? 24 + popGoal * 2 : 16 + Math.max(0, 14 - Math.floor(n / 2)),
      food: n < 12 ? 16 : 12,
    },
    goals: {
      population: popGoal,
      days,
      ...(tierBump >= 4 ? { orders: 1 + Math.floor(n / 12) } : {}),
    },
    mechanics: mech,
    par: { days: Math.max(12, days - 8), score: 300 + n * 60 },
    tutorial: n < 5,
    mastery,
    theme: ['meadow', 'river', 'highland', 'autumn', 'dusk'][n % 5],
    blurb: stageBlurb(tierBump, mastery),
  };
  return stage;
}

function stageName(n, tier, mastery) {
  const tierNames = ['First Trails', 'Fresh Water', 'Harvest', 'Timber', 'Market Day'];
  const base = tierNames[tier];
  return (mastery ? 'Mastery: ' : '') + base + ' ' + (n + 1);
}

function stageBlurb(tier, mastery) {
  const blurbs = [
    'Lay roads and raise houses. Connect every home to the hall.',
    'Wells supply water within 2 tiles. Keep every home watered.',
    'Farms grow food on grass; riverside farms yield more.',
    'Lumber huts must border forest. Wood fuels expansion.',
    'Markets serve homes within 3 tiles and fulfil trade orders.',
  ];
  const b = blurbs[tier];
  return mastery ? b + ' Prove your mastery under tighter limits.' : b;
}

export const JOURNEY_STAGES = [];
for (let i = 0; i < 44; i++) JOURNEY_STAGES.push(makeStage(i));

// ---- Tutorials (Learn mode) ----------------------------------------------------
// Interactive lessons: one rule at a time; each step requires the player to
// perform the matching action through the normal command path.
export const TUTORIALS = [
  {
    id: 'learn-1', version: CONTENT_VERSION, kind: 'learn', stageIndex: 0,
    name: 'Roads & Homes', seed: hashString('learn-1'), gridSize: 8,
    terrainOpts: { hills: 1, forests: 2, rocks: 0 },
    start: { coins: 60, wood: 20, food: 12 },
    goals: { population: 4, days: 30 },
    mechanics: ['road', 'house'],
    theme: 'meadow',
    steps: [
      { text: 'Select the Road tool, then build a road next to the Village Hall.', require: { type: 'place', building: 'road' } },
      { text: 'Build one more road extending outward.', require: { type: 'place', building: 'road' } },
      { text: 'Select the House tool and build a house beside a connected road.', require: { type: 'place', building: 'house' } },
      { text: 'Build a second house. Residents move in when homes are happy.', require: { type: 'place', building: 'house' } },
      { text: 'Reach 4 residents before the charter expires. Time passes on its own — use pause if you need to think.', require: { type: 'goal', population: 4 } },
    ],
  },
  {
    id: 'learn-2', version: CONTENT_VERSION, kind: 'learn', stageIndex: 1,
    name: 'Water & Wells', seed: hashString('learn-2'), gridSize: 8,
    terrainOpts: { hills: 1, forests: 2, rocks: 0 },
    start: { coins: 70, wood: 20, food: 14 },
    goals: { population: 6, days: 30 },
    mechanics: ['road', 'house', 'well'],
    theme: 'river',
    steps: [
      { text: 'Homes need water. Build two houses near the hall first.', require: { type: 'place', building: 'house' }, count: 2 },
      { text: 'Build a Well within 2 tiles of your houses.', require: { type: 'place', building: 'well' } },
      { text: 'Grow to 6 residents. Watch each home’s needs icons.', require: { type: 'goal', population: 6 } },
    ],
  },
  {
    id: 'learn-3', version: CONTENT_VERSION, kind: 'learn', stageIndex: 2,
    name: 'Food & Farms', seed: hashString('learn-3'), gridSize: 9,
    terrainOpts: { hills: 1, forests: 3, rocks: 1 },
    start: { coins: 80, wood: 24, food: 8 },
    goals: { population: 8, days: 32 },
    mechanics: ['road', 'house', 'well', 'farm'],
    theme: 'river',
    steps: [
      { text: 'Hungry residents leave. Build a Farm on grass — riverside farms yield +1 food.', require: { type: 'place', building: 'farm' } },
      { text: 'Build a Well to cover your homes.', require: { type: 'place', building: 'well' } },
      { text: 'Reach 8 residents without a food shortage.', require: { type: 'goal', population: 8 } },
    ],
  },
  {
    id: 'learn-4', version: CONTENT_VERSION, kind: 'learn', stageIndex: 3,
    name: 'Timber & Lumber', seed: hashString('learn-4'), gridSize: 9,
    terrainOpts: { hills: 2, forests: 4, rocks: 1 },
    start: { coins: 80, wood: 10, food: 12 },
    goals: { population: 8, days: 34 },
    mechanics: ['road', 'house', 'well', 'farm', 'lumber'],
    theme: 'highland',
    steps: [
      { text: 'Wood runs out fast. Build a Lumber Hut bordering a forest tile.', require: { type: 'place', building: 'lumber' } },
      { text: 'Sustain growth: reach 8 residents.', require: { type: 'goal', population: 8 } },
    ],
  },
  {
    id: 'learn-5', version: CONTENT_VERSION, kind: 'learn', stageIndex: 4,
    name: 'Markets & Trade', seed: hashString('learn-5'), gridSize: 10,
    terrainOpts: { hills: 2, forests: 4, rocks: 2 },
    start: { coins: 110, wood: 30, food: 14 },
    goals: { population: 10, orders: 1, days: 36 },
    mechanics: ['road', 'house', 'well', 'farm', 'lumber', 'market'],
    theme: 'autumn',
    steps: [
      { text: 'Build a Market on a connected road. It serves homes within 3 tiles.', require: { type: 'place', building: 'market' } },
      { text: 'Trade orders arrive every few days. Fulfil one from the orders panel when you have the goods.', require: { type: 'fulfill' } },
      { text: 'Finish the charter: 10 residents.', require: { type: 'goal', population: 10 } },
    ],
  },
];

// ---- Daily --------------------------------------------------------------------
export function dailyContent(dateISO, timeOffsetDays = 0) {
  // dateISO: 'YYYY-MM-DD' in UTC. Immutable once published.
  const seed = hashString('daily-' + dateISO);
  const dayNum = Math.floor(Date.parse(dateISO + 'T00:00:00Z') / 86400000);
  const size = 10 + (dayNum % 3);
  const tier = 2 + (dayNum % 3); // tiers 2..4 rotate
  return {
    id: 'daily-' + dateISO, version: CONTENT_VERSION, kind: 'daily',
    name: 'Daily Trail — ' + dateISO,
    seed, gridSize: size,
    terrainOpts: { hills: 2, forests: tier >= 3 ? 4 : 2, rocks: 2 },
    start: { coins: 80, wood: tier >= 3 ? 22 : 26 + (14 + (dayNum % 5)) * 2, food: 12 },
    goals: { population: 14 + (dayNum % 5), orders: tier >= 4 ? 2 : 1, days: 32 },
    mechanics: TIER_MECHANICS[tier],
    par: { days: 24, score: 1200 },
    theme: ['meadow', 'river', 'highland', 'autumn', 'dusk'][dayNum % 5],
    daily: dateISO,
    blurb: 'One shared map for everyone today. Same seed, same rules.',
  };
}

// ---- Practice --------------------------------------------------------------------
export function practiceContent(difficulty = 'normal', seed = null) {
  const presets = {
    relaxed: { size: 10, start: { coins: 120, wood: 40, food: 20 }, goals: { population: 10, days: 45 }, tier: 4 },
    normal:  { size: 10, start: { coins: 80, wood: 24, food: 12 }, goals: { population: 14, days: 34 }, tier: 4 },
    hard:    { size: 12, start: { coins: 60, wood: 14, food: 8 },  goals: { population: 20, orders: 2, days: 30 }, tier: 4 },
  };
  const p = presets[difficulty] || presets.normal;
  const s = seed ?? ((Math.random() * 0xffffffff) >>> 0); // practice seed is client-chosen, never ranked
  return {
    id: 'practice-' + difficulty + '-' + s.toString(16), version: CONTENT_VERSION, kind: 'practice',
    name: 'Practice (' + difficulty + ')',
    seed: s, gridSize: p.size,
    terrainOpts: { hills: 2, forests: 4, rocks: 2 },
    start: p.start, goals: p.goals,
    mechanics: TIER_MECHANICS[p.tier],
    allowUndo: true,
    par: { days: p.goals.days - 8, score: 1000 },
    theme: 'meadow',
    blurb: 'Unranked. Undo allowed. Experiment freely.',
  };
}

// ---- Challenges -------------------------------------------------------------------
export const CHALLENGES = [
  {
    id: 'ch-speedrun', version: CONTENT_VERSION, kind: 'challenge',
    name: 'Against the Sun', seed: hashString('ch-speedrun'), gridSize: 9,
    terrainOpts: { hills: 1, forests: 3, rocks: 1 },
    start: { coins: 90, wood: 26, food: 14 },
    goals: { population: 12, days: 18 },
    mechanics: TIER_MECHANICS[4],
    par: { days: 15, score: 900 }, theme: 'dusk',
    blurb: 'A very short charter. Every day counts.',
  },
  {
    id: 'ch-noroads', version: CONTENT_VERSION, kind: 'challenge',
    name: 'Sparse Streets', seed: hashString('ch-noroads'), gridSize: 10,
    terrainOpts: { hills: 2, forests: 4, rocks: 2 },
    start: { coins: 100, wood: 30, food: 12 },
    goals: { population: 12, days: 30 },
    mechanics: TIER_MECHANICS[4],
    roadLimit: 10,
    par: { days: 26, score: 950 }, theme: 'highland',
    blurb: 'Only 10 road tiles may exist at once. Plan the network carefully.',
  },
  {
    id: 'ch-harvest', version: CONTENT_VERSION, kind: 'challenge',
    name: 'Great Harvest', seed: hashString('ch-harvest'), gridSize: 11,
    terrainOpts: { hills: 1, forests: 5, rocks: 1 },
    start: { coins: 70, wood: 20, food: 6 },
    goals: { orders: 4, population: 8, days: 32 },
    mechanics: TIER_MECHANICS[4],
    par: { days: 28, score: 1100 }, theme: 'autumn',
    blurb: 'Trade is everything: complete 4 orders.',
  },
  {
    id: 'ch-rocky', version: CONTENT_VERSION, kind: 'challenge',
    name: 'Broken Ground', seed: hashString('ch-rocky'), gridSize: 12,
    terrainOpts: { hills: 3, forests: 3, rocks: 8 },
    start: { coins: 90, wood: 22, food: 12 },
    goals: { population: 16, days: 34 },
    mechanics: TIER_MECHANICS[4],
    par: { days: 30, score: 1000 }, theme: 'river',
    blurb: 'Rock-strewn land leaves little room to build.',
  },
];

// ---- Themes --------------------------------------------------------------------------
export const THEMES = {
  meadow:   { name: 'Meadow',   sky: 0x9fc5e8, fog: 0xbfd8e8, grass: 0x6aa84f, hill: 0x8a9a5b, forest: 0x38761d, water: 0x3d85c6, rock: 0x999999, ambient: 'day' },
  river:    { name: 'Riverlands', sky: 0xa8d0e6, fog: 0xc3dfea, grass: 0x5b9e4d, hill: 0x7d9160, forest: 0x2e6b34, water: 0x2f6fb2, rock: 0x8d8d8d, ambient: 'day' },
  highland: { name: 'Highland', sky: 0xa3b8cc, fog: 0xbccbd8, grass: 0x74955a, hill: 0x9aa06a, forest: 0x3d6b35, water: 0x4a86b8, rock: 0x7f7f7f, ambient: 'wind' },
  autumn:   { name: 'Autumn',   sky: 0xd9b98c, fog: 0xe0c9a4, grass: 0xa08a45, hill: 0xa8763e, forest: 0xb45f06, water: 0x4a7fa5, rock: 0x8a7f72, ambient: 'wind' },
  dusk:     { name: 'Dusk',     sky: 0x4a4a72, fog: 0x5c5c82, grass: 0x4a6b4a, hill: 0x5f6b52, forest: 0x2a4a2e, water: 0x2a4a72, rock: 0x5a5a5a, ambient: 'night' },
};

// ---- Content materialisation -------------------------------------------------------
export function materialize(def) {
  const t = generateTerrain(def.seed, def.gridSize, def.gridSize, def.terrainOpts || {});
  return {
    id: def.id, version: def.version, kind: def.kind, name: def.name,
    seed: def.seed,
    grid: { w: t.w, h: t.h },
    terrain: t.terrain,
    hall: t.hall,
    start: def.start,
    goals: def.goals,
    mechanics: def.mechanics,
    roadLimit: def.roadLimit || 0,
    par: def.par || null,
    theme: def.theme || 'meadow',
    steps: def.steps || null,
    daily: def.daily || null,
    mastery: !!def.mastery,
    allowUndo: !!def.allowUndo,
    blurb: def.blurb || '',
  };
}

// ---- Offline validator ---------------------------------------------------------------
// Greedy solver bot proves goals are reachable within the day bound without soft locks.
export function validateContent(def) {
  const issues = [];
  const content = materialize(def);
  // Basic legality
  if (!content.id || !content.version) issues.push('missing id/version');
  if (content.grid.w < 6 || content.grid.h < 6) issues.push('grid too small');
  if (content.terrain.length !== content.grid.w * content.grid.h) issues.push('terrain size mismatch');
  const hallT = content.terrain[content.hall.y * content.grid.w + content.hall.x];
  if (hallT === R.TERRAIN.WATER || hallT === R.TERRAIN.ROCK) issues.push('hall on invalid terrain');
  const buildable = content.terrain.filter(t => t === R.TERRAIN.GRASS || t === R.TERRAIN.HILL).length;
  if (buildable < 20) issues.push('not enough buildable land');
  if (!content.goals.days || content.goals.days < 5) issues.push('day bound missing or too small');

  // Solver: greedy bot plays the game with the same public rules API.
  // It may issue several commands per day (as a fast player would).
  let state = R.createGame(content);
  let guard = 0;
  let illegal = null;
  while (state.status === 'active' && guard++ < 500) {
    let actions = 0, action;
    while (actions++ < 24 && state.status === 'active' && (action = botMove(state))) {
      const res = R.apply(state, action);
      if (!res.ok) { illegal = 'bot produced illegal action: ' + res.reason; break; }
      state = res.state;
    }
    if (illegal) break;
    state = R.advanceDay(state);
  }
  if (illegal) issues.push(illegal);
  if (guard >= 500) issues.push('unbounded loop in solver');
  if (state.status !== 'won') {
    issues.push(`solver could not reach goals (status=${state.status}, tick=${state.tick})`);
  }
  if (state.tick > content.goals.days) issues.push('duration exceeds bound');
  return { ok: issues.length === 0, issues, solvedTick: state.tick, state };
}

export function botMove(state) {
  // Strategy: keep farms ahead of food, wells covering houses, lumber income,
  // houses+roads toward the population goal, fulfil orders when safe.
  const legal = R.legalActions(state);
  const pop = R.totalPopulation(state);
  const farmCount = R.findBuildings(state, 'farm').length;
  const houses = R.findBuildings(state, 'house');
  const lumbers = R.findBuildings(state, 'lumber').length;
  const wells = R.findBuildings(state, 'well');
  const evald = R.evaluateHouses(state);
  const goalPop = state.goals.population || 0;
  const expanding = R.totalCapacity(state) < goalPop + 2;
  // When expanding, keep a coin reserve for the next house (+road to connect it).
  const houseCost = (R.BUILDINGS.house.cost.coins || 0) + (R.BUILDINGS.road.cost.coins || 0);
  const reserve = expanding ? houseCost : 0;
  // Wood reserve: without lumber income, wood for all remaining houses is finite.
  const hasLumberIncome = state.mechanics.includes('lumber');
  const housesNeeded = Math.max(0, Math.ceil((goalPop + 2 - R.totalCapacity(state)) / R.BUILDINGS.house.capacity));
  const woodReserve = expanding
    ? (hasLumberIncome ? 4 : housesNeeded * (R.BUILDINGS.house.cost.wood || 0) + 4)
    : 0;
  const foodEmergency = state.resources.food < Math.ceil(pop / 2) * 3 + 2;

  // Fulfil orders only while keeping residents' food supply and reserves safe.
  for (const oid of legal.fulfill) {
    const o = state.orders.find(x => x.id === oid);
    if (!o) continue;
    if (o.want.res === 'food') {
      const net = farmCount * 4 - Math.ceil(pop / 2);
      const buffer = Math.ceil(pop / 2) * 3 + 4;
      if (net >= 0 && state.resources.food - o.want.n >= buffer) return { type: 'fulfill', orderId: oid };
    } else if (state.mechanics.includes('lumber')
        ? state.resources[o.want.res] - o.want.n >= 6
        : state.resources[o.want.res] - o.want.n >= woodReserve + 6) {
      return { type: 'fulfill', orderId: oid };
    }
  }

  // Legal spots ignoring affordability (to know what to save for).
  const spotsFor = (type) => {
    const out = [];
    for (let y = 0; y < state.grid.h; y++) {
      for (let x = 0; x < state.grid.w; x++) {
        const err = R.placementError(state, x, y, type);
        if (err === null || err === 'insufficient-funds') out.push({ x, y });
      }
    }
    return out;
  };

  const tryPlace = (type, pref) => {
    if (!state.mechanics.includes(type) || !R.canAfford(state, type)) return null;
    const spots = legal.placements.filter(p => p.type === type);
    if (!spots.length) return null;
    const s = pref ? pref(spots) : spots[0];
    if (!s) return null;
    return { type: 'place', building: type, x: s.x, y: s.y };
  };

  // Food security: farms to cover pop (each farm ~4 food/day; pop eats pop/2).
  // Survival beats saving, but don't burn the finite wood reserve on farms.
  const foodNeed = Math.ceil((pop + 4) / 2);
  const foodProd = farmCount * 4;
  const foodDeficit = foodProd < Math.ceil(pop / 2) + 2; // actual near-term shortfall
  if (state.mechanics.includes('farm') && foodProd < foodNeed + 2 &&
      (foodEmergency || foodDeficit || hasLumberIncome ||
       state.resources.wood - (R.BUILDINGS.farm.cost.wood || 0) >= woodReserve)) {
    const m = tryPlace('farm', spots => spots.find(s => R.adjacentWaterCount(state, s.x, s.y) > 0) || spots[0]);
    if (m) return m;
  }
  // Wood income if mechanics include lumber and wood is low (respect reserve).
  if (state.mechanics.includes('lumber') && lumbers < 1 + Math.floor(goalPop / 12) &&
      state.resources.wood < 20 &&
      state.resources.coins - (R.BUILDINGS.lumber.cost.coins || 0) >= (state.resources.wood < 6 ? 0 : reserve)) {
    const m = tryPlace('lumber');
    if (m) return m;
  }
  // Water coverage for unwatered houses.
  if (state.mechanics.includes('well')) {
    const unwatered = houses.filter(hs => {
      const info = evald.houses.get(hs.y * state.grid.w + hs.x);
      return info && !info.water;
    });
    if (unwatered.length || (houses.length && !wells.length)) {
      const target = unwatered[0] || houses[0];
      const m = tryPlace('well', spots => {
        let best = spots[0], bestD = 99;
        for (const s of spots) {
          const d = R.chebyshev(s.x, s.y, target.x, target.y);
          if (d < bestD) { bestD = d; best = s; }
        }
        return best;
      });
      if (m) return m;
    }
  }
  // Expand housing toward the goal.
  if (expanding) {
    const m = tryPlace('house', spots => {
      // Prefer spots already covered by a well, then closest to the hall.
      const hall = R.findBuildings(state, 'hall')[0];
      let best = spots[0], bestScore = Infinity;
      for (const s of spots) {
        const watered = wells.some(wl => R.chebyshev(s.x, s.y, wl.x, wl.y) <= 2);
        const d = hall ? R.chebyshev(s.x, s.y, hall.x, hall.y) : 0;
        const score = d + (watered ? 0 : 50);
        if (score < bestScore) { bestScore = score; best = s; }
      }
      return best;
    });
    if (m) return m;
    // No affordable house: extend the connected road network toward open ground,
    // but only while keeping the reserve — and only if wood isn't the blocker
    // (roads don't fix a wood shortage).
    const woodForHouse = hasLumberIncome || state.resources.wood >= (R.BUILDINGS.house.cost.wood || 0);
    const anyHouseSpot = spotsFor('house').length > 0;
    if (woodForHouse && state.resources.coins >= houseCost) {
      const r = tryPlace('road', spots => {
        const conn = R.connectedRoads(state);
        const hall = R.findBuildings(state, 'hall')[0];
        const useful = spots.filter(s => R.extendsNetwork(state, s.x, s.y, conn));
        if (!useful.length) return null;
        // Prefer roads that open the most buildable neighbours, near the hall.
        let best = useful[0], bestScore = -Infinity;
        for (const s of useful) {
          let open = 0;
          for (const [nx, ny] of R.neighbors4(state, s.x, s.y)) {
            const t = R.terrainAt(state, nx, ny);
            if (!R.buildingAt(state, nx, ny) && t !== R.TERRAIN.WATER && t !== R.TERRAIN.ROCK) open++;
          }
          const d = hall ? R.chebyshev(s.x, s.y, hall.x, hall.y) : 0;
          const score = open * 10 - d;
          if (score > bestScore) { bestScore = score; best = s; }
        }
        return best;
      });
      if (r) return r;
      if (!anyHouseSpot) return null; // truly blocked: wait for income
    }
    return null; // saving up for the next house
  }
  // Market for trade/happiness when established.
  if (state.mechanics.includes('market') && houses.length >= 3 && !R.findBuildings(state, 'market').length) {
    const m = tryPlace('market');
    if (m) return m;
  }
  // Save resources for orders if that's the remaining goal.
  if (state.goals.orders && state.stats.ordersCompleted < state.goals.orders) {
    return null;
  }
  // Otherwise keep expanding housing/roads when affordable (useful roads only).
  if (state.resources.coins > 30) {
    const m = tryPlace('house') || tryPlace('road', spots => {
      const conn = R.connectedRoads(state);
      const useful = spots.filter(s => R.extendsNetwork(state, s.x, s.y, conn));
      return useful.length ? useful[0] : null;
    });
    if (m) return m;
  }
  return null;
}

// Validate all shipped content (used by tests; heavy but offline).
export function validateAll() {
  const report = [];
  for (const def of [...TUTORIALS, ...JOURNEY_STAGES, ...CHALLENGES]) {
    const r = validateContent(def);
    report.push({ id: def.id, ok: r.ok, issues: r.issues, solvedTick: r.solvedTick });
  }
  return report;
}
