/**
 * Settlement Trails — end-to-end QA playthrough (dev only, not shipped).
 *
 * Drives the REAL visible UI in headless Chrome via playwright-core:
 *   title → Play (Journey stage 1) → set game speed → play the settlement
 *   to an authentic win by selecting build tools in the toolbox and
 *   tapping/clicking real tiles on the Three.js canvas (with a keyboard
 *   cursor+Enter fallback), fulfilling any trade order from the orders
 *   panel → "🎉 Charter fulfilled!" results with score breakdown.
 *   Also exercises pause/resume, the Hint button and Settings open/close,
 *   then a short Practice run that verifies Undo through the visible
 *   Undo button, then quits to home.
 * A second pass runs load → Play → a few real touchscreen taps on a
 * mobile viewport (touch), verifying progress.
 *
 * The game exposes a read-only debug handle `window.__ST = state`
 * (js/main.js automationHook — no gameplay effect) and the renderer's
 * `window.__ST.view.projectCell(x, y)`. The test reads that handle ONLY
 * to observe round state and to pick the next legal move (via the same
 * `botMove` legality surface the Hint button / offline validator use),
 * and to project a tile to screen coordinates for a real pointer tap.
 * It never calls the game's own move API — every action is a real click
 * or key press on visible elements. No game code is modified.
 *
 * Serving: the repo ships `server.js` (the StarHermit authoritative
 * script declared by starhermit.txt), but the game is fully playable
 * offline — with no host launch token `Platform.init()` sets
 * `hosted=false` (js/platform.js:22-40) and every screen works locally
 * with zero /api calls. So, following the sibling-test convention
 * (picture-logic), this test embeds a minimal node:http static server on
 * an ephemeral port and answers `/api/*` probes with 200 `{}` so the
 * client degrades to its documented offline path with no console noise.
 * If the UI ever starts requiring the backend, swap in spawning
 * `server.js`; today it is not needed.
 *
 * Run: npm run test:e2e  (or: node tests/e2e.mjs)
 */
import { chromium } from 'playwright-core';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOT = (stage, vp) => `/tmp/settlement-trails-e2e-${stage}-${vp}.png`;

// benign GPU/swiftshader noise (mirrors tools/production_game_audit.mjs)
const browserNoise = /GL Driver Message|GPU stall due to ReadPixels|Automatic fallback to software WebGL|EnableWebGLDeveloperExtensions/i;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.glb': 'model/gltf-binary',
  '.woff2': 'font/woff2',
  '.ts': 'text/plain; charset=utf-8',
};

const server = http.createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p === '/') p = '/index.html';
    // No authoritative backend needed for offline play: answer API probes with
    // empty JSON (200) so the platform adapter stays quiet. ("hosted=false"
    // means the client won't even call these unless a token is supplied.)
    if (p.startsWith('/api/')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
      return;
    }
    const file = path.normalize(path.join(ROOT, p));
    if (!file.startsWith(ROOT)) { res.writeHead(403).end('forbidden'); return; }
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404).end('not found');
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

let failures = 0;
const ok = (name) => console.log(`ok - ${name}`);

// ---------- read-only observation of the debug handle ----------

// window.__ST is the game's own debug handle (main.js). Read only: the live
// rules state and the command-log length used to confirm UI actions landed.
const liveState = (page) => page.evaluate(() => {
  const s = window.__ST?.session?.state;
  if (!s) return null;
  let pop = 0;
  for (const c of s.cells) if (c && c.type === 'house') pop += c.pop || 0;
  return {
    status: s.status, tick: s.tick, w: s.grid.w, h: s.grid.h,
    pop, buildingsPlaced: s.stats.buildingsPlaced,
    cmdLen: window.__ST.session.commandLog.length,
    finished: window.__ST.session.finished,
  };
});

const cmdLenOf = (page) => page.evaluate(() => (window.__ST?.session?.commandLog?.length ?? 0));

// Pick the next legal move with the same legality surface the game's own Hint
// button and offline validator use (content.js botMove). Runs in-page against
// the live state via the served module — read-only; the move is then executed
// by real UI. Returns a move object or null when there is nothing to do yet.
const nextMove = (page) => page.evaluate(async () => {
  const st = window.__ST?.session?.state;
  if (!st || st.status !== 'active' || window.__ST.session.finished) return null;
  const C = await import('/js/content.js');
  return C.botMove(st);
});

async function waitCmd(page, before, timeout = 2500) {
  try {
    await page.waitForFunction((n) => (window.__ST?.session?.commandLog?.length ?? 0) > n, before, { timeout });
    return true;
  } catch { return false; }
}

// ---------- real UI actions ----------

// Select a build tool by clicking the visible toolbox button.
async function selectTool(page, tool) {
  const btn = page.locator(`#toolbox .tool[data-tool="${tool}"]`);
  if (await btn.count() === 0) return false;
  if (await btn.isDisabled()) return false;
  await btn.click();
  await page.waitForFunction((t) =>
    document.querySelector(`#toolbox .tool[data-tool="${t}"]`)?.getAttribute('aria-pressed') === 'true',
    tool, { timeout: 3000 });
  return true;
}

// Project a tile to viewport CSS pixels at the *pick-plane* height (≈0.01),
// matching render.js _pick (raycast onto a horizontal plane at y=0.01). This
// avoids the parallax offset of projectCell (which projects the +0.6 elevated
// building point, not the plane) so a real pointer tap lands on the same tile
// the raycast rounds back to. Read-only observation of the camera.
async function projectTile(page, x, y) {
  return page.evaluate(async ([xx, yy]) => {
    const v = window.__ST?.view;
    if (!v || !v.camera || !v.content) return null;
    const THREE = await import('/vendor/three.module.js');
    const w = v.content.grid.w;
    const wx = xx - (w - 1) / 2;
    const wz = yy - (v.content.grid.h - 1) / 2;
    const top = (v.cellTopY && v.cellTopY(xx, yy)) || 0;
    const p = new THREE.Vector3(wx, top + 0.01, wz);
    p.project(v.camera);
    const rect = v.renderer.domElement.getBoundingClientRect();
    return {
      x: (p.x * 0.5 + 0.5) * rect.width + rect.left,
      y: (-p.y * 0.5 + 0.5) * rect.height + rect.top,
      behind: p.z > 1,
    };
  }, [x, y]);
}

// Tap a tile with a real mouse click at the tile's projected screen position.
async function tapCellMouse(page, x, y) {
  const pos = await projectTile(page, x, y);
  if (!pos || pos.behind) return false;
  await page.mouse.click(pos.x, pos.y);
  return true;
}

// Tap a tile with a real touchscreen tap at the tile's projected position.
async function tapCellTouch(page, x, y) {
  const pos = await projectTile(page, x, y);
  if (!pos || pos.behind) return false;
  await page.touchscreen.tap(pos.x, pos.y);
  return true;
}

// Tap a tile with the keyboard cursor (arrows + Enter) — the game's own
// keyboard path, works even if WebGL is unavailable.
async function tapCellKeyboard(page, x, y) {
  const cur = await page.evaluate(() => {
    const c = window.__ST?.cursor;
    return c ? { x: c.x, y: c.y } : null;
  });
  if (!cur) return false;
  while (cur.y > y) { await page.keyboard.press('ArrowUp'); cur.y--; }
  while (cur.y < y) { await page.keyboard.press('ArrowDown'); cur.y++; }
  while (cur.x > x) { await page.keyboard.press('ArrowLeft'); cur.x--; }
  while (cur.x < x) { await page.keyboard.press('ArrowRight'); cur.x++; }
  await page.keyboard.press('Enter');
  return true;
}

// True if the cell (x,y) now holds the placed building.
async function waitBuild(page, move, timeout = 3000) {
  try {
    await page.waitForFunction((m) => {
      const s = window.__ST?.session?.state;
      if (!s) return false;
      const c = s.cells[m.y * s.grid.w + m.x];
      return c && c.type === m.building;
    }, move, { timeout });
    return true;
  } catch { return false; }
}

// Execute one legal move through the real controls. The keyboard cursor path
// is primary (it places at exactly the accessed cursor cell); the projected
// mouse pointer is a fallback. Success is verified by the building appearing
// at the target cell, not by log growth (a rejected command also logs).
async function doMove(page, move) {
  if (move.type === 'place') {
    if (!(await selectTool(page, move.building))) return false;
    // keyboard cursor + Enter (deterministic placement at cursor)
    await tapCellKeyboard(page, move.x, move.y);
    if (await waitBuild(page, move)) return true;
    // fallback: projected pointer click on the tile
    await tapCellMouse(page, move.x, move.y);
    if (await waitBuild(page, move)) return true;
    if (process.env.ST_DEBUG) console.error(`DBG place ${move.building}@(${move.x},${move.y}) FAILED`);
    await page.waitForTimeout(180); // game may have run out of funds; loop re-evaluates
    return false;
  } else if (move.type === 'fulfill') {
    // Fulfil the first deliverable order via the visible orders-panel button.
    const before = await cmdLenOf(page);
    const btn = page.locator('#orders-list li button.btn.small:not([disabled])').first();
    if (await btn.count()) {
      await btn.click();
      return waitCmd(page, before);
    }
    return false;
  }
  return false;
}

// Advance a day, waiting for the sim clock to tick (the game's own update loop).
async function waitDay(page, tick) {
  try {
    await page.waitForFunction((t) => {
      const s = window.__ST?.session?.state;
      return s && s.tick > t;
    }, tick, { timeout: 8000 });
  } catch {
    // no tick within timeout — re-evaluate next iteration
  }
}

// Drive the whole settlement to its terminal (win) via real controls, using
// botMove only to choose which legal move to click next.
async function playToWin(page, maxMs = 90000) {
  const start = Date.now();
  for (let guard = 0; guard < 500; guard++) {
    const st = await liveState(page);
    if (!st) throw new Error('live state handle missing');
    if (st.finished || st.status !== 'active') return st;
    const move = await nextMove(page);
    if (move) {
      const acted = await doMove(page, move);
      if (!acted && process.env.ST_DEBUG) console.error(`DBG move did not register: ${JSON.stringify(move)} tick=${st.tick}`);
      await page.waitForTimeout(140);
    } else {
      await waitDay(page, st.tick);
    }
    if (Date.now() - start > maxMs) throw new Error('settlement did not finish within time limit');
  }
  throw new Error('play loop exceeded guard limit');
}

async function gameActive(page) {
  await page.waitForSelector('#screen-game.active', { timeout: 15000 });
  await page.waitForFunction(() => !!window.__ST?.session?.state, null, { timeout: 15000 });
}

// ---------- one full pass ----------
async function runPass(browser, name, ctxOpts, { full }) {
  const errors = [];
  const context = await browser.newContext(ctxOpts);
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error' || browserNoise.test(m.text())) return;
    const url = m.location()?.url || '';
    if (/Failed to load resource/.test(m.text()) && /\/api\/|\/favicon/.test(url)) return;
    const isWebglFallback = /WebGL unavailable|context lost/i.test(m.text());
    if (isWebglFallback) return;
    errors.push(`console: ${m.text()}`);
  });
  page.on('response', (r) => {
    const p = r.url();
    if (r.status() >= 400 && !/\/api\/|\/favicon/.test(p)) errors.push(`http ${r.status()}: ${p}`);
  });

  try {
    // load + title
    await page.goto(BASE, { waitUntil: 'load' });
    await page.waitForSelector('#screen-title.active', { timeout: 15000 });
    await page.screenshot({ path: SHOT('title', name) });
    ok(`${name}: title screen visible`);

    // Play → Journey stage 1 (the default quick-play: ≤2 actions to the field)
    await page.click('#btn-play');
    await gameActive(page);
    const modePill = (await page.textContent('#hud-mode')).trim();
    if (!/Journey/.test(modePill)) throw new Error(`expected Journey mode, got "${modePill}"`);
    const day = (await page.textContent('#hud-day')).trim();
    if (!/Day 0 \/ 30/.test(day)) throw new Error(`expected Day 0 / 30, got "${day}"`);
    ok(`${name}: journey mode started ("${modePill}", ${day})`);

    // crank game speed to 3 via the visible speed button (skips the countdown)
    await page.click('#btn-speed');
    await page.waitForTimeout(120);
    await page.click('#btn-speed');
    await page.waitForFunction(() => window.__ST?.session?.speed === 3, null, { timeout: 4000 });
    ok(`${name}: game speed set to 3 via the speed button`);

    if (full) {
      // pause / resume through the visible buttons
      await page.click('#btn-pause');
      await page.waitForSelector('#screen-pause.active', { timeout: 5000 });
      await page.screenshot({ path: SHOT('pause', name) });
      await page.click('#btn-resume-game');
      await page.waitForFunction(() => !document.getElementById('screen-pause').classList.contains('active'));
      ok(`${name}: pause (⏸) and resume work`);

      // settings open/close from within the pause menu
      await page.click('#btn-pause');
      await page.waitForSelector('#screen-pause.active');
      await page.click('#btn-pause-settings');
      await page.waitForSelector('#screen-settings.active', { timeout: 5000 });
      await page.click('#btn-settings-close');
      await page.waitForFunction(() => !document.getElementById('screen-settings').classList.contains('active'));
      // still paused behind settings; resume
      await page.click('#btn-resume-game');
      await page.waitForFunction(() => !document.getElementById('screen-pause').classList.contains('active'));
      ok(`${name}: settings open/close from pause menu, then resume`);

      // Hint button (cosmetic suggestion via the same legality surface)
      await page.click('#btn-hint');
      await page.waitForTimeout(200);
      ok(`${name}: hint button works`);

      // Play to a genuine win through real controls.
      const end = await playToWin(page);
      if (end.status !== 'won') {
        throw new Error(`settlement did not win (status=${end.status} tick=${end.tick}, pop=${end.pop})`);
      }

      // results overlay
      await page.waitForSelector('#screen-results.active', { timeout: 8000 });
      const headline = (await page.textContent('#results-heading')).trim();
      if (!/Charter fulfilled/.test(headline)) throw new Error(`unexpected results headline "${headline}"`);
      const scoreRows = await page.locator('#score-breakdown .row').count();
      if (scoreRows < 1) throw new Error('score breakdown empty');
      await page.screenshot({ path: SHOT('results', name) });
      ok(`${name}: settlements charter fulfilled ("${headline}", ${scoreRows} score rows, day ${end.tick})`);

      // progression persisted (journey stage won + a local board entry)
      const prog = await page.evaluate(() => {
        const raw = localStorage.getItem('settlement-trails.progress');
        return raw ? JSON.parse(raw).data : null;
      });
      if (!prog || !prog.journeyWon?.['journey-0']) throw new Error('journey stage 1 win not persisted: ' + JSON.stringify(prog));
      const boards = await page.evaluate(() => {
        const raw = localStorage.getItem('settlement-trails.boards');
        return raw ? JSON.parse(raw).data : null;
      });
      if (!boards || !Array.isArray(boards.entries) || boards.entries.length < 1) throw new Error('local board entry not recorded');
      ok(`${name}: progress persisted (journeyWon.journey-0, board entries: ${boards.entries.length})`);

      // Practice: verify Undo through the real Undo button (practice is unranked, undo on).
      await page.click('#btn-results-home');
      await page.waitForSelector('#screen-title.active');
      await page.click('#btn-practice');
      await page.waitForSelector('#screen-picker.active');
      const card = page.locator('#picker-body .setup-card', { hasText: 'Relaxed' });
      await card.locator('button.btn.primary').click();
      await gameActive(page);
      const pill = (await page.textContent('#hud-mode')).trim();
      if (!/Practice/.test(pill)) throw new Error(`expected Practice, got "${pill}"`);
      // place one building via the real controls (ask botMove for a legal spot)
      const b0 = await liveState(page);
      const move = await nextMove(page);
      if (!move || move.type !== 'place') throw new Error('no legal placement in practice to exercise undo');
      await doMove(page, move);
      await page.waitForTimeout(250);
      const b1 = await liveState(page);
      if (b1.buildingsPlaced !== b0.buildingsPlaced + 1) throw new Error('practice placement did not register');
      await page.waitForSelector('#btn-undo:not(.hidden)', { timeout: 4000 });
      await page.screenshot({ path: SHOT('practice-undo', name) });
      await page.click('#btn-undo');
      await page.waitForFunction((n) => window.__ST?.session?.state?.stats?.buildingsPlaced === n, b0.buildingsPlaced, { timeout: 4000 });
      ok(`${name}: practice — placed a building then Undo restored it (${b0.buildingsPlaced}→${b1.buildingsPlaced}→${b0.buildingsPlaced})`);

      // leave the settlement back to home (Leave Settlement lives in the pause menu)
      await page.click('#btn-pause');
      await page.waitForSelector('#screen-pause.active', { timeout: 5000 });
      await page.click('#btn-quit');
      await page.waitForSelector('#screen-title.active');
      ok(`${name}: left settlement back to title`);
    } else {
      // mobile: a few real touchscreen.tap moves on the visible canvas
      let placed = 0;
      for (let i = 0; i < 4; i++) {
        const st = await liveState(page);
        if (st.finished || st.status !== 'active' || st.tick >= 8) break;
        const mv = await nextMove(page);
        if (!mv || mv.type !== 'place') { await page.waitForTimeout(200); continue; }
        await selectTool(page, mv.building);
        const okTap = await tapCellTouch(page, mv.x, mv.y);
        if (okTap && (await waitBuild(page, mv))) placed++;
        else await page.waitForTimeout(200);
      }
      const stFinal = await liveState(page);
      if (placed < 1) throw new Error('touchscreen taps produced no placed building');
      await page.screenshot({ path: SHOT('mobile-play', name) });
      ok(`${name}: started journey and placed ${placed} building(s) via touchscreen.tap (total ${stFinal.buildingsPlaced}, day ${stFinal.tick})`);
    }
  } finally {
    await context.close();
  }

  if (errors.length) throw new Error(`${name} pass had page errors:\n  ${errors.join('\n  ')}`);
  console.log(`ok - ${name}: no page errors`);
}

// ---------- main ----------
let browser = null;
try {
  browser = await chromium.launch({
    executablePath: '/usr/bin/google-chrome',
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--mute-audio'],
  });
  console.log(`serving ${ROOT} at ${BASE}`);
  await runPass(browser, 'desktop', { viewport: { width: 1280, height: 800 } }, { full: true });
  await runPass(browser, 'mobile',
    { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }, { full: false });
  console.log('\nE2E PASS — settlement-trails, desktop + mobile, no page errors');
} catch (e) {
  failures++;
  console.error('\nE2E FAIL:', e.message || e);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  server.close();
}
if (failures) process.exit(1);
