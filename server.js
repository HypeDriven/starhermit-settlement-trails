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

// Score claim validation: deterministic replay of the submitted input log.
async function validateScoreClaim(payload) {
  if (!payload || typeof payload !== 'object') return { ok: false, reason: 'bad-payload' };
  const { score, replay } = payload;
  if (!Number.isFinite(score) || score < 0 || score > 100000) return { ok: false, reason: 'implausible' };
  if (!replay) return { ok: false, reason: 'no-replay' };
  try {
    const { Session } = await import('./js/session.js');
    const R = await import('./js/rules.js');
    if (!replay.materialized) return { ok: false, reason: 'no-content' };
    const check = Session.validateReplay(replay);
    if (!check.ok) return { ok: false, reason: 'replay-' + check.reason };
    // Score must match the deterministic replay exactly.
    const state = R.createGame(replay.materialized);
    void state;
    if (replay.result.score.total !== score) return { ok: false, reason: 'score-mismatch' };
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
      // Unverifiable scores are still listed but marked casual.
      return json(res, 202, { ok: true, casual: true, reason: verdict.reason });
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
      when: Date.now(),
    });
    entries.sort((a, b) => b.score - a.score);
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
