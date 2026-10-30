# Settlement Trails

A cozy low-poly settlement builder: place homes, roads, wells, farms, lumber
huts and markets; keep residents happy; fulfil trade orders before the
charter expires. A StarHermit engine script game (engine 1.29.0, minor 31),
played natively by the StarHermit client and in browsers by the engine's web
runtime. See `spec.md`.

## Run

```
starhermit .            # the StarHermit runtime (STARHERMIT=~/sh/runtime/1.29.0/…/starhermit)
npm run package         # writes the web loader index.html + starhermit-files.json (after every change)
```

## Test

```
npm test                # rules, session, saves, i18n, then the native checks and play scripts
npm run test:browser    # the packaged loader in Chrome on the GPU (desktop, phone, landscape)
```

## Layout

- `js/rules.js`, `js/content.js`, `js/session.js`, `js/rng.js` — the pure rules, content and session (shared with the tests)
- `js/store.js` — the save documents and their merge; `js/i18n.js`, `js/locales/`, `js/names.js`, `js/sh-strings.js` — localization
- `native/*.ts` — the engine client (screens, scene, audio, platform, quality, style)
- `tools/` — `ui-style.css` → `assets/ui-style.json` (`npm run css`), `bake-textures.mjs`, `gen-plays.mjs`, `browser-play.mjs`, `package-web.mjs`
- `score-script.js` — the platform script: range-checks posted totals for the `high-score` board
- `server.js` — local dev server (not part of the package)

## Modes

Learn (5 lessons), Journey (44 stages with mastery stages), Daily (shared UTC
seed), Practice (3 difficulties, undo, unranked), Challenges (restricted
tools and limits).
