// Plays the web package in Chrome on the machine's GPU (~/games/tools/
// gpu-chrome.mjs; GPU_ADAPTER=software for headless SwiftShader), the loader
// index.html that `npm run package` writes, at a desktop viewport, a phone
// (DPR 3) and a phone held sideways (DPR 3), with the game's bot plan
// (tools/gen-plays.mjs planStage): on the desktop Journey stage 1 is won by
// keys (digits, arrows, Enter, Space), stage 2 by the mouse (toolbox buttons,
// clicks on the board at the cursor's tile), with a pause by Escape; on the
// phone Learn lesson 1 is won by finger (toolbox, taps on the board, Deliver
// from the drawer); sideways today's Daily is won by keys with Deliver from
// the drawer by finger, after a swipe that pans the map. Widgets and the
// cursor tile's named area are found through the page's accessibility mirror
// of the engine's UI. Screenshots of each step go to --shots. Fails on console
// errors or warnings, the runtime's error screen, or a view that does not
// finish.
//   node tools/browser-play.mjs [GAME_DIR] [--shots OUT_DIR]
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { existsSync, readFileSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { JOURNEY_STAGES, TUTORIALS, dailyContent } from '../js/content.js';
import { planStage } from './gen-plays.mjs';

const args = process.argv.slice(2);
const dir = resolve(args[0] && !args[0].startsWith('--') ? args[0] : '.');
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const shots = opt('--shots', null);

function findPlaywright() {
  const roots = [dir, resolve(dir, '..'), ...readdirSync(resolve(dir, '..')).map((d) => resolve(dir, '..', d))];
  for (const r of roots) {
    const p = join(r, 'node_modules', 'playwright-core');
    if (existsSync(p)) return createRequire(join(r, 'package.json'))('playwright-core');
  }
  throw new Error('playwright-core not found');
}
const { chromium } = findPlaywright();

const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.ts': 'text/plain',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.wav': 'audio/wav', '.mp3': 'audio/mpeg' };
const server = createServer((req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^\/+/, '') || 'index.html';
  if (path === 'api/v1/time') { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ serverTime: Date.now(), serverTimeIso: new Date().toISOString() })); return; }
  const parts = path.split('/');
  if (parts.some((p) => p.startsWith('.') || p === '..') || ['tests', 'tools', 'node_modules'].includes(parts[0])) { res.writeHead(404).end(); return; }
  const file = join(dir, path);
  if (!existsSync(file) || !statSync(file).isFile()) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' }).end(readFileSync(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;

const views = [
  { name: 'desktop', viewport: { width: 1280, height: 800 } },
  { name: 'phone', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 },
  { name: 'landscape', viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 },
];

const { launchChrome } = await import('/home/albert/games/tools/gpu-chrome.mjs');
const { browser, gpu, close } = await launchChrome(chromium);
console.log(`# chrome on ${gpu}`);
let failed = false;
for (const v of views) {
  if (process.env.VIEWS && !process.env.VIEWS.split(',').includes(v.name)) continue;
  const ctx = await browser.newContext({ viewport: v.viewport, isMobile: v.isMobile, hasTouch: v.hasTouch, deviceScaleFactor: v.deviceScaleFactor });
  const page = await ctx.newPage();
  const cdp = v.hasTouch ? await ctx.newCDPSession(page) : null;
  const problems = [];
  const environment = /^No available adapters\.$|GL Driver Message/;
  page.on('console', (m) => {
    const platformRoute = /\/api\//.test(m.location()?.url ?? '');
    if ((m.type() === 'error' || m.type() === 'warning') && !environment.test(m.text()) && !platformRoute) problems.push(`${m.type()}: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('response', (r) => { if (r.status() >= 400 && !/\/api\//.test(r.url())) problems.push(`http ${r.status()}: ${r.url()}`); });
  await page.goto(url, { waitUntil: 'load', timeout: 120000 });
  const started = await page.waitForFunction(() => ['running', 'error'].includes(document.documentElement.dataset.starhermit), null, { timeout: 90000 }).then(() => true, () => false);
  await page.waitForTimeout(4000);
  const shot = async (name) => { if (shots) { mkdirSync(shots, { recursive: true }); await page.screenshot({ path: join(shots, `${v.name}-${name}.png`) }); } };
  const find = (name) => page.getByRole('button', { name, exact: true }).or(page.getByRole('checkbox', { name, exact: true })).or(page.getByText(name, { exact: true })).first();
  /** A tap / click at window coordinates (CSS px). */
  const tapAt = async (x, y) => {
    if (cdp) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
      await page.waitForTimeout(80);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } else await page.mouse.click(x, y);
    await page.waitForTimeout(250);
  };
  /** A press on a widget (or a table target): the mouse on the desktop, a finger on the phones. */
  const press = async (name) => {
    const el = find(name);
    await el.waitFor({ timeout: 15000 });
    const b = await el.boundingBox();
    const x = b.x + b.width / 2, y = b.y + b.height / 2;
    if (cdp) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
      await page.waitForTimeout(80);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } else await page.mouse.click(x, y);
    await page.waitForTimeout(250);
  };
  let reached = false;
  const KEY = { up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight' };
  const day = async (tick, days) => { await page.getByText(`Day ${tick} / ${days}`, { exact: true }).first().waitFor({ timeout: 60000 }); };
  const cursorTarget = (x, y) => page.getByText(new RegExp(`Cursor: Tile ${x},${y},`)).first();
  /** One stage won by the bot's plan: tools and building by 'keys', 'mouse' or 'finger'; Deliver from the rail or the drawer. */
  const playStage = async (def, how, drawer) => {
    const { content, days, tools } = planStage(def);
    const cur = { ...content.hall };
    let tool = 'inspect', speed = 1;
    await day(0, content.goals.days);
    await page.waitForTimeout(500);
    for (const { tick, moves } of days) {
      if (tick > 0) await day(tick, content.goals.days);
      if (process.env.DEBUG_PLAN && moves.length) {
        const want = moves[0].before.resources.coins;
        const got = await page.evaluate(() => [...document.querySelectorAll('*')].filter((e) => !e.children.length).map((e) => (e.getAttribute('aria-label') || e.textContent || '').trim()).filter((t) => /Coins|🪙|Population|Day /.test(t)).slice(0, 8).join(' | '));
        if (process.env.DEBUG_PLAN) await shot(`day-${tick}`);
        console.log(`  day ${tick}: ${moves.length} moves, coins want ${want} got ${got}`);
      }
      const want = moves.length ? 1 : 3;
      while (tick > 0 && speed !== want) { await page.keyboard.press('Space'); speed = speed % 3 + 1; await page.waitForTimeout(60); }
      for (const { a, before } of moves) {
        if (a.type === 'fulfill') {
          const o = before.orders.find((x) => x.id === a.orderId);
          if (drawer) await press('Toggle objectives panel');
          const btn = page.getByRole('button', { name: `Deliver ${o.want.n} ${o.want.res}` }).first();
          await btn.waitFor({ timeout: 15000 });
          let b = await btn.boundingBox();
          // a short drawer scrolls: wheel it until the button sits inside (between the toggle and the drawer's foot)
          const foot = v.viewport.height - (v.viewport.height <= 500 ? 90 : 140);
          for (let k = 0; drawer && k < 10 && (b.y < 110 || b.y + b.height > foot); k++) {
            await page.mouse.move(60, 200);
            await page.mouse.wheel(0, b.y + b.height > foot ? 120 : -120);
            await page.waitForTimeout(350);
            b = await btn.boundingBox();
          }
          await tapAt(b.x + b.width / 2, b.y + b.height / 2);
          const last = tick === days[days.length - 1].tick && a === moves[moves.length - 1].a;
          if (process.env.DEBUG_PLAN) await shot(`day-${tick}-delivered`);
          if (drawer && !last) await press('Toggle objectives panel');
          continue;
        }
        const t = a.type === 'place' ? a.building : 'demolish';
        if (tool !== t) {
          if (how === 'keys') await page.keyboard.press(`Digit${tools.indexOf(t) + 1}`);
          else {
            const btn = page.getByRole('button', { name: new RegExp(`, ${tools.indexOf(t) + 1}$`) }).first();
            const b = await btn.boundingBox();
            await tapAt(b.x + b.width / 2, b.y + b.height / 2);
          }
          tool = t;
        }
        while (cur.x !== a.x || cur.y !== a.y) {
          const k = cur.x < a.x ? 'right' : cur.x > a.x ? 'left' : cur.y < a.y ? 'down' : 'up';
          await page.keyboard.press(KEY[k]);
          if (k === 'right') cur.x++; else if (k === 'left') cur.x--; else if (k === 'down') cur.y++; else cur.y--;
          await page.waitForTimeout(15);
        }
        if (how === 'keys') await page.keyboard.press('Enter');
        else {
          const tg = cursorTarget(a.x, a.y);
          await tg.waitFor({ timeout: 15000 });
          const b = await tg.boundingBox();
          await tapAt(b.x + b.width / 2, b.y + b.height / 2);
        }
        await page.waitForTimeout(80);
        if (process.env.DEBUG_PLAN) await shot(`day-${tick}-${a.building || a.type}-${a.x ?? ''}`);
      }
    }
    await page.getByText('Charter fulfilled!', { exact: false }).first().waitFor({ timeout: 60000 });
    await page.waitForTimeout(800);
  };
  try {
    await shot('title');
    if (v.name === 'desktop') {
      await press('Journey');
      await page.getByRole('button', { name: /^1\. First Trails 1/ }).first().click();
      await page.waitForTimeout(1500);
      await shot('journey-1');
      await playStage(JOURNEY_STAGES[0], 'keys');
      await shot('journey-1-results');
      await press('Next stage →');
      await page.waitForTimeout(3000);
      await page.keyboard.press('Escape');
      await find('Resume').waitFor({ timeout: 15000 });
      await page.waitForTimeout(500);
      await shot('pause');
      await press('Resume');
      await page.waitForTimeout(500);
      await playStage(JOURNEY_STAGES[1], 'mouse');
      await shot('journey-2-results');
    } else if (v.name === 'phone') {
      await press('Learn');
      await page.getByRole('button', { name: /^Roads & Homes/ }).first().waitFor({ timeout: 15000 });
      const b = await page.getByRole('button', { name: /^Roads & Homes/ }).first().boundingBox();
      await tapAt(b.x + b.width / 2, b.y + b.height / 2);
      await page.waitForTimeout(2500);
      await shot('lesson-1');
      await playStage(TUTORIALS[0], 'finger', true);
      await shot('lesson-1-results');
    } else {
      // relaxed days (Settings › Day length, timing assistance): the Daily's busy days need more than 5 s of key presses here
      await press('Settings');
      await page.waitForTimeout(500);
      await page.mouse.move(420, 200);
      await page.mouse.wheel(0, 600);
      await page.waitForTimeout(800);
      await press('Normal');
      await page.waitForTimeout(300);
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Enter');
      await page.waitForTimeout(300);
      await shot('settings');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(500);
      await press('Daily Trail');
      await page.getByRole('button', { name: /^Start Daily Trail/ }).first().waitFor({ timeout: 15000 });
      const b = await page.getByRole('button', { name: /^Start Daily Trail/ }).first().boundingBox();
      await tapAt(b.x + b.width / 2, b.y + b.height / 2);
      await page.waitForTimeout(2500);
      // a finger's swipe pans the map; C recentres it
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 420, y: 200, id: 1 }] });
      for (let i = 1; i <= 8; i++) { await page.waitForTimeout(30); await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 420 + i * 12, y: 200 + i * 4, id: 1 }] }); }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await page.waitForTimeout(600);
      await shot('daily-panned');
      await page.keyboard.press('KeyC');
      await playStage(dailyContent(new Date().toISOString().slice(0, 10)), 'keys', true);
      await shot('daily-results');
    }
    reached = true;
  } catch (e) { problems.push(`play: ${String(e.message || e).split('\n')[0]}`); await shot('failed'); }
  const state = await page.evaluate(() => document.documentElement.dataset.starhermit ?? '');
  const ok = started && state === 'running' && problems.length === 0 && reached;
  failed ||= !ok;
  console.log(`${ok ? 'ok' : 'not ok'} - ${v.name} played: started=${started} state=${state || '-'} played=${reached}`);
  for (const p of problems) console.log(`  ${p}`);
  await ctx.close();
}
await close();
server.close();
process.exit(failed ? 1 : 0);
