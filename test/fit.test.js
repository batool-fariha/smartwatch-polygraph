const test = require('node:test');
const assert = require('node:assert/strict');
const WT = require('../analyzer.js');
const FIT = require('../fit.js');
const { activity, encoder } = require('./fit-encode.js');

test('recognises the FIT signature', () => {
  assert.equal(FIT.isFit(activity()), true);
  assert.equal(FIT.isFit(new TextEncoder().encode('<?xml version="1.0"?><HealthData>')), false);
  assert.throws(() => FIT.decode(new Uint8Array(20)), /Not a FIT file/);
});

test('decodes records, compressed timestamps, big-endian and developer fields', () => {
  const msgs = FIT.decode(activity({ minutes: 2 }));
  const recs = msgs.filter((m) => m.num === 20);
  assert.equal(recs.length, 120);
  // every record has a timestamp, one second apart, including the compressed ones
  recs.forEach((r, i) => assert.equal(r.fields[253], recs[0].fields[253] + i));
  assert.equal(recs[5].fields[4], undefined, 'invalid cadence (0xFF) is dropped');
  const session = msgs.find((m) => m.num === 18);
  assert.equal(session.fields[5], 1, 'big-endian session sport');
  assert.equal(session.fields[7], 120000);
});

test('maps a run to one heart-rate reading per minute, steps and a workout, in local time', () => {
  const r = FIT.toRecords(activity({ minutes: 30, offsetMin: 120, cadence: 85 }));
  assert.equal(r.sourceName, 'Garmin watch (FIT)');
  assert.equal(r.offsetMinutes, 120);
  const hr = r.records.filter((x) => x.type === 'HKQuantityTypeIdentifierHeartRate');
  const steps = r.records.filter((x) => x.type === 'HKQuantityTypeIdentifierStepCount');
  assert.equal(hr.length, 30);
  assert.equal(hr[0].startDate, '2026-09-03 08:00:00 +0200');
  assert.equal(steps.length, 30);
  assert.equal(steps[1].value, '170', 'cadence is per foot, so steps per minute is double');
  assert.deepEqual(r.workouts, [{ startDate: '2026-09-03 08:00:00 +0200', endDate: '2026-09-03 08:30:00 +0200' }]);
});

test('cycling gives heart rate but no steps', () => {
  const r = FIT.toRecords(activity({ sport: 2 }));
  assert.ok(r.records.some((x) => x.type.endsWith('HeartRate')));
  assert.equal(r.records.filter((x) => x.type.endsWith('StepCount')).length, 0);
});

test('a non-Garmin maker is not classed as a watch by name', () => {
  assert.equal(FIT.toRecords(activity({ maker: 255 })).sourceName, 'FIT device');
});

test('a truncated file is rejected, not half-read silently', () => {
  const b = activity({ minutes: 1 });
  assert.throws(() => FIT.decode(b.slice(0, 200)), /truncated/);
});

test('a data message before its definition is rejected', () => {
  const e = encoder();
  e.define(0, 20, [[253, 4, 134]]);
  const b = e.bytes();
  b[14] = 0x01; // turn the definition header into a data header for local type 1
  assert.throws(() => FIT.decode(b), /before its definition/);
});

test('the analyzer flags an impossible heart rate read from a FIT file', () => {
  const an = WT.createAnalyzer();
  const runs = [];
  for (let d = 0; d < 10; d++) runs.push(activity({ start: `2026-09-${String(d + 1).padStart(2, '0')}T06:00:00Z`, spikeAt: d === 4 ? 10 : -1, spikeBpm: 250 }));
  runs.forEach((b) => FIT.feed(b, an));
  const rep = an.finish();
  assert.ok(rep.counts.hr >= 300);
  assert.equal(rep.counts.workouts, 10);
  assert.equal(rep.facts.hrImpossible, 1);
  assert.ok(rep.receipts.some((x) => x.rule === 'heart-rate.impossible'));
});

test('workout-only data leaves coverage unscored instead of scoring the gaps between runs', () => {
  const an = WT.createAnalyzer({ workoutOnly: true });
  for (let d = 0; d < 5; d++) FIT.feed(activity({ start: `2026-09-0${d + 1}T06:00:00Z` }), an);
  const rep = an.finish();
  assert.equal(rep.workoutOnly, true);
  assert.equal(rep.scores.coverage, null);
  assert.ok(!rep.receipts.some((x) => x.kind === 'coverage'));
  const plain = WT.createAnalyzer();
  for (let d = 0; d < 5; d++) FIT.feed(activity({ start: `2026-09-0${d + 1}T06:00:00Z` }), plain);
  assert.ok(plain.finish().scores.coverage < 20, 'without the option, an hour a day scores as poor coverage');
});
