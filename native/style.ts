// The look of the HUD, rails, toolbox and panels: the browser build's
// css/style.css, rewritten class-based in tools/ui-style.css and converted
// once with `starhermit css` into assets/ui-style.json (`npm run css`),
// registered at start with the theme the runtime's own widgets (scroll bars,
// focus rings, selects) take. The runtime's high contrast option is the old
// html[data-contrast="high"] token set.
import { files } from "starhermit:engine";
import * as ui from "starhermit:ui";

type Tokens = Record<string, string>;
const BASE: Tokens = {
  bg: "#1c2a22", panel: "#24352b", "panel-2": "#2c4134", ink: "#f2ede0", "ink-dim": "#b8c2ae",
  accent: "#ffd54a", "accent-2": "#7cfc7a", danger: "#ff6a5a", "accent-ink": "#231a00", hover: "#37503f", line: "#ffffff24",
};
/** html[data-contrast="high"]: black panels, white ink, a brighter accent and stronger edges. */
const CONTRAST: Tokens = {
  bg: "#000000", panel: "#101810", "panel-2": "#1a241a", ink: "#ffffff", "ink-dim": "#e0e0e0", accent: "#ffe600", line: "#ffffffaa",
};

let current: Tokens = { ...BASE };
export function initStyles(): void {
  const css = files.readJson("assets/ui-style.json") as unknown as ui.CssStyles;
  ui.setFont({ family: "sans-serif" });
  ui.setTheme({
    fontSize: 16, smallSize: 13.6, headingSize: 24, padding: 8, spacing: 8, radius: 10,
    text: BASE.ink!, muted: BASE["ink-dim"]!, panel: BASE.panel!, control: BASE["panel-2"]!, hovered: BASE.hover!,
    pressed: "#3d5342", field: BASE["panel-2"]!, accent: BASE.accent!, focus: BASE.accent!, outline: "#5a6b5e",
  });
  ui.setTokens(css.tokens);
  ui.setStyles({
    ...css.styles,
    label: { text: { color: "$ink" } },
    paragraph: { text: { color: "$ink" } },
    heading: { text: { color: "$ink" } },
    widget: { focusRing: { color: "$accent", width: 3, offset: 2 } },
    scrollArea: { parts: { bar: { background: "#5a6b5e", radius: 4 } } },
    tooltip: { background: "$panel", text: { color: "$ink" }, radius: 6, padding: 6 },
    // .screen.overlay: rgba(8, 14, 10, 0.72) behind the panels.
    dialog: { background: "#00000000", padding: 0, parts: { backdrop: { background: "#080e0ab8" } } },
  });
  key = "";
  applyTokens(false);
}

let key = "";
/** The base or high-contrast tokens (cheap when unchanged). */
export function applyTokens(highContrast: boolean): void {
  const k = String(highContrast);
  if (k === key) return;
  key = k;
  current = { ...BASE, ...(highContrast ? CONTRAST : {}) };
  ui.setTokens(current);
  ui.setTheme({
    text: current.ink!, muted: current["ink-dim"]!, panel: current.panel!, control: current["panel-2"]!, hovered: current.hover!,
    field: current["panel-2"]!, accent: current.accent!, focus: current.accent!,
  });
}
/** A token's current colour (for draw calls, which take real colours). */
export function token(name: string): string { return current[name] ?? "#000000"; }
