// Settlement Trails localization core.
//
// Every player-facing string is authored in US English and looked up by that
// English text: T('Play') → the current locale's translation (en-US is the
// key itself). Placeholders use {name}. N('…') marks a string for extraction
// without translating it at that point (the caller translates at display time).
//
// The locale is the StarHermit runtime's interface language (the player's
// Options › Language, else the account's preferred language, else the
// device's), matched to the nine supported locales; a change notifies
// onLanguage listeners (the engine client draws every string through T() each
// frame, so it simply shows on the next one).

import { matchLocale } from './sh-strings.js';
import EN_GB from './locales/en-GB.js';
import { ES_419, ES_ES } from './locales/es.js';
import DE_DE from './locales/de.js';
import { FR_FR, FR_CA } from './locales/fr.js';
import PT_BR from './locales/pt.js';
import IT_IT from './locales/it.js';

export const LOCALES = ['en-US', 'en-GB', 'es-419', 'es-ES', 'de-DE', 'fr-FR', 'fr-CA', 'pt-BR', 'it-IT'];

/** Locale → { English key: translation }. en-US is the identity; en-GB lists spelling changes. */
export const DICTS = {
  'en-US': {},
  'en-GB': EN_GB,
  'es-419': ES_419,
  'es-ES': { ...ES_419, ...ES_ES },
  'de-DE': DE_DE,
  'fr-FR': FR_FR,
  'fr-CA': { ...FR_FR, ...FR_CA },
  'pt-BR': PT_BR,
  'it-IT': IT_IT,
};

let lang = 'en-US';
let dict = DICTS[lang];
const listeners = new Set();
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

export function fmt(s, vars) {
  return String(s).replace(/\{(\w+)\}/g, (m, k) => (vars && vars[k] != null ? String(vars[k]) : m));
}

/** Translate an English source string (unknown strings, e.g. player names, pass through). */
export function T(key, vars) {
  if (key == null) return '';
  const s = String(key);
  const out = has(dict, s) ? dict[s] : s;
  return vars ? fmt(out, vars) : out;
}

/** Mark a string for extraction; translated later with T(). */
export const N = (key) => key;

export function getLang() { return lang; }

export function onLanguage(fn) { listeners.add(fn); return () => listeners.delete(fn); }

export function setLocale(next) {
  const m = matchLocale(next);
  const resolved = DICTS[m] ? m : 'en-US';
  const changed = resolved !== lang;
  lang = resolved;
  dict = DICTS[lang];
  if (changed) for (const fn of [...listeners]) { try { fn(lang); } catch (e) { console.error(e); } }
  return lang;
}
