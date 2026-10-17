// names.js — display text for content and simulation records in the current
// language. Content definitions and rule events keep their stable English
// text (it feeds replays, hashes and saves); the UI translates at display time.

import { T, N } from './i18n.js';
import { BUILDINGS, INVALID_REASONS } from './rules.js';

const STAGE_RE = /^(Mastery: )?(First Trails|Fresh Water|Harvest|Timber|Market Day) (\d+)$/;
const STAGE_BASES = [N('First Trails'), N('Fresh Water'), N('Harvest'), N('Timber'), N('Market Day')];
const MASTERY_TAIL = ' Prove your mastery under tighter limits.';
const PRACTICE_LEVELS = { relaxed: N('Relaxed'), normal: N('Normal'), hard: N('Hard') };

/** A content definition's display name (journey, learn, daily, practice, challenge). */
export function contentName(def, { bare = false } = {}) {
  const name = String(def?.name || '');
  const st = STAGE_RE.exec(name);
  if (st) {
    const base = `${T(st[2])} ${st[3]}`;
    return st[1] && !bare ? T('Mastery: {name}', { name: base }) : base;
  }
  const daily = /^Daily Trail — (.+)$/.exec(name);
  if (daily) return T('Daily Trail — {date}', { date: daily[1] });
  const practice = /^Practice \((\w+)\)$/.exec(name);
  if (practice) return T('Practice ({level})', { level: practiceLevel(practice[1]) });
  return T(name);
}

export function practiceLevel(level) {
  return PRACTICE_LEVELS[level] ? T(PRACTICE_LEVELS[level]) : level;
}

/** A content definition's blurb; mastery stages append a fixed sentence. */
export function contentBlurb(def) {
  const b = String(def?.blurb || '');
  if (!b) return '';
  if (b.endsWith(MASTERY_TAIL)) return `${T(b.slice(0, -MASTERY_TAIL.length))} ${T(MASTERY_TAIL.trim())}`;
  return T(b);
}

export function buildingName(type) { return BUILDINGS[type] ? T(BUILDINGS[type].name) : type; }
export function buildingDesc(type) { return BUILDINGS[type] ? T(BUILDINGS[type].desc) : ''; }
export function invalidText(reason) { return INVALID_REASONS[reason] ? T(INVALID_REASONS[reason]) : T('Invalid action.'); }

const RES = { food: N('food'), wood: N('wood'), coins: N('coins') };

/** A rule event's log/toast text in the current language (falls back to the English text). */
export function eventText(ev) {
  switch (ev.kind) {
    case 'start': return T('Settlement founded.');
    case 'invalid': return invalidText(ev.reason);
    case 'place': return T('{building} built.', { building: buildingName(ev.building) });
    case 'demolish': return T('{building} demolished (half refund).', { building: buildingName(ev.building) });
    case 'fulfill': return T('Trade order complete: +{n} coins.', { n: ev.reward });
    case 'leave': return T('A resident left an unhappy home.');
    case 'expired': return T('A trade order expired.');
    case 'order': {
      const m = /^New trade order: (\d+) (\w+) for (\d+) coins\.$/.exec(ev.text || '');
      if (m) return T('New trade order: {n} {res} for {reward} coins.', { n: m[1], res: RES[m[2]] ? T(RES[m[2]]) : m[2], reward: m[3] });
      break;
    }
    case 'produce': return T('Day {day}: +{food} food, +{wood} wood, +{coins} coin taxes.', { day: ev.tick, food: ev.food, wood: ev.wood, coins: ev.coins });
    case 'shortage': return T('Food shortage! Residents are going hungry.');
    case 'won': return T('All objectives complete!');
    case 'lost': return T('The charter expired before objectives were met.');
    default: break;
  }
  return T(ev.text || '');
}
