/* Daylight saving and travel. Timestamps in an export are local wall-clock time plus the UTC offset in force
   at that moment. Treating them as plain wall-clock invents gaps when clocks jump forward, double-counts the
   repeated hour when they fall back, and misreads a flight across time zones. These tests use the real tz
   database (via Intl) so the offsets are the ones a phone would have written. */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const WT = require('../analyzer.js');

const HR = 'HKQuantityTypeIdentifierHeartRate', STEPS = 'HKQuantityTypeIdentifierStepCount', SLEEP = 'HKCategoryTypeIdentifierSleepAnalysis';
const WATCH = 'Sam’s Apple Watch', PHONE = 'Sam’s iPhone';

/* "2026-03-08 03:05:00 -0400" for a real instant in a named zone */
function local(zone, ms) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  const wall = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  const off = Math.round((wall - ms) / 60000), a = Math.abs(off);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second} ${off < 0 ? '-' : '+'}${String(Math.floor(a / 60)).padStart(2, '0')}${String(a % 60).padStart(2, '0')}`;
}
const at = (iso) => Date.parse(iso);                 // real instants, written in UTC
const M = 60000;
const rec = (type, src, zone, s, e, v) => `<Record type="${type}" sourceName="${src}" startDate="${local(zone, s)}" endDate="${local(zone, e)}" value="${v}"/>`;
const run = (xml) => { const a = WT.createAnalyzer(); WT.createParser(a).feed('<HealthData>' + xml + '</HealthData>'); return a.finish(); };
/* heart rate every `step` minutes of real time, in whatever zone `zoneAt(ms)` says the phone was in */
const hrSeries = (from, to, zoneAt, step = 5) => { let x = ''; for (let t = from; t < to; t += step * M) x += rec(HR, WATCH, zoneAt(t), t, t, 70); return x; };
const NY = () => 'America/New_York';

describe('spring forward (New York, 8 March 2026, 02:00 becomes 03:00)', () => {
  // three whole local days with a reading every 5 minutes of real time
  const from = at('2026-03-07T05:00:00Z'), to = at('2026-03-10T04:00:00Z');
  it('the missing hour is not reported as a gap in your data', () => {
    const r = run(hrSeries(from, to, NY));
    assert.equal(r.facts.hoursLostToShortGaps, 0);
    assert.equal(r.facts.recurringGap, null);
    assert.equal(r.scores.coverage, 100);
  });
  it('a night asleep across the jump is 7 hours long, not 8', () => {
    const s = at('2026-03-08T04:00:00Z'), e = at('2026-03-08T11:00:00Z');   // 23:00 EST to 07:00 EDT
    let x = rec(SLEEP, WATCH, NY(), s, e, 'HKCategoryValueSleepAnalysisAsleepCore');
    for (let t = s + 5 * M; t < e; t += 10 * M) x += rec(HR, WATCH, NY(), t, t, 55);
    x += hrSeries(e + 60 * M, e + 660 * M, NY);                               // daytime readings so the day has coverage
    const d = run(x).daily.find((q) => q.sleepMin > 0);
    assert.equal(d.sleepMin, 420);
  });
});

describe('fall back (New York, 1 November 2026, 02:00 becomes 01:00)', () => {
  it('the repeated hour is not counted twice', () => {
    // 140 steps every minute of real time across the repeated hour: 140 a minute is plausible, 280 is not
    let x = ''; for (let t = at('2026-11-01T04:00:00Z'); t < at('2026-11-01T09:00:00Z'); t += M) x += rec(STEPS, WATCH, NY(), t, t + M, 140);
    const r = run(x);
    assert.equal(r.facts.implausibleStepMinutes, 0);
    assert.equal(r.facts.rawSteps, 140 * 300);
  });
  it('a night asleep across it is 9 hours long, not 8', () => {
    const s = at('2026-11-01T03:00:00Z'), e = at('2026-11-01T12:00:00Z');   // 23:00 EDT to 07:00 EST
    let x = rec(SLEEP, WATCH, NY(), s, e, 'HKCategoryValueSleepAnalysisAsleepCore');
    for (let t = s + 5 * M; t < e; t += 10 * M) x += rec(HR, WATCH, NY(), t, t, 55);
    x += hrSeries(e + 60 * M, e + 660 * M, NY);
    assert.equal(run(x).daily.find((q) => q.sleepMin > 0).sleepMin, 540);
  });
  it('readings from the two passes through 01:00 are not interleaved into false spikes', () => {
    // alternate readings 70 and 130 in the first pass, steady 70 in the second: interleaving would pair them up
    let x = ''; for (let t = at('2026-11-01T05:00:00Z'); t < at('2026-11-01T06:00:00Z'); t += 4 * M) x += rec(HR, WATCH, NY(), t, t, 70);
    for (let t = at('2026-11-01T06:00:00Z'); t < at('2026-11-01T07:00:00Z'); t += 4 * M) x += rec(HR, WATCH, NY(), t, t, 70);
    assert.equal(run(x).facts.hrBlips, 0);
  });
});

describe('travel across time zones', () => {
  const LON = 'Europe/London', SIN = 'Asia/Singapore', flight = at('2026-12-10T12:00:00Z');
  it('flying east does not leave an 8 hour hole in the day', () => {
    const r = run(hrSeries(at('2026-12-08T00:00:00Z'), at('2026-12-12T16:00:00Z'), (t) => (t < flight ? LON : SIN)));
    assert.equal(r.scores.coverage, 100);
    assert.equal(r.facts.darkDays, 0);
  });
  it('flying west does not count the repeated hours twice', () => {
    // 140 steps a minute of real time for 12 hours either side of the flight, Singapore then London
    let x = ''; for (let t = flight - 12 * 60 * M; t < flight + 12 * 60 * M; t += M) x += rec(STEPS, WATCH, t < flight ? SIN : LON, t, t + M, 140);
    assert.equal(run(x).facts.implausibleStepMinutes, 0);
  });
  it('days are the days on the clock where you were', () => {
    // 23:30 on the 1st in New York is already the 2nd in UTC, but it is still the 1st for the wearer
    const r = run(rec(HR, WATCH, 'America/New_York', at('2026-09-02T03:30:00Z'), at('2026-09-02T03:30:00Z'), 70));
    assert.match(r.span.from, /1 Sep/);
  });
});

describe('the same moment written in different offsets is the same moment', () => {
  const sleepRec = (src, startLocal, endLocal) => `<Record type="${SLEEP}" sourceName="${src}" startDate="${startLocal}" endDate="${endLocal}" value="HKCategoryValueSleepAnalysisAsleepCore"/>`;
  const day = (xml) => run(xml + (() => { let h = ''; for (let m = 0; m < 600; m += 5) h += `<Record type="${HR}" sourceName="${WATCH}" startDate="2026-09-02 ${String(Math.floor((420 + m) / 60)).padStart(2, '0')}:${String((420 + m) % 60).padStart(2, '0')}:00 +0000" endDate="2026-09-02 ${String(Math.floor((420 + m) / 60)).padStart(2, '0')}:${String((420 + m) % 60).padStart(2, '0')}:00 +0000" value="75"/>`; return h; })());
  it('a watch in UTC and a phone in UTC+1 logging the same night overlap completely', () => {
    const r = day(sleepRec(WATCH, '2026-09-01 23:00:00 +0000', '2026-09-02 07:00:00 +0000') + sleepRec(PHONE, '2026-09-02 00:00:00 +0100', '2026-09-02 08:00:00 +0100'));
    assert.equal(r.daily.find((q) => q.sleepMin > 0).sleepMin, 480);
    assert.equal(r.facts.flaggedNights, 1);                              // same night twice, so it is a duplicate
  });
  it('half-hour offsets work (India is UTC+5:30)', () => {
    const r = day(sleepRec(WATCH, '2026-09-01 23:00:00 +0000', '2026-09-02 07:00:00 +0000') + sleepRec(PHONE, '2026-09-02 04:30:00 +0530', '2026-09-02 12:30:00 +0530'));
    assert.equal(r.daily.find((q) => q.sleepMin > 0).sleepMin, 480);
  });
  it('a timestamp with no offset is read as written', () => {
    const r = run(`<Record type="${HR}" sourceName="W" startDate="2026-09-01 10:00:00" endDate="2026-09-01 10:00:00" value="70"/>`);
    assert.match(r.span.from, /1 Sep/);
  });
});

describe('times shown to the user stay in local time', () => {
  it('a spike recorded at 14:38 local is reported at 14:38, whatever the offset', () => {
    for (const zone of ['America/New_York', 'Asia/Kolkata', 'Pacific/Auckland']) {
      const noon = at('2026-09-16T00:00:00Z');
      let x = ''; for (let t = noon - 5 * 60 * M; t < noon + 5 * 60 * M; t += 30 * M) x += rec(HR, WATCH, zone, t, t, 70);
      const t0 = at('2026-09-16T10:00:00Z');
      x += rec(HR, WATCH, zone, t0, t0, 70) + rec(HR, WATCH, zone, t0 + 2 * M, t0 + 2 * M, 190) + rec(HR, WATCH, zone, t0 + 4 * M, t0 + 4 * M, 70);
      const r = run(x), want = local(zone, t0 + 2 * M).slice(11, 16);
      const blip = r.receipts.find((q) => q.chart && q.chart.type === 'blip' && q.chart.v === 190);
      assert.ok(blip, 'blip found in ' + zone);
      assert.ok(blip.detail.includes('at ' + want), `${zone}: expected "at ${want}" in: ${blip.detail}`);
    }
  });
});
