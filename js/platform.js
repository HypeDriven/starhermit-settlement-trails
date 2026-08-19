// platform.js — StarHermit host integration with graceful standalone fallback.
// Reads the launch token for game scope, syncs clock with /api/v1/time using
// round-trip adjustment, and degrades cleanly to local/offline play.
// Access/launch tokens are never persisted to storage.

export class Platform {
  constructor() {
    this.hosted = false;
    this.launchToken = null;
    this.gameScope = 'settlement-trails';
    this.timeOffsetMs = 0;      // serverNow - clientNow
    this.timeSyncedAt = 0;
    this.profile = null;        // { name, avatar } when signed in
    this.friends = [];          // display names for friends-filtered boards
    this.consent = { analytics: false };
    this.presenceTimer = null;
    this.activityStarted = false;
  }

  async init() {
    // Launch token arrives as ?token=... from the host shell (short-lived).
    const params = new URLSearchParams(location.search);
    this.launchToken = params.get('token');
    if (this.launchToken) {
      try {
        const payload = JSON.parse(atob(this.launchToken.split('.')[1] || ''));
        if (payload && payload.game) this.gameScope = payload.game;
        this.hosted = true;
      } catch { /* malformed token: stay local */ }
    }
    if (this.hosted) {
      await this.syncTime();
      await this._fetchProfile();
    } else {
      // Standalone: local guest profile.
      this.profile = { name: 'Guest', guest: true };
      this.friends = [];
    }
    return this;
  }

  now() { return Date.now() + this.timeOffsetMs; }

  utcToday() {
    return new Date(this.now()).toISOString().slice(0, 10);
  }

  async syncTime() {
    if (!this.hosted) return;
    try {
      const t0 = Date.now();
      const res = await fetch('/api/v1/time', { headers: this._headers() });
      const t1 = Date.now();
      if (!res.ok) return;
      const body = await res.json();
      const serverNow = typeof body.now === 'number' ? body.now : Date.parse(body.now);
      // Round-trip-adjusted offset: assume symmetric latency.
      this.timeOffsetMs = serverNow - (t0 + (t1 - t0) / 2);
      this.timeSyncedAt = Date.now();
    } catch { /* offline: keep local clock */ }
  }

  _headers() {
    const h = { 'Content-Type': 'application/json' };
    if (this.launchToken) h['Authorization'] = 'Bearer ' + this.launchToken;
    return h;
  }

  async _fetchProfile() {
    try {
      const res = await fetch('/api/v1/me', { headers: this._headers() });
      if (res.ok) {
        const p = await res.json();
        // Honor privacy: hidden profiles expose only a generic identity.
        this.profile = p.hidden ? { name: 'Settler', guest: true } : { name: p.name || 'Settler', avatar: p.avatar };
        this.friends = Array.isArray(p.friends) ? p.friends.filter(f => !f.hidden).map(f => f.name) : [];
      }
    } catch { /* stay guest */ }
    if (!this.profile) this.profile = { name: 'Guest', guest: true };
  }

  // Activity start/end pairing for accurate playtime.
  startActivity(mode) {
    if (!this.hosted || this.activityStarted) return;
    this.activityStarted = true;
    this._post('/api/v1/activity/start', { mode }).catch(() => {});
    // Throttled presence heartbeat while actively playing.
    this.presenceTimer = setInterval(() => {
      this._post('/api/v1/presence', { game: this.gameScope }).catch(() => {});
    }, 60000);
  }

  endActivity() {
    if (!this.hosted || !this.activityStarted) return;
    this.activityStarted = false;
    clearInterval(this.presenceTimer);
    this._post('/api/v1/activity/end', {}).catch(() => {});
  }

  async _post(url, body) {
    const res = await fetch(url, { method: 'POST', headers: this._headers(), body: JSON.stringify(body) });
    if (res.status === 429) { // rate limited: recoverable
      await new Promise(r => setTimeout(r, 2000));
    }
    return res;
  }

  // Anonymous funnel events: start, tutorial step, round end, retry, settings
  // change, error category. No raw text, no personal data. Consent-gated.
  track(event, detail = {}) {
    if (!this.consent.analytics) return;
    const safe = {};
    for (const k of ['mode', 'step', 'tier', 'category', 'result']) {
      if (typeof detail[k] === 'string' || typeof detail[k] === 'number') safe[k] = detail[k];
    }
    if (this.hosted) this._post('/api/v1/telemetry', { event, ...safe }).catch(() => {});
  }

  // Score submission to hosted leaderboard when available; local fallback by caller.
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
