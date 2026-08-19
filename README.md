# Settlement Trails

A cozy low-poly settlement builder for desktop and mobile browsers. Place homes,
roads, wells, farms, lumber huts and markets; keep residents happy; fulfil trade
orders before the charter expires.

## Run

```
node server.js     # serves on http://localhost:8080 (PORT env to change)
```

No build step, no runtime dependencies beyond the vendored Three.js
(`vendor/three.module.js`). Everything else is hand-rolled ES modules.

## Test

```
npm test           # rules engine + content validation + session/replay tests
```

The content tests prove every shipped stage (44 journey stages, 5 lessons,
4 challenges, sampled daily seeds) is solvable by a greedy bot playing through
the same public rules API players use.

## Layout

- `js/rules.js` — pure deterministic rules engine (no DOM/render imports)
- `js/content.js` — versioned stages, tutorials, daily generator, validator bot
- `js/session.js` — command dispatch, undo, snapshots, replay envelopes
- `js/render.js` — Three.js scene (never mutates rules state)
- `js/ui.js` — semantic HTML shell, HUD, overlays, accessibility mirrors
- `js/audio.js` — WebAudio procedural sound, four independent buses
- `js/platform.js` — StarHermit host adapter with offline fallback
- `js/store.js` — versioned, checksummed local persistence
- `server.js` — authoritative script: server time, replay-validated scores
- `starhermit.txt` — distribution manifest

## Modes

Learn (5 interactive lessons), Journey (44 stages with mastery gates), Daily
(shared UTC seed), Practice (3 difficulties, undo, unranked), Challenges
(restricted tools/limits), Score chase (local + hosted boards with replay
validation).

## Deep links / automation

`?auto=journey:3`, `?auto=daily`, `?auto=practice:hard`, `?auto=challenge:speedrun`
jump straight into a game; append `&bot=1` for self-play (used by smoke tests).
