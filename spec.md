# Settlement Trails — Product and Game Specification

**Document status:** running specification of the shipped game (present tense).  
**Game index:** 63  
**Genre:** Settlement simulation  
**Players:** 1 player; asynchronous score comparison on leaderboards  
**Targets:** the StarHermit client (native) and browsers (the StarHermit engine's web runtime), desktop and mobile, landscape and portrait  
**Implementation:** a StarHermit engine **script game** (TypeScript on the host API, `engine.version=1.27.0`, `engine.minor=29`): the settlement on `starhermit:scene`, every screen on `starhermit:ui`, sound on `starhermit:audio`, saves on `starhermit:storage`, the platform on `starhermit:platform`

## 1. Product vision

Settlement Trails is a game in which players place homes, services, roads, and production buildings while satisfying residents and trade orders. Its signature setting is a lively low-poly town spanning river and hills. The product should feel immediately understandable, responsive within one input, and polished enough that the board or playfield itself is the visual hero. Sessions should begin quickly, make the next useful action obvious without solving the game for the player, and end with a clear explanation of score and progress.

The experience must be original. Do not copy names, layouts, characters, iconography, writing, audio, progression maps, or level data from an existing title. Use an original visual language, original procedural assets, and internally authored content.

### Design pillars

1. **Readable before spectacular:** legal actions, hazards, selection, ownership, and goals remain legible with effects disabled.
2. **One-input confidence:** every press, tap, drag, key, or pointer action gives immediate visual and sonic acknowledgment.
3. **Short path to play:** a returning player reaches the primary playfield in at most two deliberate actions.
4. **Fair mastery:** randomness is seeded and inspectable; outcomes never depend on hidden purchases or invisible stat boosts.
5. **Scalable beauty:** the same art direction survives low-power mobile hardware and high-resolution desktop displays.

## 2. Core game design

### Objective and rules contract

Place homes, services, roads, and production buildings while satisfying residents and trade orders.

The rules engine must represent legal actions independently from rendering. It must expose legal-action queries, deterministic resolution, serializable state, a monotonically increasing turn/tick number, and a terminal-state reason. Tutorials and hints call the same legal-action API used by play rather than duplicating rules.

### Core loop

The repeated loop is: **zone or place a building, connect service, collect production, resolve needs, and expand**. Input is locked only during the shortest non-interruptible resolution phase. Cosmetic animation may continue after the logical state is ready, but skip/fast-forward must settle every object into the exact deterministic end state.

### Scoring and victory

Progress measures population wellbeing, balanced services, and scenario objectives. Results show a component breakdown rather than one unexplained total. Store integers for score and simulation units; format values only in presentation. Ties use, in order: primary objective completion, fewer invalid actions, lower authoritative elapsed time, then stable session identifier.

### Modes

- **Learn:** interactive lessons introduce one rule at a time and require the player to perform the action.
- **Journey:** authored progression with gradually combined mechanics and periodic mastery stages.
- **Daily:** one shared seed and ruleset per UTC day, synchronized to platform time.
- **Practice:** selectable difficulty, restart, undo where rules permit, and no effect on competitive rating.
- **Challenge:** constrained goals such as move limits, speed targets, altered layouts, or restricted tools.
- **Score chase:** asynchronous global and friends comparisons using validated seeds and rulesets.

### Difficulty and content generation

- Represent content as versioned data: identifier, seed, initial state, goals, allowed mechanics, par values, tutorial flags, and presentation theme.
- Run offline validators to prove basic legality, reachable goals, bounded duration, and absence of soft locks. Logic puzzles additionally require a unique or explicitly accepted solution class.
- Difficulty is measured from solution depth, branching factor, time pressure, motor precision, hidden information, and recovery options—not merely larger numbers.
- Introduce one new concept in isolation, combine it with one known concept, then test mastery before adding another.
- Daily seeds are immutable after publication. If content is defective, mark the day excluded from ranking rather than silently replacing it.

### Game-state model

`boot → title → profile-ready → mode-select → preparing → tutorial/countdown → active ↔ paused/reconnecting → resolving → results → progression`.

Every transition has one owner and an explicit reason. Backgrounding pauses solo simulation. In hosted play, the authoritative clock continues where rules require it, while the returning client receives a fresh snapshot and a concise “while you were away” summary.

## 3. Interaction and user-interface design

### Information hierarchy

1. **Primary:** playfield, current objective, legal interaction target (cursor, hover ring, ghost preview), food shortages and unhappy homes ("!" markers).
2. **Secondary:** resources, day / charter length, game speed, trade orders, the inspector.
3. **Tertiary:** settings, help, scoreboards, account controls.

The 3D settlement fills the window; the HUD, rails, toolbox, lesson card and panels are `starhermit:ui` widgets drawn over it every frame (native/screens.ts). Screen readers and the browser's accessibility mirror see every widget with its role and name; the keyboard cursor's tile is a named area ("Settlement playfield. Cursor: Tile x,y, terrain, building").

### Responsive layouts

Layouts are picked by the window's logical size (window pixels ÷ the runtime's UI scale, safe area excluded), as the old CSS breakpoints did:

- **Wide (≥ 1024 px, not short):** HUD bar on top (resources left; day pill and mode pill centre; speed, undo, hint, centre-map and pause icons right); the Objective rail (272 px) left and the Inspector rail right; the toolbox centred at the bottom; the lesson card and toasts above it.
- **Compact (< 1024 px):** the rails become drawers opened by ☰ (Objective) and ℹ (Inspector) under the HUD.
- **Phone portrait (≤ 700 px wide, portrait):** the HUD wraps (resources; icon buttons; day and mode between the drawer toggles); the toolbox shows icon tools with costs (no names), wrapping in centred rows; the drawers rise from above the toolbox (at most 42 % of the height) and opening one closes the other.
- **Short landscape (≤ 500 px tall):** narrow drawers (224 px); the toolbox is a scrolling column at the right edge (the left edge with the left-handed layout); the lesson card sits at the top. Narrow rails stack each trade order over its Deliver button.
- The runtime's UI scale covers large screens (the old `ui-scale.js`); resize, rotation, DPR and safe-area changes relayout on the next frame without restarting the settlement.

### Screens and overlays

- **Title:** Settlement **Trails**, the tagline, ▶ Play (the furthest unlocked Journey stage), Daily Trail (✓ done today), Journey (unlocked / 44); Practice, Challenges, Learn, Scores, Help, Settings; the profile line ("Signed in as …" with the cloud sync state); Sign in with StarHermit (signed out) and Invite a friend (signed in); ↩ Resume saved settlement when an autosave exists.
- **Pickers** (panel with ← Back): Journey (44 stage cards: number and name, MASTERY, stars or 🔒, blurb; locked stages disabled), Learn (five lessons, ✅ when finished, step count), Practice (Relaxed / Normal / Hard cards with goals and Start), Challenges (four setup cards), Daily Trail (today's setup card). Setup cards show the blurb, objectives, "Solo · ~N min · Ranked/Unranked · Tools", the road limit and Start. Escape goes back.
- **Play:** the HUD, rails (Objective: blurb, population / orders / coins goals with done ticks, days left, trade orders with Deliver, the newest 8 log lines; Inspector: tile, terrain, building, residents and happiness, needs ✅/❌), the toolbox (Inspect, the scenario's buildings with costs, disabled when unaffordable, Demolish), the lesson card ("Lesson n/total" and the step), the 3-2-1 countdown (700 ms beats; skipped with reduced motion), toasts (2.6 s; errors outlined red).
- **Pause:** Resume, Settings, Help, Restart scenario, Leave settlement (autosaves an unfinished settlement). Escape and the backdrop resume.
- **Results:** 🎉 Charter fulfilled! / ⏳ Charter expired, the reason, the score breakdown (population, wellbeing, trade, treasury, service balance, swiftness) and the total, new achievements, the local board rank, the leaderboard line (posting / rank #N / posted / not posted, signed in only), Retry, Next stage → (won Journey stages), Scoreboard, Home.
- **Settings** (title and pause): a note that volumes, mute, graphics, language, larger text, high contrast and reduced motion are in the StarHermit Options, with Open Options and Key bindings; Display & motion: Color palette (Default, Deuteranopia-safe, Protanopia-safe, Tritanopia-safe: selection ring and ghost hues), Camera shake; Accessibility & controls: Day length (Normal / Relaxed: 0.6× day speed, a timing assist recorded with ranked scores), Left-handed layout (the landscape toolbox on the left), Haptics, Replay tutorials.
- **Help:** Goal, Buildings (icon, cost, description), Trade orders, Controls (pointer, keyboard with the player's bound keys, gamepad).
- **Scoreboards:** Global (the platform high-score board when signed in, else the local board), Daily (today's local board), Friends (the player's own local scores: the platform has no friends list), with each list's note.

### Input

- **Keyboard** (actions in `starhermit.txt`, rebindable in the runtime's Options): arrows (and W/S) move the cursor (the hover ring and ghost follow it), Enter builds / inspects at the cursor, 1–9 pick a tool (Inspect, the scenario's buildings in toolbox order, Demolish), [ / ] cycle tools, I inspect, X demolish, Space cycles the game speed (▶ ▶▶ ▶▶▶: 5 / 2.5 / 1.2 s a day) and starts time, U undo (Practice), H hint (the cursor jumps to a suggested placement), C reset camera, Escape puts a building tool down, then pauses; it also closes panels. Enter and Space on a focused button press it; arrows clear button focus and move the cursor.
- **Pointer:** pick a tool, click a tile (an off-board click returns to Inspect); hover previews (hover ring, green / red ghost); a drag (> 8 px) pans the map (the look-at point stays on the board); the wheel zooms (6–30). A press that lands on a widget never reaches the board.
- **Touch:** tap a tool, tap a tile; a one-finger drag pans; a two-finger pinch zooms (new on the engine; never needed for play).
- **Gamepad:** D-pad / left stick cursor, South build / inspect, East Inspect tool, the shoulders cycle tools, Start pause, West undo, North hint, Select speed, right stick press reset camera.
- Commands carry ids (idempotent), invalid placements explain why (toast, the inspector, an assertive announcement) and count as no action.

### Accessibility

- Full keyboard and gamepad play; every control is a named widget; the cursor tile is a named area; objective changes, errors, shortages, lesson steps and results are announced (at most one joined announcement a frame).
- Colour is backed by shape (ring vs. corner cursor, ghost shapes, ✅/❌ needs, "!" markers); four palettes.
- Reduced motion (the runtime's preference) skips the countdown and removes pop-ins, particles, shake, water bob, cloud drift and marker bob.
- The runtime's Options provide volumes, mute, larger text, high contrast (the game's token set), captions-free play (no audio-only information), and rebinding.

### Localization

Every string ships in **en-US, en-GB, es-419, es-ES, de-DE, fr-FR, fr-CA, pt-BR and it-IT** (`js/i18n.js`, `js/locales/`, English text as keys; account strings in `js/sh-strings.js`), in the runtime's interface language (`preferences().language`: Options › Language, else the account's preferred language, else the device's; the game's own Language setting is gone). Content and rule events keep their stable English text; `js/names.js` translates names, blurbs, buildings, rejections and events at display time. Strings draw through `T()` every frame, so a change shows at once without restarting the settlement.

## 4. Visual and audio design

### The settlement (native/render.ts)

A tabletop board of instanced land tiles (hills raised 0.45; per-tile shade jitter; forests a darker grass), instanced translucent water tiles over an opaque riverbed (bob and drifting normal map when detailed), instanced cone forests with per-tree tints that vanish when a tile is cleared, flat-shaded rocks, low-poly clouds high above (culled near the camera), buildings built from parts and merged into one vertex-coloured mesh per material kind (hall with banner and plinth, road with stripe and kerbs, house with door, windows and chimney, farm, lumber hut with logs, well with water, market with awning), warm emissive windows (brighter on dusk boards), "!" sprites over unhappy homes, the hover ring, the corner cursor, the ghost preview, pooled burst particles and chimney smoke, pop-in animations and camera shake. Five themes (meadow, riverlands, highland, autumn, dusk) colour sky, fog, ground, forest, water and rock. The camera orbits at a fixed pitch, eases to its targets, fits narrow windows (and widens the FOV in portrait), and fog follows its distance.

From three.js r160: colours as written; hemisphere and key light intensities as written, the key light's shadow box fitted to the board as render.js did, bloom strength squared for r185; `new RoomEnvironment(renderer)` as the old page called it, PMREM-filtered, set as each standard material's own envMap at its old envMapIntensity (scene.environment ignores per-material intensities at minor 20); ACES tone mapping at exposure 1.05 (0.95 detailed); the sky gradient pre-compensated for the tone curve as before. The procedural ground grain and water normals are baked by `tools/bake-textures.mjs` (the old noise code) into `assets/textures/`.

### Graphics per quality tier (native/quality.ts)

The runtime's Options choose the graphics level (Auto from the hardware, render scale, adaptive resolution, frame-rate limit and readout); the game maps the tier (`frame().quality`) onto the old presets and budgets (`js/gfx.js`), scaling the particle pool within the tier by the level (≤ 2×):

| | Low | Balanced | High | Ultra |
|---|---|---|---|---|
| Shading | Lambert, flat sky | Standard + room reflections, detail | same | same |
| Shadows | off | 1024² | 2048² | 4096² |
| GTAO | off | off | on (8 samples, ½ res) | high (16, full res) |
| Bloom (0.45 / 0.4 / threshold 0.9) | off | ½ res | ½ res | full res |
| Grade (display space: S-curve, +10 % saturation, split toning, 0.2 vignette) | off | on | on | on |
| Antialiasing | off | FXAA | SMAA | MSAA |
| Ground grain / water normals | — | 128 / 64 px | 256 / 128 | 512 / 256 |
| Round-part segments | ×1 | ×1 | ×1.5 | ×2 |
| Particles | off | 30 % of 2000 | 2000 + smoke | 3000 + smoke |
| Clouds | 3 | 4 | 5 | 7 |

The board, picking and rules are identical on every tier. The old per-category overrides are not offered (the runtime's Options choose a level).

### Audio (native/audio.ts)

The authored one-shots (`sfx/*.opus`, `sfx/manifest.json`) per event on the effects bus; the music (a soft sine pad on a four-chord loop and an arpeggio layer that fades in with the charter's progress) and the wind ambience (low-passed noise with a swaying cutoff) are rendered into looping clips in slices across frames and played on the music bus (the ambience at the old 0.4 : 0.5 ratio). The old synthesized fallbacks are not played while a clip loads. The runtime's Options own the volumes and mute.

## 5. Technical architecture

- `js/rules.js`, `js/content.js`, `js/session.js`, `js/rng.js`: the pure, deterministic rules, content (44 Journey stages, 5 lessons, Daily, Practice, 4 challenges, themes, the greedy validator bot) and session (commands, undo, the day clock fed by the runtime's fixed steps, snapshots, replay envelopes), shared with the node tests.
- `js/store.js`: settings, progress, achievements, local boards and the autosave as versioned, checksummed documents over a swappable key/value backend; the cloud-document merge; the game's option validation.
- `js/i18n.js`, `js/locales/`, `js/names.js`, `js/sh-strings.js`: localization.
- `native/main.ts` (screen flow, input, clock, lessons, results), `native/screens.ts` (every screen), `native/render.ts`, `native/quality.ts`, `native/audio.ts`, `native/platform.ts`, `native/style.ts` (tools/ui-style.css → assets/ui-style.json, high-contrast tokens), `native/i18n.ts`, `native/game.ts` (typed facade over the js modules).
- The game clock advances 1/60 s per fixed step: days, the countdown and toasts never depend on frame rate, and play scripts replay exactly. A hidden window pauses the settlement (the pause panel shows on return), silences the loops and autosaves.
- Rule timings measured natively: a legal-action sweep and the hint take ≈ 1 ms on a 12×12 board, 12 bot days ≈ 56 ms; no worker is needed.

## 6. StarHermit integration

- **Package:** `starhermit.txt` (launch=index.html, the engine pins, capabilities platform, storage, clipboard, controls and gamepad defaults, `server=score-script.js`); `npm run package` writes the web loader `index.html` and `starhermit-files.json`; `.starhermitignore` leaves out tests, tools, docs and `server.js`.
- **Saves:** every store.js document lives in a map whose export (`store.exportSaveDoc`, kind `settlement-trails-save`) is the engine save (`saves`, schema 1, on the device and in the account). On a conflict the two saves merge (`mergeSaveDocs`: the furthest unlock, best stars, every win, larger totals, best daily scores and the later streak, every achievement at its earliest unlock, both boards, every finished lesson; this device's preferences and autosave). The browser build's cloud slot (`game:<slug>`, the same document written by the JS SDK) shows as a foreign save: it is merged in once and replaced. The old account settings KV is read once: colour palette, camera shake, day length, left-handed layout and haptics carry over; all its keys are then removed.
- **Player:** signed out the title offers Sign in with StarHermit; signed in it shows the name, the sync state and Invite a friend (copies the invite link). A signed-out session end shows a notice and play goes on locally.
- **Time:** the Daily's UTC date and streak use the platform clock (`serverNow()`) when it has answered, else the device's.
- **Leaderboards:** signed in, every finished ranked round (Journey, Daily, Challenge — not Practice or Learn) posts its total through `score-script.js` (a practice session; the script range-checks the integer 0–100,000 for the `high-score` board and returns it in `scores`, so the result is server-recorded), and the results show the rank. The client-reported solo total is accepted by range check, as before (user decision for solo boards). Scores → Global reads the platform board. Local boards keep the full history (rank, day, seed) with the old tie-breaks.
- **Achievements:** First Charter, Town Planner (all five lessons), Steady Trails (three-day Daily streak), Beyond the Hills (Journey stage 30), Century Builder (100 buildings), idempotent, stored in the save.
- No multiplayer: the browser build never used realtime rooms (`server=` named only the score script), so the port has none.

## 7. Content, economy, and retention

- Launch scope: tutorial sequence, at least 40 authored stages or equivalent procedural depth, daily challenge, practice, five visual themes, and a mastery track.
- Cosmetic rewards may alter materials, trails, board surrounds, ambience, or profile flourishes, but never hitboxes, timing windows, information, or power.
- Reward cadence: early feedback every session, meaningful unlock every 3–5 sessions, and long-term goals visible without manipulative countdowns.
- No real-money wagering, paid random rewards, forced advertising, energy pressure, punitive streak loss, or purchases that affect competitive outcomes.
- Notifications, if ever added by the host, are opt-in, frequency-capped, quiet-hour aware, and never use false urgency.

## 8. Analytics and privacy

Hosted play collects no telemetry: the platform exposes no per-game telemetry endpoint reachable by launch tokens, so the game sends none (the old consent-gated funnel is removed). If analytics are ever added, measure tutorial completion, first meaningful action time, session duration bands, level attempts, quit state, input modality, performance tier, reconnect success, and accessibility feature usage only in aggregate, with random session identifiers, short retention, and explicit consent where required. Never collect message content, drawings, voice, private board notes, or exact pointer trails as analytics.

Success targets for the first public test: median first-play time under 20 seconds, tutorial completion above 80%, crash-free sessions above 99.5%, p95 input acknowledgment below 100 ms locally, and at least 95% of supported mobile sessions holding their selected frame-rate tier.

## 9. Checks

- `npm test`: `tests/rules.test.js` (legality, reasons, scoring, terminal states, serialization, replay determinism, every shipped stage solved by the bot, fuzzing), `tests/session.test.js`, `tests/store.test.js`, `tests/save.test.mjs` (backend swap, the old cloud document as a foreign save, two-device merge, old settings KV options), `tests/i18n.test.mjs` (every key in `js/` and `native/` translated in all nine locales with matching placeholders, no unused rows), then `tests/native.mjs`: the web index matches the files, `tsc`, `starhermit check` with zero warnings, and the play scripts as signed-out render checks — `journey-keys.play` (Journey 1–3 by keys to their results), `learn-phone.play` (lessons 1–2 by finger on a DPR-3 phone, ✅ afterwards), `market-land.play` (lesson 5 sideways on a DPR-3 phone, Deliver from the drawer), `menus.play` (pickers, panels, settings, Practice build and undo, leave, resume, speed, restart), and today's Daily (`.daily.play`, generated at test time). `tools/gen-plays.mjs` writes the scripts from the validator bot (lesson steps first), waiting on each day's HUD line.
- `npm run test:browser` (`tools/browser-play.mjs`): the packaged loader in Chrome on the GPU at desktop (Journey 1 by keys, Journey 2 by mouse, pause), DPR-3 phone (lesson 1 by finger) and DPR-3 landscape (relaxed days, a swipe pan, today's Daily), failing on console errors or warnings.

## 10. Known limitations

- Hosted play does not exist (solo game); signed-in paths (cloud merge, legacy settings, score posting) are covered by unit tests, not live-tested here.
- The Friends board shows only the player's own local scores: the platform offers no friends list to the game.
- Text-presentation symbols in the toolbox (🛤 road, ⚖️ market, ✖️ demolish) draw as monochrome glyphs in the text colour on the engine.
- In short landscape the lesson card can cover far tiles; the keyboard or a pan reaches them.
- Kept from the browser build: Practice maps use a random seed (unranked); the happiness chip now shows the homes' average happiness (it stayed "–" in the browser build).
