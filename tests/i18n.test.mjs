// Every player-facing string exists in all nine locales (node --test).
// Keys are the US-English source strings: literal T('…') / N('…') calls in
// src/, data-i18n markup in index.html, and the display fields of the content
// and rules tables (lessons, challenges, buildings, rejections, achievements).
import test from 'node:test';
import assert from 'node:assert/strict';
import { DICTS, LOCALES, T, setLocale, getLang } from '../js/i18n.js';
import { shStrings } from '../js/sh-strings.js';
import { contentName, contentBlurb, eventText } from '../js/names.js';
import { JOURNEY_STAGES, dailyContent, practiceContent } from '../js/content.js';
import { ALL } from './i18n-keys.mjs';

const placeholders = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');

test('the key set is non-trivial', () => {
  assert.ok(ALL.size > 200, `only ${ALL.size} keys found`);
});

for (const locale of LOCALES.filter((l) => l !== 'en-US' && l !== 'en-GB')) {
  test(`${locale}: every key is translated with the same placeholders`, () => {
    const dict = DICTS[locale];
    const missing = [...ALL].filter((k) => !Object.prototype.hasOwnProperty.call(dict, k));
    assert.deepEqual(missing, [], `${missing.length} missing in ${locale}`);
    const bad = [...ALL].filter((k) => placeholders(dict[k]) !== placeholders(k));
    assert.deepEqual(bad, [], `placeholder mismatch in ${locale}`);
  });
}

test('no locale carries keys that no longer exist', () => {
  for (const locale of LOCALES) {
    const stray = Object.keys(DICTS[locale]).filter((k) => !ALL.has(k));
    assert.deepEqual(stray, [], locale);
  }
});

test('T falls back to the key and fills placeholders; regional dictionaries inherit', () => {
  setLocale('de-DE');
  assert.equal(getLang(), 'de-DE');
  assert.equal(T('Not a real key {x}', { x: 1 }), 'Not a real key 1');
  assert.equal(T('Paused'), 'Pausiert');
  setLocale('fr-CA');
  assert.equal(T('Paused'), 'En pause'); // inherited from fr-FR
  setLocale('xx-YY');
  assert.equal(getLang(), 'en-US');
  assert.equal(T('Paused'), 'Paused');
});

test('StarHermit chrome strings follow the game language', () => {
  assert.notEqual(shStrings('it-IT').signIn, 'Sign in with StarHermit');
  assert.equal(shStrings('en-US').signIn, 'Sign in with StarHermit');
});

test('composed content names, blurbs and rule events translate', () => {
  setLocale('de-DE');
  assert.equal(contentName(JOURNEY_STAGES[0]), 'Erste Pfade 1');
  assert.equal(contentName(JOURNEY_STAGES[9]), 'Meisterprüfung: Ernte 10');
  assert.equal(contentName(JOURNEY_STAGES[9], { bare: true }), 'Ernte 10');
  assert.ok(contentBlurb(JOURNEY_STAGES[9]).endsWith('Beweise dein Können unter strengeren Vorgaben.'));
  assert.equal(contentName(dailyContent('2026-10-17')), 'Tagespfad – 2026-10-17');
  assert.equal(contentName(practiceContent('hard', 1)), 'Übung (Schwer)');
  assert.equal(eventText({ kind: 'order', text: 'New trade order: 6 food for 30 coins.' }), 'Neuer Handelsauftrag: 6 Nahrung für 30 Münzen.');
  assert.equal(eventText({ kind: 'place', building: 'well', text: 'Well built.' }), 'Brunnen gebaut.');
  assert.equal(eventText({ kind: 'produce', tick: 3, food: 4, wood: 1, coins: 2 }), 'Tag 3: +4 Nahrung, +1 Holz, +2 Münzen Steuern.');
  setLocale('en-US');
  assert.equal(contentName(JOURNEY_STAGES[9]), 'Mastery: Harvest 10');
});
