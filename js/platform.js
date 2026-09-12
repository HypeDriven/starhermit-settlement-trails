// platform.js — StarHermit host integration with graceful standalone fallback.
// Reads the launch token from the URL fragment, fetches the account nickname,
// mirrors the local save docs to the platform cloud-save slot, and degrades
// cleanly to local/offline play. Launch tokens are never persisted to storage.

import { exportSaveDoc, importSaveDoc } from './store.js';

// Minimal ZIP writer/reader (stored entries only, no compression).
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function zipStore(name, dataBytes) {
  const enc = new TextEncoder();
  const nameB = enc.encode(name);
  const crc = crc32(dataBytes);
  const out = [];
  const u16 = (v) => out.push(v & 0xff, (v >> 8) & 0xff);
  const u32 = (v) => out.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
  u32(0x04034b50); u16(20); u16(0); u16(0); u16(0); u16(0);
  u32(crc); u32(dataBytes.length); u32(dataBytes.length);
  u16(nameB.length); u16(0);
  const local = out.length;
  const head = new Uint8Array(out);
  const cd = [];
  const c16 = (v) => cd.push(v & 0xff, (v >> 8) & 0xff);
  const c32 = (v) => cd.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
  c32(0x02014b50); c16(20); c16(20); c16(0); c16(0); c16(0); c16(0);
  c32(crc); c32(dataBytes.length); c32(dataBytes.length);
  c16(nameB.length); c16(0); c16(0); c16(0); c16(0); c32(0); c32(0); // attrs + local-header offset
  const cdHead = new Uint8Array(cd);
  const cdOff = head.length + nameB.length + dataBytes.length;
  const parts = [head, nameB, dataBytes, cdHead, nameB];
  const eocd = [];
  const e32 = (v) => eocd.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
  const e16 = (v) => eocd.push(v & 0xff, (v >> 8) & 0xff);
  e32(0x06054b50); e16(0); e16(0); e16(1); e16(1);
  e32(cdHead.length + nameB.length); e32(cdOff); e16(0);
  parts.push(new Uint8Array(eocd));
  const total = parts.reduce((n, p) => n + p.length, 0);
  const buf = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { buf.set(p, o); o += p.length; }
  return buf;
}
function unzipFirstEntry(zipBytes) {
  // Stored single-entry reader: scan local headers for compression 0.
  const dv = new DataView(zipBytes.buffer, zipBytes.byteOffset, zipBytes.byteLength);
  let off = 0;
  while (off + 30 <= zipBytes.length && dv.getUint32(off, true) === 0x04034b50) {
    const method = dv.getUint16(off + 8, true);
    const size = dv.getUint32(off + 18, true);
    const nameLen = dv.getUint16(off + 26, true);
    const extraLen = dv.getUint16(off + 28, true);
    const dataOff = off + 30 + nameLen + extraLen;
    if (method !== 0) throw new Error('unsupported zip entry');
    return zipBytes.slice(dataOff, dataOff + size);
  }
  throw new Error('bad zip');
}
function bytesToBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export class Platform {
  constructor() {
    this.hosted = false;
    this.launchToken = null;
    this.gameScope = 'settlement-trails'; // replaced by the token's game_scope
    this.userId = null;                   // token sub
    this.timeOffsetMs = 0;      // serverNow - clientNow
    this.timeSyncedAt = 0;
    this.profile = null;        // { name } when signed in
    this.friends = [];          // no friends list is fetched from the platform
    this.syncStatus = null;     // null (standalone) | saving | synced | offline | error
    this.onSyncStatus = null;   // main.js refreshes the title line on change
    this._profiles = new Map(); // userId -> nickname cache
    this._leaderboardId = undefined;
    this._saveTimer = null;
    this._flushing = false;
    this._lastCloudJson = null;
    this._refreshTimer = null;
    this._refreshRetry = null;
  }

  async init() {
    // Launch token arrives in the URL fragment (#game_token=<jwt>); read it
    // once and strip it. Query params are accepted for local dev only.
    const token = this._readLaunchToken();
    if (token && this._decodeToken(token)) {
      this.launchToken = token;
      this.hosted = true;
    }
    if (this.hosted) {
      await this.syncTime();
      await this._fetchProfile();
      await this._cloudLoad();
      this._scheduleRefresh();
      this._wireFlushEvents();
    } else {
      // Standalone: local guest profile, local docs are the only save.
      this.profile = { name: 'Guest', guest: true };
    }
    return this;
  }

  // ---- launch token ----------------------------------------------------------
  _readLaunchToken() {
    if (location.hash.length > 1) {
      const frag = new URLSearchParams(location.hash.slice(1));
      const token = frag.get('game_token');
      if (token) {
        frag.delete('game_token');
        const rest = frag.toString();
        history.replaceState(null, '', location.pathname + location.search + (rest ? '#' + rest : ''));
        return token;
      }
    }
    return new URLSearchParams(location.search).get('token'); // local dev
  }

  _decodeToken(token) {
    try {
      const seg = token.split('.')[1] || '';
      const b64 = seg.replace(/-/g, '+').replace(/_/g, '/');
      const payload = JSON.parse(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)));
      if (!payload || typeof payload !== 'object') return false;
      if (typeof payload.sub === 'string') this.userId = payload.sub;
      if (typeof payload.game_scope === 'string' && payload.game_scope) this.gameScope = payload.game_scope;
      return true;
    } catch { return false; } // malformed token: stay local
  }

  _scheduleRefresh() {
    // Scoped launch tokens live 60 min; re-mint on a 45-min cadence.
    this._refreshTimer = setInterval(() => this._refreshToken(), 45 * 60 * 1000);
  }

  async _refreshToken() {
    if (!this.hosted || !this.launchToken) return;
    try {
      const res = await fetch(`/api/v1/games/${encodeURIComponent(this.gameScope)}/launch-token`, {
        method: 'POST', headers: this._headers(),
      });
      if (res.ok) {
        const body = await res.json().catch(() => ({}));
        const t = body && (body.token || body.launchToken || body.launch_token);
        if (typeof t === 'string' && t) {
          this.launchToken = t;
          this._decodeToken(t);
          clearTimeout(this._refreshRetry);
          this._refreshRetry = null;
          return;
        }
      }
    } catch { /* transient: retry below */ }
    if (!this._refreshRetry) {
      this._refreshRetry = setTimeout(() => { this._refreshRetry = null; this._refreshToken(); }, 60000);
    }
  }

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
      const res = await fetch('/api/v1/time', { headers: this._headers() });
      const t1 = Date.now();
      if (!res.ok) return;
      const body = await res.json();
      const serverNow = typeof body.now === 'number' ? body.now : Date.parse(body.now);
      if (!Number.isFinite(serverNow)) return;
      this.timeOffsetMs = serverNow - (t0 + (t1 - t0) / 2);
      this.timeSyncedAt = Date.now();
    } catch { /* offline: keep local clock */ }
  }

  _headers() {
    const h = { 'Content-Type': 'application/json' };
    if (this.launchToken) h['Authorization'] = 'Bearer ' + this.launchToken;
    return h;
  }

  // ---- identity ---------------------------------------------------------------
  // Nickname from the platform profile (never /api/v1/me — 403 for launch
  // tokens — and never usernames). Neutral "Player "+id8 fallback.
  async _fetchProfile() {
    if (!this.userId) {
      this.profile = { name: 'Guest', guest: true };
      return;
    }
    const fallback = 'Player ' + this.userId.slice(0, 8);
    try {
      const res = await fetch(`/api/v1/users/${encodeURIComponent(this.userId)}/profile`, { headers: this._headers() });
      if (res.ok) {
        const p = await res.json();
        const nick = typeof p.nickname === 'string' ? p.nickname.trim() : '';
        this.profile = { name: nick || 'Player ' + String(p.id || this.userId).slice(0, 8) };
        return;
      }
    } catch { /* offline: neutral fallback */ }
    this.profile = { name: fallback };
  }

  async profileName(userId) {
    if (this._profiles.has(userId)) return this._profiles.get(userId);
    let name = null;
    try {
      const res = await fetch(`/api/v1/users/${encodeURIComponent(userId)}/profile`, { headers: this._headers() });
      if (res.ok) {
        const p = await res.json();
        if (typeof p.nickname === 'string' && p.nickname.trim()) name = p.nickname.trim();
      }
    } catch { /* neutral fallback below */ }
    if (!name) name = 'Player ' + String(userId).slice(0, 8);
    this._profiles.set(userId, name);
    return name;
  }

  // ---- cloud save: one platform slot mirroring the local docs -----------------
  // localStorage stays the offline cache and the standalone source of truth;
  // when hosted, the remote doc wins on load and local changes mirror up.

  _cloudUrl() {
    return `/api/v1/me/cloud-saves/${encodeURIComponent(this.gameScope)}`;
  }

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
      const res = await fetch(this._cloudUrl(), { headers: this._headers() });
      if (res.status === 404) { this._setSyncStatus('synced'); return; } // no remote save yet
      if (!res.ok) { this._setSyncStatus('error'); return; }
      const doc = JSON.parse(new TextDecoder().decode(unzipFirstEntry(new Uint8Array(await res.arrayBuffer()))));
      this._setSyncStatus(importSaveDoc(doc) ? 'synced' : 'error');
    } catch { this._setSyncStatus('offline'); }
  }

  cloudNotifyChanged() {
    if (!this.hosted || !this.launchToken) return;
    this._setSyncStatus('saving');
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this._cloudFlush(), 2000);
  }

  async _cloudFlush() {
    if (!this.hosted || !this.launchToken || this._flushing) return;
    this._flushing = true;
    try {
      const doc = exportSaveDoc();
      let json = JSON.stringify(doc);
      if (json.length > 9_000_000) { doc.autosave = null; json = JSON.stringify(doc); }
      if (json.length > 9_500_000) { this._setSyncStatus('error'); return; }
      if (json === this._lastCloudJson) { this._setSyncStatus('synced'); return; }
      const res = await fetch(this._cloudUrl(), {
        method: 'PUT',
        headers: this._headers(),
        body: JSON.stringify({ dataBase64: bytesToBase64(zipStore('save.json', new TextEncoder().encode(json))) }),
      });
      if (res.ok) { this._lastCloudJson = json; this._setSyncStatus('synced'); }
      else this._setSyncStatus('error');
    } catch {
      this._setSyncStatus('offline');
    } finally {
      this._flushing = false;
    }
  }

  _wireFlushEvents() {
    const flush = () => { clearTimeout(this._saveTimer); this._cloudFlush(); };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', () => { if (document.hidden) flush(); });
  }

  // ---- leaderboards -------------------------------------------------------------
  // Platform boards are read-only; entries resolve userIds to nicknames.
  async leaderboardEntries({ friendsOnly = false, page = 0, pageSize = 50 } = {}) {
    if (!this.hosted || !this.launchToken) return { ok: false, reason: 'not-hosted' };
    try {
      if (this._leaderboardId === undefined) {
        const res = await fetch(`/api/v1/games/${encodeURIComponent(this.gameScope)}`, { headers: this._headers() });
        if (!res.ok) return { ok: false, reason: 'http-' + res.status };
        const info = await res.json();
        this._leaderboardId = info.leaderboardId || null;
        if (!this._leaderboardId) return { ok: false, reason: 'no-leaderboard' };
      }
      const q = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
      if (friendsOnly) q.set('friendsOnly', '1');
      const res = await fetch(`/api/v1/leaderboards/${encodeURIComponent(this._leaderboardId)}/entries?${q}`, { headers: this._headers() });
      if (!res.ok) return { ok: false, reason: 'http-' + res.status };
      const body = await res.json();
      const raw = Array.isArray(body) ? body : (body.entries || body.items || []);
      const entries = [];
      for (const e of raw.slice(0, pageSize)) {
        const userId = e.userId ?? e.user_id ?? e.playerId ?? null;
        entries.push({
          name: userId ? await this.profileName(userId) : (typeof e.name === 'string' ? e.name : 'Player'),
          score: Number(e.score ?? e.value ?? e.points ?? 0),
          rank: e.rank,
        });
      }
      return { ok: true, entries };
    } catch {
      return { ok: false, reason: 'offline' };
    }
  }

  async _post(url, body) {
    const res = await fetch(url, { method: 'POST', headers: this._headers(), body: JSON.stringify(body) });
    if (res.status === 429) { // rate limited: recoverable
      await new Promise(r => setTimeout(r, 2000));
    }
    return res;
  }

  // Score submission goes only to the game's own replay-validated backend
  // (server.js) when reachable; the platform leaderboard itself is read-only.
  async submitHostedScore(payload) {
    if (!this.hosted) return { ok: false, reason: 'not-hosted' };
    try {
      const res = await this._post('/api/v1/scores', payload);
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        return { ok: false, reason: err.error || 'http-' + res.status };
      }
      return { ok: true, ...(await res.json()) };
    } catch (e) {
      return { ok: false, reason: 'offline' };
    }
  }
}
