// tests/starhermit.test.js — platform adapter over the shipped StarHermit SDK
// with a stubbed fetch and launch fragment: token read, profile nickname,
// cloud-save round-trip on game:<slug>, settings KV patch, control bindings,
// and zero network calls when standalone.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

// The package is "type": "module", so evaluate the UMD SDK as a CommonJS body.
const sdkModule = { exports: {} };
new Function('module', readFileSync(new URL('../starhermit-sdk.js', import.meta.url), 'utf8'))(sdkModule);
const SDK = sdkModule.exports;

const SLUG = 'settlement-trails-test';
const USER = 'abcdef12-3456-7890-abcd-ef1234567890';
function jwt(claims) {
  const b = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return b({ alg: 'none' }) + '.' + b(claims) + '.sig';
}

function res(status, body) {
  const bytes = body instanceof Uint8Array ? body : null;
  const text = bytes ? '' : body == null ? '' : JSON.stringify(body);
  return {
    status, ok: status >= 200 && status < 300, statusText: String(status),
    text: async () => text, json: async () => JSON.parse(text),
    arrayBuffer: async () => (bytes || Buffer.from(text)).slice().buffer,
  };
}

function fakeServer() {
  const calls = [];
  let save = null;
  const settings = { music: 0.1, textSize: 'large' };
  const fetch = async (url, init = {}) => {
    const method = init.method || 'GET';
    calls.push({ url, method, init });
    assert.equal(init.headers.Authorization, 'Bearer ' + tokenNow);
    const path = url.split('?')[0];
    if (path === `/api/v1/users/${USER}/profile`) return res(200, { nickname: 'Trailblazer' });
    if (path === `/api/v1/me/cloud-saves/${encodeURIComponent('game:' + SLUG)}`) {
      if (method === 'PUT') { save = Buffer.from(JSON.parse(init.body).dataBase64, 'base64'); return res(204); }
      return save ? res(200, new Uint8Array(save)) : res(404);
    }
    if (path === `/api/v1/games/${SLUG}/settings`) {
      if (method === 'PATCH') { Object.assign(settings, JSON.parse(init.body).settings); return res(200, { settings }); }
      return res(200, { settings });
    }
    if (path === `/api/v1/games/${SLUG}/controls`) return res(200, { actions: [{ action: 'hint', codes: ['KeyJ'] }] });
    return res(404);
  };
  return { fetch, calls, settings, getSave: () => save };
}

let tokenNow = null;
const flush = () => new Promise((r) => setTimeout(r, 0));

function makeWindow(hash) {
  return {
    location: { hash, search: '', pathname: '/index.html', hostname: 'localhost', href: 'http://localhost/index.html' + hash },
    history: { state: null, replaceState(_s, _t, url) { this.last = url; } },
    addEventListener() {},
  };
}

// ---- hosted -----------------------------------------------------------------
{
  tokenNow = jwt({ sub: USER, game_scope: SLUG, exp: Math.floor(Date.now() / 1000) + 3600 });
  const srv = fakeServer();
  const win = makeWindow('#game_token=' + tokenNow + '&x=1');
  globalThis.window = win;
  globalThis.document = { addEventListener() {}, hidden: false };
  globalThis.StarHermit = SDK.create({ window: win, fetch: srv.fetch, setTimeout: (f) => 0, clearTimeout() {} });

  const store = await import('../js/store.js');
  const { Platform } = await import('../js/platform.js');
  const p = await new Platform().init();
  assert.equal(p.hosted, true, 'token read from fragment');
  assert.equal(p.userId, USER);
  assert.equal(p.gameScope, SLUG, 'slug from game_scope claim');
  assert.equal(win.history.last, '/index.html#x=1', 'token stripped from fragment');
  assert.equal(p.profile.name, 'Trailblazer', 'profile nickname');
  assert.equal(store.loadSettings().music, 0.1, 'platform settings win on start');
  assert.equal(store.loadSettings().textSize, 'large');
  assert.deepEqual(p.controls.hint, ['KeyJ'], 'control override applied');
  assert.deepEqual(p.controls.undo, ['KeyU'], 'default bindings kept');
  assert.ok(p.inviteLink().includes(`/game-invite/${USER}/${SLUG}`), 'invite link');
  assert.equal(p.canSignIn(), false);

  // settings patch
  const s = store.loadSettings();
  s.music = 0.7; s.tutorialsDone = ['x'];
  p.pushSettings(s);
  await flush();
  const patch = srv.calls.find((c) => c.method === 'PATCH');
  assert.ok(patch, 'settings PATCH sent');
  assert.equal(JSON.parse(patch.init.body).settings.music, 0.7);
  assert.ok(!('tutorialsDone' in JSON.parse(patch.init.body).settings), 'only preferences mirrored');

  // cloud save round-trip on game:<slug>
  const prog = store.loadProgress();
  prog.journeyUnlocked = 7;
  store.saveProgress(prog);
  p.cloudNotifyChanged();
  await globalThis.StarHermit.flushSave(true);
  const put = srv.calls.find((c) => c.method === 'PUT');
  assert.ok(put && put.url.endsWith('/cloud-saves/game%3A' + SLUG), 'PUT to game:<slug>');
  assert.equal(put.init.keepalive, true);
  prog.journeyUnlocked = 0;
  store.saveProgress(prog);
  const doc = await globalThis.StarHermit.loadJSON();
  assert.equal(doc.progress.journeyUnlocked, 7, 'cloud save round-trip');
  assert.ok(store.importSaveDoc(doc));
  assert.equal(store.loadProgress().journeyUnlocked, 7);

  // renewal refused → signed out, local play continues
  let signedOut = false;
  p.onAuthChange = () => { signedOut = true; };
  globalThis.StarHermit.signOut('expired');
  assert.equal(signedOut, true);
  assert.equal(p.hosted, false);
  assert.equal(p.inviteLink(), null);
}

// ---- standalone: no network ---------------------------------------------------
{
  const calls = [];
  const win = makeWindow('');
  globalThis.window = win;
  globalThis.StarHermit = SDK.create({ window: win, fetch: async (u) => { calls.push(u); return res(500); } });
  const { Platform } = await import('../js/platform.js?standalone');
  const p = await new Platform().init();
  p.cloudNotifyChanged();
  p.pushSettings({ music: 1 });
  await p.leaderboardEntries();
  await globalThis.StarHermit.flushSave(true);
  assert.equal(p.hosted, false);
  assert.equal(p.profile.name, 'Guest');
  assert.equal(p.canSignIn(), false, 'no sign-in button when running locally');
  assert.deepEqual(p.controls.undo, ['KeyU']);
  assert.equal(calls.length, 0, 'no fetch standalone');
}

console.log('starhermit tests passed');
