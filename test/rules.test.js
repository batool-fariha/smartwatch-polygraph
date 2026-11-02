/* Unit tests for each scoring rule and its boundary. Uses only node:test, no dependencies.
   Every case builds a tiny export by hand so the expected result is easy to reason about. */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const WT = require('../analyzer.js');

const HR = 'HKQuantityTypeIdentifierHeartRate', STEPS = 'HKQuantityTypeIdentifierStepCount', SLEEP = 'HKCategoryTypeIdentifierSleepAnalysis';
const WATCH = 'Sam’s Apple Watch', PHONE = 'Sam’s iPhone';
const stamp = (min) => new Date(Date.UTC(2026, 8, 1) + min * 60000).toISOString().slice(0, 19).replace('T', ' ') + ' +0000';
const rec = (type, src, s, e, v) => `<Record type="${type}" sourceName="${src}" startDate="${stamp(s)}" endDate="${stamp(e)}" value="${v}"/>`;
const hr = (m, v, src = WATCH) => rec(HR, src, m, m, v);
const steps = (m, v, src = WATCH, len = 1) => rec(STEPS, src, m, m + len, v);
const sleep = (s, e, src = WATCH) => rec(SLEEP, src, s, e, 'HKCategoryValueSleepAnalysisAsleepCore');
const run = (xml) => { const a = WT.createAnalyzer(); WT.createParser(a).feed('<HealthData>' + xml + '</HealthData>'); return a.finish(); };
const DAY = 1440;

/* ---------- heart rate ---------- */
// sparse baseline every 30 minutes, so each event sits alone
const baseline = (from, to) => { let x = ''; for (let m = from; m <= to; m += 30) x += hr(m, 70); return x; };
// an event is three readings 2 minutes apart, 15 minutes away from any baseline reading
const triple = (m, a, b, c) => hr(m, a) + hr(m + 2, b) + hr(m + 4, c);

describe('heart rate: impossible readings (below 30 or above 230)', () => {
  // runs of three identical values so they never count as blips
  const run3 = (m, v) => hr(m, v) + hr(m + 2, v) + hr(m + 4, v);
  it('29 and 231 are impossible, 30 and 230 are not', () => {
    const r = run(baseline(0, 600) + run3(15, 29) + run3(75, 30) + run3(135, 230) + run3(195, 231));
    assert.equal(r.facts.hrImpossible, 6);
    assert.equal(r.facts.hrBlips, 0);
  });
});

describe('heart rate: single-reading blips', () => {
  it('a 59 bpm jump is not a blip, 60 is', () => {
    assert.equal(run(baseline(0, 300) + triple(15, 70, 129, 70)).facts.hrBlips, 0);
    assert.equal(run(baseline(0, 300) + triple(15, 70, 130, 70)).facts.hrBlips, 1);
  });
  it('a spike that does not come back down is not a blip', () => {
    // 60, 200, 100: both jumps are large but the neighbours differ by more than 25
    assert.equal(run(baseline(0, 300) + triple(15, 60, 200, 100)).facts.hrBlips, 0);
  });
  it('neighbours more than 10 minutes apart are not a blip', () => {
    assert.equal(run(baseline(0, 300) + hr(15, 70) + hr(23, 140) + hr(31, 70)).facts.hrBlips, 0);
  });
  it('a spike inside a workout is not a blip', () => {
    const workout = `<Workout workoutActivityType="HKWorkoutActivityTypeRunning" startDate="${stamp(5)}" endDate="${stamp(30)}"></Workout>`;
    assert.equal(run(baseline(0, 300) + triple(15, 70, 190, 70) + workout).facts.hrBlips, 0);
    assert.equal(run(baseline(0, 300) + triple(15, 70, 190, 70)).facts.hrBlips, 1);
  });
  it('heart-rate score falls as bad readings grow, and is null with under 100 readings', () => {
    let clean = ''; for (let m = 0; m < 600; m += 5) clean += hr(m, 70);
    assert.equal(run(clean).scores.hr, 100);
    assert.equal(run(baseline(0, 300)).scores.hr, null);
    assert.ok(run(clean + hr(601, 251)).scores.hr < 100);
  });
});

/* ---------- sleep ---------- */
// an 8 hour night with a reading every 10 minutes; the first `hot` readings (from the 6th) are elevated
function night({ start = DAY, mins = 480, src = WATCH, hot = 0, hotValue = 95, withHr = true, extraSource = null } = {}) {
  let x = sleep(start, start + mins, src);
  if (extraSource) x += sleep(start, start + extraSource.mins, extraSource.src);
  if (withHr) { let i = 0; for (let m = start + 5; m < start + mins; m += 10, i++) x += hr(m, i >= 5 && i < 5 + hot ? hotValue : 55); }
  // daytime readings on the wake day so the day has coverage and the report carries a per-day trust value
  for (let m = start + mins + 60; m < start + mins + 60 + 600; m += 5) x += hr(m, 75);
  return x;
}
const verdict = (xml) => { const r = run(xml); const d = r.daily.find((x) => x.sleepMin > 0); return { nights: r.facts.nights, flagged: r.facts.flaggedNights, trust: d ? d.sleepTrust : null, receipts: r.receipts }; };

describe('sleep: heart rate during sleep', () => {
  it('4 elevated readings (20 min, under 5% of the night) are not flagged, 5 readings (25 min) are', () => {
    assert.equal(verdict(night({ hot: 4 })).flagged, 0);
    assert.equal(verdict(night({ hot: 5 })).flagged, 1);
  });
  it('more elevated readings means lower trust', () => {
    const t5 = verdict(night({ hot: 5 })).trust, t8 = verdict(night({ hot: 8 })).trust;
    assert.ok(t8 < t5 && t5 < 0.8);
  });
  it('the ceiling is 90 bpm: a reading of 89 is fine, 90 counts', () => {
    assert.equal(verdict(night({ hot: 8, hotValue: 89 })).flagged, 0);
    assert.equal(verdict(night({ hot: 8, hotValue: 90 })).flagged, 1);
  });
  it('a clean night scores full trust', () => {
    const v = verdict(night()); assert.equal(v.flagged, 0); assert.equal(v.trust, 1);
  });
});

describe('sleep: other penalties', () => {
  it('sleeps longer than 12 hours are flagged, exactly 12 hours is not', () => {
    assert.equal(verdict(night({ mins: 720 })).flagged, 0);
    assert.equal(verdict(night({ mins: 721 })).flagged, 1);
  });
  it('two sources logging the same night are flagged', () => {
    const v = verdict(night({ extraSource: { src: PHONE, mins: 480 } }));
    assert.equal(v.flagged, 1);
    assert.deepEqual(v.receipts.find((r) => r.kind === 'sleep').sources.sort(), [PHONE, WATCH].sort());
  });
  it('overlap up to 25% costs nothing; beyond that it costs a little', () => {
    assert.equal(verdict(night({ extraSource: { src: PHONE, mins: 96 } })).trust, 1);       // 576 / 480 = 1.2
    const t = verdict(night({ extraSource: { src: PHONE, mins: 132 } })).trust;              // 612 / 480 = 1.275
    assert.ok(t < 1 && t > 0.8, 'trust ' + t);
  });
  it('a watch-logged night with no pulse readings costs 0.2 but is not flagged on its own', () => {
    const v = verdict(night({ withHr: false }));
    assert.equal(v.flagged, 0);
    assert.ok(Math.abs(v.trust - 0.8) < 1e-9, 'trust ' + v.trust);
  });
  it('sessions under 90 minutes of sleep are not scored', () => {
    assert.equal(verdict(night({ mins: 89 })).nights, 0);
    assert.equal(verdict(night({ mins: 90 })).nights, 1);
  });
  it('walking-pace steps (40 a minute) inside sleep count as conflict', () => {
    let x = night(); for (let m = DAY + 100; m < DAY + 130; m++) x += steps(m, 60);   // 30 minutes of walking
    assert.equal(verdict(x).flagged, 1);
    let y = night(); for (let m = DAY + 100; m < DAY + 130; m++) y += steps(m, 39);   // just under the cutoff
    assert.equal(verdict(y).flagged, 0);
  });
});

/* ---------- steps ---------- */
describe('steps: double counting', () => {
  const minutes = (from, n, v, src) => { let x = ''; for (let m = from; m < from + n; m++) x += steps(m, v, src); return x; };
  it('one source means no inflation and a perfect score', () => {
    const r = run(minutes(600, 10, 40));
    assert.equal(r.facts.inflation, 0); assert.equal(r.scores.steps, 100);
  });
  it('phone and watch counting every minute doubles the total and zeroes the score', () => {
    const r = run(minutes(600, 10, 40, WATCH) + minutes(600, 10, 40, PHONE));
    assert.equal(r.facts.rawSteps, 800); assert.equal(r.facts.dedupSteps, 400);
    assert.equal(r.facts.inflation, 1); assert.equal(r.scores.steps, 0);
  });
  it('20% inflation scores 70', () => {
    const r = run(minutes(600, 10, 40, WATCH) + minutes(600, 2, 40, PHONE));   // 480 raw vs 400 real
    assert.ok(Math.abs(r.facts.inflation - 0.2) < 1e-9);
    assert.ok(Math.abs(r.scores.steps - 70) < 1e-6, 'score ' + r.scores.steps);
  });
  it('the larger source in a minute is the one kept', () => {
    const r = run(steps(600, 30, WATCH) + steps(600, 50, PHONE));
    assert.equal(r.facts.dedupSteps, 50); assert.equal(r.facts.stepOverlap.keep, PHONE);
  });
  it('more than 250 steps in a minute is implausible cadence; 250 is not', () => {
    let a = '', b = ''; for (let m = 0; m < 10; m++) { a += steps(600 + m, 250); b += steps(600 + m, 251); }
    assert.equal(run(a).facts.implausibleStepMinutes, 0); assert.equal(run(a).scores.steps, 100);
    assert.equal(run(b).facts.implausibleStepMinutes, 10); assert.equal(run(b).scores.steps, 99);
  });
  it('a long record (over 30 minutes) is booked at its start, shorter ones are spread across their minutes', () => {
    assert.equal(run(steps(600, 3000, WATCH, 60)).facts.implausibleStepMinutes, 1);   // one 3000-step minute
    assert.equal(run(steps(600, 3000, WATCH, 30)).facts.implausibleStepMinutes, 0);   // 100 a minute
  });
});

/* ---------- coverage ---------- */
describe('coverage: hours with watch data, against an 18 hour day', () => {
  const hours = (n) => { let x = ''; for (let m = 0; m < n * 60; m += 5) x += hr(m, 70); return x; };
  it('18 hours is full marks, 9 hours is half', () => {
    assert.equal(run(hours(18)).scores.coverage, 100);
    assert.equal(run(hours(9)).scores.coverage, 50);
  });
  it('more than 18 hours does not score above 100', () => assert.equal(run(hours(24)).scores.coverage, 100));
  // ten days with a reading in every hour except hour 7 on the first `gapDays` days
  const tenDays = (gapDays) => { let x = ''; for (let d = 0; d < 10; d++) for (let h = 0; h < 24; h++) if (!(h === 7 && d < gapDays)) x += hr(d * DAY + h * 60 + 5, 70); return x; };
  it('a gap at the same hour on 3 of 10 days is recurring, 2 of 10 is not', () => {
    assert.deepEqual(run(tenDays(3)).facts.recurringGap, { hour: 7, days: 3, of: 10 });
    assert.equal(run(tenDays(2)).facts.recurringGap, null);
  });
  it('a day with nothing in the middle of the range is reported as dark', () => {
    let x = ''; for (let m = 0; m < 600; m += 5) x += hr(m, 70) + hr(2 * DAY + m, 70);
    const r = run(x); assert.equal(r.facts.darkDays, 1); assert.equal(r.facts.longestDark, 1);
  });
});

/* ---------- sources ---------- */
describe('source kinds are guessed from the source name', () => {
  const kinds = (names) => { const r = run(names.map((n, i) => steps(600 + i, 10, n)).join('')); return Object.fromEntries(r.facts.sources.map((s) => [s.name, s.kind])); };
  it('watches, phones and everything else', () => {
    const k = kinds(['Apple Watch of Sam', 'Fitbit Charge 6', 'Garmin Connect', 'WHOOP', 'Oura Ring', 'iPhone 15', 'Sam’s iPad', 'Withings Health Mate']);
    assert.deepEqual(k, {
      'Apple Watch of Sam': 'watch', 'Fitbit Charge 6': 'watch', 'Garmin Connect': 'watch', WHOOP: 'watch', 'Oura Ring': 'watch',
      'iPhone 15': 'phone', 'Sam’s iPad': 'phone', 'Withings Health Mate': 'other'
    });
  });
  it('lists at most 8 sources, busiest first', () => {
    let x = ''; for (let i = 0; i < 10; i++) for (let k = 0; k <= i; k++) x += steps(600 + i * 20 + k, 5, 'Source ' + i);
    const list = run(x).facts.sources;
    assert.equal(list.length, 8);
    assert.equal(list[0].name, 'Source 9'); assert.equal(list[7].name, 'Source 2');
  });
  it('a missing source name is kept as "Unknown source"', () => {
    const r = run(`<Record type="${STEPS}" startDate="${stamp(600)}" endDate="${stamp(601)}" value="5"/>`);
    assert.equal(r.facts.sources[0].name, 'Unknown source');
  });
});

/* ---------- parsing ---------- */
describe('parsing', () => {
  it('timestamps are read as wall-clock time, whatever the offset', () => {
    const r = run(`<Record type="${HR}" sourceName="W" startDate="2026-09-01 23:30:00 -0500" endDate="2026-09-01 23:30:00 -0500" value="70"/>`);
    assert.match(r.span.from, /1 Sep/);
    const r2 = run(`<Record type="${HR}" sourceName="W" startDate="2026-09-01 00:10:00 +0900" endDate="2026-09-01 00:10:00 +0900" value="70"/>`);
    assert.match(r2.span.from, /1 Sep/);
  });
  it('splitting the file at any point gives the same result', () => {
    let xml = '<?xml version="1.0"?>\n<HealthData>\n <ExportDate value="x"/>\n';
    for (let i = 0; i < 12; i++) xml += hr(i * 7, 60 + i) + '\n' + steps(300 + i, 10 + i, i % 2 ? WATCH : PHONE) + '\n';
    xml += sleep(0, 500) + '\n<Correlation type="x"><Record type="HKQuantityTypeIdentifierBodyMass" value="1"/></Correlation>\n</HealthData>\n';
    const whole = (() => { const a = WT.createAnalyzer(); WT.createParser(a).feed(xml); return JSON.stringify({ c: a.counts, r: a.finish() }); })();
    for (let size = 1; size <= 211; size++) {
      const a = WT.createAnalyzer(), p = WT.createParser(a);
      for (let i = 0; i < xml.length; i += size) p.feed(xml.slice(i, i + size));
      assert.equal(JSON.stringify({ c: a.counts, r: a.finish() }), whole, 'chunk size ' + size);
    }
  });
  it('tags it does not use, and attributes containing ">" or "/", do not confuse it', () => {
    const r = run(`<Record type="HKQuantityTypeIdentifierBodyMass" sourceName="a>b" value="1"/>` + hr(10, 70, 'Watch / v2') + `<MetadataEntry key="k" value="v"/>`);
    assert.equal(r.counts.hr, 1); assert.equal(r.facts.sources[0].name, 'Watch / v2');
  });
  it('an export with nothing it uses comes back empty', () => {
    assert.equal(run('').empty, true);
    assert.equal(run(`<Record type="HKQuantityTypeIdentifierBodyMass" startDate="${stamp(0)}" endDate="${stamp(0)}" value="70"/>`).empty, true);
  });
});

/* ---------- overall score ---------- */
describe('overall score', () => {
  it('a missing sub-score drops out and the rest are renormalised', () => {
    let x = ''; for (let m = 0; m < 10; m++) x += steps(600 + m, 40);
    const r = run(x);                                  // steps only: no sleep, too little heart rate
    assert.equal(r.scores.sleep, null); assert.equal(r.scores.hr, null);
    assert.ok(Math.abs(r.scores.overall - (r.scores.steps * 0.25 + r.scores.coverage * 0.25) / 0.5) < 1e-9);
  });
  it('grades follow the bands', () => {
    const grade = (xml) => run(xml).grade;
    let clean = ''; for (let m = 0; m < 18 * 60; m += 5) clean += hr(m, 70);
    assert.equal(grade(clean), 'Trustworthy');
    let doubled = ''; for (let m = 0; m < 600; m++) doubled += steps(m, 20, WATCH) + steps(m, 20, PHONE);
    assert.notEqual(grade(doubled), 'Trustworthy');
  });
});
