// The browser build's DOM shell (index.html + js/ui.js + css/style.css) as
// starhermit:ui, built every frame over the settlement: the title card, the
// mode pickers (Journey stage grid, lessons, practice levels, challenges, the
// Daily), the HUD bar (resources, day and mode pills, speed / undo / hint /
// centre / pause), the Objective rail (objective, progress, trade orders with
// Deliver, the event log) and the Inspector rail, the toolbox, the lesson
// card, the toast, the countdown, and the overlay panels (pause, results,
// settings, help, scoreboards). The old media queries are layouts picked by
// the window's logical size: wide (≥ 1024 px: both rails shown), compact
// (rails as drawers behind ☰ / ℹ), phone portrait (≤ 700 px wide: the HUD
// wraps, the drawers rise from above the wrapped icon toolbox) and short
// landscape (≤ 500 px tall: narrow drawers, the toolbox a column at the side,
// the left side with the left-handed layout).
import { frame, openMenu } from "starhermit:engine";
import { bindings, requestRebind } from "starhermit:input";
import * as draw from "starhermit:draw";
import * as ui from "starhermit:ui";
import { Contents, Names, Rules, Store, type Def } from "./game.ts";
import { N, S, T } from "./i18n.ts";
import * as platform from "./platform.ts";
import * as render from "./render.ts";
import {
  app, canUndo, centerCamera, closeOverlay, cycleSpeed, fresh, fulfill, hasAutosave, inGame, invite, later, lbText, modeLabel, nextStage,
  pauseGame, profileName, quickPlay, quitToTitle, renderBoard, replayTutorials, restart, resumeAutosave, resumeGame, setTool, showHint,
  showHelp, showPicker, showScores, showSettings, showTitle, signIn, sound, startGame, tools, topOverlay, undo, type Overlay, type Tool,
} from "./main.ts";
import { token } from "./style.ts";

// ------------------------------------------------------------------ layout
interface Layout { lw: number; lh: number; sc: number; wide: boolean; phone: boolean; land: boolean }
function layoutNow(): Layout {
  const f = frame();
  const sc = ui.preferences().scale;
  const sa = f.safeArea;
  const lw = Math.max(1, (f.width - sa.left - sa.right) / sc), lh = Math.max(1, (f.height - sa.top - sa.bottom) / sc);
  const land = lh <= 500 && lw > lh;
  return { lw, lh, sc, wide: lw >= 1024 && !land, phone: lw <= 700 && lh >= lw, land };
}
/** The wide layout (both rails shown). */
export function isWide(): boolean { return layoutNow().wide; }
/** The portrait-phone layout (both rails are bottom drawers in the same spot: opening one closes the other). */
export function isPhonePortrait(): boolean { return layoutNow().phone; }

const lastSize = new Map<string, ui.Rect>();
function textWidth(text: string, style: string, kind?: "button" | "heading"): number {
  return ui.measureText(text, { ...(kind ? { kind } : {}), style: [style] }).width / ui.preferences().scale;
}
/** Text up to `width` wide: one label when it fits, else a paragraph. */
function para(text: string, width: number, cls = "text", id?: string): void {
  if (!text) return;
  let u = ui.style(cls);
  if (id) u = u.id(id);
  if (textWidth(text, cls) <= width) u.label(text);
  else u.paragraph(text, Math.max(20, width));
}
interface Btn {
  id: string; text: string; style?: string; act: () => void; disabled?: boolean; name?: string; selected?: boolean;
  content?: () => void; width?: number; height?: number; quiet?: boolean; tip?: string;
}
const buttonWidth = (text: string, style: string): number => textWidth(text, style, "button") + 2;
function button(b: Btn): void {
  const style = b.style ?? "btn";
  const opts: ui.ButtonOptions = {};
  if (b.disabled) opts.disabled = true;
  if (b.selected !== undefined) opts.selected = b.selected;
  if (b.tip) (opts as { tooltip?: string }).tooltip = b.tip;
  if (b.content) opts.content = b.content;
  else if (b.width != null && buttonWidth(b.text, style) > b.width) {
    const inner = b.width - 34;
    opts.content = () => { ui.style(style === "btn-primary" || style === "btn-big" ? "wrap-ink" : "wrap").paragraph(b.text, Math.max(20, inner)); };
  } else if (b.name && b.name !== b.text) opts.content = () => { ui.label(b.text); };
  const s: ui.Style = {};
  if (b.width != null) s.width = b.width;
  if (b.height != null) s.height = b.height;
  if (ui.style(style, s).id(b.id).button(b.name ?? b.text, opts) && fresh()) {
    later(() => { if (!b.quiet) sound("ui"); b.act(); });
  }
}
/** Buttons at their own widths in rows that wrap at `width` (flex-wrap). */
function flow(label: string, list: Btn[], width: number, gap = 8, justify: "start" | "center" = "start"): number {
  const rows: Btn[][] = [[]];
  let used = 0;
  const bw = (b: Btn): number => Math.min(width, b.width ?? buttonWidth(b.text, b.style ?? "btn"));
  for (const b of list) {
    const w = bw(b);
    if (rows[rows.length - 1]!.length && used + gap + w > width) { rows.push([]); used = 0; }
    used += (rows[rows.length - 1]!.length ? gap : 0) + w;
    rows[rows.length - 1]!.push(b);
  }
  ui.column(label, () => {
    rows.forEach((row, ri) => ui.row(`${label}-r${ri}`, () => {
      for (const b of row) button({ ...b, width: bw(b) });
    }, { spacing: gap, width, justify, align: "center" }));
  }, { spacing: gap, width });
  return rows.length;
}
/** A box over a logical rectangle drawn by a placed role-none widget. */
function paint(id: string, x: number, y: number, w: number, h: number, cls: string): void {
  if (w <= 0 || h <= 0) return;
  ui.place(id, { anchor: "top-start", x, y }, () => { ui.style(cls).widget("", { role: "none", size: { width: w, height: h } }); });
}

// ------------------------------------------------------------------ the frame
export function drawScreens(): void {
  const L = layoutNow();
  const f = frame();
  render.setActive(app.screen === "game");
  if (app.screen === "title") titleScreen(L);
  else if (app.screen === "picker") pickerScreen(L);
  else if (inGame()) gameScreen(L);
  overlay(L);
  toastBox(L);
  if (app.focusNext) {
    const age = f.frame - app.openedFrame;
    if (age >= 1) ui.setFocus(app.focusNext);
    if (age >= 3) app.focusNext = null;
  }
}

// ------------------------------------------------------------------ title (#screen-title)
function titleScreen(L: Layout): void {
  paint("title-bg", 0, 0, L.lw, L.lh, "title-bg");
  const w = Math.min(480, L.lw - 32);
  const prog = Store.loadProgress();
  const today = platform.utcToday();
  const dailyDone = !!prog.daily.best[today];
  const unlocked = Math.min(prog.journeyUnlocked, Contents.JOURNEY_STAGES.length);
  const body = (): void => {
    lastSize.set("title-in", ui.column("title-in", () => {
      const big = !L.land && L.lw > 420;
      const h1 = L.land ? "h1-land" : "h1";
      ui.style(h1, big ? {} : { text: { size: L.land ? 30.4 : 38.4 } }).id("title-h").label("Settlement");
      ui.style(h1 + "-accent", big ? {} : { text: { size: L.land ? 30.4 : 38.4 } }).id("title-h2").label("Trails");
      para(T("A cozy low-poly settlement builder spanning river and hills."), w, "tagline", "title-tag");
      ui.spacer(0.0001);
      const main: Btn[] = [
        { id: "btn-play", text: T("▶ Play"), style: "btn-big", act: quickPlay, width: L.land ? undefined : w },
        { id: "btn-daily", text: `📅 ${T("Daily Trail")}${dailyDone ? "  " + T("✓ done") : ""}`, name: T("Daily Trail"), act: () => showPicker("daily"), width: L.land ? undefined : w },
        { id: "btn-journey", text: `🗺 ${T("Journey")}  ${unlocked}/${Contents.JOURNEY_STAGES.length}`, name: T("Journey"), act: () => showPicker("journey"), width: L.land ? undefined : w },
      ];
      if (L.land) flow("title-actions", main, w, 10, "center");
      else ui.column("title-actions", () => { for (const b of main) button(b); }, { spacing: 10, width: w, align: "center" });
      flow("title-secondary", [
        { id: "btn-practice", text: T("Practice"), style: "btn-small", act: () => showPicker("practice") },
        { id: "btn-challenge", text: T("Challenges"), style: "btn-small", act: () => showPicker("challenge") },
        { id: "btn-learn", text: T("Learn"), style: "btn-small", act: () => showPicker("learn") },
        { id: "btn-scores", text: T("Scores"), style: "btn-small", act: showScores },
        { id: "btn-help", text: T("Help"), style: "btn-small", act: showHelp },
        { id: "btn-settings", text: T("Settings"), style: "btn-small", act: showSettings },
      ], w, 8, "center");
      const sync = syncLine();
      para(T("Signed in as {name}", { name: profileName() }) + (sync ? ` · ${sync}` : ""), w, "small", "profile-line");
      const acct: Btn[] = [];
      if (!platform.signedIn()) acct.push({ id: "btn-signin", text: S("signIn"), style: "btn-small", act: signIn });
      if (platform.inviteLink()) acct.push({ id: "btn-invite", text: S("invite"), style: "btn-small", act: invite });
      if (acct.length) flow("title-account", acct, w, 8, "center");
      if (hasAutosave()) button({ id: "btn-resume", text: T("↩ Resume saved settlement"), style: "btn-ghost", act: resumeAutosave });
    }, { spacing: 12, width: w, align: "center" }));
  };
  const h = (lastSize.get("title-in")?.height ?? 0) / L.sc;
  const avail = L.lh - 16;
  ui.place("title", { anchor: "top-start", x: (L.lw - w) / 2, y: Math.max(8, (L.lh - h) / 2) }, () => {
    if (h > avail) ui.scrollArea("title-scroll", { width: w + 14, height: avail }, body);
    else body();
  });
}
function syncLine(): string {
  switch (platform.syncState()) {
    case "saving": return T("Saving…");
    case "synced": return T("Cloud synced");
    case "offline": return T("Offline");
    case "error": return T("Sync issue");
    default: return "";
  }
}

// ------------------------------------------------------------------ pickers (#screen-picker)
function pickerTitle(): string {
  switch (app.picker) {
    case "journey": return T("Journey");
    case "learn": return T("Learn");
    case "practice": return T("Practice");
    case "challenge": return T("Challenges");
    case "daily": return T("Daily Trail");
    default: return "";
  }
}
function pickerScreen(L: Layout): void {
  paint("picker-bg", 0, 0, L.lw, L.lh, "page");
  const w = Math.min(704, L.lw * 0.94);
  const pad = L.lw < 500 ? 16 : 24;
  const inner = w - 2 * pad;
  const maxH = (L.land ? L.lh - 16 : Math.min(L.lh * 0.88, L.lh - 16));
  const prev = lastSize.get("picker-in");
  const scroll = !!prev && prev.height / L.sc + 2 * 20 > maxH;
  const h = prev ? Math.min(maxH, prev.height / L.sc + 40) : maxH;
  ui.place("picker", { anchor: "top-start", x: (L.lw - w) / 2, y: Math.max(8, (L.lh - h) / 2) }, () => {
    ui.column("picker-panel", () => {
      const iw = inner - (scroll ? 14 : 0);
      const body = (): void => {
        lastSize.set("picker-in", ui.column("picker-in", () => {
          ui.row("picker-head", () => {
            button({ id: "btn-back", text: T("← Back"), style: "btn-small", act: showTitle });
            para(pickerTitle(), iw - 120, "h2", "picker-h");
          }, { spacing: 16, width: iw, align: "center" });
          pickerBody(iw);
        }, { spacing: 10, width: iw }));
      };
      if (scroll) ui.scrollArea("picker-scroll", { width: inner + 6, height: maxH - 40 }, body, frame().frame - app.openedFrame <= 6 ? { scrollTo: { top: 0 } } : undefined);
      else body();
    }, { style: "panel", width: w, spacing: 0, padding: { top: 20, bottom: 20, start: pad, end: pad } });
  });
}
function pickerBody(w: number): void {
  const p = app.picker;
  if (p === "journey") journeyGrid(w);
  else if (p === "learn") learnList(w);
  else if (p === "practice") practiceCards(w);
  else if (p === "challenge") for (const ch of Contents.CHALLENGES) setupCard(ch, w, false, "5–8", () => startGame(ch, "challenge"));
  else if (p === "daily") { const def = Contents.dailyContent(platform.utcToday()); setupCard(def, w, true, "5–10", () => startGame(def, "daily")); }
}
/** ui.js stageGrid: 44 stage cards (name, MASTERY, stars or a lock, the blurb). */
function journeyGrid(w: number): void {
  const prog = Store.loadProgress();
  const gap = 10, min = 144;
  const cols = Math.max(1, Math.floor((w + gap) / (min + gap)));
  const cw = (w - (cols - 1) * gap) / cols;
  const J = Contents.JOURNEY_STAGES;
  ui.column("stage-grid", () => {
    for (let r = 0; r * cols < J.length; r++) {
      ui.row(`stage-grid-r${r}`, () => {
        for (let i = r * cols; i < Math.min(J.length, (r + 1) * cols); i++) {
          const st = J[i]!;
          const unlocked = i <= prog.journeyUnlocked;
          const stars = prog.journeyStars[st.id] || 0;
          const title = `${i + 1}. ${Names.contentName(st, { bare: true })}`;
          const starText = unlocked ? "★".repeat(stars) + "☆".repeat(3 - stars) : "🔒";
          const blurb = Names.contentBlurb(st);
          const iw = cw - 24;
          button({
            id: `stage-${i + 1}`, text: title, name: [title, st.mastery ? T("MASTERY") : "", unlocked ? T("{n} of 3 stars", { n: stars }) : T("Locked")].filter(Boolean).join(", "),
            style: "stage-card", width: cw, disabled: !unlocked, act: () => startGame(st, "journey"),
            content: () => ui.column(`stage-${i + 1}-face`, () => {
              para(title, iw, "text");
              if (st.mastery) para(T("MASTERY"), iw, "mastery");
              para(starText, iw, "stars");
              para(blurb, iw, "small");
            }, { spacing: 2, width: iw }),
          });
        }
      }, { spacing: gap, align: "stretch" });
    }
  }, { spacing: gap, width: w });
}
function learnList(w: number): void {
  const done = platform.options().tutorialsDone;
  ui.column("learn-list", () => {
    for (const t of Contents.TUTORIALS) {
      const fin = done.includes(t.id);
      const title = `${fin ? "✅" : "▶️"} ${Names.contentName(t)}`;
      const sub = T("{n} steps", { n: t.steps!.length });
      button({
        id: `lesson-${t.id}`, text: title, name: `${Names.contentName(t)}, ${sub}${fin ? ", " + T("✓ done") : ""}`, style: "stage-card", width: w,
        act: () => startGame(t, "learn"),
        content: () => ui.column(`lesson-${t.id}-face`, () => { para(title, w - 24, "text"); para(sub, w - 24, "small"); }, { spacing: 2, width: w - 24 }),
      });
    }
  }, { spacing: 10, width: w });
}
function practiceCards(w: number): void {
  for (const d of ["relaxed", "normal", "hard"]) {
    const def = Contents.practiceContent(d, 0xc0ffee);
    ui.column(`practice-${d}`, () => {
      para(Names.practiceLevel(d), w - 32, "h3", `practice-${d}-h`);
      para(T("Population {pop} in {days} days. Unranked, undo enabled.", { pop: def.goals.population ?? 0, days: def.goals.days }), w - 32, "text");
      button({ id: `btn-practice-${d}`, text: T("Start"), name: `${T("Start")} ${Names.practiceLevel(d)}`, style: "btn-primary", act: () => startGame(Contents.practiceContent(d), "practice") });
    }, { style: "setup-card", width: w, spacing: 10 });
  }
}
/** ui.js setupCard: name, blurb, objectives, mode facts, road limit, Start. */
function setupCard(def: Def, w: number, ranked: boolean, expected: string, onStart: () => void): void {
  const iw = w - 32;
  ui.column(`setup-${def.id}`, () => {
    para(Names.contentName(def), iw, "h3");
    para(Names.contentBlurb(def), iw, "text");
    const goals: string[] = [];
    if (def.goals.population) goals.push(T("{n} residents", { n: def.goals.population }));
    if (def.goals.orders) goals.push(T("{n} trade orders", { n: def.goals.orders }));
    if (def.goals.coins) goals.push(T("{n} coins", { n: def.goals.coins }));
    para(T("Objectives: {list} within {days} days.", { list: goals.join(", "), days: def.goals.days }), iw, "text");
    para(T("Solo · ~{min} min · {ranked} · Tools: {tools}", {
      min: expected, ranked: ranked ? T("Ranked") : T("Unranked"), tools: def.mechanics.map((m) => Names.buildingName(m)).join(", "),
    }), iw, "dim");
    if (def.roadLimit) para(T("Road limit: {n} tiles.", { n: def.roadLimit }), iw, "dim");
    button({ id: `btn-start-${def.id}`, text: T("Start"), name: `${T("Start")} ${Names.contentName(def)}`, style: "btn-primary", act: onStart });
  }, { style: "setup-card", width: w, spacing: 10 });
}

// ------------------------------------------------------------------ the game (#screen-game)
const TOOL_ICONS: Record<string, string> = { road: "🛤", house: "🏠", farm: "🌾", lumber: "🪓", well: "💧", market: "⚖️", demolish: "✖️", inspect: "🔍" };
export function costText(cost: { coins?: number; wood?: number }): string {
  const parts: string[] = [];
  if (cost.coins) parts.push(cost.coins + "🪙");
  if (cost.wood) parts.push(cost.wood + "🪵");
  return parts.join(" ") || T("free");
}
function gameScreen(L: Layout): void {
  const s = app.session!;
  const st = s.state;
  // the HUD's gradient, under everything
  const hudH = (lastSize.get("hud")?.height ?? 52 * L.sc) / L.sc + 8;
  paint("hud-bg", 0, 0, L.lw, hudH + 8, "hud");
  // toolbox size (laid out last frame) for the drawers and the lesson card
  const tb = lastSize.get("toolbox");
  const tbH = tb ? tb.height / L.sc : 70;
  const tbW = tb ? tb.width / L.sc : 64;
  // rails
  const railW = L.land ? 224 : L.wide ? 272 : Math.min(320, L.lw * 0.78);
  let top = L.wide ? 54 : L.land ? 48 : L.phone ? 0 : 64;
  let bottom = L.wide ? 102 : L.land ? 80 : 112;
  if (L.phone) { bottom = tbH + 20 + 8; }
  const railH = L.phone ? Math.min(L.lh * 0.42, L.lh - bottom - hudH - 8) : L.lh - top - bottom;
  if (L.phone) top = L.lh - bottom - railH;
  const toggles = !L.wide;
  const leftHanded = !!platform.options().leftHanded;
  const toolX = L.land ? (leftHanded ? 8 : L.lw - tbW - 8) : (L.lw - tbW) / 2;
  const showLeft = L.wide || app.railLeft;
  const showRight = L.wide || app.railRight;
  const padTop = toggles && !L.phone ? (L.land ? 64 : 48) : 13;
  const leftX = L.land && leftHanded ? tbW + 16 : 10;
  const rightX = L.land && !leftHanded ? L.lw - railW - tbW - 16 : L.lw - railW - 10;
  if (showLeft) rail("rail-left", leftX, top, railW, railH, padTop, toggles, (iw) => objectiveRail(iw));
  if (showRight) rail("rail-right", rightX, top, railW, railH, padTop, toggles, (iw) => inspectorRail(iw));
  toolbox(L, toolX);
  tutorialCard(L, tbH);
  hud(L);
  if (toggles) {
    const ty = L.wide ? 58 : L.land ? 52 : L.phone ? hudH - 46 : 58;
    ui.place("toggle-l", { anchor: "top-start", x: 6, y: ty }, () => {
      button({ id: "rail-left-toggle", text: "☰", name: T("Toggle objectives panel"), style: "rail-toggle", selected: app.railLeft, act: () => toggleRail("left"), width: 44 });
    });
    ui.place("toggle-r", { anchor: "top-start", x: L.lw - 50, y: ty }, () => {
      button({ id: "rail-right-toggle", text: "ℹ", name: T("Toggle inspector panel"), style: "rail-toggle", selected: app.railRight, act: () => toggleRail("right"), width: 44 });
    });
  }
  if (app.countdown != null) {
    const size = Math.max(64, Math.min(144, L.lw * 0.18));
    ui.place("countdown", { anchor: "center" }, () => { ui.style("countdown", { text: { size } }).id("countdown").label(app.countdown!); });
  }
  boardTargets(L);
  void st;
}
function toggleRail(which: "left" | "right"): void {
  if (which === "left") { app.railLeft = !app.railLeft; if (app.railLeft && isPhonePortrait()) app.railRight = false; }
  else { app.railRight = !app.railRight; if (app.railRight && isPhonePortrait()) app.railLeft = false; }
}
/** A .rail panel at a logical rectangle; its content scrolls when taller. */
function rail(id: string, x: number, y: number, w: number, h: number, padTop: number, drawer: boolean, build: (inner: number) => void): void {
  ui.place(id, { anchor: "top-start", x, y }, () => {
    ui.column(id, () => {
      const prev = lastSize.get(`${id}-in`);
      const padX = 16;
      const inner = h - padTop - 13;
      const scroll = !!prev && prev.height / ui.preferences().scale > inner + 1;
      const iw = w - 2 * padX - (scroll ? 14 : 0);
      const body = (): void => { lastSize.set(`${id}-in`, ui.column(`${id}-in`, () => build(iw), { spacing: 6, width: iw })); };
      if (scroll) ui.scrollArea(`${id}-scroll`, { width: w - padX - 2, height: inner }, body);
      else body();
    }, { style: drawer ? "rail-open" : "rail", width: w, height: h, spacing: 0, padding: { top: padTop, bottom: 13, start: 16, end: 16 } });
  });
}
/** #rail-left: objective, progress, trade orders, event log. */
function objectiveRail(w: number): void {
  const s = app.session!, st = s.state, def = app.def ?? (s.content as unknown as Def);
  para(T("Objective"), w, "rail-title", "objective-heading");
  para(def.blurb ? Names.contentBlurb(def) : Names.contentName(s.content), w, "text", "objective-text");
  const pop = Rules.totalPopulation(st);
  const g = st.goals;
  ui.column("objective-progress", () => {
    if (g.population) para(`👥 ${T("Population {n} / {goal}", { n: pop, goal: g.population })}`, w, pop >= g.population ? "obj-done" : "obj", "obj-pop");
    if (g.orders) para(`📦 ${T("Orders {n} / {goal}", { n: st.stats.ordersCompleted, goal: g.orders })}`, w, st.stats.ordersCompleted >= g.orders ? "obj-done" : "obj", "obj-orders");
    if (g.coins) para(`🪙 ${T("Coins {n} / {goal}", { n: st.resources.coins, goal: g.coins })}`, w, st.resources.coins >= g.coins ? "obj-done" : "obj", "obj-coins");
    para(`⏳ ${T("{n} days left", { n: Math.max(0, g.days - st.tick) })}`, w, "obj", "obj-days");
  }, { spacing: 4, width: w });
  ui.spacer(0.0001);
  para(T("Trade orders"), w, "rail-sub", "orders-h");
  ui.column("orders-list", () => {
    if (!st.orders.length) {
      ui.column("orders-empty", () => para(T("No open orders. New orders arrive every few days."), w - 20, "small"), { style: "order-row", width: w });
    }
    for (const o of st.orders) {
      const can = (st.resources[o.want.res] || 0) >= o.want.n;
      const left = o.expiresTick - st.tick;
      ui.row(`order-${o.id}`, () => {
        ui.style("order-text").label(`${o.want.n} ${o.want.res === "food" ? "🌾" : "🪵"} → ${o.reward} 🪙`);
        ui.spacer();
        ui.style("exp").label(T("{n}d", { n: left }));
        button({ id: `deliver-${o.id}`, text: T("Deliver"), name: `${T("Deliver")} ${o.want.n} ${T(o.want.res)}`, style: "btn-small", disabled: !can, act: () => fulfill(o.id), quiet: true, tip: can ? T("Fulfil this order") : T("Not enough goods yet") });
      }, { style: "order-row", width: w, spacing: 8, align: "center" });
    }
  }, { spacing: 6, width: w });
  ui.spacer(0.0001);
  para(T("Event log"), w, "rail-sub", "log-h");
  ui.column("event-log", () => {
    st.events.slice(-8).reverse().forEach((ev, i) => para(`${i + 1}. [${T("D{n}", { n: ev.tick })}] ${Names.eventText(ev)}`, w, i === 0 ? "log-first" : "log", `log-${i}`));
  }, { spacing: 2, width: w });
}
/** #rail-right: the inspected tile (terrain, building, residents, happiness, needs). */
function inspectorRail(w: number): void {
  const st = app.session!.state;
  para(T("Inspector"), w, "rail-title", "inspector-heading");
  const ins = app.inspect;
  if (!ins) { para(T("Select a tile or building."), w, "dim", "inspector-empty"); return; }
  const { x, y } = ins;
  const t = st.terrain[y * st.grid.w + x]!;
  const b = st.cells[y * st.grid.w + x];
  para(T("Tile {x},{y}", { x, y }), w, "h3", "inspect-tile");
  para(T("Terrain: {terrain}", { terrain: T(Rules.TERRAIN_NAME[t]!) }), w, "text", "inspect-terrain");
  if (b) {
    para(Names.buildingName(b.type), w, "text", "inspect-building");
    if (b.type === "house") {
      para(T("Residents: {n}/4 · Happiness: {pct}%", { n: b.pop || 0, pct: Math.round((b.happy ?? 0) * 100) }), w, "text", "inspect-residents");
      const info = Rules.evaluateHouses(st).houses.get(y * st.grid.w + x);
      if (info) {
        const needs = [`${info.road ? "✅" : "❌"} ${T("road")}`, `${info.water ? "✅" : "❌"} ${T("water")}`, `${info.food ? "✅" : "❌"} ${T("food")}`, `${info.market ? "✅" : "➖"} ${T("market")}`];
        para(needs.join(" · "), w, "text", "inspect-needs");
      }
    }
  } else if (ins.error) para(Names.invalidText(ins.error), w, "text", "inspect-error");
}
/** #hud-top: resources, day and mode, the speed / undo / hint / centre / pause buttons. */
function hud(L: Layout): void {
  const s = app.session!, st = s.state;
  let pop = 0, cap = 0;
  for (const c of st.cells) if (c && c.type === "house") { pop += c.pop || 0; cap += 4; }
  const ev = Rules.evaluateHouses(st);
  const small = L.phone;
  const res: [string, string, string][] = [
    ["res-coins", "🪙", String(st.resources.coins)], ["res-wood", "🪵", String(st.resources.wood)], ["res-food", "🌾", String(st.resources.food)],
    ["res-pop", "👥", `${pop}/${cap}`], ["res-happy", "😊", ev.total ? `${Math.round(ev.avgHappy * 100)}%` : "–"],
  ];
  const resNames = [N("Coins"), N("Wood"), N("Food"), N("Population"), N("Happiness")];
  const resources = (): void => {
    ui.row("hud-resources", () => {
      res.forEach(([id, ico, v], i) => ui.row(id, () => {
        ui.style(small ? "res-v-sm" : "res-v").label(`${ico} ${v}`, { name: `${T(resNames[i]!)} ${v}` } as ui.WidgetOptions);
      }, { style: small ? "res-sm" : "res", align: "center" }));
    }, { spacing: small ? 6 : 8, align: "center" });
  };
  const paused = s.paused && app.countdown == null;
  const speedText = paused ? "⏸" : ["⏸", "▶", "▶▶", "▶▶▶"][s.speed] || "▶";
  const btns: Btn[] = [
    { id: "btn-speed", text: speedText, name: paused ? T("Resume time") : T("Speed {n}", { n: s.speed }), tip: T("Game speed (Space)"), style: "btn-icon", act: cycleSpeed, width: speedText.length > 2 ? 64 : 44 },
  ];
  if (canUndo()) btns.push({ id: "btn-undo", text: "↩", name: T("Undo"), tip: T("Undo (U)"), style: "btn-icon", act: undo, width: 44 });
  btns.push({ id: "btn-hint", text: "💡", name: T("Hint"), tip: T("Hint (H)"), style: "btn-icon", act: showHint, width: 44, quiet: true });
  btns.push({ id: "btn-center", text: "⌖", name: T("Center map"), tip: T("Center map (C)"), style: "btn-icon", act: centerCamera, width: 44 });
  btns.push({ id: "btn-pause", text: "⏸", name: T("Pause"), tip: T("Pause (Esc)"), style: "btn-icon", act: pauseGame, width: 44, quiet: true });
  const buttons = (): void => { ui.row("hud-buttons", () => { for (const b of btns) button({ ...b, act: () => { b.act(); later(() => ui.setFocus(null)); } }); }, { spacing: 8, align: "center" }); };
  const center = (): void => {
    ui.row("hud-center", () => {
      ui.row("hud-day", () => ui.style("day").id("hud-day-text").label(T("Day {day} / {days}", { day: st.tick, days: st.goals.days })), { style: "day-pill" });
      ui.row("hud-mode", () => ui.style("pill-text").label(modeLabel(app.mode)), { style: "pill" });
    }, { spacing: 10, align: "center" });
  };
  ui.place("hud", { anchor: "top-start", x: 0, y: 0 }, () => {
    lastSize.set("hud", ui.column("hud-col", () => {
      if (L.phone) {
        resources();
        buttons();
        ui.row("hud-r3", () => { ui.spacer(); center(); ui.spacer(); }, { width: L.lw - 20, align: "center", height: 52 });
      } else {
        ui.row("hud-row", () => { resources(); ui.spacer(); center(); ui.spacer(); buttons(); }, { width: L.lw - 20, align: "center" });
      }
    }, { spacing: 6, width: L.lw, padding: { top: 6, bottom: 6, start: 10, end: 10 } }));
  });
}
/** #toolbox: Inspect, the scenario's buildings with their costs, Demolish. */
function toolbox(L: Layout, x: number): void {
  const st = app.session!.state;
  const list = tools();
  const vertical = L.land;
  const noNames = L.phone;
  const tw = vertical ? 76 : noNames ? 56 : 0;
  const face = (t: Tool, cost: string): void => {
    ui.style("tool-ico").label(TOOL_ICONS[t] ?? "🔨");
    if (!noNames) ui.style("tool-nm").label(toolName(t));
    if (cost) ui.style("tool-cost").label(cost);
  };
  const toolBtn = (t: Tool, i: number): void => {
    const def = t === "inspect" || t === "demolish" ? null : Rules.BUILDINGS[t];
    const afford = !def || Rules.canAfford(st, t);
    const cost = def ? costText(def.cost) : "";
    const s: ui.Style = {};
    if (tw) s.width = tw;
    const pressed = ui.style("tool", s).id(`tool-${t}`).button(`${toolName(t)}${cost ? ` (${cost})` : ""}, ${i + 1}`, {
      selected: app.tool === t, disabled: !afford, content: () => face(t, cost),
      tooltip: def ? Names.buildingDesc(t) : t === "inspect" ? T("Inspect tiles (I)") : T("Demolish (X) — half refund"),
    } as ui.ButtonOptions);
    if (pressed && fresh()) later(() => { sound("ui"); setTool(t); ui.setFocus(null); });
  };
  const maxW = L.lw - 16;
  ui.place("toolbox", { anchor: "top-start", x, y: vertical ? 104 : L.lh - (lastSize.get("toolbox")?.height ?? 70 * L.sc) / L.sc - 11 }, () => {
    let r: ui.Rect;
    if (vertical) {
      const maxH = Math.min(L.lh * 0.7, L.lh - 116);
      const prevIn = lastSize.get("toolbox-in");
      const scroll = !!prevIn && prevIn.height / L.sc > maxH;
      r = ui.column("toolbox-box", () => {
        const body = (): void => { lastSize.set("toolbox-in", ui.column("toolbox-in", () => list.forEach(toolBtn), { spacing: 7 })); };
        if (scroll) ui.scrollArea("toolbox-scroll", { width: tw + 14, height: maxH }, body);
        else body();
      }, { style: "toolbox", spacing: 0 });
    } else {
      // wrap rows within the window (phone portrait: icon tools wrap, centred)
      const unit = noNames ? 56 + 5 : 0;
      const perRow = noNames ? Math.max(1, Math.floor((maxW - 12 + 5) / unit)) : list.length;
      r = ui.column("toolbox-box", () => {
        for (let i = 0; i < list.length; i += perRow) {
          ui.row(`toolbox-r${i}`, () => list.slice(i, i + perRow).forEach((t, k) => toolBtn(t, i + k)), { spacing: noNames ? 5 : 7, justify: "center" });
        }
      }, { style: "toolbox", spacing: 5, align: "center" });
    }
    lastSize.set("toolbox", r);
  });
}
function toolName(t: Tool): string {
  return t === "inspect" ? T("Inspect") : t === "demolish" ? T("Demolish") : Names.buildingName(t);
}
/** #tutorial-card: the lesson step over the toolbox (at the top in short landscape). */
function tutorialCard(L: Layout, tbH: number): void {
  const t = app.tutorial;
  const step = t?.steps[t.idx];
  if (!t || !step) return;
  const w = Math.min(L.lw * 0.92, 480);
  const prev = lastSize.get("tutorial");
  const h = prev ? prev.height / L.sc : 90;
  const y = L.land ? 54 : L.lh - tbH - 22 - h - (L.phone ? 12 : 0);
  const x = L.land ? (L.lw - w) / 2 : (L.lw - w) / 2;
  ui.place("tutorial", { anchor: "top-start", x, y }, () => {
    lastSize.set("tutorial", ui.column("tutorial-card", () => {
      para(T("Lesson {n}/{total}", { n: t.idx + 1, total: t.steps.length }), w - 40, "lesson-h", "lesson-h");
      para(T(step.text), w - 40, "text", "lesson-text");
    }, { style: "tutorial", width: w, spacing: 4 }));
  });
}
/** The keyboard cursor's tile as a named area (the old board-sr mirror's role), and the playfield's name. */
function boardTargets(L: Layout): void {
  if (topOverlay()) return;
  const st = app.session!.state;
  const f = frame();
  const c = app.cursor;
  const p = render.project(c.x, c.y, { w: f.width, h: f.height });
  if (!p) return;
  const b = st.cells[c.y * st.grid.w + c.x];
  const terrain = T(Rules.TERRAIN_NAME[st.terrain[c.y * st.grid.w + c.x]!]!);
  const r = 18 * L.sc;
  ui.target(`${T("Settlement playfield")}. ${T("Cursor")}: ${T("Tile {x},{y}", { x: c.x, y: c.y })}, ${terrain}${b ? ", " + Names.buildingName(b.type) : ""}`,
    { x: p.x - r, y: p.y - r, width: 2 * r, height: 2 * r }, { role: "label" });
}

// ------------------------------------------------------------------ toast
function toastBox(L: Layout): void {
  const t = app.toast;
  if (!t) return;
  const w = Math.min(L.lw * 0.9, 560);
  const tbH = (lastSize.get("toolbox")?.height ?? 70 * L.sc) / L.sc;
  const bottom = app.screen === "game" && !L.land ? tbH + 50 : 24;
  const prev = lastSize.get("toast");
  const pw = prev ? prev.width / L.sc : w;
  const ph = prev ? prev.height / L.sc : 40;
  ui.place("toast", { anchor: "top-start", x: (L.lw - pw) / 2, y: L.lh - bottom - ph }, () => {
    const fits = textWidth(t.text, "toast-text") <= w - 34;
    lastSize.set("toast", ui.column("toast-box", () => para(t.text, w - 34, "toast-text", "toast-text"), { style: t.err ? "toast-err" : "toast", ...(fits ? {} : { width: w }) }));
  });
}

// ------------------------------------------------------------------ overlay panels (.screen.overlay > .panel)
function overlay(L: Layout): void {
  const o = topOverlay();
  if (!o) return;
  const wide = o !== "pause";
  const w = Math.min(wide ? 704 : 544, L.lw * (wide ? 0.94 : 0.92));
  const pad = L.lw < 500 ? 16 : 24;
  const inner = w - 2 * pad;
  const maxH = (L.land ? L.lh - 16 : Math.min(L.lh * 0.88, L.lh - 16)) - 2;
  const key = `panel-${o}`;
  const prev = lastSize.get(key);
  const scroll = !!prev && prev.height / L.sc + 40 > maxH;
  const opening = frame().frame - app.openedFrame <= 6;
  const isOpen = ui.dialog(panelLabel(o), "", true, () => {
    ui.column("panel", () => {
      const iw = inner - (scroll ? 14 : 0);
      const body = (): void => { lastSize.set(key, ui.column(`${key}-in`, () => buildPanel(o, iw), { spacing: 12, width: iw })); };
      if (scroll) ui.scrollArea(`${key}-scroll`, { width: inner + 6, height: maxH - 40 }, body, opening ? { scrollTo: { top: 0 } } : undefined);
      else body();
    }, { style: "panel", width: w, spacing: 0, padding: { top: 20, bottom: 20, start: pad, end: pad } });
  });
  if (!isOpen && fresh()) {
    // Escape / the backdrop: the pause panel resumes, the others close; results stay.
    if (o === "pause") later(resumeGame);
    else if (o !== "results") later(() => closeOverlay(o));
  }
}
function panelLabel(o: Overlay): string {
  switch (o) {
    case "pause": return T("Paused");
    case "results": return resultsHeading();
    case "settings": return T("Settings");
    case "help": return T("How to play");
    case "scores": return T("Scoreboards");
  }
}
function buildPanel(o: Overlay, w: number): void {
  switch (o) {
    case "pause": pausePanel(w); break;
    case "results": resultsPanel(w); break;
    case "settings": settingsPanel(w); break;
    case "help": helpPanel(w); break;
    case "scores": scoresPanel(w); break;
  }
}
function header(title: string, w: number, id: string, close: () => void): void {
  const cw = buttonWidth(T("✕ Close"), "btn-small");
  ui.row(`${id}-head`, () => {
    para(title, w - cw - 16, "h2", `${id}-h`);
    ui.spacer();
    button({ id: "btn-close", text: T("✕ Close"), style: "btn-small", act: close });
  }, { width: w, align: "center", spacing: 16 });
}
function pausePanel(w: number): void {
  para(T("Paused"), w, "h2", "pause-h");
  ui.column("pause-stack", () => {
    button({ id: "btn-resume-game", text: T("Resume"), style: "btn-primary", act: resumeGame, width: w });
    button({ id: "btn-pause-settings", text: T("Settings"), act: showSettings, width: w });
    button({ id: "btn-pause-help", text: T("Help"), act: showHelp, width: w });
    button({ id: "btn-restart", text: T("Restart scenario"), act: restart, width: w });
    button({ id: "btn-quit", text: T("Leave settlement"), style: "btn-danger", act: quitToTitle, width: w });
  }, { spacing: 10, width: w });
}
function resultsHeading(): string { return app.results?.won ? T("🎉 Charter fulfilled!") : T("⏳ Charter expired"); }
const REASONS: Record<string, string> = {
  "objectives-complete": N("Every objective complete — the settlement thrives."),
  "out-of-time": N("The charter ran out of days before objectives were met."),
};
const COMPONENTS: Record<string, string> = {
  population: N("Population"), wellbeing: N("Wellbeing"), trade: N("Trade"), treasury: N("Treasury"), services: N("Service balance"), swiftness: N("Swiftness bonus"),
};
function resultsPanel(w: number): void {
  const r = app.results;
  if (!r) return;
  para(resultsHeading(), w, "h2", "results-heading");
  const why = r.state.endReason && REASONS[r.state.endReason] ? T(REASONS[r.state.endReason]!) : "";
  if (why) para(why, w, "dim", "results-sub");
  ui.column("score-breakdown", () => {
    for (const k of Object.keys(r.score.components)) {
      ui.row(`score-${k}`, () => {
        ui.style("score-k").label(COMPONENTS[k] ? T(COMPONENTS[k]!) : k);
        ui.spacer();
        ui.style("score-v").label(String(r.score.components[k]));
      }, { style: "score-row", width: w, align: "center" });
    }
    ui.row("score-total", () => {
      ui.style("total-k").label(T("Total"));
      ui.spacer();
      ui.style("total-v").id("score-total-v").label(String(r.score.total));
    }, { style: "total-row", width: w, align: "center" });
  }, { spacing: 5, width: w });
  if (r.newAchievements.length) {
    ui.column("results-achievements", () => {
      r.newAchievements.forEach((a, i) => ui.row(`ach-${i}`, () => ui.style("ach-text").label(`🏅 ${T(a.name)}`), { style: "ach-badge" }));
    }, { spacing: 6, width: w });
  }
  if (r.rankInfo) para(r.rankInfo(), w, "dim", "results-compare");
  const lb = lbText();
  if (lb) para(lb, w, "dim", "results-lb");
  const acts: Btn[] = [{ id: "btn-retry", text: T("Retry"), style: "btn-primary", act: restart }];
  if (r.won && r.nextAvailable) acts.push({ id: "btn-next", text: T("Next stage →"), act: nextStage });
  acts.push({ id: "btn-results-scores", text: T("Scoreboard"), act: showScores });
  acts.push({ id: "btn-results-home", text: T("Home"), act: quitToTitle });
  flow("results-actions", acts, w, 8);
}

// --- settings (what the runtime's Options do not cover) --------------------------------------
const PALETTES = ["default", "deuteranopia", "protanopia", "tritanopia"];
const PALETTE_NAMES = [N("Default"), N("Deuteranopia-safe"), N("Protanopia-safe"), N("Tritanopia-safe")];
function settingsPanel(w: number): void {
  header(T("Settings"), w, "settings", () => closeOverlay("settings"));
  const o = platform.options();
  group("set-runtime", T("Audio"), w, (iw) => {
    para(T("Volumes, mute, graphics quality, language, larger text, high contrast and reduced motion are in the StarHermit Options."), iw, "dim", "options-note");
    flow("set-runtime-row", [
      { id: "btn-options", text: T("Open Options"), act: () => openMenu() },
      { id: "btn-rebind", text: T("Key bindings"), act: () => requestRebind() },
    ], iw, 8);
  });
  group("set-display", T("Display & motion"), w, (iw) => {
    selectRow("set-palette", T("Color palette"), PALETTES.indexOf(o.colorPalette), PALETTE_NAMES.map((n) => T(n)), iw, (i) => platform.setOption("colorPalette", PALETTES[i]));
    toggleRow("set-shake", T("Camera shake"), o.cameraShake !== false, iw, (v) => platform.setOption("cameraShake", v));
  });
  group("set-access", T("Accessibility & controls"), w, (iw) => {
    selectRow("set-daylen", T("Day length (timing assistance)"), o.dayLength === "relaxed" ? 1 : 0, [T("Normal"), T("Relaxed (slower days)")], iw,
      (i) => platform.setOption("dayLength", i === 1 ? "relaxed" : "normal"));
    toggleRow("set-left", T("Left-handed layout"), !!o.leftHanded, iw, (v) => platform.setOption("leftHanded", v));
    toggleRow("set-haptics", T("Haptics"), o.haptics !== false, iw, (v) => platform.setOption("haptics", v));
    button({ id: "btn-replay", text: T("Replay tutorials"), act: replayTutorials });
  });
}
function group(id: string, title: string, w: number, build: (iw: number) => void): void {
  ui.column(id, () => { para(title, w, "h3-accent", `${id}-h`); build(w); }, { style: "set-group", width: w, spacing: 8 });
}
function selectRow(id: string, label: string, idx: number, names: string[], w: number, set: (i: number) => void): void {
  const sw = Math.min(w * 0.5, 240);
  ui.row(`${id}-row`, () => {
    para(label, w - sw - 16, "text", `${id}-label`);
    ui.spacer();
    const pick = ui.id(id).select(label, Math.max(0, idx), names, { width: sw } as ui.WidgetOptions);
    if (pick !== Math.max(0, idx)) later(() => set(pick));
  }, { width: w, align: "center", spacing: 8 });
}
/** A check box row (a role "checkbox" widget: built-in check box labels don't wrap). */
function toggleRow(id: string, label: string, on: boolean, w: number, set: (v: boolean) => void): void {
  ui.row(`${id}-row`, () => {
    para(label, w - 60, "text", `${id}-label`);
    ui.spacer();
    const res = ui.id(id).widget(label, {
      role: "checkbox", checked: on, size: { width: 44, height: 44 },
      draw: (r, st) => {
        const s = st.scale, box = 22 * s, bx = r.x + (r.width - box) / 2, by = r.y + (r.height - box) / 2;
        draw.roundRect(bx, by, box, box, 4, on ? token("accent") : token("panel-2"));
        draw.strokeRoundRect(bx, by, box, box, 4, "#8a9a8e", 2);
        if (on) draw.text("✓", bx + box / 2, by + 1 * s, { size: 17 * s, color: "#231a00", align: "center", weight: "bold" });
      },
    });
    if (res.activated && fresh()) later(() => set(!on));
  }, { width: w, align: "center", spacing: 8, height: 44 });
}

// --- help (ui.js helpContent) ------------------------------------------------------------------
const GLYPH: Record<string, string> = { "Arrow Up": "↑", "Arrow Down": "↓", "Arrow Left": "←", "Arrow Right": "→", Escape: "Esc", "Numpad Enter": "Num Enter" };
function keysFor(action: string): string {
  let list: string[] = [];
  try { list = bindings(action).filter((b) => b.device === "keyboard").map((b) => GLYPH[b.label] ?? b.label); } catch { /* not yet */ }
  return list[0] ?? "";
}
/** The old **bold** and [[key]] markup as plain text. */
const plain = (s: string): string => s.replace(/\*\*(.+?)\*\*/g, "$1").replace(/\[\[(.+?)\]\]/g, "[$1]");
function helpPanel(w: number): void {
  header(T("How to play"), w, "help", () => closeOverlay("help"));
  const card = (id: string, text: string): void => {
    ui.column(id, () => para(text, w - 28, "text", `${id}-p`), { style: "rule-card", width: w });
  };
  para(T("Goal"), w, "h3-accent", "help-goal");
  card("help-g1", plain(T("Grow your settlement to meet the charter objectives before the final day. Residents move into **happy** homes and leave unhappy ones.")));
  card("help-g2", plain(T("A happy home has three things: a **road** connected to the Village Hall, **water** from a Well within 2 tiles, and **food** in the town stockpile. A nearby Market adds comfort and tax income.")));
  para(T("Buildings"), w, "h3-accent", "help-buildings");
  for (const t of Rules.BUILD_ORDER) card(`help-b-${t}`, `${TOOL_ICONS[t]} ${Names.buildingName(t)} (${costText(Rules.BUILDINGS[t].cost)}) — ${Names.buildingDesc(t)}`);
  para(T("Trade orders"), w, "h3-accent", "help-orders");
  card("help-o", T("Every few days a trade order arrives: deliver the requested goods before it expires to earn coins. Coins fund expansion."));
  para(T("Controls"), w, "h3-accent", "help-controls");
  card("help-c1", T("Pointer/touch: pick a tool, tap a tile. Drag pans the map, scroll zooms."));
  card("help-c2", plain(T("Keyboard: arrows move the cursor, [[{confirm}]] build/inspect, [[{cancel}]] cancel or pause, [[{undo}]] undo, [[{hint}]] hint, [[{speed}]] change speed, [[{camera}]] reset camera, [[1–7]] tools.", {
    confirm: keysFor("confirm"), cancel: keysFor("pause"), undo: keysFor("undo"), hint: keysFor("hint"), speed: keysFor("speed"), camera: keysFor("camera"),
  })));
  card("help-c3", T("Gamepad: stick/d-pad moves the cursor, A confirms, B cancels, Start pauses."));
}

// --- scoreboards ---------------------------------------------------------------------------------
function scoresPanel(w: number): void {
  header(T("Scoreboards"), w, "scores", () => closeOverlay("scores"));
  const tabs: ["global" | "daily" | "friends", string][] = [["global", T("Global")], ["daily", T("Daily")], ["friends", T("Friends")]];
  ui.row("tabs", () => {
    for (const [id, name] of tabs) {
      button({ id: `tab-${id}`, text: name, style: "tab", selected: app.boardTab === id, act: () => renderBoard(id) });
    }
  }, { spacing: 6, role: "radiogroup" } as ui.Layout);
  const b = app.board;
  ui.column("scores-list", () => {
    if (!b || !b.rows.length) { para(T("No scores yet — be the first!"), w, "dim", "scores-empty"); return; }
    b.rows.forEach((e, i) => {
      const parts = [`#${e.rank ?? i + 1}`, `${e.name} — ${e.score}`];
      if (e.meta) parts.push(`(${e.meta})`);
      para(parts.join(" "), w, e.me ? "me" : "text", `score-row-${i}`);
    });
  }, { spacing: 5, width: w });
  if (b?.note) para(b.note, w, "dim", "scores-note");
}

