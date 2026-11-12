// Run: node tests/parse.test.mjs
import assert from 'node:assert/strict';
import {
  parseQuickAdd, nextOccurrence, describeRecurrence, formatDue, formatDateLong,
  parseDateText, matchesFilter, validateFilter, toDateStr, fromDateStr, addDays, todayStr,
} from '../js/parse.js';

// Reference "now": Thursday 2026-11-12 10:00 local time.
const NOW = new Date(2026, 10, 12, 10, 0);
const PROJECTS = [
  { id: 'p-werk', name: 'Werk' },
  { id: 'p-cp', name: 'Click Pax' },
  { id: 'p-sport', name: 'Sport' },
  { id: 'p-huis', name: 'Huishouden' },
  { id: 'p-hobby', name: 'Hobby' },
];
const LABELS = ['klant', 'Wachten op', 'urgent'];
const ctx = { now: NOW, projects: PROJECTS, labels: LABELS };
const P = (s, c = {}) => parseQuickAdd(s, { ...ctx, ...c });

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (e) { failed++; console.error(`FAIL ${name}\n  ${e.message.split('\n').join('\n  ')}`); }
}
/** Check a subset of fields on the parse result. */
function q(input, expect, c) {
  test(`quickadd: ${input}`, () => {
    const r = P(input, c);
    for (const [k, v] of Object.entries(expect)) {
      if (k === 'rec') {
        if (v === null) assert.equal(r.recurrence, null, 'recurrence');
        else for (const [rk, rv] of Object.entries(v)) assert.deepEqual(r.recurrence && r.recurrence[rk], rv, `recurrence.${rk}`);
      } else if (k === 'projectId') assert.equal(r.project && r.project.id, v, 'project');
      else assert.deepEqual(r[k], v, k);
    }
    // invariants: tokens sorted, non-overlapping, text matches original
    for (let i = 0; i < r.tokens.length; i++) {
      const t = r.tokens[i];
      assert.equal(input.slice(t.start, t.end), t.text, 'token text');
      if (i) assert.ok(t.start >= r.tokens[i - 1].end, 'tokens overlap / unsorted');
    }
  });
}

/* ---------------- helpers ---------------- */
test('toDateStr/fromDateStr', () => {
  assert.equal(toDateStr(new Date(2026, 0, 5, 23, 59)), '2026-01-05');
  const d = fromDateStr('2026-03-29');
  assert.equal(d.getHours(), 0); assert.equal(d.getDate(), 29);
  assert.equal(todayStr(NOW), '2026-11-12');
});
test('addDays', () => {
  assert.equal(addDays('2026-11-12', 1), '2026-11-13');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(addDays('2026-03-28', 2), '2026-03-30'); // across DST
  assert.equal(addDays('2026-10-24', 2), '2026-10-26'); // across DST
});

/* ---------------- spec examples ---------------- */
q('Offerte sturen vrijdag 9u #werk p1 @klant', {
  title: 'Offerte sturen', due_date: '2026-11-13', due_time: '09:00', priority: 1, projectId: 'p-werk', labels: ['klant'], new_project: null,
});
q('Lotte bellen morgen', { title: 'Lotte bellen', due_date: '2026-11-13', due_time: null });
// Documented choice: weekly days include today even if the time already passed.
q('Hardlopen elke ma en do om 7:30 #sport', {
  title: 'Hardlopen', due_date: '2026-11-12', due_time: '07:30', projectId: 'p-sport',
  rec: { freq: 'week', interval: 1, days: [1, 4], text: 'elke week op maandag en donderdag' },
});
q('Huur betalen elke 1e', { title: 'Huur betalen', due_date: '2026-12-01', rec: { freq: 'month', monthday: 1, interval: 1 } });
q('Boek lezen', { title: 'Boek lezen', tokens: [], due_date: null, priority: null, project: null });
q('Bel om 3 klanten', { title: 'Bel om 3 klanten', due_time: null, due_date: null, tokens: [] });
q('Rapport afmaken {vrijdag}', { title: 'Rapport afmaken', deadline: '2026-11-13', due_date: null });
q('Verjaardag Lotte 14 nov elk jaar', { title: 'Verjaardag Lotte', due_date: '2026-11-14', rec: { freq: 'year', interval: 1, text: 'elk jaar' } });
q('Ticket boeken voor 3 december', { title: 'Ticket boeken', due_date: '2026-12-03' });
q('Tweede kamer verkiezing', { title: 'Tweede kamer verkiezing', due_date: null, tokens: [] });
q('Werk aan project #Click Pax', { title: 'Werk aan project', projectId: 'p-cp' });

/* ---------------- relative dates ---------------- */
q('Iets vandaag', { title: 'Iets', due_date: '2026-11-12' });
q('Iets VANDAAG', { title: 'Iets', due_date: '2026-11-12' });
q('Iets overmorgen', { title: 'Iets', due_date: '2026-11-14' });
q('Iets vanavond', { title: 'Iets', due_date: '2026-11-12', due_time: '19:00' });
q('Iets vanavond om 21u', { title: 'Iets', due_date: '2026-11-12', due_time: '21:00' });
q('Iets morgenochtend', { title: 'Iets', due_date: '2026-11-13', due_time: '09:00' });
q('Iets morgenmiddag', { title: 'Iets', due_date: '2026-11-13', due_time: '13:00' });
q('Iets morgenavond', { title: 'Iets', due_date: '2026-11-13', due_time: '19:00' });
q('Iets morgen avond', { title: 'Iets', due_date: '2026-11-13', due_time: '19:00' });
q('Iets morgen om 9:30', { title: 'Iets', due_date: '2026-11-13', due_time: '09:30' });
q('Something today', { title: 'Something', due_date: '2026-11-12' });
q('Something tomorrow', { title: 'Something', due_date: '2026-11-13' });
q('Something next week', { title: 'Something', due_date: '2026-11-16' });

/* ---------------- weekdays ---------------- */
q('Iets maandag', { title: 'Iets', due_date: '2026-11-16' });
q('Iets donderdag', { title: 'Iets', due_date: '2026-11-12' }); // same weekday = today
q('Iets woensdag', { title: 'Iets', due_date: '2026-11-18' });
q('Iets zondag', { title: 'Iets', due_date: '2026-11-15' });
q('Iets volgende maandag', { title: 'Iets', due_date: '2026-11-16' });
q('Iets volgende vrijdag', { title: 'Iets', due_date: '2026-11-20' }); // Friday of next week
q('Iets volgende donderdag', { title: 'Iets', due_date: '2026-11-19' });
q('Iets op vrijdag', { title: 'Iets', due_date: '2026-11-13' });
q('Iets op vr', { title: 'Iets', due_date: '2026-11-13' });
q('Iets op ma', { title: 'Iets', due_date: '2026-11-16' });
q('Iets vrijdagmiddag', { title: 'Iets', due_date: '2026-11-13', due_time: '13:00' });
q('Something friday', { title: 'Something', due_date: '2026-11-13' });
q('Something on monday', { title: 'Something', due_date: '2026-11-16' });
q('Op maandag bellen met Jan', { title: 'Bellen met Jan', due_date: '2026-11-16' });
q('Zomaar iets doen', { title: 'Zomaar iets doen', due_date: null, tokens: [] });
q('Ma bellen', { title: 'Ma bellen', due_date: null });   // "ma" (mother) not a weekday
q('Ik doe het zo', { title: 'Ik doe het zo', due_date: null });
q('Doe het op zo’n manier', { title: 'Doe het op zo’n manier', due_date: null });
q('Maandag-overleg voorbereiden', { title: 'Maandag-overleg voorbereiden', due_date: null });
q('Vrijdagmiddagborrel regelen', { title: 'Vrijdagmiddagborrel regelen', due_date: null });
q('Morgenster lezen', { title: 'Morgenster lezen', due_date: null });

/* ---------------- periods ---------------- */
q('Iets volgende week', { title: 'Iets', due_date: '2026-11-16' });
q('Iets dit weekend', { title: 'Iets', due_date: '2026-11-14' });
q('Iets weekend', { title: 'Iets', due_date: '2026-11-14' });
q('Iets volgend weekend', { title: 'Iets', due_date: '2026-11-21' });
q('Iets volgende maand', { title: 'Iets', due_date: '2026-12-01' });
q('Iets over 3 dagen', { title: 'Iets', due_date: '2026-11-15' });
q('Iets over 2 weken', { title: 'Iets', due_date: '2026-11-26' });
q('Iets over een week', { title: 'Iets', due_date: '2026-11-19' });
q('Iets over 1 maand', { title: 'Iets', due_date: '2026-12-12' });
q('Iets over drie dagen', { title: 'Iets', due_date: '2026-11-15' });
q('Something in 3 days', { title: 'Something', due_date: '2026-11-15' });
q('Iets eind van de maand', { title: 'Iets', due_date: '2026-11-30' });
q('Iets einde maand', { title: 'Iets', due_date: '2026-11-30' });
q('Iets eind van de week', { title: 'Iets', due_date: '2026-11-13' });
q('Iets eind van de maand', { title: 'Iets', due_date: '2027-01-31' }, { now: new Date(2027, 0, 3, 9) });

/* ---------------- explicit dates ---------------- */
q('Iets 14 nov', { title: 'Iets', due_date: '2026-11-14' });
q('Iets 14 november', { title: 'Iets', due_date: '2026-11-14' });
q('Iets 14 nov.', { title: 'Iets', due_date: '2026-11-14' });
q('Iets 14-11', { title: 'Iets', due_date: '2026-11-14' });
q('Iets 14/11', { title: 'Iets', due_date: '2026-11-14' });
q('Iets 14-11-2026', { title: 'Iets', due_date: '2026-11-14' });
q('Iets 14/11/27', { title: 'Iets', due_date: '2027-11-14' });
q('Iets 14 nov 2027', { title: 'Iets', due_date: '2027-11-14' });
q('Iets 2026-11-14', { title: 'Iets', due_date: '2026-11-14' });
q('Iets 3 januari', { title: 'Iets', due_date: '2027-01-03' }); // passed -> next year
q('Iets 1 nov', { title: 'Iets', due_date: '2027-11-01' });
q('Iets 12 nov', { title: 'Iets', due_date: '2026-11-12' }); // today is not "passed"
q('Iets 5 mei', { title: 'Iets', due_date: '2027-05-05' });
q('Iets 1e december', { title: 'Iets', due_date: '2026-12-01' });
q('Iets op 3 december', { title: 'Iets', due_date: '2026-12-03' });
q('Iets 31-02', { title: 'Iets 31-02', due_date: null });   // invalid date stays text
q('Iets 32 nov', { title: 'Iets 32 nov', due_date: null });
q('Bel 3 Jan', { title: 'Bel 3 Jan', due_date: null });   // "Jan" is a name
q('Iets 29 feb', { title: 'Iets', due_date: '2028-02-29' });
q('Versie 2.10 testen', { title: 'Versie 2.10 testen', due_date: null, due_time: null });
q('Score 3-2 morgen bespreken', { title: 'Score 3-2 bespreken', due_date: '2026-11-13' }); // relative beats numeric

/* ---------------- times ---------------- */
q('Iets om 9', { title: 'Iets', due_date: '2026-11-13', due_time: '09:00' }); // 09:00 already passed -> tomorrow
q('Iets om 9u', { due_time: '09:00', due_date: '2026-11-13' });
q('Iets 9u', { title: 'Iets', due_time: '09:00' });
q('Iets 9:30', { title: 'Iets', due_time: '09:30', due_date: '2026-11-13' });
q('Iets 09:30', { title: 'Iets', due_time: '09:30' });
q('Iets om 14:00', { title: 'Iets', due_time: '14:00', due_date: '2026-11-12' }); // still ahead -> today
q('Iets om 14.30', { title: 'Iets', due_time: '14:30' });
q('Iets 14.30', { title: 'Iets 14.30', due_time: null });
q('Iets 5pm', { title: 'Iets', due_time: '17:00', due_date: '2026-11-12' });
q('Iets 9am', { title: 'Iets', due_time: '09:00' });
q('Iets 12am', { due_time: '00:00' });
q('Iets 12pm', { due_time: '12:00' });
q('Iets om 9u30', { title: 'Iets', due_time: '09:30' });
q('Iets om 10 uur', { title: 'Iets', due_time: '10:00', due_date: '2026-11-13' }); // 10:00 == now -> tomorrow
q('Iets om 3u', { title: 'Iets', due_time: '03:00' });
q('Iets om 25:00', { due_time: null });
q('Koop 9 appels', { title: 'Koop 9 appels', due_time: null });
q('Iets om 8 morgen', { title: 'Iets', due_date: '2026-11-13', due_time: '08:00' });
q('Vergadering 9:30-10:30', { title: 'Vergadering 9:30-10:30', due_time: null });

/* ---------------- recurrence ---------------- */
q('Vitamine elke dag', { title: 'Vitamine', due_date: '2026-11-12', rec: { freq: 'day', interval: 1, text: 'elke dag' } });
q('Vitamine dagelijks', { title: 'Vitamine', rec: { freq: 'day', interval: 1 } });
q('Vitamine elke dag om 8u', { title: 'Vitamine', due_time: '08:00', due_date: '2026-11-12', rec: { freq: 'day' } });
q('Mail elke werkdag', { title: 'Mail', due_date: '2026-11-12', rec: { freq: 'week', days: [1, 2, 3, 4, 5], workdays: true, text: 'elke werkdag' } });
q('Mail elke werkdag', { due_date: '2026-11-16' }, { now: new Date(2026, 10, 14, 10) }); // Saturday -> Monday
q('Plan elke week', { title: 'Plan', due_date: '2026-11-12', rec: { freq: 'week', interval: 1, days: undefined } });
q('Plan wekelijks', { title: 'Plan', rec: { freq: 'week', interval: 1 } });
q('Plan elke maandag', { title: 'Plan', due_date: '2026-11-16', rec: { freq: 'week', days: [1], text: 'elke week op maandag' } });
q('Plan elke maandag en donderdag', { title: 'Plan', due_date: '2026-11-12', rec: { days: [1, 4] } });
q('Plan elke ma, wo en vr', { title: 'Plan', due_date: '2026-11-13', rec: { days: [1, 3, 5], text: 'elke week op maandag, woensdag en vrijdag' } });
q('Plan elke 2 weken', { title: 'Plan', rec: { freq: 'week', interval: 2, text: 'elke 2 weken' } });
q('Plan elke 2 weken op dinsdag', { title: 'Plan', due_date: '2026-11-17', rec: { freq: 'week', interval: 2, days: [2] } });
q('Vuilnis om de week', { title: 'Vuilnis', rec: { freq: 'week', interval: 2 } });
q('Vuilnis om de 3 weken', { title: 'Vuilnis', rec: { freq: 'week', interval: 3 } });
q('Factuur elke maand', { title: 'Factuur', due_date: '2026-11-12', rec: { freq: 'month', interval: 1, monthday: 12, text: 'elke maand op de 12e' } });
q('Factuur maandelijks', { title: 'Factuur', rec: { freq: 'month', monthday: 12 } });
q('Factuur elke 15e', { title: 'Factuur', due_date: '2026-11-15', rec: { freq: 'month', monthday: 15 } });
q('Factuur elke maand op de 20e', { title: 'Factuur', due_date: '2026-11-20', rec: { freq: 'month', monthday: 20 } });
q('Factuur elke 31e', { due_date: '2026-11-30', rec: { monthday: 31, text: 'elke maand op de laatste dag' } });
q('Factuur elke laatste dag van de maand', { title: 'Factuur', due_date: '2026-11-30', rec: { monthday: 31 } });
q('Factuur elke maand 3 dec', { title: 'Factuur', due_date: '2026-12-03', rec: { freq: 'month', monthday: 3 } });
q('APK elk jaar', { title: 'APK', due_date: '2026-11-12', rec: { freq: 'year', interval: 1 } });
q('APK jaarlijks', { title: 'APK', rec: { freq: 'year' } });
q('Planten water elke 3 dagen', { title: 'Planten water', rec: { freq: 'day', interval: 3, text: 'elke 3 dagen' } });
q('Planten om de dag', { title: 'Planten', rec: { freq: 'day', interval: 2 } });
q('Run every day', { title: 'Run', rec: { freq: 'day', interval: 1 } });
q('Run every monday', { title: 'Run', due_date: '2026-11-16', rec: { freq: 'week', days: [1] } });
q('Run every monday and friday', { title: 'Run', due_date: '2026-11-13', rec: { days: [1, 5] } });
q('Iedere vrijdag borrel', { title: 'Borrel', due_date: '2026-11-13', rec: { days: [5] } });
q('Elke ochtend mediteren', { title: 'Elke ochtend mediteren', rec: null }); // unsupported -> untouched

/* ---------------- priority, project, labels, section ---------------- */
q('Iets p2', { title: 'Iets', priority: 2 });
q('Iets P3', { title: 'Iets', priority: 3 });
q('Iets p4', { priority: 4 });
q('Iets p5', { title: 'Iets p5', priority: null });
q('Iets !!1', { title: 'Iets', priority: 1 });
q('Iets app1', { title: 'Iets app1', priority: null });
q('Iets #werk', { title: 'Iets', projectId: 'p-werk', new_project: null });
q('Iets #WERK', { projectId: 'p-werk' });
q('Iets #huis', { title: 'Iets', projectId: 'p-huis' }); // unique prefix
q('Iets #h', { title: 'Iets', project: null, new_project: 'h' }); // ambiguous prefix (Huishouden, Hobby)
q('Iets #Click', { projectId: 'p-cp' });
q('Iets #Click_Pax', { projectId: 'p-cp' });
q('Iets #Nieuw', { title: 'Iets', project: null, new_project: 'Nieuw' });
q('Iets #werk, morgen', { title: 'Iets', projectId: 'p-werk', due_date: '2026-11-13' });
q('Bug #42 fixen', { title: 'Bug #42 fixen', project: null, new_project: null });
q('Iets #morgen', { title: 'Iets', new_project: 'morgen', due_date: null });
q('Iets @klant @Urgent', { title: 'Iets', labels: ['klant', 'urgent'] });
q('Iets @Wachten op Jan', { title: 'Iets Jan', labels: ['Wachten op'] });
q('Iets @nieuwlabel', { labels: ['nieuwlabel'] });
q('Iets @klant @klant', { labels: ['klant'] });
q('Mail jan@example.com', { title: 'Mail jan@example.com', labels: [] });
q('Iets /planning', { title: 'Iets', section: 'planning' });
q('Kies en/of', { title: 'Kies en/of', section: null });
q('Iets #Click Pax /Offertes p1', { title: 'Iets', projectId: 'p-cp', section: 'Offertes', priority: 1 });

/* ---------------- deadline / reminder / duration ---------------- */
q('Rapport deadline vrijdag', { title: 'Rapport', deadline: '2026-11-13', due_date: null });
q('Rapport {20 nov} morgen', { title: 'Rapport', deadline: '2026-11-20', due_date: '2026-11-13' });
q('Rapport {onzin}', { title: 'Rapport {onzin}', deadline: null });
q('Iets morgen !30m', { title: 'Iets', reminder: { minutes_before: 30 }, due_date: '2026-11-13' });
q('Iets !1u', { title: 'Iets', reminder: { minutes_before: 60 } });
q('Iets morgen !om 8:00', { title: 'Iets', reminder: { at: '2026-11-13T08:00' } });
q('Iets !8:00', { reminder: { at: '2026-11-13T08:00' } });
q('Iets !15:00', { reminder: { at: '2026-11-12T15:00' } });
q('Wow!', { title: 'Wow!', reminder: null });
q('Iets duur 30m', { title: 'Iets', duration_min: 30 });
q('Iets duur 1u', { duration_min: 60 });
q('Iets duur 1,5u', { duration_min: 90 });
q('30 min lezen', { title: '30 min lezen', duration_min: null });

/* ---------------- title hygiene ---------------- */
q('  veel   spaties   morgen  ', { title: 'veel spaties', due_date: '2026-11-13' });
q('Iets voor morgen #werk', { title: 'Iets', due_date: '2026-11-13' });
q('Voor vrijdag rapport inleveren', { title: 'Voor rapport inleveren', due_date: '2026-11-13' }); // only trailing prepositions
q('Ticket boeken voor 3 december om 10u', { title: 'Ticket boeken', due_date: '2026-12-03', due_time: '10:00' });
q('Vanaf maandag sporten', { title: 'Sporten', due_date: '2026-11-16' });
q('Bellen, morgen', { title: 'Bellen', due_date: '2026-11-13' });
q('Over de brug lopen', { title: 'Over de brug lopen', due_date: null });
q('', { title: '', tokens: [] });
q('Eerste morgen en dan dinsdag', { title: 'Eerste en dan dinsdag', due_date: '2026-11-13' }); // first date only

test('quickadd: token ranges for highlighting', () => {
  const s = 'Offerte sturen vrijdag 9u #werk p1 @klant';
  const r = P(s);
  assert.deepEqual(r.tokens.map((t) => [t.type, t.text]), [
    ['date', 'vrijdag'], ['time', '9u'], ['project', '#werk'], ['priority', 'p1'], ['label', '@klant'],
  ]);
  assert.equal(r.tokens[0].start, 15);
});
test('quickadd: without ctx', () => {
  const r = parseQuickAdd('Iets #werk morgen');
  assert.equal(r.new_project, 'werk');
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(r.due_date));
});

/* ---------------- nextOccurrence ---------------- */
const nx = (rec, from, now = NOW) => nextOccurrence(rec, from, { now });
test('next: daily', () => {
  assert.equal(nx({ freq: 'day', interval: 1 }, '2026-11-12'), '2026-11-13');
  assert.equal(nx({ freq: 'day', interval: 3 }, '2026-11-12'), '2026-11-15');
  assert.equal(nx({ freq: 'day', interval: 1 }, '2026-11-01'), '2026-11-12'); // overdue -> today
  assert.equal(nx({ freq: 'day', interval: 1 }, '2026-11-11'), '2026-11-12');
  assert.equal(nx({ freq: 'day', interval: 3 }, '2026-11-01'), '2026-11-13'); // in phase: 4,7,10,13
});
test('next: weekly', () => {
  assert.equal(nx({ freq: 'week', interval: 1 }, '2026-11-12'), '2026-11-19');
  assert.equal(nx({ freq: 'week', interval: 2 }, '2026-11-12'), '2026-11-26');
  assert.equal(nx({ freq: 'week', interval: 1, days: [1, 4] }, '2026-11-12'), '2026-11-16');
  assert.equal(nx({ freq: 'week', interval: 1, days: [1, 4] }, '2026-11-16', new Date(2026, 10, 16)), '2026-11-19');
  assert.equal(nx({ freq: 'week', interval: 2, days: [1, 4] }, '2026-11-12'), '2026-11-23');
  assert.equal(nx({ freq: 'week', interval: 2, days: [1, 4] }, '2026-11-23', new Date(2026, 10, 23)), '2026-11-26');
  assert.equal(nx({ freq: 'week', interval: 1, days: [7] }, '2026-11-15', new Date(2026, 10, 15)), '2026-11-22');
  assert.equal(nx({ freq: 'week', interval: 1, days: [1, 4] }, '2026-11-02'), '2026-11-12'); // overdue Monday -> today (Thu)
});
test('next: workdays', () => {
  const w = { freq: 'week', interval: 1, days: [1, 2, 3, 4, 5], workdays: true };
  assert.equal(nx(w, '2026-11-12'), '2026-11-13');
  assert.equal(nx(w, '2026-11-13', new Date(2026, 10, 13)), '2026-11-16'); // Fri -> Mon
  assert.equal(nx({ freq: 'week', interval: 1, workdays: true }, '2026-11-13', new Date(2026, 10, 13)), '2026-11-16');
});
test('next: monthly', () => {
  assert.equal(nx({ freq: 'month', interval: 1, monthday: 12 }, '2026-11-12'), '2026-12-12');
  assert.equal(nx({ freq: 'month', interval: 1, monthday: 31 }, '2027-01-31', new Date(2027, 0, 31)), '2027-02-28');
  assert.equal(nx({ freq: 'month', interval: 1, monthday: 31 }, '2027-02-28', new Date(2027, 1, 28)), '2027-03-31');
  assert.equal(nx({ freq: 'month', interval: 1, monthday: 30 }, '2028-01-30', new Date(2028, 0, 30)), '2028-02-29');
  assert.equal(nx({ freq: 'month', interval: 3, monthday: 15 }, '2026-11-15', new Date(2026, 10, 15)), '2027-02-15');
  assert.equal(nx({ freq: 'month', interval: 1 }, '2026-11-12'), '2026-12-12'); // no monthday -> from day
  assert.equal(nx({ freq: 'month', interval: 1, monthday: 1 }, '2026-12-01'), '2027-01-01');
  assert.equal(nx({ freq: 'month', interval: 1, monthday: 5 }, '2026-08-05'), '2026-12-05'); // overdue
  assert.equal(nx({ freq: 'month', interval: 1, monthday: 12 }, '2026-10-12'), '2026-11-12'); // overdue -> today ok
});
test('next: yearly', () => {
  assert.equal(nx({ freq: 'year', interval: 1 }, '2026-11-14'), '2027-11-14');
  assert.equal(nx({ freq: 'year', interval: 1 }, '2028-02-29', new Date(2028, 1, 29)), '2029-02-28');
  assert.equal(nx({ freq: 'year', interval: 1 }, '2024-03-01'), '2027-03-01');
});
test('next: strictly after today when due today', () => {
  assert.ok(nx({ freq: 'day', interval: 1 }, '2026-11-12') > '2026-11-12');
  assert.equal(nextOccurrence(null, '2026-11-12'), null);
});

/* ---------------- describeRecurrence ---------------- */
test('describeRecurrence', () => {
  assert.equal(describeRecurrence({ freq: 'day', interval: 1 }), 'Elke dag');
  assert.equal(describeRecurrence({ freq: 'day', interval: 3 }), 'Elke 3 dagen');
  assert.equal(describeRecurrence({ freq: 'week', interval: 1, days: [1, 2, 3, 4, 5], workdays: true }), 'Elke werkdag');
  assert.equal(describeRecurrence({ freq: 'week', interval: 1, days: [1, 4] }), 'Elke week op maandag en donderdag');
  assert.equal(describeRecurrence({ freq: 'week', interval: 2 }), 'Elke 2 weken');
  assert.equal(describeRecurrence({ freq: 'week', interval: 1 }), 'Elke week');
  assert.equal(describeRecurrence({ freq: 'month', interval: 1, monthday: 15 }), 'Elke maand op de 15e');
  assert.equal(describeRecurrence({ freq: 'month', interval: 2, monthday: 1 }), 'Elke 2 maanden op de 1e');
  assert.equal(describeRecurrence({ freq: 'year', interval: 1 }), 'Elk jaar');
  assert.equal(describeRecurrence({ freq: 'year', interval: 2 }), 'Elke 2 jaar');
  assert.equal(describeRecurrence(null), '');
});

/* ---------------- formatDue / formatDateLong ---------------- */
test('formatDue', () => {
  assert.deepEqual(formatDue(null, null, NOW), { text: '', tone: 'none' });
  assert.deepEqual(formatDue('2026-11-12', null, NOW), { text: 'Vandaag', tone: 'today' });
  assert.deepEqual(formatDue('2026-11-12', '09:30', NOW), { text: 'Vandaag 09:30', tone: 'today' });
  assert.deepEqual(formatDue('2026-11-13', null, NOW), { text: 'Morgen', tone: 'tomorrow' });
  assert.deepEqual(formatDue('2026-11-11', null, NOW), { text: 'Gisteren', tone: 'overdue' });
  assert.deepEqual(formatDue('2026-11-10', '08:00', NOW), { text: '10 nov 08:00', tone: 'overdue' });
  assert.deepEqual(formatDue('2026-11-14', null, NOW), { text: 'Zaterdag', tone: 'week' });
  assert.deepEqual(formatDue('2026-11-18', null, NOW), { text: 'Woensdag', tone: 'week' });
  assert.deepEqual(formatDue('2026-11-19', null, NOW), { text: '19 nov', tone: 'later' });
  assert.deepEqual(formatDue('2027-03-05', null, NOW), { text: '5 mrt 2027', tone: 'later' });
  assert.deepEqual(formatDue('2025-12-24', null, NOW), { text: '24 dec 2025', tone: 'overdue' });
});
test('formatDateLong', () => {
  assert.equal(formatDateLong('2026-11-12', NOW), 'Donderdag 12 november');
  assert.equal(formatDateLong('2026-11-14', NOW), 'Zaterdag 14 november');
  assert.equal(formatDateLong('2027-01-01', NOW), 'Vrijdag 1 januari 2027');
});

/* ---------------- parseDateText ---------------- */
test('parseDateText', () => {
  assert.deepEqual(parseDateText('morgen', NOW), { due_date: '2026-11-13', due_time: null, recurrence: null });
  assert.deepEqual(parseDateText('vrijdag 9u', NOW), { due_date: '2026-11-13', due_time: '09:00', recurrence: null });
  assert.deepEqual(parseDateText('14 nov 2027', NOW), { due_date: '2027-11-14', due_time: null, recurrence: null });
  assert.deepEqual(parseDateText('geen datum', NOW), { due_date: null, due_time: null, recurrence: null, cleared: true });
  assert.deepEqual(parseDateText('Geen', NOW), { due_date: null, due_time: null, recurrence: null, cleared: true });
  const r = parseDateText('elke maandag om 8:00', NOW);
  assert.equal(r.due_date, '2026-11-16'); assert.equal(r.due_time, '08:00'); assert.deepEqual(r.recurrence.days, [1]);
  assert.equal(parseDateText('boodschappen', NOW), null);
  assert.equal(parseDateText('morgen boodschappen', NOW), null);
  assert.equal(parseDateText('', NOW), null);
  assert.equal(parseDateText('#werk', NOW), null);
  assert.equal(parseDateText('voor vrijdag', NOW).due_date, '2026-11-13');
});

/* ---------------- filters ---------------- */
const T = (o) => ({ title: 'Taak', description: '', priority: 4, due_date: null, due_time: null, labels: [], project_id: null, section_id: null, completed: false, parent_id: null, recurrence: null, ...o });
const fctx = { now: NOW, projectsById: { 'p-werk': { name: 'Werk' }, 'p-cp': { name: 'Click Pax' } }, sectionsById: { s1: { name: 'Offertes' } } };
const F = (task, query) => matchesFilter(T(task), query, fctx);
test('filter: dates', () => {
  assert.equal(F({ due_date: '2026-11-12' }, 'vandaag'), true);
  assert.equal(F({ due_date: '2026-11-12' }, 'today'), true);
  assert.equal(F({ due_date: '2026-11-11' }, 'vandaag'), false);
  assert.equal(F({ due_date: '2026-11-13' }, 'morgen'), true);
  assert.equal(F({ due_date: '2026-11-11' }, 'achterstallig'), true);
  assert.equal(F({ due_date: '2026-11-12' }, 'overdue'), false);
  assert.equal(F({ due_date: '2026-11-11' }, 'vandaag | achterstallig'), true);
  assert.equal(F({}, 'geen datum'), true);
  assert.equal(F({ due_date: '2026-11-12' }, 'no date'), false);
  assert.equal(F({ due_date: '2026-11-18' }, '7 dagen'), true);
  assert.equal(F({ due_date: '2026-11-19' }, '7 dagen'), false);
  assert.equal(F({ due_date: '2026-11-11' }, '7 days'), false); // excludes overdue
  assert.equal(F({ due_date: '2026-11-12' }, '1 dag'), true);
  assert.equal(F({ due_date: '2026-11-13' }, 'vrijdag'), true);
  assert.equal(F({ due_date: '2026-11-14' }, '14 nov'), true);
  assert.equal(F({ due_date: '2026-11-15' }, '14 nov'), false);
  assert.equal(F({ due_date: '2026-11-10' }, 'voor: vandaag'), true);
  assert.equal(F({ due_date: '2026-11-20' }, 'na: 14 nov'), true);
});
test('filter: priority/project/labels/misc', () => {
  assert.equal(F({ priority: 1 }, 'p1'), true);
  assert.equal(F({ priority: 2 }, 'p1'), false);
  assert.equal(F({ priority: null }, 'p4'), true);
  assert.equal(F({ project_id: 'p-werk' }, '#werk'), true);
  assert.equal(F({ project_id: 'p-werk' }, '#Werk'), true);
  assert.equal(F({ project_id: 'p-cp' }, '#Click Pax'), true);
  assert.equal(F({ project_id: 'p-cp' }, '#werk'), false);
  assert.equal(F({ project_id: null }, '#inbox'), true);
  assert.equal(F({ project_id: 'p-werk' }, '#inbox'), false);
  assert.equal(F({ project_id: 'p-onbekend' }, '#werk'), false);
  assert.equal(F({ project_id: 'p-cp' }, '#click*'), true);
  assert.equal(F({ labels: ['Klant'] }, '@klant'), true);
  assert.equal(F({ labels: ['klant'] }, '@urgent'), false);
  assert.equal(F({ labels: [] }, 'geen labels'), true);
  assert.equal(F({ labels: ['x'] }, 'no labels'), false);
  assert.equal(F({ recurrence: { freq: 'day', interval: 1 } }, 'terugkerend'), true);
  assert.equal(F({}, 'recurring'), false);
  assert.equal(F({ parent_id: 'x' }, 'subtaak'), true);
  assert.equal(F({}, 'subtask'), false);
  assert.equal(F({ title: 'Offerte Lotte' }, 'zoek: lotte'), true);
  assert.equal(F({ description: 'bel Lotte' }, 'search: LOTTE'), true);
  assert.equal(F({ title: 'x' }, 'zoek: lotte'), false);
  assert.equal(F({ section_id: 's1' }, '/offertes'), true);
});
test('filter: operators', () => {
  const t = { priority: 1, project_id: 'p-werk', due_date: '2026-11-12', labels: ['klant'] };
  assert.equal(F(t, 'p1 & #werk'), true);
  assert.equal(F(t, 'p1 & #inbox'), false);
  assert.equal(F(t, '!#inbox'), true);
  assert.equal(F(t, '!p1'), false);
  assert.equal(F(t, '!!p1'), true);
  assert.equal(F(t, '(vandaag | achterstallig) & @klant'), true);
  assert.equal(F(t, '(morgen | achterstallig) & @klant'), false);
  assert.equal(F(t, 'p2 | p3 | p1'), true);
  assert.equal(F(t, 'p2 & p3 | p1'), true);          // & binds tighter
  assert.equal(F(t, 'p2 & (p3 | p1)'), false);
  assert.equal(F({ ...t, completed: true }, 'p1'), false); // completed never matches
});
test('filter: malformed -> false, validateFilter', () => {
  assert.equal(F({ priority: 1 }, 'p1 &'), false);
  assert.equal(F({ priority: 1 }, '(p1'), false);
  assert.equal(F({ priority: 1 }, 'p1)'), false);
  assert.equal(F({ priority: 1 }, 'blabla'), false);
  assert.equal(F({ priority: 1 }, ''), false);
  assert.equal(F({ priority: 1 }, '@'), false);
  assert.deepEqual(validateFilter('vandaag | achterstallig'), { ok: true });
  assert.deepEqual(validateFilter('(p1 | p2) & #werk & !@klant'), { ok: true });
  assert.equal(validateFilter('(p1').ok, false);
  assert.match(validateFilter('(p1').error, /Haakje/);
  assert.match(validateFilter('blabla').error, /Onbekende term/);
  assert.match(validateFilter('').error, /Lege filter/);
  assert.match(validateFilter('@').error, /Labelnaam/);
  assert.equal(validateFilter('p1 | ').ok, false);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
