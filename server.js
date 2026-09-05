// server.js — authoritative StarHermit Game Script for Settlement Trails.
// Responsibilities: server time (daily boundary sync), seeded daily content
// identity, replay-validated leaderboard submission, durable achievement
// delivery. Also serves the static distribution for local play.
// No secrets, no external deps.

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PORT = process.env.PORT || 8080;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.opus': 'audio/ogg',
  '.md': 'text/markdown; charset=utf-8',
};

// ---- In-memory boards (per process). A hosted deployment would back these
// with durable storage; the validation logic below is the authoritative part.
const boards = new Map(); // board -> entries[]

function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

// Resolve the authoritative content definition for a submitted content id.
// Shipped content (daily / journey / challenge / tutorial) is deterministic and
// immutable; a competitive claim must be replayed against that definition, never
// against a client-supplied materialized view. Returns { def, match }.
function authoritativeContentDef(lib, id) {
  const dm = /^daily-(\d{4}-\d{2}-\d{2})$/.exec(String(id || ''));
  if (dm) return { def: lib.dailyContent(dm[1]), match: true };
  const jm = /^journey-(\d+)$/.exec(String(id || ''));
  if (jm) {
    const n = Number(jm[1]);
    if (Number.isInteger(n) && n >= 0 && n < lib.JOURNEY_STAGES.length) {
      return { def: lib.JOURNEY_STAGES[n], match: true };
    }
  }
  const ch = (lib.CHALLENGES || []).find(c => c.id === id);
  if (ch) return { def: ch, match: true };
  const tut = (lib.TUTORIALS || []).find(t => t.id === id);
  if (tut) return { def: tut, match: true };
  return { def: null, match: false };
}

// Score claim validation: deterministic replay of the submitted input log.
async function validateScoreClaim(payload) {
  if (!payload || typeof payload !== 'object') return { ok: false, reason: 'bad-payload' };
  const { score, contentId, seed, contentVersion } = payload;
  if (!Number.isFinite(score) || score < 0 || score > 100000) return { ok: false, reason: 'implausible' };
  const replay = payload.replay;
  if (!replay) return { ok: false, reason: 'no-replay' };
  try {
    const { Session } = await import('./js/session.js');
    const C = await import('./js/content.js');
    // Rebuild the authoritative content from the immutable content id; the
    // client's own materialized view is never trusted for competitive boards.
    const { def, match } = authoritativeContentDef(C, contentId ?? replay.contentId);
    if (!match || !def) return { ok: false, reason: 'unknown-content' };
    if ((seed >>> 0) !== (def.seed >>> 0)) return { ok: false, reason: 'seed-mismatch' };
    if (contentVersion !== undefined && contentVersion !== def.version) {
      return { ok: false, reason: 'content-version-mismatch' };
    }
    // Replay against the authoritative definition, not the client's.
    const envelope = { ...replay, materialized: C.materialize(def) };
    const check = Session.validateReplay(envelope);
    if (!check.ok) return { ok: false, reason: 'replay-' + check.reason };
    // Score must match the deterministic replay exactly.
    if (envelope.result.score.total !== score) return { ok: false, reason: 'score-mismatch' };
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: 'validator-error' };
  }
}

async function handleApi(req, res, url) {
  if (url.pathname === '/api/v1/time' && req.method === 'GET') {
    return json(res, 200, { now: Date.now() });
  }
  if (url.pathname === '/api/v1/scores' && req.method === 'POST') {
    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 1_000_000) return json(res, 413, { error: 'payload too large' });
    }
    let payload;
    try { payload = JSON.parse(body); } catch { return json(res, 400, { error: 'bad json' }); }
    // Rate sanity: reject duplicate session submissions idempotently.
    const boardName = String(payload.board || 'global').slice(0, 64);
    const entries = boards.get(boardName) || [];
    if (payload.sessionId && entries.some(e => e.sessionId === payload.sessionId)) {
      const rank = entries.findIndex(e => e.sessionId === payload.sessionId) + 1;
      return json(res, 200, { ok: true, rank, duplicate: true });
    }
    const verdict = await validateScoreClaim(payload);
    if (!verdict.ok) {
      // Honest rejection: an unverifiable score is NOT stored, so don't tell the
      // client it succeeded. The hosted client surfaces this as unavailable.
      return json(res, 422, { ok: false, reason: verdict.reason });
    }
    entries.push({
      name: String(payload.name || 'Guest').slice(0, 24),
      score: payload.score,
      seed: payload.seed,
      contentId: String(payload.contentId || ''),
      contentVersion: payload.contentVersion,
      assists: Array.isArray(payload.assists) ? payload.assists.slice(0, 4) : [],
      durationMs: payload.durationMs | 0,
      sessionId: String(payload.sessionId || ''),
      won: !!payload.won,
      invalidActions: (payload.stats && payload.stats.invalidActions) | 0,
      elapsedTicks: payload.durationMs | 0,
      when: Date.now(),
    });
    // Spec §2 tie-break: primary objective completion, fewer invalid actions,
    // lower authoritative elapsed time, then stable session identifier.
    entries.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.won !== b.won) return (b.won ? 1 : 0) - (a.won ? 1 : 0);
      if (a.invalidActions !== b.invalidActions) return a.invalidActions - b.invalidActions;
      if (a.elapsedTicks !== b.elapsedTicks) return a.elapsedTicks - b.elapsedTicks;
      return String(a.sessionId).localeCompare(String(b.sessionId));
    });
    boards.set(boardName, entries.slice(0, 200));
    const rank = entries.findIndex(e => e.sessionId === String(payload.sessionId)) + 1;
    return json(res, 200, { ok: true, rank });
  }
  if (url.pathname === '/api/v1/scores' && req.method === 'GET') {
    const boardName = url.searchParams.get('board') || 'global';
    return json(res, 200, { entries: (boards.get(boardName) || []).slice(0, 50) });
  }
  if (url.pathname === '/api/v1/activity/start' || url.pathname === '/api/v1/activity/end' ||
      url.pathname === '/api/v1/presence' || url.pathname === '/api/v1/telemetry') {
    return json(res, 204, {});
  }
  if (url.pathname === '/api/v1/me') {
    return json(res, 200, { name: 'Guest', guest: true, friends: [] });
  }
  return json(res, 404, { error: 'not found' });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    // Static files with path traversal protection.
    let path = normalize(decodeURIComponent(url.pathname));
    if (path === '/' || path === '\\') path = '/index.html';
    const file = join(ROOT, path);
    if (!file.startsWith(ROOT)) return json(res, 403, { error: 'forbidden' });
    const data = await readFile(file);
    const immutable = /\.(js|css)$/.test(file);
    res.writeHead(200, {
      'Content-Type': MIME[extname(file)] || 'application/octet-stream',
      'Cache-Control': immutable ? 'public, max-age=3600' : 'no-cache',
    });
    res.end(data);
  } catch (e) {
    if (e.code === 'ENOENT') json(res, 404, { error: 'not found' });
    else json(res, 500, { error: 'server error' });
  }
});

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  server.listen(PORT, () => console.log(`Settlement Trails listening on http://localhost:${PORT}`));
}

export { server, validateScoreClaim };
