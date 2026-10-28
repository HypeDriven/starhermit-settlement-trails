// The browser build's pure game modules (shared with the node tests), typed
// for this client: the rules (js/rules.js: terrain, buildings, placement,
// the day advance, scoring, the hint), the content (js/content.js: the 44
// Journey stages, the five lessons, the Daily, Practice, the challenges, the
// themes, the greedy bot), the session (js/session.js: validated commands,
// undo, the day clock, snapshots, replay envelopes), the save documents
// (js/store.js: settings, progress, achievements, local boards, the autosave,
// the cloud-save merge) and the display names (js/names.js).
import * as rules from "../js/rules.js";
import * as content from "../js/content.js";
import * as sessionMod from "../js/session.js";
import * as storeMod from "../js/store.js";
import * as namesMod from "../js/names.js";

export type Building = "hall" | "road" | "house" | "farm" | "lumber" | "well" | "market";
export interface Cell { type: Building; pop?: number; happy?: number }
export interface Order { id: string; want: { res: "food" | "wood"; n: number }; reward: number; createdTick: number; expiresTick: number }
export interface GameEvent { tick: number; kind: string; text: string; reason?: string; x?: number; y?: number; building?: string; reward?: number; food?: number; wood?: number; coins?: number; orderId?: string }
export interface Goals { population?: number; orders?: number; coins?: number; days: number }
export interface Stats { invalidActions: number; buildingsPlaced: number; demolished: number; ordersCompleted: number; daysSurvived: number; foodShortage?: boolean }
export interface State {
  version: number; contentId: string; contentVersion: number; seed: number; tick: number; grid: { w: number; h: number };
  terrain: number[]; cells: (Cell | null)[]; resources: { coins: number; wood: number; food: number };
  orders: Order[]; goals: Goals; mechanics: Building[]; roadLimit: number; stats: Stats;
  status: "active" | "won" | "lost"; endReason: string | null; events: GameEvent[];
}
export interface Step { text: string; require: { type: string; building?: string; population?: number; count?: number }; count?: number }
export interface Def {
  id: string; version: number; kind: string; name: string; seed: number; gridSize: number; stageIndex?: number;
  start: { coins: number; wood: number; food: number }; goals: Goals; mechanics: Building[]; roadLimit?: number;
  par?: { days: number; score: number } | null; theme?: string; mastery?: boolean; blurb?: string; steps?: Step[]; daily?: string; allowUndo?: boolean;
}
export interface Content {
  id: string; version: number; kind: string; name: string; seed: number; grid: { w: number; h: number }; terrain: number[];
  hall: { x: number; y: number }; start: Def["start"]; goals: Goals; mechanics: Building[]; roadLimit: number;
  par: Def["par"]; theme: string; steps: Step[] | null; daily: string | null; mastery: boolean; allowUndo: boolean; blurb: string;
}
export interface Theme { name: string; sky: number; fog: number; grass: number; hill: number; forest: number; water: number; rock: number; ambient: string }
export interface HouseInfo { road: boolean; water: boolean; food: boolean; market: boolean; happy: number }
export interface Score { components: Record<string, number>; total: number; won: boolean }
export interface Command { type: string; x?: number; y?: number; building?: string; orderId?: string; id?: string }
export interface Hint { kind: "place" | "fulfill"; x?: number; y?: number; type?: Building; building?: Building; orderId?: string }

export interface Session {
  content: Content; mode: string; allowUndo: boolean; sessionId: string; state: State; speed: number; paused: boolean;
  finished: boolean; elapsedActiveMs: number; undoStack: unknown[]; commandLog: unknown[];
  submit(cmd: Command): { ok: boolean; reason?: string; duplicate?: boolean };
  undo(): { ok: boolean; reason?: string };
  update(dtMs: number): GameEvent[];
  setPaused(p: boolean): void;
  setSpeed(s: number): void;
  snapshot(): Snapshot;
  replayEnvelope(): Record<string, unknown>;
}
export interface Snapshot { mode: string; content: Content; sessionId: string; [k: string]: unknown }
export interface SessionOpts { mode?: string; allowUndo?: boolean; onEvents?: (ev: GameEvent[], st: State) => void; onTerminal?: (st: State) => void; sessionId?: string }

interface RulesApi {
  TERRAIN: Record<"GRASS" | "FOREST" | "HILL" | "WATER" | "ROCK", number>; TERRAIN_NAME: string[];
  BUILDINGS: Record<Building, { name: string; cost: { coins?: number; wood?: number }; desc: string; radius?: number; capacity?: number }>;
  BUILD_ORDER: Building[]; INVALID_REASONS: Record<string, string>;
  placementError(s: State, x: number, y: number, type: string): string | null;
  demolishError(s: State, x: number, y: number): string | null;
  evaluateHouses(s: State): { houses: Map<number, HouseInfo>; total: number; served: number; avgHappy: number };
  totalPopulation(s: State): number; totalCapacity(s: State): number;
  suggestAction(s: State): Hint | null;
  score(s: State): Score;
  canAfford(s: State, type: string): boolean;
}
interface ContentApi {
  JOURNEY_STAGES: Def[]; TUTORIALS: Def[]; CHALLENGES: Def[]; THEMES: Record<string, Theme>;
  dailyContent(dateISO: string): Def; practiceContent(difficulty: string, seed?: number | null): Def;
  materialize(def: Def): Content; botMove(s: State): Command | null;
}
export interface Progress {
  journeyUnlocked: number; journeyStars: Record<string, number>; journeyWon: Record<string, boolean>;
  totals: { gamesPlayed: number; gamesWon: number; buildingsPlaced: number; ordersFulfilled: number };
  daily: { lastPlayed: string | null; streak: number; best: Record<string, number> };
}
export interface Settings {
  colorPalette: string; cameraShake: boolean; dayLength: string; leftHanded: boolean; haptics: boolean; tutorialsDone: string[];
  [k: string]: unknown;
}
export interface BoardEntry { board: string; name: string; score: number; seed?: number; elapsedTicks?: number; sessionId: string; rank?: number }
export interface SaveDoc { kind: string; version: number; [k: string]: unknown }
interface StoreApi {
  setBackend(kv: { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void }): void;
  loadSettings(): Settings; saveSettings(s: Settings): void; loadProgress(): Progress; saveProgress(p: Progress): void;
  ACHIEVEMENTS: { id: string; name: string; desc: string }[]; loadAchievements(): { unlocked: Record<string, number> };
  unlockAchievement(id: string): boolean;
  submitScore(e: Record<string, unknown>): { ok: boolean; rank?: number };
  getBoard(board: string, o?: { friendsOnly?: boolean; friends?: string[] }): BoardEntry[];
  exportSaveDoc(): SaveDoc; mergeSaveDocs(local: SaveDoc, remote: SaveDoc): SaveDoc; mergeSaveDoc(doc: unknown): boolean; importSaveDoc(doc: unknown): boolean;
  saveAutosave(s: Snapshot): void; loadAutosave(): Snapshot | null; clearAutosave(): void;
  DEFAULT_SETTINGS: Settings;
}
interface NamesApi {
  contentName(def: { name?: string } | null, o?: { bare?: boolean }): string; contentBlurb(def: { blurb?: string } | null): string;
  buildingName(type: string): string; buildingDesc(type: string): string; invalidText(reason: string): string;
  eventText(ev: GameEvent): string; practiceLevel(level: string): string;
}

export const Rules = rules as unknown as RulesApi;
export const Contents = content as unknown as ContentApi;
export const Store = storeMod as unknown as StoreApi;
export const Names = namesMod as unknown as NamesApi;
export const SessionClass = (sessionMod as unknown as { Session: new (c: Content, o: SessionOpts) => Session; DAY_MS: number[] }).Session;
export const RestoreSession = (sessionMod as unknown as { Session: { restore(s: Snapshot, o: SessionOpts): Session } }).Session.restore;
export const ValidateReplay = (sessionMod as unknown as { Session: { validateReplay(e: Record<string, unknown>): { ok: boolean } } }).Session.validateReplay;
