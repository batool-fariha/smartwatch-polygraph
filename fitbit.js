/* Fitbit (Google Takeout) -> the record shape analyzer.js reads.

   NOT YET CHECKED AGAINST A REAL EXPORT. The file layout below is what community write-ups
   describe for Takeout's "Fitbit/Global Export Data" folder; Fitbit has not published it.
   Every assumption is listed here so a real export can confirm or correct it:

   heart_rate-YYYY-MM-DD.json  [{ "dateTime": "MM/DD/YY HH:MM:SS", "value": { "bpm": 72, "confidence": 2 } }]
   steps-YYYY-MM-DD.json       [{ "dateTime": "MM/DD/YY HH:MM:SS", "value": "13" }]       one entry per minute
   sleep-YYYY-MM-DD.json       [{ "startTime": "YYYY-MM-DDTHH:MM:SS.000", "endTime": "...",
                                  "levels": { "data": [{ "dateTime": "YYYY-MM-DDTHH:MM:SS.000",
                                  "level": "wake|light|deep|rem|asleep|restless|awake", "seconds": 30 }] } }]

   Times: heart-rate and step times are read as UTC, sleep times as local wall-clock time
   (ASSUMPTION, see above). Local time comes from offsetFor(utcMs), which defaults to this
   browser's time zone, so day boundaries are right for someone who lives where their browser is.
   Runs in the browser and in Node. Nothing leaves the page. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.WearableFitbit = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SOURCE = 'Fitbit';
  const T_HR = 'HKQuantityTypeIdentifierHeartRate', T_STEPS = 'HKQuantityTypeIdentifierStepCount', T_SLEEP = 'HKCategoryTypeIdentifierSleepAnalysis';
  const NAME = /(?:^|\/)(heart_rate|steps|sleep)-(\d{4}-\d{2}-\d{2})\.json$/;
  const AWAKE = /^(wake|awake)$/i;

  const kind = (name) => { const m = NAME.exec(name || ''); return m ? m[1] : null; };
  const localOffset = (utcMs) => -new Date(utcMs).getTimezoneOffset();

  const pad = (n) => String(Math.abs(n)).padStart(2, '0');
  function stamp(utcMs, offMin) {
    const d = new Date(utcMs + offMin * 60000);
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} ${offMin < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(offMin) / 60))}${pad(Math.abs(offMin) % 60)}`;
  }
  // "04/01/23 07:00:05" -> UTC ms
  function usUtc(s) {
    const m = /^(\d{2})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(String(s || ''));
    return m ? Date.UTC(2000 + +m[3], +m[1] - 1, +m[2], +m[4], +m[5], +m[6]) : NaN;
  }
  // "2023-03-31T23:12:30.000" read as local wall-clock time -> UTC ms, using offsetFor
  function isoLocal(s, offsetFor) {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(String(s || ''));
    if (!m) return NaN;
    const wall = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
    const guess = wall - offsetFor(wall) * 60000;
    return wall - offsetFor(guess) * 60000;
  }

  /* Turn one Takeout JSON file into Apple-shaped records. Unknown files give []. */
  function toRecords(name, text, opts) {
    const k = kind(name);
    if (!k) return [];
    const offsetFor = (opts && opts.offsetFor) || localOffset;
    let rows;
    try { rows = JSON.parse(text); } catch (e) { throw new Error(`${name.split('/').pop()} is not valid JSON`); }
    if (!Array.isArray(rows)) throw new Error(`${name.split('/').pop()} is not a list of readings`);
    const out = [];
    const rec = (type, a, b, value) => out.push({ type, sourceName: SOURCE, startDate: stamp(a, offsetFor(a)), endDate: stamp(b, offsetFor(b)), value: String(value) });

    if (k === 'heart_rate') {
      const seen = new Set();
      for (const r of rows) {
        const t = usUtc(r && r.dateTime), bpm = r && r.value && +r.value.bpm;
        if (!isFinite(t) || !isFinite(bpm)) continue;
        const minute = Math.floor(t / 60000);
        if (seen.has(minute)) continue; // first reading in each minute, like the FIT adapter
        seen.add(minute); rec(T_HR, t, t, bpm);
      }
    } else if (k === 'steps') {
      for (const r of rows) {
        const t = usUtc(r && r.dateTime), v = r && +r.value;
        if (!isFinite(t) || !(v > 0)) continue;
        rec(T_STEPS, t, t + 60000, v);
      }
    } else {
      for (const log of rows) {
        const data = log && log.levels && Array.isArray(log.levels.data) ? log.levels.data : null;
        if (data && data.length) {
          for (const seg of data) {
            const a = isoLocal(seg.dateTime, offsetFor), secs = +seg.seconds;
            if (!isFinite(a) || !(secs > 0)) continue;
            rec(T_SLEEP, a, a + secs * 1000, AWAKE.test(seg.level || '') ? 'HKCategoryValueSleepAnalysisAwake' : 'HKCategoryValueSleepAnalysisAsleepUnspecified');
          }
        } else {
          const a = isoLocal(log && log.startTime, offsetFor), b = isoLocal(log && log.endTime, offsetFor);
          if (isFinite(a) && b > a) rec(T_SLEEP, a, b, 'HKCategoryValueSleepAnalysisAsleepUnspecified');
        }
      }
    }
    return out;
  }

  /* Feed one Takeout JSON file into an analyzer from analyzer.js. Returns how many records it added. */
  function feed(name, text, analyzer, opts) {
    const r = toRecords(name, text, opts);
    r.forEach((x) => analyzer.addRecord(x));
    return r.length;
  }

  return { kind, toRecords, feed, stamp };
});
