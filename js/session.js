// session.js — local session controller: validated command dispatch with
// idempotent command ids, undo (where rules permit), replay log with periodic
// state hashes, day clock, snapshots and reconnect-safe restore.

import * as R from './rules.js';

export const DAY_MS = [Infinity, 5000, 2500, 1200]; // per speed 0..3 (0 = paused)
export const REPLAY_SCHEMA = 1;

let sessionSeq = 0;

export class Session {
  /**
   * @param content materialized content def
   * @param opts { mode, allowUndo, onEvents(events, state), onTerminal(state), sessionId }
   */
  constructor(content, opts = {}) {
    this.content = content;
    this.mode = opts.mode || content.kind || 'practice';
    this.allowUndo = !!opts.allowUndo;
    this.onEvents = opts.onEvents || (() => {});
    this.onTerminal = opts.onTerminal || (() => {});
    this.sessionId = opts.sessionId || ('s' + Date.now().toString(36) + '-' + (sessionSeq++));
    this.state = R.createGame(content);
    this.commandLog = [];        // ordered commands incl. day ticks
    this.seenIds = new Set();
    this.undoStack = [];
    this.hashLog = [];           // periodic state hashes for replay validation
    this.speed = 1;
    this.paused = true;          // starts paused until countdown ends
    this.acc = 0;                // ms accumulated toward next day
    this.startedAt = null;
    this.elapsedActiveMs = 0;    // authoritative elapsed (active play only)
    this.finished = false;
    this._cmdSeq = 0;
    // Initial state hash: "state at start of tick 0".
    this.hashLog.push({ tick: 0, hash: R.hash(this.state) });
  }

  _recordHash() {
    // Record only start-of-tick hashes (right after a day advance, before any
    // commands of that tick) so replays can be checked unambiguously.
    if (this.state.tick % 5 === 0) {
      const hash = R.hash(this.state);
      const last = this.hashLog[this.hashLog.length - 1];
      if (!last || last.tick !== this.state.tick) this.hashLog.push({ tick: this.state.tick, hash });
    }
  }

  nextCommandId() { return this.sessionId + ':c' + (this._cmdSeq++); }

  /** Submit a player command. Idempotent by cmd.id. Returns {ok, reason?}. */
  submit(cmd) {
    if (this.finished || this.state.status !== 'active') return { ok: false, reason: 'game-over' };
    if (!cmd.id) cmd.id = this.nextCommandId();
    if (this.seenIds.has(cmd.id)) return { ok: true, duplicate: true }; // idempotent reject
    this.seenIds.add(cmd.id);
    const before = this.state;
    const res = R.apply(before, cmd);
    if (res.ok && this.allowUndo) {
      this.undoStack.push({ state: before, logLen: this.commandLog.length });
      if (this.undoStack.length > 50) this.undoStack.shift();
    }
    this.state = res.state;
    this.commandLog.push({ id: cmd.id, tick: before.tick, cmd: { ...cmd, id: undefined } });
    this._afterChange(before);
    return res;
  }

  undo() {
    if (!this.allowUndo || !this.undoStack.length || this.finished) return { ok: false, reason: 'undo-unavailable' };
    const prev = this.undoStack.pop();
    this.state = prev.state;
    this.commandLog.length = prev.logLen;
    this.onEvents([{ kind: 'undo', text: 'Undone.', tick: this.state.tick }], this.state);
    return { ok: true };
  }

  /** Advance the day clock by dtMs (called from the render loop). */
  update(dtMs) {
    if (this.paused || this.finished || this.state.status !== 'active') return [];
    this.elapsedActiveMs += dtMs;
    this.acc += dtMs;
    const step = DAY_MS[this.speed];
    const dayEvents = [];
    let guard = 0;
    while (this.acc >= step && this.state.status === 'active' && guard++ < 10) {
      this.acc -= step;
      const before = this.state;
      this.state = R.advanceDay(this.state);
      this.commandLog.push({ id: this.sessionId + ':d' + this.state.tick, tick: before.tick, cmd: { type: 'day' } });
      const newEvents = this.state.events.slice(before.events.length);
      dayEvents.push(...newEvents);
      this._recordHash();
      if (this.state.status !== 'active') this._finish();
    }
    return dayEvents;
  }

  _afterChange(before) {
    const newEvents = this.state.events.slice(Math.min(before.events.length, this.state.events.length));
    if (this.state.status !== 'active' && !this.finished) {
      if (newEvents.length) this.onEvents(newEvents, this.state);
      this._finish();
      return;
    }
    if (newEvents.length) this.onEvents(newEvents, this.state);
  }

  _finish() {
    this.finished = true;
    this.onTerminal(this.state);
  }

  setPaused(p) { this.paused = p; if (!p && !this.startedAt) this.startedAt = Date.now(); }
  setSpeed(s) { if (s >= 0 && s <= 3) { this.speed = s; this.acc = 0; } }

  /** Serializable snapshot for autosave / reconnect. */
  snapshot() {
    return {
      version: R.RULES_VERSION,
      sessionId: this.sessionId,
      mode: this.mode,
      content: this.content,
      state: this.state,
      commandLog: this.commandLog,
      undoStack: this.undoStack,
      hashLog: this.hashLog,
      speed: this.speed,
      elapsedActiveMs: this.elapsedActiveMs,
      finished: this.finished,
      cmdSeq: this._cmdSeq,
    };
  }

  static restore(snap, opts = {}) {
    const s = new Session(snap.content, { ...opts, mode: snap.mode, sessionId: snap.sessionId });
    s.state = R.deserialize(JSON.stringify(snap.state));
    s.commandLog = snap.commandLog || [];
    s.undoStack = snap.undoStack || [];
    s.hashLog = snap.hashLog || [];
    s.speed = snap.speed ?? 1;
    s.elapsedActiveMs = snap.elapsedActiveMs || 0;
    s.finished = !!snap.finished;
    s._cmdSeq = snap.cmdSeq || 0;
    s.seenIds = new Set(s.commandLog.map(c => c.id));
    s.paused = true; // always resume paused; player explicitly resumes
    return s;
  }

  /** Replay envelope per spec: schema, versions, seed, initial hash, commands,
   *  periodic hashes, terminal result. */
  replayEnvelope() {
    const initial = R.createGame(this.content);
    return {
      schema: REPLAY_SCHEMA,
      rulesVersion: R.RULES_VERSION,
      contentVersion: this.content.version,
      contentId: this.content.id,
      seed: this.content.seed,
      initialHash: R.hash(initial),
      sessionId: this.sessionId,
      elapsedMs: Math.round(this.elapsedActiveMs),
      commands: this.commandLog,
      hashes: this.hashLog,
      result: {
        status: this.state.status,
        endReason: this.state.endReason,
        score: R.score(this.state),
        stats: this.state.stats,
        finalHash: R.hash(this.state),
      },
    };
  }

  /** Validate a replay envelope by re-executing it deterministically. */
  static validateReplay(envelope) {
    try {
      if (envelope.schema !== REPLAY_SCHEMA) return { ok: false, reason: 'schema' };
      let state = R.createGame(envelopeContent(envelope));
      if (R.hash(state) !== envelope.initialHash) return { ok: false, reason: 'initial-hash' };
      let hi = 0;
      // Hash entries describe the state at the START of a tick: the initial
      // state (tick 0) and each state right after a day advance, before any
      // commands of that tick.
      const consumeHashes = () => {
        while (hi < envelope.hashes.length && envelope.hashes[hi].tick === state.tick) {
          if (envelope.hashes[hi].hash !== R.hash(state)) {
            return { ok: false, reason: 'hash-mismatch', at: state.tick };
          }
          hi++;
        }
        return null;
      };
      {
        const bad = consumeHashes();
        if (bad) return bad;
      }
      for (const entry of envelope.commands) {
        if (entry.cmd.type === 'day') {
          state = R.advanceDay(state);
          const bad = consumeHashes();
          if (bad) return bad;
        } else {
          const res = R.apply(state, entry.cmd);
          if (!res.ok) return { ok: false, reason: 'illegal-command', at: entry.id };
          state = res.state;
        }
      }
      if (R.hash(state) !== envelope.result.finalHash) return { ok: false, reason: 'final-hash' };
      const sc = R.score(state);
      if (sc.total !== envelope.result.score.total) return { ok: false, reason: 'score-mismatch' };
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: 'exception', error: String(e) };
    }
  }
}

// Reconstruct a materialized content view sufficient for createGame from an envelope.
function envelopeContent(env) {
  // The envelope carries content via session snapshots; for pure replay we rebuild
  // from the stored materialized content embedded by callers as env.materialized,
  // or regenerate via content.js when available. Kept explicit to stay pure here.
  if (env.materialized) return env.materialized;
  throw new Error('replay validation requires envelope.materialized content');
}
