// Settlement Trails on the StarHermit engine: the entry module (starhermit.txt
// engine.entry), played natively by the StarHermit client and in browsers by
// the engine's web runtime. The rules (js/rules.js), content (js/content.js),
// session (js/session.js: validated commands, undo, the day clock, snapshots)
// and save documents (js/store.js) are the browser build's, unchanged in
// behaviour; this module is what js/main.js did around them — the screen flow
// (title → pickers → countdown → the settlement ⇄ pause / settings / help /
// scores → results), starting every mode (Learn, Journey, Daily, Practice,
// Challenges), building, inspecting and demolishing by keys, pads, pointer and
// touch, the hint, undo, game speed, the lessons, trade orders, the results
// with stars, achievements, the daily streak, the local boards and the score
// post, "Resume saved settlement", and the lifecycle (a hidden window pauses
// and autosaves, as visibilitychange did). Screens are drawn by screens.ts
// (starhermit:ui), the settlement by render.ts (starhermit:scene).
//
// Time is the runtime's fixed steps: the day clock (session.update), the
// countdown's 700 ms beats and the toasts run on a clock advanced 1/60 s per
// fixed step, so slow frames never change a game and play scripts replay
// exactly.
import { clipboard, frame, onFixedUpdate, onPreferencesChange, onRender, onResume, onStart, onSuspend, onUpdate, preferences, setFixedRate } from "starhermit:engine";
import { onAction, onPointerButton, onPointerMove, onTouch, onWheel, vibrate } from "starhermit:input";
import * as ui from "starhermit:ui";
import { onSessionEnded, requestSignIn } from "starhermit:platform";
import {
  Contents, Names, RestoreSession, Rules, SessionClass, Store, ValidateReplay,
  type Building, type Content, type Def, type GameEvent, type Score, type Session, type State, type Step,
} from "./game.ts";
import * as audio from "./audio.ts";
import { N, S, T } from "./i18n.ts";
import * as platform from "./platform.ts";
import { lookFor } from "./quality.ts";
import * as render from "./render.ts";
import { drawScreens, isPhonePortrait, isWide } from "./screens.ts";
import { applyTokens, initStyles } from "./style.ts";

export type Screen = "title" | "picker" | "game";
export type Picker = "journey" | "learn" | "practice" | "challenge" | "daily";
export type Overlay = "pause" | "results" | "settings" | "help" | "scores";
export type Tool = "inspect" | "demolish" | Building;
export interface Results {
  won: boolean; state: State; score: Score; mode: string; rankInfo: (() => string) | null;
  newAchievements: { id: string; name: string; desc: string }[]; nextAvailable: boolean;
}
export interface Inspect { x: number; y: number; error?: string }
const DAY_STEP_MS = 1000 / 60;
const BEAT_MS = 700;

export const app = {
  screen: "title" as Screen,
  picker: null as Picker | null,
  overlays: [] as Overlay[],
  openedFrame: 0,
  focusNext: null as string | null,
  session: null as Session | null,
  def: null as Def | null,
  mode: "",
  cursor: { x: 0, y: 0 },
  showCursor: false,
  tool: "inspect" as Tool,
  tutorial: null as { steps: Step[]; idx: number; count: number } | null,
  countdown: null as string | null,
  countdownLeft: 0,
  countdownAt: 0,
  toast: null as { text: string; err: boolean; until: number } | null,
  results: null as Results | null,
  lb: null as { state: "posting" | "failed" | "posted"; rank?: number | null } | null,
  boardTab: "global" as "global" | "daily" | "friends",
  board: null as { rows: { name: string; score: number; rank?: number; meta?: string; me?: boolean }[]; note: string } | null,
  railLeft: true,
  railRight: false,
  inspect: null as Inspect | null,
  hover: null as { x: number; y: number } | null,
};
let clockMs = 0;
export const now = (): number => clockMs;
export const fresh = (): boolean => frame().frame !== app.openedFrame;
export const topOverlay = (): Overlay | null => app.overlays[app.overlays.length - 1] ?? null;
export const inGame = (): boolean => app.screen === "game" && !!app.session;
export const playing = (): boolean => inGame() && !topOverlay();
let dayLength = 1;

// ------------------------------------------------------------------ helpers
const spoken: string[] = [];
let spokenAssertive = false;
/** The live regions (board-sr, alert-sr): one announcement a frame, joined. */
export function announce(text: string, assertive = false): void {
  if (!text) return;
  spoken.push(text);
  spokenAssertive ||= assertive;
}
function flushAnnouncements(): void {
  if (!spoken.length) return;
  const text = spoken.splice(0).join(" ").slice(0, 500);
  try { ui.announce(text, { politeness: spokenAssertive ? "assertive" : "polite" }); } catch { /* busy */ }
  spokenAssertive = false;
}
/** ui.js toast: one at a time for 2.6 s, announced. */
export function toast(text: string, err = false): void {
  app.toast = { text, err, until: clockMs + 2600 };
  announce(text);
}
const pending: (() => void)[] = [];
/** A widget's press, run once the frame's UI is built (state changes mid-build would break later widgets). */
export function later(fn: () => void): void { pending.push(fn); }
export function sound(name: audio.Sfx): void { audio.play(name); }
export function theme(c: Content) { return Contents.THEMES[c.theme] ?? Contents.THEMES.meadow!; }
export function profileName(): string { return platform.signedIn() ? platform.displayName() || T("Player") : T("Guest"); }
export function modeLabel(mode: string): string {
  const labels: Record<string, string> = { journey: N("Journey"), learn: N("Lesson"), daily: N("Daily"), practice: N("Practice"), challenge: N("Challenge") };
  return labels[mode] ? T(labels[mode]!) : mode;
}
/** The tools in toolbox order: Inspect, the scenario's buildings, Demolish. */
export function tools(): Tool[] {
  const st = app.session?.state;
  return ["inspect", ...Rules.BUILD_ORDER.filter((t) => !!st && st.mechanics.includes(t)), "demolish"];
}

// ------------------------------------------------------------------ screens and overlays
function focusFirst(id: string | null): void {
  app.openedFrame = frame().frame;
  app.focusNext = id;
  ui.setFocus(null);
}
export function showTitle(): void {
  app.screen = "title"; app.picker = null; app.overlays = [];
  focusFirst("btn-play");
}
export function showPicker(p: Picker): void {
  app.screen = "picker"; app.picker = p; app.overlays = [];
  focusFirst("btn-back");
}
export function showOverlay(o: Overlay): void {
  app.overlays = app.overlays.filter((x) => x !== o);
  app.overlays.push(o);
  focusFirst(o === "pause" ? "btn-resume-game" : o === "results" ? "btn-retry" : o === "scores" ? "tab-global" : "btn-close");
}
export function closeOverlay(o: Overlay): void {
  app.overlays = app.overlays.filter((x) => x !== o);
  app.openedFrame = frame().frame;
  ui.setFocus(null);
}
export function showSettings(): void { showOverlay("settings"); }
export function showHelp(): void { showOverlay("help"); }
export function showScores(): void { showOverlay("scores"); renderBoard(app.boardTab); }

// ------------------------------------------------------------------ starting games
export function quickPlay(): void {
  const idx = Math.min(platform_progress().journeyUnlocked, Contents.JOURNEY_STAGES.length - 1);
  startGame(Contents.JOURNEY_STAGES[idx]!, "journey");
}
export function platform_progress() { return Store.loadProgress(); }

export function startGame(def: Def, mode: string): void {
  const content = Contents.materialize(def);
  app.def = def;
  app.mode = mode;
  app.session = new SessionClass(content, {
    mode, allowUndo: mode === "practice" || !!content.allowUndo, onEvents: handleEvents, onTerminal: handleTerminal,
  });
  app.tool = "inspect";
  app.tutorial = content.steps ? { steps: content.steps, idx: 0, count: 0 } : null;
  app.results = null;
  app.lb = null;
  app.inspect = null;
  app.hover = null;
  render.load(content, theme(content));
  render.clearGhost();
  render.setHover(null);
  app.cursor = { x: content.hall.x, y: content.hall.y };
  render.setCursor(app.cursor.x, app.cursor.y);
  app.screen = "game";
  app.picker = null;
  app.overlays = [];
  app.railLeft = isWide();
  app.railRight = false;
  focusFirst(null);
  syncAll();
  const s = app.session;
  s.setPaused(true);
  if (preferences().reducedMotion) {
    s.setPaused(false);
    app.countdown = null;
  } else {
    app.countdown = "3";
    app.countdownLeft = 2;
    app.countdownAt = clockMs + BEAT_MS;
  }
  announce(`${Names.contentName(content)}. ${Names.contentBlurb(def)}`);
}
function countdownTick(): void {
  const s = app.session;
  if (!s || app.countdown == null || clockMs < app.countdownAt) return;
  if (app.countdownLeft > 0) {
    app.countdown = String(app.countdownLeft);
    app.countdownLeft--;
    app.countdownAt = clockMs + BEAT_MS;
  } else {
    app.countdown = null;
    // Don't unpause behind the pause panel; Resume handles that path.
    s.setPaused(!!topOverlay());
  }
}
export function pauseGame(): void {
  const s = app.session;
  if (!s || s.finished) return;
  s.setPaused(true);
  showOverlay("pause");
  sound("pause");
}
export function resumeGame(): void {
  closeOverlay("pause");
  const s = app.session;
  if (s && !s.finished && app.countdown == null) s.setPaused(false);
}
export function restart(): void {
  if (!app.def) return;
  startGame(app.def, app.mode);
}
export function quitToTitle(): void {
  const s = app.session;
  if (s && !s.finished && s.state.status === "active") Store.saveAutosave(s.snapshot());
  if (s?.finished) Store.clearAutosave();
  platform.persist();
  app.session = null;
  app.countdown = null;
  render.clearGhost();
  render.setHover(null);
  render.setCursor(null);
  showTitle();
}
export function nextStage(): void {
  if (app.mode === "journey" && app.def?.stageIndex != null) {
    const next = Contents.JOURNEY_STAGES[app.def.stageIndex + 1];
    if (next) { startGame(next, "journey"); return; }
  }
  quitToTitle();
}
export function hasAutosave(): boolean { return !!Store.loadAutosave(); }
/** main.js resumeAutosave: the snapshot, always resumed paused. */
export function resumeAutosave(): void {
  const snap = Store.loadAutosave();
  if (!snap) return;
  try {
    const content = snap.content;
    app.def = content as unknown as Def;
    app.mode = snap.mode;
    app.session = RestoreSession(snap, { onEvents: handleEvents, onTerminal: handleTerminal });
    app.tutorial = content.steps ? { steps: content.steps, idx: content.steps.length, count: 0 } : null;
    app.results = null;
    app.inspect = null;
    app.tool = "inspect";
    render.load(content, theme(content));
    app.cursor = { x: content.hall.x, y: content.hall.y };
    render.setCursor(app.cursor.x, app.cursor.y);
    app.screen = "game";
    app.overlays = [];
    app.countdown = null;
    app.railLeft = isWide();
    app.railRight = false;
    focusFirst(null);
    syncAll();
    toast(T("Welcome back — your settlement is exactly as you left it."));
  } catch (e) {
    console.warn(`autosave restore failed: ${String(e)}`);
    Store.clearAutosave();
    platform.persist();
    app.session = null;
    toast(T("Saved game could not be loaded (version mismatch)."), true);
  }
}

// ------------------------------------------------------------------ playing
/** main.js onTileHover: the hover ring and the ghost preview. */
export function tileHover(cell: { x: number; y: number } | null): void {
  const s = app.session;
  if (!s) return;
  app.hover = cell;
  if (!cell) { render.setHover(null); render.clearGhost(); return; }
  render.setHover(cell.x, cell.y);
  if (app.tool !== "inspect" && app.tool !== "demolish") {
    const err = Rules.placementError(s.state, cell.x, cell.y, app.tool);
    render.setGhost(cell.x, cell.y, app.tool, err === null);
  } else render.clearGhost();
}
/** main.js onTileTap: inspect, demolish or build at a tile (null: off the board → Inspect). */
export function tileTap(x: number | null, y: number | null): void {
  audio.start();
  const s = app.session;
  if (!s || s.finished) return;
  sound("select");
  if (x == null || y == null) { setTool("inspect"); return; }
  app.cursor = { x, y };
  render.setCursor(x, y);
  const st = s.state;
  if (app.tool === "inspect") { inspectTile(x, y); return; }
  if (app.tool === "demolish") {
    const err = Rules.demolishError(st, x, y);
    if (err) { toast(Names.invalidText(err), true); sound("invalid"); return; }
    s.submit({ type: "demolish", x, y });
    return;
  }
  const err = Rules.placementError(st, x, y, app.tool);
  if (err) {
    toast(Rules.INVALID_REASONS[err] ? Names.invalidText(err) : T("Cannot build here."), true);
    sound("invalid");
    announce(T("Cannot build: {reason}", { reason: Names.invalidText(err) }), true);
    inspectTile(x, y, err);
    return;
  }
  const building = app.tool;
  const r = s.submit({ type: "place", x, y, building });
  if (r.ok) {
    afterPlayerAction("place", building);
    render.kick(0.4);
    tileHover(app.hover ?? { x, y });
  }
}
function inspectTile(x: number, y: number, error?: string): void {
  app.inspect = { x, y, ...(error ? { error } : {}) };
  app.railRight = true;
  if (isPhonePortrait()) app.railLeft = false;
}
export function setTool(t: Tool): void {
  app.tool = t;
  render.clearGhost();
  if (app.hover) tileHover(app.hover);
  else if (app.showCursor) tileHover(app.cursor);
}
export function cycleTool(dir: number): void {
  const list = tools();
  const i = list.indexOf(app.tool);
  setTool(list[(i + dir + list.length) % list.length]!);
}
export function cycleSpeed(): void {
  const s = app.session;
  if (!s) return;
  s.setSpeed((s.speed % 3) + 1);
  if (app.countdown == null) s.setPaused(false);
}
export function undo(): void {
  const s = app.session;
  if (!s) return;
  const r = s.undo();
  if (r.ok) { syncAll(); sound("ui"); } else toast(T("Nothing to undo."), true);
}
export const canUndo = (): boolean => !!app.session && app.session.allowUndo && app.session.undoStack.length > 0;
export function fulfill(orderId: string): void {
  const s = app.session;
  if (!s) return;
  const r = s.submit({ type: "fulfill", orderId });
  if (r.ok) afterPlayerAction("fulfill");
  else toast(r.reason && Rules.INVALID_REASONS[r.reason] ? Names.invalidText(r.reason) : T("Cannot fulfil."), true);
}
/** main.js showHint: a suggested placement (the cursor jumps there) or an order to deliver. */
export function showHint(): void {
  const s = app.session;
  if (!s || s.finished) return;
  const hint = Rules.suggestAction(s.state);
  if (!hint) { toast(T("Nothing useful to do — wait for the next day.")); return; }
  sound("hint");
  if (hint.kind === "place") {
    toast(T("💡 Try a {building} at ({x}, {y}).", { building: Names.buildingName((hint.type || hint.building)!), x: hint.x!, y: hint.y! }));
    app.cursor = { x: hint.x!, y: hint.y! };
    render.setCursor(hint.x!, hint.y!);
  } else if (hint.kind === "fulfill") {
    toast(T("💡 You can fulfil a trade order from the orders panel."));
  }
}
export function centerCamera(): void { render.resetCamera(); }
export function moveCursor(dx: number, dy: number): void {
  const s = app.session;
  if (!s) return;
  app.showCursor = true;
  app.cursor.x = Math.max(0, Math.min(s.state.grid.w - 1, app.cursor.x + dx));
  app.cursor.y = Math.max(0, Math.min(s.state.grid.h - 1, app.cursor.y + dy));
  render.setCursor(app.cursor.x, app.cursor.y);
  tileHover({ ...app.cursor });
}

// ------------------------------------------------------------------ lessons
function afterPlayerAction(type: string, building?: string): void {
  advanceTutorial(type, building);
  syncAll();
}
function advanceTutorial(type: string, building?: string): void {
  const t = app.tutorial;
  if (!t || t.idx >= t.steps.length) return;
  const step = t.steps[t.idx]!;
  const req = step.require;
  let hit = false;
  if (req.type === "place" && type === "place" && req.building === building) hit = true;
  if (req.type === "fulfill" && type === "fulfill") hit = true;
  if (!hit) return;
  t.count++;
  if (t.count >= (req.count || step.count || 1)) {
    t.idx++;
    t.count = 0;
    sound("achievement");
    lessonAnnounce();
    if (t.idx >= t.steps.length) completeTutorial();
  }
}
function checkTutorialGoals(): void {
  const t = app.tutorial;
  const s = app.session;
  if (!t || t.idx >= t.steps.length || !s) return;
  const step = t.steps[t.idx]!;
  if (step.require.type === "goal" && step.require.population && Rules.totalPopulation(s.state) >= step.require.population) {
    t.idx++;
    lessonAnnounce();
    if (t.idx >= t.steps.length) completeTutorial();
  }
}
function lessonAnnounce(): void {
  const t = app.tutorial;
  const step = t?.steps[t.idx];
  if (step) announce(`${T("Lesson {n}/{total}", { n: t!.idx + 1, total: t!.steps.length })}: ${T(step.text)}`);
}
function completeTutorial(): void {
  if (!app.def?.id?.startsWith("learn-")) return;
  const s = platform.options();
  if (!s.tutorialsDone.includes(app.def.id)) {
    s.tutorialsDone.push(app.def.id);
    platform.saveSettings();
  }
  if (s.tutorialsDone.length >= Contents.TUTORIALS.length) unlockAch("master_mechanics");
}
export function replayTutorials(): void {
  platform.options().tutorialsDone = [];
  platform.saveSettings();
  closeOverlay("settings");
  if (app.session && !app.session.finished) quitToTitle();
  showPicker("learn");
}

// ------------------------------------------------------------------ events
const HAPTIC: Record<string, number> = { place: 12, demolish: 25, invalid: 30, fulfill: 20, shortage: 25, leave: 20, won: 100, lost: 80 };
function handleEvents(events: GameEvent[]): void {
  for (const ev of events) {
    audio.playEvent(ev);
    if (ev.kind === "invalid") toast(Names.eventText(ev), true);
    if (ev.kind === "shortage") announce(Names.eventText(ev), true);
    if (ev.kind === "order") toast(Names.eventText(ev));
    if (platform.options().haptics && HAPTIC[ev.kind]) { try { vibrate(HAPTIC[ev.kind]!); } catch { /* none */ } }
  }
  syncAll();
}
/** main.js syncAll: the settlement shows the state, the music follows the charter's progress. */
export function syncAll(): void {
  const st = app.session?.state;
  if (!st) return;
  render.sync(st, Rules.evaluateHouses(st).houses);
  audio.setIntensity(Math.min(1, st.tick / st.goals.days));
}

// ------------------------------------------------------------------ results
function unlockAch(id: string): { id: string; name: string; desc: string } | null {
  if (!Store.unlockAchievement(id)) return null;
  const a = Store.ACHIEVEMENTS.find((x) => x.id === id) ?? null;
  if (a) toast(T("🏅 Achievement: {name}", { name: T(a.name) }));
  sound("achievement");
  platform.persist();
  return a;
}
/** main.js handleTerminal: progress, stars, the daily streak, achievements, the local board, the score post, the results. */
function handleTerminal(st: State): void {
  const s = app.session!;
  const score = Rules.score(st);
  const won = st.status === "won";
  Store.clearAutosave();
  const p = Store.loadProgress();
  p.totals.gamesPlayed++;
  if (won) p.totals.gamesWon++;
  p.totals.buildingsPlaced += st.stats.buildingsPlaced;
  p.totals.ordersFulfilled += st.stats.ordersCompleted;
  const newAch: { id: string; name: string; desc: string }[] = [];
  const ach = (id: string): void => { if (Store.unlockAchievement(id)) { const a = Store.ACHIEVEMENTS.find((x) => x.id === id); if (a) newAch.push(a); } };
  if (won) ach("first_charter");
  if (p.totals.buildingsPlaced >= 100) ach("century_builder");
  let nextAvailable = false;
  const def = app.def!;
  if (app.mode === "journey" && won && def.stageIndex != null) {
    const idx = def.stageIndex;
    p.journeyWon[def.id] = true;
    p.journeyUnlocked = Math.max(p.journeyUnlocked, Math.min(idx + 1, Contents.JOURNEY_STAGES.length - 1));
    nextAvailable = idx + 1 < Contents.JOURNEY_STAGES.length;
    let stars = 1;
    if (def.par && st.tick <= def.par.days) stars++;
    if (def.par && score.total >= def.par.score) stars++;
    p.journeyStars[def.id] = Math.max(p.journeyStars[def.id] || 0, stars);
    if (idx >= 29) ach("mastery_30");
  }
  if (app.mode === "daily") {
    const today = platform.utcToday();
    const prev = p.daily.best[today];
    if (!prev || score.total > prev) p.daily.best[today] = score.total;
    if (won) {
      const yesterday = new Date(platform.nowMs() - 86400000).toISOString().slice(0, 10);
      p.daily.streak = p.daily.lastPlayed === yesterday || p.daily.lastPlayed === today ? p.daily.streak + (p.daily.lastPlayed === today ? 0 : 1) : 1;
      p.daily.lastPlayed = today;
      if (p.daily.streak >= 3) ach("streak_3");
    }
  }
  Store.saveProgress(p);
  if (newAch.length) sound("achievement");
  // Practice and Learn are unranked by design and never touch boards.
  let rankInfo: (() => string) | null = null;
  if (app.mode !== "practice" && app.mode !== "learn") {
    const board = app.mode === "daily" ? "daily-" + platform.utcToday() : "global";
    const res = Store.submitScore({
      board, name: platform.signedIn() ? platform.displayName() || "Guest" : "Guest", score: score.total, contentId: def.id, contentVersion: def.version,
      seed: s.content.seed, assists: platform.options().dayLength !== "normal" ? ["relaxed-time"] : [],
      durationMs: Math.round(s.elapsedActiveMs), sessionId: s.sessionId, won, stats: st.stats,
    });
    if (res.ok && res.rank) { const rank = res.rank; rankInfo = () => T("Local board rank: #{rank}", { rank }); }
    // Replay self-check of the finished round (logged when it fails).
    const envelope = s.replayEnvelope();
    envelope.materialized = s.content;
    const check = ValidateReplay(envelope);
    if (!check.ok) console.warn(`replay self-check failed: ${JSON.stringify(check)}`);
  }
  platform.persist();
  app.results = { won, state: st, score, mode: app.mode, rankInfo, newAchievements: newAch, nextAvailable };
  showOverlay("results");
  announce(won ? T("Victory! Total score {score}.", { score: score.total }) : T("Charter failed. Score {score}.", { score: score.total }), true);
  postHighScore(st, score.total);
}
/** Signed in, every finished ranked round (not Practice or Learn) posts its total to the high-score board. */
function postHighScore(st: State, total: number): void {
  if (!platform.signedIn() || app.mode === "practice" || app.mode === "learn") { app.lb = null; return; }
  app.lb = { state: "posting" };
  void platform.postScore(total).then((r) => {
    if (app.session?.state !== st) return;
    app.lb = !r.posted ? { state: "failed" } : { state: "posted", rank: r.rank };
  });
}
export function lbText(): string | null {
  const lb = app.lb;
  if (!lb) return null;
  if (lb.state === "posting") return S("lbPosting");
  if (lb.state === "failed") return S("lbNotPosted");
  return lb.rank ? S("lbRank", { rank: lb.rank }) : S("lbPosted");
}

// ------------------------------------------------------------------ scoreboards
let boardReq = 0;
/** main.js renderBoard: the platform board (signed in, Global), else the local boards. */
export function renderBoard(tab: "global" | "daily" | "friends"): void {
  app.boardTab = tab;
  const me = platform.signedIn() ? platform.displayName() : "Guest";
  const local = (board: string, note: string, friends = false): void => {
    let rows = Store.getBoard(friends ? "global" : board);
    if (friends) rows = rows.filter((e) => e.name === me);
    app.board = {
      rows: rows.map((e, i) => {
        const meta: string[] = [];
        if (e.elapsedTicks != null) meta.push(T("day {n}", { n: e.elapsedTicks }));
        if (e.seed != null) meta.push(T("seed {seed}", { seed: (e.seed >>> 0).toString(16).slice(0, 6) }));
        return { name: e.name, score: e.score, rank: i + 1, meta: meta.join(", "), me: e.name === me };
      }),
      note,
    };
  };
  const req = ++boardReq;
  if (tab === "daily") { local("daily-" + platform.utcToday(), T("Today’s shared seed.")); return; }
  if (tab === "friends") { local("global", T("No friends yet — showing your own scores."), true); return; }
  local("global", T("All local scores."));
  if (platform.signedIn()) {
    void platform.boardEntries(50).then((rows) => {
      if (req !== boardReq || !rows) return;
      app.board = { rows: rows.map((r) => ({ name: r.name, score: r.score, rank: r.rank, me: r.name === me })), note: T("Platform leaderboard — read only. Local scores keep your full history.") };
    });
  }
}

// ------------------------------------------------------------------ account
export function signIn(): void { void requestSignIn().catch(() => undefined); }
export function invite(): void {
  const link = platform.inviteLink();
  if (!link) return;
  try { clipboard.writeText(link); toast(S("copied")); } catch { toast(`${S("copyFailed")}: ${link}`, true); }
}

// ------------------------------------------------------------------ keys and pads (main.js wireKeyboard / pollGamepad)
onAction((e) => {
  if (!e.pressed || ui.capturingKeys()) return;
  audio.start();
  const a = e.action;
  const o = topOverlay();
  if (a === "pause") {
    if (!fresh()) return;
    if (o === "settings" || o === "help" || o === "scores") { later(() => closeOverlay(o)); return; }
    if (o === "pause") { later(resumeGame); return; }
    if (o === "results") return;
    if (app.screen === "picker") { later(showTitle); return; }
    if (inGame()) {
      if (app.tool !== "inspect") { setTool("inspect"); return; }
      later(pauseGame);
    }
    return;
  }
  if (!inGame() || o) return;
  // Enter / Space / arrows on a focused HUD, rail or toolbox button are the button's (UI focus navigation).
  if (ui.focused() !== null) {
    if (a === "confirm" || a === "speed") return;
    if (a === "up" || a === "down" || a === "left" || a === "right") ui.setFocus(null);
  }
  switch (a) {
    case "up": moveCursor(0, -1); return;
    case "down": moveCursor(0, 1); return;
    case "left": moveCursor(-1, 0); return;
    case "right": moveCursor(1, 0); return;
    case "confirm": { const c = { ...app.cursor }; app.showCursor = true; later(() => tileTap(c.x, c.y)); return; }
    case "undo": later(undo); return;
    case "hint": later(showHint); return;
    case "speed": later(cycleSpeed); return;
    case "camera": render.resetCamera(); return;
    case "inspect": setTool("inspect"); return;
    case "demolish": setTool("demolish"); return;
    case "toolprev": cycleTool(-1); return;
    case "toolnext": cycleTool(1); return;
    default: break;
  }
  const m = /^tool(\d)$/.exec(a);
  if (m) {
    const t = tools()[Number(m[1]) - 1];
    if (t) setTool(t);
  }
});

// ------------------------------------------------------------------ pointer and touch on the board (render.js _bindPointer)
let downAt: { x: number; y: number; t: number; drag: boolean; lx: number; ly: number } | null = null;
const taps: { x: number; y: number }[] = [];
let hoverAt: { x: number; y: number } | null = null;
let lastTouch = -1e9;
const fingers = new Map<number, { x: number; y: number }>();
let pinchDist = 0;
function press(x: number, y: number): void { downAt = { x, y, t: clockMs, drag: false, lx: x, ly: y }; pressConsumed = false; }
function move(x: number, y: number): void {
  if (!downAt) return;
  const sc = frame().scale;
  if (Math.abs(x - downAt.x) / sc > 8 || Math.abs(y - downAt.y) / sc > 8) downAt.drag = true;
  if (downAt.drag && !pressConsumed && playing()) render.panBy((x - downAt.lx) / sc, (y - downAt.ly) / sc);
  downAt.lx = x; downAt.ly = y;
}
function release(x: number, y: number): void {
  if (!downAt) return;
  const d = downAt;
  downAt = null;
  if (d.drag || clockMs - d.t >= 600 || pressConsumed) return;
  taps.push({ x, y });
}
/** A press that began on a widget (HUD, rails, toolbox) belongs to the UI, not the board. */
let pressConsumed = false;
let pressPending = false;
onTouch((e) => {
  lastTouch = clockMs;
  if (e.control) return;
  if (e.phase === "start") fingers.set(e.id, { x: e.x, y: e.y });
  else if (e.phase === "move") fingers.set(e.id, { x: e.x, y: e.y });
  else fingers.delete(e.id);
  if (fingers.size >= 2) {
    // a two-finger pinch zooms (and cancels the tap / drag)
    const [a, b] = [...fingers.values()];
    const dist = Math.hypot(a!.x - b!.x, a!.y - b!.y) / frame().scale;
    if (pinchDist > 0 && playing()) render.zoomBy((pinchDist - dist) * 0.04);
    pinchDist = dist;
    downAt = null;
    return;
  }
  pinchDist = 0;
  if (!e.primary) return;
  if (e.phase === "start") { press(e.x, e.y); pressPending = true; }
  else if (e.phase === "move") move(e.x, e.y);
  else if (e.phase === "end") release(e.x, e.y);
  else downAt = null;
});
onPointerButton((e) => {
  if (e.button !== 0 || clockMs - lastTouch < 600) return;
  if (e.pressed) { press(e.x, e.y); pressPending = true; } else release(e.x, e.y);
});
onPointerMove((x, y) => {
  if (clockMs - lastTouch < 600) return;
  hoverAt = { x, y };
  move(x, y);
});
onWheel((_dx, dy) => { if (playing() && !ui.pointerOver()) render.zoomBy(dy); });
/** Presses on the board, decided after the frame's UI is built (so ui.pointerOver() is this frame's). */
function pointerInput(wasPlaying: boolean): void {
  if (pressPending) {
    pressPending = false;
    if (ui.pointerOver() || !wasPlaying) pressConsumed = true;
  }
  const list = taps.splice(0);
  const h = hoverAt;
  hoverAt = null;
  if (!wasPlaying || !playing()) return;
  if (h && !downAt && !ui.pointerOver()) {
    const cell = render.pick(h.x, h.y);
    if (!cell) { if (app.hover) tileHover(null); }
    else if (!app.hover || app.hover.x !== cell.x || app.hover.y !== cell.y) tileHover(cell);
  }
  for (const p of list) {
    const cell = render.pick(p.x, p.y);
    ui.setFocus(null);
    app.showCursor = false;
    if (cell) tileTap(cell.x, cell.y);
    else tileTap(null, null);
  }
}

// ------------------------------------------------------------------ the clock
let hidden = false;
onFixedUpdate(() => {
  if (hidden) return;
  clockMs += DAY_STEP_MS;
  countdownTick();
  if (app.toast && clockMs > app.toast.until) app.toast = null;
  const s = app.session;
  if (s && !s.finished) {
    const ev = s.update(DAY_STEP_MS * dayLength);
    if (ev.length) {
      handleEvents(ev);
      checkTutorialGoals();
      if (s === app.session && !s.finished && s.state.status === "active") { Store.saveAutosave(s.snapshot()); platform.persist(); }
    }
  }
});

// ------------------------------------------------------------------ boot and lifecycle
let lookKey = "";
function applyLook(): void {
  const f = frame();
  const k = `${f.quality}:${f.levelIndex}`;
  if (k === lookKey) return;
  lookKey = k;
  render.applyLook(lookFor(f.quality, f.levelIndex));
}
function applyOptions(): void {
  const o = platform.options();
  render.setPalette(o.colorPalette);
  render.setCameraShake(o.cameraShake !== false);
  dayLength = o.dayLength === "relaxed" ? 0.6 : 1;
}
/** The title backdrop: the first Journey stage's board behind the title card. */
function backdrop(): void {
  const c = Contents.materialize(Contents.JOURNEY_STAGES[0]!);
  render.load(c, theme(c));
}
onStart(() => {
  setFixedRate(60);
  initStyles();
  platform.initPlatform();
  audio.loadSfx();
  render.setReducedMotion(preferences().reducedMotion);
  applyOptions();
  applyLook();
  backdrop();
  render.setActive(true);
  showTitle();
});
onPreferencesChange((p) => render.setReducedMotion(p.reducedMotion));
platform.onOptionsChange(applyOptions);
platform.onProgressMerged(() => { if (app.screen === "title") announce(T("Progress restored from your StarHermit cloud save.")); });
onSessionEnded(() => toast(S("signedOut")));
onSuspend(() => {
  hidden = true;
  // Backgrounding pauses solo simulation and audio, and autosaves (main.js visibilitychange).
  const s = app.session;
  if (s && !s.finished) {
    s.setPaused(true);
    if (s.state.status === "active") Store.saveAutosave(s.snapshot());
    if (playing() && app.countdown == null) showOverlay("pause");
  }
  audio.setSuspended(true);
  platform.persist();
  platform.flush();
});
onResume(() => { hidden = false; audio.setSuspended(false); });

let frameDt = 0;
onUpdate((dt) => {
  frameDt = dt;
  applyLook();
  applyTokens(ui.preferences().highContrast);
  audio.update();
});
onRender(() => {
  const wasPlaying = playing();
  drawScreens();
  for (const fn of pending.splice(0)) fn();
  pointerInput(wasPlaying);
  const f = frame();
  render.update(frameDt, f.width, f.height);
  flushAnnouncements();
});
