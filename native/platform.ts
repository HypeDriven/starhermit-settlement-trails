// The game's data and the StarHermit platform, on the runtime's modules (what
// js/platform.js did over the JS SDK and localStorage):
// - every document js/store.js keeps (settings, progress, achievements, the
//   local boards and the in-progress autosave) lives in a key/value map whose
//   whole content is the engine save (starhermit:storage `saves`, schema 1:
//   on the device and in the player's cloud slot) — the same document the
//   browser build mirrored to the cloud (store.exportSaveDoc). Two devices'
//   saves merge on a conflict (store.mergeSaveDocs, as the browser build did
//   on its saveconflict); the slot the browser build wrote through the JS SDK
//   (game:<slug>) shows as foreign: it is merged in and replaced once;
// - the game's own options (colour palette, camera shake, day length,
//   left-handed layout, haptics) stay in the settings document; the browser
//   build's values in the account's settings KV (js/platform.js
//   SYNCED_SETTINGS) are adopted once, then all its KV keys are removed
//   (volumes, mute, graphics, reduced motion, contrast, text size and the
//   language are the runtime's Options now);
// - the player, the invite link, the platform's clock for the Daily, posting a
//   finished round's total through score-script.js (a practice session whose
//   socket carries { type: 'result', scores }, as the JS SDK's submitScores
//   did) with the rank, and the board's entries for the Scores panel.
import type { JsonValue } from "starhermit:engine";
import {
  connectGame, inviteLink as fetchInviteLink, leaderboards, onPlayerChange, player, serverNow, serverTime, sessions, type Leaderboard,
} from "starhermit:platform";
import { saves, settings as legacyStore } from "starhermit:storage";
import { Store, type SaveDoc, type Settings } from "./game.ts";

// --- the documents ----------------------------------------------------------------------------
const docs = new Map<string, string>();
Store.setBackend({
  getItem: (k) => docs.get(k) ?? null,
  setItem: (k, v) => { docs.set(k, String(v)); },
  removeItem: (k) => { docs.delete(k); },
});
const SAVE_KIND = "settlement-trails-save";
let lastSavedAt = 0;
const mergedListeners = new Set<() => void>();
/** fn() after progress from the account (another device, the browser build) was merged in. */
export function onProgressMerged(fn: () => void): void { mergedListeners.add(fn); }
function merged(): void { for (const fn of mergedListeners) fn(); }

/** platform.js _buildDoc: the whole mirror, without the autosave when it would not fit. */
function buildDoc(): SaveDoc | null {
  const doc = Store.exportSaveDoc();
  let json = JSON.stringify(doc);
  if (json.length > 9_000_000) { doc.autosave = null; json = JSON.stringify(doc); }
  return json.length > 9_500_000 ? null : doc;
}
const isDoc = (d: unknown): d is SaveDoc => !!d && typeof d === "object" && (d as SaveDoc).kind === SAVE_KIND;
/** What two docs hold apart from their timestamps (platform.js _differs, plus the autosave). */
function key(d: SaveDoc): string {
  const { exportedAt: _e, ...rest } = d as Record<string, unknown>;
  void _e;
  return canonical(rest);
}
function canonical(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  const o = v as Record<string, unknown>;
  return "{" + Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => JSON.stringify(k) + ":" + canonical(o[k])).join(",") + "}";
}
function write(opts: { replaceForeign?: boolean } = {}): void {
  const doc = buildDoc();
  if (!doc) { console.warn("save: too large"); return; }
  try {
    saves.save(doc as unknown as JsonValue, { schema: 1, ...opts });
    lastSavedAt = saves.load()?.savedAt ?? lastSavedAt;
  } catch (e) { console.warn(`save: ${String(e)}`); }
}
/** Saves every document (the device at once, the account debounced by the runtime): platform.js cloudNotifyChanged. */
export function persist(): void { write(); }
/** A doc from elsewhere merged into ours (store.mergeSaveDoc); true when anything changed. */
function adopt(other: unknown): boolean {
  if (!isDoc(other)) return false;
  const before = key(Store.exportSaveDoc());
  if (!Store.mergeSaveDoc(other)) return false;
  if (key(Store.exportSaveDoc()) === before) return false;
  write();
  return true;
}
saves.onConflict((mine, remote) => {
  const a = isDoc(mine?.data) ? mine.data as unknown as SaveDoc : Store.exportSaveDoc();
  const b = remote.data as unknown;
  return isDoc(b) ? { merged: Store.mergeSaveDocs(a, b) as unknown as JsonValue } : "keep-local";
});
saves.onStatus((_status, state) => {
  if (state === "foreign") { migrateForeign(); return; }
  const cur = saves.load();
  if (cur && cur.savedAt !== lastSavedAt) {
    lastSavedAt = cur.savedAt;
    if (adopt(cur.data)) merged();
  }
});
/** The browser build's cloud document (its save.json): merged with this device's, saved over it once. */
function migrateForeign(): void {
  const old = saves.foreign();
  if (!old) return;
  let doc: unknown = null;
  try { doc = old.text != null ? JSON.parse(old.text) : null; } catch { doc = null; }
  const before = key(Store.exportSaveDoc());
  if (isDoc(doc)) Store.mergeSaveDoc(doc);
  const grew = key(Store.exportSaveDoc()) !== before;
  write({ replaceForeign: true });
  if (grew) merged();
}

/** The sync line: platform.js syncLabel's states (null for a guest). */
export function syncState(): "saving" | "synced" | "offline" | "error" | null {
  if (!player()) return null;
  const st = saves.state();
  if (st === "error" || st === "read-blocked") return "error";
  if (st === "loading") return "saving";
  if (st === "foreign" || st === "uploading" || saves.status() === "pending") return "saving";
  if (saves.status() === "saved-on-device") return "offline";
  return "synced";
}
export function flush(): void { void saves.flush().catch(() => undefined); }

// --- the game's options (settings document) ---------------------------------------------------
/** js/platform.js SYNCED_SETTINGS that are still the game's (the rest are the runtime's Options). */
const OPTION_KEYS = ["colorPalette", "cameraShake", "dayLength", "leftHanded", "haptics"] as const;
/** Every key the browser build kept in the account's settings KV. */
const BROWSER_KEYS = ["music", "effects", "ambience", "voice", "muteAll", "graphics", "reducedMotion", "highContrast", "colorPalette",
  "textSize", "leftHanded", "holdToPan", "haptics", "cameraShake", "dayLength"];
const PALETTES = ["default", "deuteranopia", "protanopia", "tritanopia"];
/** A valid value for an option, or undefined. */
export function pickOption(k: string, v: unknown): unknown {
  switch (k) {
    case "colorPalette": return typeof v === "string" && PALETTES.includes(v) ? v : undefined;
    case "dayLength": return v === "normal" || v === "relaxed" ? v : undefined;
    case "cameraShake": case "leftHanded": case "haptics": return typeof v === "boolean" ? v : undefined;
    default: return undefined;
  }
}
let settings: Settings = Store.loadSettings();
const optionListeners = new Set<() => void>();
export function onOptionsChange(fn: () => void): void { optionListeners.add(fn); }
function optionsChanged(): void { for (const fn of optionListeners) fn(); }
/** The settings document (options and finished lessons). */
export function options(): Settings { return settings; }
export function setOption(k: (typeof OPTION_KEYS)[number], v: unknown): void {
  const ok = pickOption(k, v);
  if (ok === undefined || settings[k] === ok) return;
  settings[k] = ok as never;
  Store.saveSettings(settings);
  persist();
  optionsChanged();
}
/** The finished lessons (settings.tutorialsDone). */
export function saveSettings(): void { Store.saveSettings(settings); persist(); }
/** The browser build's account settings KV: the game's options carry over once, then all its keys go. */
function importLegacy(): void {
  const keys = legacyStore.legacyKeys();
  if (!keys) return;
  let changed = false;
  for (const k of keys) {
    if (!(OPTION_KEYS as readonly string[]).includes(k)) continue;
    const v = pickOption(k, legacyStore.legacy(k));
    if (v !== undefined && settings[k] !== v) { settings[k] = v as never; changed = true; }
  }
  for (const k of keys) if (BROWSER_KEYS.includes(k) || k.startsWith("ui.")) legacyStore.removeLegacy(k);
  if (changed) { Store.saveSettings(settings); persist(); optionsChanged(); }
}

/** Reads the device's save (from onStart). */
export function initPlatform(): void {
  const cur = saves.load();
  lastSavedAt = cur?.savedAt ?? 0;
  if (isDoc(cur?.data)) Store.importSaveDoc(cur!.data);
  settings = Store.loadSettings();
  legacyStore.onLegacy(importLegacy);
  importLegacy();
  if (saves.state() === "foreign") migrateForeign();
  refreshPlayer();
  void serverTime().then(() => undefined, () => undefined);
}
/** After a merge: re-read the settings document. */
export function reloadSettings(): void { settings = Store.loadSettings(); optionsChanged(); }
onProgressMerged(reloadSettings);

// --- the player and the clock -----------------------------------------------------------------
export function signedIn(): boolean { return !!player(); }
export function displayName(): string { return player()?.displayName ?? ""; }
let invite: string | null = null;
/** The invite link, fetched ahead so a button press can copy it at once. */
export function inviteLink(): string | null { return player() ? invite : null; }
function refreshPlayer(): void {
  invite = null;
  board = undefined;
  if (!player()) return;
  fetchInviteLink().then((u) => { invite = u; }, () => { invite = null; });
}
const playerListeners = new Set<() => void>();
export function onPlayer(fn: () => void): void { playerListeners.add(fn); }
onPlayerChange(() => { refreshPlayer(); for (const fn of playerListeners) fn(); });

/** Now in ms by the platform's clock when it has answered, else the device's (platform.js now()). */
export function nowMs(): number {
  try { return serverNow() ?? Date.now(); } catch { return Date.now(); }
}
/** platform.js utcToday: the Daily's UTC date. */
export function utcToday(): string { return new Date(nowMs()).toISOString().slice(0, 10); }

// --- the high-score board ---------------------------------------------------------------------
let board: Leaderboard | null | undefined;
async function highScoreBoard(): Promise<Leaderboard | null> {
  if (board !== undefined) return board;
  const list = await leaderboards.list();
  board = list.find((b) => b.key === "high-score") ?? list[0] ?? null;
  return board;
}
export interface BoardRow { name: string; score: number; rank: number }
/** platform.js leaderboardEntries: the platform board (read only), null when unavailable. */
export async function boardEntries(n: number): Promise<BoardRow[] | null> {
  try {
    const b = await highScoreBoard();
    if (!b) return null;
    const r = await leaderboards.entries(b.id, { pageSize: n });
    return r.items.slice(0, n).map((e) => ({ name: e.displayName || e.username || "", score: Number.isFinite(e.score) ? e.score : 0, rank: e.rank }));
  } catch { return null; }
}
export interface Posted { posted: boolean; rank: number | null }
/** Signed in only: post a finished round's total through score-script.js; { posted, rank }. Never rejects. */
export async function postScore(total: number): Promise<Posted> {
  const me = player();
  if (!me) return { posted: false, rank: null };
  const score = Math.max(0, Math.round(total));
  let accepted: string[] = [];
  try {
    const sessionId = await sessions.practice();
    accepted = await new Promise<string[]>((resolve) => {
      const socket = connectGame(sessionId);
      let done = false;
      const finish = (list: string[]): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        socket.close();
        resolve(list);
      };
      const timer = setTimeout(() => finish([]), 15000);
      socket.on("open", () => { socket.sendCommand({ type: "result", scores: { "high-score": score } }); });
      socket.on("game", (d) => {
        const m = d as { type?: string; accepted?: string[] } | null;
        if (m && m.type === "result-ack") finish(Array.isArray(m.accepted) ? m.accepted : []);
      });
      socket.on("error", () => finish([]));
      socket.on("stopped", () => finish([]));
      socket.on("abandoned", () => finish([]));
    });
  } catch { return { posted: false, rank: null }; }
  if (!accepted.includes("high-score")) return { posted: false, rank: null };
  try {
    const b = await highScoreBoard();
    if (!b) return { posted: true, rank: null };
    const r = await leaderboards.entries(b.id, { pageSize: 100 });
    const mine = r.items.find((e) => e.userId === me.userId);
    return { posted: true, rank: mine ? mine.rank : null };
  } catch { return { posted: true, rank: null }; }
}
