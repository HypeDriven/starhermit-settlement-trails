# Known Issues — Settlement Trails

QA pass 2026-08-20. Static review driven by Qwen3.8 27B on spark185 (OBLITERATED Q8_0, 262k ctx),
alongside the game's own unit tests and a headless-Chrome boot check.

Method note: broad "find the defects in this module" prompts to the review model mostly came back
*NO DEFECTS FOUND*; the findings below were located by reading the source and then **re-executing
the real modules** to reproduce each one. Narrow, single-question prompts to the model were used
afterwards to double-check individual findings, and where that happened it is noted in the
evidence.

## Test results

| Check | Result |
| --- | --- |
| `npm test` | 168/168 rules + 21/21 session + 18/18 store — all pass |
| `node --check` on all modules | clean (10 `js/*.js` + `server.js`) |
| `tests/e2e.mjs` (headless Chrome) | **PASS — desktop + mobile, no page errors** (E2E PASS line) |

## Resolved defects

All four confirmed defects below were reproduced against the current source, fixed, and re-verified.
Fixes are surgical and confined to `server.js` and `js/rules.js`.

### 1. The authoritative server trusts the client's own content definition, so any score is forgeable — RESOLVED

- **Fixed:** `server.js` `validateScoreClaim` now rebuilds the authoritative content definition
  from the immutable content id (`server.js:36-86`): added `authoritativeContentDef` which resolves
  daily / journey / challenge / tutorial ids to their shipped definition, and the validator replays
  against `C.materialize(def)`, never against the client-supplied `replay.materialized`. It also
  rejects unknown content ids (`unknown-content`), seed mismatches (`seed-mismatch`) and content
  version mismatches. The dead `R.createGame(...) / void state` lines were removed.
- **Verification:** running `validateScoreClaim` against the real server module: the legit
  2026-08-20 daily playthrough returns `{"ok":true}`; the previously-published forgery
  (`start.coins=99000`, `goals.days=2`) is now rejected with `{"ok":false,"reason":"replay-initial-hash"}`;
  an invented content id is rejected with `unknown-content`.

### 2. Server leaderboard ignores the mandated tie-break order — RESOLVED

- **Fixed:** `server.js` now stores `won` and `invalidActions` (from `payload.won` /
  `payload.stats.invalidActions`) and `elapsedTicks` (= `durationMs`) on each entry
  (`server.js:113-122`), and the sort implements the spec §2 chain — score, then win, then fewer
  invalid actions, then lower elapsed time, then stable session id (`server.js:127-135`).
- **Verification:** inline comparator test: two 100-point entries, one won and one lost with fewer
  invalid actions, rank the winner first, then stable session id.

### 3. A rejected score is reported to the client as success — RESOLVED

- **Fixed:** `server.js:107-112` returns an honest non-2xx rejection —
  `json(res, 422, { ok: false, reason: verdict.reason })` — instead of a 202 `{ ok: true, casual: true }`.
  The unverified score is genuinely not stored, and the hosted client (`js/platform.js`
  `submitHostedScore`) now sees `!res.ok` and surfaces it as unavailable rather than success.
- **Verification:** invalid claims (bad replay / unknown content / implausible score) now reach the
  `422 { ok:false }` branch; the client path no longer reports a success.

### 4. A Lumber Hut keeps producing after every forest tile beside it is cleared — RESOLVED

- **Fixed:** `js/rules.js` `advanceDay` lumber production now reads the adjacent forest count and
  only produces when it borders forest: `woodMade += Math.min(4, 1 + forest)` for `forest > 0`,
  else `0` (`js/rules.js:444-447`). A hut with zero adjacent forest produces nothing; output
  still scales with the number of bordering forest tiles (2 for one, 3 for two, capped at 4).
- **Verification:** `npm test` (rules/session/store) passes with the change; the day-advance
  production test still confirms a forest-bordering lumber hut produces wood, and the content
  validation (all journey/challenge/daily solvable) still passes.

## Suspected — not confirmed

### 1. `evaluateHouses` treats food as satisfied before the first day advance

- **File:** `js/rules.js:178`
- **Concern:** `const hasFood = state.resources.food > 0 || state.stats.foodShortage !== true;`
  reads `stats.foodShortage`, which `createGame` never initialises, so at tick 0 the expression is
  `false || true` even with zero food.
- **Why unconfirmed:** after the first `advanceDay` the flag is authoritative
  (`js/rules.js:470`), and no shipped content starts at zero food, so the window is unreachable in
  practice.

### 2. `practiceContent` seeds from `Math.random()`

- **File:** `js/content.js:281` — flagged by the model.
- **Concern:** `const s = seed ?? ((Math.random() * 0xffffffff) >>> 0)` is non-deterministic.
- **Why unconfirmed:** the chosen seed is embedded in the content id and the state, and the inline
  comment marks practice as "client-chosen, never ranked", which spec §2 permits ("Practice:
  selectable difficulty … no effect on competitive rating"). Recorded here only because the model
  raised it; on review it appears intentional.

## Checked, no defects found

- `js/session.js` `validateReplay`: genuinely re-executes the log — initial hash, per-tick start
  hashes, illegal-command rejection, final hash and recomputed score. It is a sound validator; the
  former defect 1 weakness (its *content input* coming from the client) is now closed on the
  server side, which replays against the authoritative definition.
- `js/session.js` undo: `undo()` restores both the state snapshot and `commandLog.length`
  (`js/session.js:70-77`), so unlike several sibling games the replay log stays consistent with the
  state after an undo.
- `js/session.js` idempotency: `submit()` rejects a repeated `cmd.id` before applying it, and
  `restore()` rebuilds `seenIds` from the persisted command log.
- `js/rules.js` scoring: all six components are integers (`Math.round` on the two ratio-derived
  ones); `compareResults` implements the full spec tie-break chain.
- `js/rules.js` order lifecycle: `fulfillError` rejects `expiresTick < tick` and `advanceDay` keeps
  `expiresTick >= tick`, so the boundary day is consistently still fulfillable — no off-by-one.
- `js/rules.js` `legalActions` is the single legality surface; `suggestAction` (hints) is built on
  top of it rather than duplicating rules, as spec §2 requires.
- `js/store.js`: 18/18 unit tests pass, covering versioned documents and defaulting.
- `server.js` static file serving: `normalize` + `join` + `startsWith(ROOT)` correctly rejects
  `..` traversal; body reads are capped at 1 MB.
- Daily identity: `dailyContent` derives the seed purely from the UTC date string, so a published
  day's seed is immutable.
- Daily starting wood (`js/content.js:263`): `wood: tier >= 3 ? 22 : 26 + (14 + (dayNum % 5)) * 2`
  looks like an operator-precedence slip (22 at tiers 3–4 versus 54–62 at tier 2), but it is
  deliberate compensation — `TIER_MECHANICS[2]` (`js/content.js:99`) is
  `['road','house','well','farm']` with **no lumber hut**, so a tier-2 day has no way to produce
  wood at all and must be handed its whole supply up front. The matching `forests: tier >= 3 ? 4 : 2`
  on the line above is consistent with that reading.

## Not tested

- **`tests/e2e.mjs`**: now shipped and run via `npm run test:e2e` (headless Chrome). The full QA
  playthrough drives Journey stage 1 to a genuine win, checks progress persistence, exercises Undo
  in a Practice run, and confirms a mobile touchscreen pass — all green, no page errors.
- **Hosted platform paths**: `js/platform.js` requires a host launch token; presence, activity and
  telemetry endpoints were exercised only as server handlers.
- **Rendering and audio**: `js/render.js` (814 lines) and `js/audio.js` were not reviewed beyond
  confirming a clean WebGL boot.
- **Durability of boards**: `server.js` keeps boards in a process-local `Map`, so nothing about
  restart behaviour or concurrent writers could be assessed.
