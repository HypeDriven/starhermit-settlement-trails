// Graphics benchmark hook for tools/gfx-bench.mjs (dev-only): picks a preset in Settings → Graphics,
// starts Practice → Hard (the largest 12×12 board), sets speed ×3 with the speed button and keeps
// building with the real toolbox and pointer taps on the 3D board (the move the Hint button would
// suggest, located through the renderer's own camera projection, like a player) — buildings pop in,
// dust bursts, chimneys smoke and the water shimmers. The town grows for a while before measuring,
// and a finished round starts a fresh Hard practice.
export const presets = ['low', 'balanced', 'high', 'ultra'];
export const levels = { low: 0, balanced: 4, high: 10, ultra: 17 };

export async function setPreset(page, preset) {
  await page.waitForSelector('#screen-title.active', { timeout: 30000 });
  await page.click('#btn-settings');
  await page.waitForSelector('#gfx-section #gfx-preset');
  await page.selectOption('#gfx-preset', preset);
  await page.waitForFunction((p) => document.body.dataset.gfxPreset === p, preset);
  await page.click('#btn-settings-close');
  await page.waitForFunction(() => !document.getElementById('screen-settings').classList.contains('active'));
}

const nextMove = (page) => page.evaluate(async () => {
  const st = window.__ST?.session?.state;
  if (!st || st.status !== 'active' || window.__ST.session.finished) return { done: true };
  const C = await import('/js/content.js');
  const m = C.botMove(st);
  if (!m || m.type !== 'place') return m || null;
  const v = window.__ST.view, THREE = await import('/vendor/three.module.js');
  const p = new THREE.Vector3(m.x - (v.content.grid.w - 1) / 2, (v.cellTopY(m.x, m.y) || 0) + 0.01, m.y - (v.content.grid.h - 1) / 2).project(v.camera);
  const r = v.renderer.domElement.getBoundingClientRect();
  return { ...m, px: (p.x * 0.5 + 0.5) * r.width + r.left, py: (-p.y * 0.5 + 0.5) * r.height + r.top };
});

async function startHard(page) {
  await page.click('#btn-practice');
  await page.waitForSelector('#screen-picker.active');
  await page.locator('#picker-body .setup-card').last().locator('button.btn.primary').click();
  await page.waitForSelector('#screen-game.active', { timeout: 15000 });
  await page.waitForFunction(() => !!window.__ST?.session?.state, null, { timeout: 15000 });
  for (let i = 0; i < 3 && await page.evaluate(() => window.__ST.session.speed) !== 3; i++) {
    await page.click('#btn-speed');
    await page.waitForTimeout(120);
  }
}

async function step(page, mobile) {
  const m = await nextMove(page);
  if (m?.done) {
    if (await page.locator('#screen-results.active').count()) {
      await page.click('#btn-results-home', { timeout: 3000 });
      await page.waitForSelector('#screen-title.active');
      await startHard(page);
    }
    return;
  }
  if (!m) return;
  if (m.type === 'fulfill') {
    const btn = page.locator('#orders-list li button.btn.small:not([disabled])').first();
    if (await btn.count()) await btn.click({ timeout: 2000 });
    return;
  }
  const tool = page.locator(`#toolbox .tool[data-tool="${m.building}"]`);
  if (!(await tool.count()) || await tool.isDisabled()) return;
  await tool.click({ timeout: 2000 });
  if (mobile) await page.touchscreen.tap(m.px, m.py); else await page.mouse.click(m.px, m.py);
}

export async function start(page, { mobile } = {}) {
  await startHard(page);
  let open = true;
  page.once('close', () => { open = false; });
  (async () => {
    while (open) {
      try { await step(page, mobile); } catch (e) { if (!open) return; if (process.env.BENCH_DEBUG) console.error(e.message); }
      await page.waitForTimeout(250).catch(() => {});
    }
  })();
  // Let the town grow before measuring.
  await page.waitForTimeout(15000);
}
