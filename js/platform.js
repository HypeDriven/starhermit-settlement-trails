// platform.js — StarHermit host integration with graceful standalone fallback.
// Thin adapter over window.StarHermit (starhermit-sdk.js): launch token +
// renewal, nickname, cloud-save mirror of the local docs (slot game:<slug>),
// per-player settings KV and keyboard bindings. Standalone (no token) it makes
// no network calls. Launch tokens are never persisted to storage.

import { exportSaveDoc, importSaveDoc, loadSettings, saveSettings } from './store.js';

const SH = () => globalThis.StarHermit || null;

// Preferences mirrored to the platform settings KV (tutorial progress and
// bindings live elsewhere: cloud save / platform controls).
export const SYNCED_SETTINGS = [
  'music', 'effects', 'ambience', 'voice', 'muteAll', 'graphics', 'reducedMotion',
  'highContrast', 'colorPalette', 'textSize', 'leftHanded', 'holdToPan', 'haptics',
  'cameraShake', 'dayLength',
];

// Keyboard actions (mirrors control.* lines in starhermit.txt).
export const DEFAULT_CONTROLS = {
  up: ['ArrowUp', 'KeyW'], down: ['ArrowDown', 'KeyS'], left: ['ArrowLeft'], right: ['ArrowRight'],
  confirm: ['Enter', 'NumpadEnter'], pause: ['Escape'], undo: ['KeyU'], hint: ['KeyH'],
  speed: ['Space'], camera: ['KeyC'], inspect: ['KeyI'], demolish: ['KeyX'],
  tool1: ['Digit1', 'Numpad1'], tool2: ['Digit2', 'Numpad2'], tool3: ['Digit3', 'Numpad3'],
  tool4: ['Digit4', 'Numpad4'], tool5: ['Digit5', 'Numpad5'], tool6: ['Digit6', 'Numpad6'],
  tool7: ['Digit7', 'Numpad7'], tool8: ['Digit8', 'Numpad8'], tool9: ['Digit9', 'Numpad9'],
};

export class Platform {
  constructor() {
    this.hosted = false;
    this.launchToken = null;
    this.gameScope = null;      // token game_scope claim
    this.userId = null;         // token sub
    this.timeOffsetMs = 0;      // serverNow - clientNow
    this.timeSyncedAt = 0;
    this.profile = null;        // { name } when signed in
    this.friends = [];          // no friends list is fetched from the platform
    this.syncStatus = null;     // null (standalone) | saving | synced | offline | error
    this.onSyncStatus = null;   // main.js refreshes the title line on change
    this.onAuthChange = null;   // main.js re-shows the sign-in button on sign-out
    this.controls = cloneControls(DEFAULT_CONTROLS);
  }

  async init() {
    const sh = SH();
    if (sh) {
      if (!sh.token) sh.init();
      sh.on('auth', (a) => this._onAuth(a));
      sh.on('saved', (ok) => this._setSyncStatus(ok ? 'synced' : 'error'));
      this._syncFromSdk();
    }
    if (this.hosted) {
      await this.syncTime();
      await this._fetchProfile();
      await this._cloudLoad();
      await this._loadRemoteSettings();
      this.controls = await sh.loadBindings(DEFAULT_CONTROLS).catch(() => cloneControls(DEFAULT_CONTROLS));
      this._wireFlushEvents();
    } else {
      // Standalone: local guest profile, local docs are the only save.
      this.profile = { name: 'Guest', guest: true };
    }
    return this;
  }

  _syncFromSdk() {
    const sh = SH();
    this.hosted = !!(sh && sh.signedIn);
    this.launchToken = sh ? sh.token : null;
    this.userId = sh ? sh.userId : null;
    this.gameScope = sh ? sh.slug : null;
  }

  _onAuth(a) {
    const was = this.hosted;
    this._syncFromSdk();
    if (was && !a.signedIn) {
      // Renewal refused: keep playing locally.
      this.profile = { name: 'Guest', guest: true };
      this._setSyncStatus(null);
      try { if (this.onAuthChange) this.onAuthChange(false); } catch { /* UI hook */ }
    }
  }

  canSignIn() { const sh = SH(); return !!(sh && sh.canSignIn()); }
  signIn() { const sh = SH(); return !!(sh && sh.signIn()); }
  inviteLink() { const sh = SH(); return this.hosted && sh ? sh.inviteLink() : null; }

  now() { return Date.now() + this.timeOffsetMs; }

  utcToday() {
    return new Date(this.now()).toISOString().slice(0, 10);
  }

  // Round-trip clock sync against the game's own backend; silently keeps the
  // device clock when unreachable.
  async syncTime() {
    if (!this.hosted) return;
    try {
      const t0 = Date.now();
      const body = await SH().api('/api/v1/time');
      const t1 = Date.now();
      if (!body) return;
      const serverNow = typeof body.now === 'number' ? body.now : Date.parse(body.now);
      if (!Number.isFinite(serverNow)) return;
      this.timeOffsetMs = serverNow - (t0 + (t1 - t0) / 2);
      this.timeSyncedAt = Date.now();
    } catch { /* offline: keep local clock */ }
  }

  // ---- identity ---------------------------------------------------------------
  // Profile nickname, "Player "+id prefix fallback (SDK convention).
  async _fetchProfile() {
    const p = await SH().profile().catch(() => null);
    this.profile = p ? { name: p.displayName } : { name: 'Guest', guest: true };
  }

  async profileName(userId) {
    const p = await SH().profile(userId).catch(() => null);
    return p ? p.displayName : 'Player ' + String(userId).slice(0, 6);
  }

  // ---- per-player settings KV -------------------------------------------------
  // Platform values win over local defaults when signed in.
  async _loadRemoteSettings() {
    const remote = await SH().getSettings().catch(() => null);
    if (!remote) return;
    const s = loadSettings();
    let changed = false;
    for (const k of SYNCED_SETTINGS) {
      if (remote[k] !== undefined && remote[k] !== null) { s[k] = remote[k]; changed = true; }
    }
    if (changed) saveSettings(s);
  }

  pushSettings(settings) {
    if (!this.hosted) return;
    const patch = {};
    for (const k of SYNCED_SETTINGS) if (settings[k] !== undefined) patch[k] = settings[k];
    SH().patchSettings(patch);
  }

  // ---- cloud save: one platform slot mirroring the local docs -----------------
  // localStorage stays the offline cache and the standalone source of truth;
  // when hosted, the remote doc wins on load and local changes mirror up.

  _setSyncStatus(s) {
    if (this.syncStatus === s) return;
    this.syncStatus = s;
    try { if (this.onSyncStatus) this.onSyncStatus(s); } catch { /* UI hook */ }
  }

  syncLabel() {
    return ({ saving: 'Saving…', synced: 'Cloud synced', offline: 'Offline', error: 'Sync issue' })[this.syncStatus] || '';
  }

  async _cloudLoad() {
    this._setSyncStatus('saving');
    try {
      const doc = await SH().loadJSON();
      this._setSyncStatus(!doc || importSaveDoc(doc) ? 'synced' : 'error');
    } catch { this._setSyncStatus('offline'); }
  }

  _buildDoc() {
    const doc = exportSaveDoc();
    let json = JSON.stringify(doc);
    if (json.length > 9_000_000) { doc.autosave = null; json = JSON.stringify(doc); }
    return json.length > 9_500_000 ? null : doc;
  }

  cloudNotifyChanged() {
    if (!this.hosted) return;
    const doc = this._buildDoc();
    if (!doc) { this._setSyncStatus('error'); return; }
    this._setSyncStatus('saving');
    SH().saveJSON(doc, 2000);
  }

  _wireFlushEvents() {
    const flush = () => { if (this.hosted) SH().flushSave(true); };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', () => { if (document.hidden) flush(); });
  }

  // ---- leaderboards -------------------------------------------------------------
  // Platform boards are read-only; entries resolve userIds to nicknames.
  async leaderboardEntries({ pageSize = 50 } = {}) {
    if (!this.hosted) return { ok: false, reason: 'not-hosted' };
    try {
      const r = await SH().leaderboard(null, { pageSize });
      if (!r.board) return { ok: false, reason: 'no-leaderboard' };
      const entries = [];
      for (const e of (r.items || []).slice(0, pageSize)) {
        const userId = e.userId ?? null;
        entries.push({
          name: userId ? await this.profileName(userId) : (e.username || 'Player'),
          score: Number(e.score ?? 0),
          rank: e.rank,
        });
      }
      return { ok: true, entries };
    } catch {
      return { ok: false, reason: 'offline' };
    }
  }

  // Score submission goes only to the game's own replay-validated backend
  // (server.js) when reachable; the platform leaderboard itself is read-only.
  // Post a finished round's total to the platform `high-score` board
  // (score-script.js) via StarHermit.submitScores; resolves {posted, rank} —
  // the player's rank on that board, or null. Signed out: no request.
  async postHighScore(total) {
    if (!this.hosted) return { posted: false, rank: null };
    const sh = SH();
    try {
      const keys = await sh.submitScores({ 'high-score': total });
      if (!keys || keys.indexOf('high-score') < 0) return { posted: false, rank: null };
      try {
        const r = await sh.leaderboard('high-score', { pageSize: 100 });
        const me = ((r && r.items) || []).find(i => i.userId === sh.userId);
        return { posted: true, rank: me ? me.rank : null };
      } catch { return { posted: true, rank: null }; }
    } catch { return { posted: false, rank: null }; }
  }

}

function cloneControls(c) {
  const out = {};
  for (const k of Object.keys(c)) out[k] = c[k].slice();
  return out;
}
