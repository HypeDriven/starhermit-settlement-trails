// Localization: the browser build's tables (js/i18n.js with js/locales/*,
// English text as the keys, the nine StarHermit locales; the account strings
// in js/sh-strings.js) in the interface language the runtime reports
// (preferences().language: the player's choice in Options › Language, else
// the account's preferred language or the device's). The runtime's Options
// replace the game's own Language setting (sh-language.js) and the DOM
// re-labelling: every string is drawn through T() each frame, so a change
// shows on the next frame and never restarts the settlement.
import { onPreferencesChange, preferences } from "starhermit:engine";
import * as ui from "starhermit:ui";
import { T as tr, N as n, setLocale, getLang } from "../js/i18n.js";
import { shStrings } from "../js/sh-strings.js";

let locale = "";
function apply(tag: string): void {
  const next = setLocale(String(tag || "en-US")) as string;
  if (next === locale) return;
  locale = next;
  ui.setLanguage(locale);
}
apply(preferences().language);
onPreferencesChange((p) => apply(p.language));

export function currentLocale(): string { return locale || (getLang() as string); }
export type Vars = Record<string, string | number>;
/** An English source string in the player's language; `{name}` placeholders from vars. */
export function T(key: string, vars?: Vars | null): string { return tr(key, vars ?? undefined) as string; }
/** Marks an English key that is translated with T() where it is shown. */
export const N = (s: string): string => n(s) as string;
type ShKey = "signIn" | "invite" | "copied" | "copyFailed" | "signedOut" | "lbPosting" | "lbRank" | "lbPosted" | "lbNotPosted";
/** The account strings (sign-in, invite, sign-out notice, score posting). */
export function S(key: ShKey, vars?: Vars): string {
  const s = (shStrings(currentLocale()) as Record<string, string>)[key] ?? key;
  return vars ? s.replace(/\{(\w+)\}/g, (m, k: string) => (vars[k] != null ? String(vars[k]) : m)) : s;
}
