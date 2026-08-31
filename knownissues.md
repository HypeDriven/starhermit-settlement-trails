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
| `tests/e2e.mjs` (headless Chrome) | not present — substituted a CDP boot check (see *Not tested*): page loads, title "Settlement Trails", canvas present, **no console errors, no page exceptions, no failed requests** |

## Confirmed defects

Each defect below was reproduced by executing the real modules, not merely reported by the model.

### 1. The authoritative server trusts the client's own content definition, so any score is forgeable

- **File:** `server.js:35` (`validateScoreClaim`), specifically `server.js:44-50`
- **Trigger:** POST `/api/v1/scores` with a replay envelope whose `materialized` field is a content
  definition the client made up.
- **Behaviour:** validation only ever builds the game from client data:

  ```js
  if (!replay.materialized) return { ok: false, reason: 'no-content' };
  const check = Session.validateReplay(replay);        // replays against replay.materialized
  ...
  const state = R.createGame(replay.materialized);
  void state;                                          // created and immediately discarded
  if (replay.result.score.total !== score) return { ok: false, reason: 'score-mismatch' };
  ```

  `Session.validateReplay` (`js/session.js:177`) calls `envelopeContent(envelope)` (`js/session.js:221`), which returns
  `env.materialized` verbatim. Nothing compares that content to the authoritative
  `dailyContent(date)` for the claimed day/seed, and the final check compares two client-supplied
  numbers to each other. The `const state = R.createGame(...)` on line 48 is dead — `void state`
  discards it.
- **Expected:** spec §6: "validate score claims through a lightweight authoritative script using
  replayable input logs and deterministic seeds"; "Treat client clocks, scores … and completion
  claims as untrusted in competitive contexts"; "Daily seeds are immutable after publication."
- **Evidence:** the real daily for 2026-08-20 grants 80 coins and a 32-day charter with population
  and order goals. Submitting a self-declared version of that same content id/seed with
  `start.coins = 99000` and `goals = { days: 2 }`:

  ```
  real daily seed: 3935742099 start:{"coins":80,...} goals:{"population":14,"orders":1,"days":32}
  forged replay status: won  score total: 99015
  server verdict on forged claim: {"ok":true}

  POST /api/v1/scores -> 200 {"ok":true,"rank":1}
  GET  /api/v1/scores?board=daily:2026-08-20 ->
    {"entries":[{"name":"Cheater","score":99015,"seed":3935742099,
                 "contentId":"daily-2026-08-20","contentVersion":1,...}]}
  ```

### 2. Server leaderboard ignores the mandated tie-break order

- **File:** `server.js:92`
- **Trigger:** two entries with the same score on one board.
- **Behaviour:** `entries.sort((a, b) => b.score - a.score)` — score only. Equal scores keep
  submission order; whether the round was won, how many invalid actions were taken and how long it
  ran never affect placement. The stored entry (`server.js:82-90`) records `durationMs` and
  `sessionId` but not `won` or `invalidActions`, so the ordering cannot be repaired at read time.
- **Expected:** spec §2: "Ties use, in order: primary objective completion, fewer invalid actions,
  lower authoritative elapsed time, then stable session identifier." `js/rules.js:553`
  (`compareResults`) implements exactly that chain — the server just does not use it.
- **Evidence:** `server.js:92` as quoted, against `js/rules.js:553-560`.

### 3. A rejected score is reported to the client as success

- **File:** `server.js:76-79`
- **Trigger:** submit any claim that fails `validateScoreClaim` (bad replay, implausible score,
  missing content).
- **Behaviour:**

  ```js
  const verdict = await validateScoreClaim(payload);
  if (!verdict.ok) {
    // Unverifiable scores are still listed but marked casual.
    return json(res, 202, { ok: true, casual: true, reason: verdict.reason });
  }
  ```

  The comment says the score is "still listed", but the handler returns before `entries.push(...)`,
  so nothing is stored on any board — while still answering `ok: true`. There is no casual board;
  the score is silently dropped and the player is told it succeeded.
- **Expected:** spec §6: "If validation is unavailable, label the board casual and apply
  plausibility/rate checks" — i.e. an actual casual board, or an honest rejection.
- **Evidence:** `server.js:76-79` versus the storage block at `server.js:81-94` — no `boards.set`
  call is reachable from the failure path. The client compounds it: `submitHostedScore`
  (`js/platform.js:120-128`) tests `res.ok`, which is true for any 2xx including this 202, so it
  returns `{ ok: true, casual: true }`; `js/main.js:721` only appends "(hosted board unavailable —
  casual)" when `!r.ok`. The player is therefore told nothing at all went wrong.

### 4. A Lumber Hut keeps producing after every forest tile beside it is cleared

- **File:** `js/rules.js:445` (`advanceDay`), against `js/rules.js:228` (`placementError`)
- **Trigger:** place a Lumber Hut next to a forest tile, then place a Road/House/Well/Market on
  that forest tile — `apply()` clears forest on placement (`js/rules.js:387`).
- **Behaviour:** production is
  `woodMade += Math.min(4, 2 + Math.max(0, adjacentForestCount(next, x, y) - 1))`, which yields 2
  for zero adjacent forest — exactly the same as for one adjacent forest. The `needsForest` rule is
  checked once, at placement, and never again.
- **Expected:** `BUILDINGS.lumber.desc` (`js/rules.js:26`) states "Produces wood each day. Must border
  forest.", and `placementError` refuses `not-adjacent-forest`. A hut that no longer borders
  forest should stop (or reduce) production; as written, the minimum legal placement also carries
  no production advantage over an illegal one.
- **Evidence:**

  ```
  lumber at 0 0  adjacent forest = 1
  wood produced with forest   : 2
  adjacent forest now = 0
  wood produced with NO forest: 2
  ```

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
  weakness in defect 1 is entirely that its *content input* comes from the client.
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

- **`tests/e2e.mjs`**: not shipped. Substituted a CDP boot check against `PORT=39602 node
  server.js`; it verifies a clean boot (title, canvas, no errors) but does not play a settlement to
  completion.
- **Hosted platform paths**: `js/platform.js` requires a host launch token; presence, activity and
  telemetry endpoints were exercised only as server handlers.
- **Rendering and audio**: `js/render.js` (814 lines) and `js/audio.js` were not reviewed beyond
  confirming a clean WebGL boot.
- **Durability of boards**: `server.js` keeps boards in a process-local `Map`, so nothing about
  restart behaviour or concurrent writers could be assessed.
