/* Fitbit Takeout adapter. All files here are synthetic, built to the layout assumed in fitbit.js. */
const test = require('node:test');
const assert = require('node:assert/strict');
const WT = require('../analyzer.js');
const FB = require('../fitbit.js');

const plus2 = () => 120; // a wearer in UTC+2 all year
const us = (iso) => { const d = new Date(iso); const p = (n) => String(n).padStart(2, '0'); return `${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())}/${String(d.getUTCFullYear()).slice(2)} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`; };

function heartRateFile(dayIso, opts) {
  const o = Object.assign({ from: 0, to: 24 * 60, every: 15, bpm: 64, spikeAt: -1 }, opts);
  const t0 = Date.parse(dayIso + 'T00:00:00Z'), rows = [];
  for (let s = o.from * 60; s < o.to * 60; s += o.every) rows.push({ dateTime: us(t0 + s * 1000), value: { bpm: s === o.spikeAt * 60 ? 250 : o.bpm + (s % 5), confidence: 2 } });
  return JSON.stringify(rows);
}
function stepsFile(dayIso, walkFrom, walkTo) {
  const t0 = Date.parse(dayIso + 'T00:00:00Z'), rows = [];
  for (let m = 0; m < 1440; m++) rows.push({ dateTime: us(t0 + m * 60000), value: String(m >= walkFrom && m < walkTo ? 100 : 0) });
  return JSON.stringify(rows);
}
function sleepFile(startLocal, segments) {
  let t = Date.parse(startLocal + 'Z');
  const data = segments.map(([level, mins]) => { const seg = { dateTime: new Date(t).toISOString().replace('Z', ''), level, seconds: mins * 60 }; t += mins * 60000; return seg; });
  return JSON.stringify([{ logId: 1, startTime: startLocal + '.000', endTime: new Date(t).toISOString().replace('Z', ''), type: 'stages', levels: { data } }]);
}

test('recognises Takeout file names, including inside folders', () => {
  assert.equal(FB.kind('Takeout/Fitbit/Global Export Data/heart_rate-2026-09-01.json'), 'heart_rate');
  assert.equal(FB.kind('steps-2026-09-01.json'), 'steps');
  assert.equal(FB.kind('sleep-2026-09-01.json'), 'sleep');
  assert.equal(FB.kind('distance-2026-09-01.json'), null);
  assert.equal(FB.kind('export.xml'), null);
});

test('heart rate: UTC times become local, one reading per minute', () => {
  const r = FB.toRecords('heart_rate-2026-09-01.json', heartRateFile('2026-09-01', { from: 60, to: 63 }), { offsetFor: plus2 });
  assert.equal(r.length, 3);
  assert.equal(r[0].startDate, '2026-09-01 03:00:00 +0200');
  assert.equal(r[0].sourceName, 'Fitbit');
});

test('steps: zero minutes are skipped, others are one-minute records', () => {
  const r = FB.toRecords('steps-2026-09-01.json', stepsFile('2026-09-01', 600, 610), { offsetFor: plus2 });
  assert.equal(r.length, 10);
  assert.equal(r[0].value, '100');
  assert.equal(r[0].startDate, '2026-09-01 12:00:00 +0200');
  assert.equal(r[0].endDate, '2026-09-01 12:01:00 +0200');
});

test('sleep: stage segments keep local time, and wake segments are awake', () => {
  const r = FB.toRecords('sleep-2026-09-02.json', sleepFile('2026-09-01T23:10:00', [['light', 60], ['wake', 10], ['deep', 90], ['awake', 5], ['rem', 30]]), { offsetFor: plus2 });
  assert.equal(r.length, 5);
  assert.equal(r[0].startDate, '2026-09-01 23:10:00 +0200');
  assert.equal(r[0].endDate, '2026-09-02 00:10:00 +0200');
  assert.deepEqual(r.map((x) => /Awake/.test(x.value)), [false, true, false, true, false]);
});

test('sleep without stages falls back to start and end time', () => {
  const r = FB.toRecords('sleep-2026-09-02.json', JSON.stringify([{ startTime: '2026-09-01T23:00:00.000', endTime: '2026-09-02T07:00:00.000', levels: { data: [] } }]), { offsetFor: plus2 });
  assert.equal(r.length, 1);
  assert.equal(r[0].startDate, '2026-09-01 23:00:00 +0200');
  assert.equal(r[0].endDate, '2026-09-02 07:00:00 +0200');
});

test('bad files give a plain error naming the file, and junk rows are skipped', () => {
  assert.throws(() => FB.toRecords('a/heart_rate-2026-09-01.json', '{oops'), /heart_rate-2026-09-01.json is not valid JSON/);
  assert.throws(() => FB.toRecords('steps-2026-09-01.json', '{"a":1}'), /not a list/);
  assert.equal(FB.toRecords('steps-2026-09-01.json', '[{"dateTime":"bad","value":"5"},{"value":"3"}]').length, 0);
  assert.deepEqual(FB.toRecords('distance-2026-09-01.json', '[]'), []);
});

test('the analyzer reads a week of Fitbit files and flags an impossible heart rate', () => {
  const an = WT.createAnalyzer();
  for (let d = 1; d <= 7; d++) {
    const day = `2026-09-0${d}`;
    FB.feed(`heart_rate-${day}.json`, heartRateFile(day, { every: 60, spikeAt: d === 3 ? 700 : -1 }), an, { offsetFor: plus2 });
    FB.feed(`steps-${day}.json`, stepsFile(day, 480, 540), an, { offsetFor: plus2 });
    FB.feed(`sleep-${day}.json`, sleepFile(`2026-09-0${d}T00:30:00`, [['light', 200], ['deep', 120], ['rem', 60]]), an, { offsetFor: plus2 });
  }
  const rep = an.finish();
  assert.ok(rep.counts.hr > 9000);
  assert.ok(rep.counts.steps > 0);
  assert.equal(rep.counts.sleep, 21);
  assert.equal(rep.facts.hrImpossible, 1);
  assert.ok(rep.facts.sources.some((s) => s.name === 'Fitbit' && s.kind === 'watch'));
});
