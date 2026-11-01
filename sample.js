/* Synthetic Apple Health export.xml with known, injected faults (ground truth in `truth`). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.WearableSample = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function rng(seed) {
    let s = seed >>> 0;
    return () => {
      s = (s + 0x6D2B79F5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const ts = (min) => new Date(min * 60000).toISOString().slice(0, 19).replace('T', ' ') + ' +0000';

  function generate(opts) {
    const days = (opts && opts.days) || 60;
    const r = rng((opts && opts.seed) || 7);
    const start0 = Date.UTC(2026, 8, 1) / 86400000;
    const WATCH = 'Sam’s Apple Watch', PHONE = 'Sam’s iPhone';
    const T = { s: 'HKQuantityTypeIdentifierStepCount', h: 'HKQuantityTypeIdentifierHeartRate', z: 'HKCategoryTypeIdentifierSleepAnalysis' };
    const out = [];
    const rec = (type, src, s, e, val, unit) => out.push(
      `<Record type="${type}" sourceName="${src}" sourceVersion="11.0" ${unit ? `unit="${unit}" ` : ''}creationDate="${ts(e)}" startDate="${ts(s)}" endDate="${ts(e)}" value="${val}"/>`);
    const hr = (s, v) => rec(T.h, WATCH, s, s, Math.round(v), 'count/min');
    const steps = (src, s, e, v) => rec(T.s, src, s, e, Math.round(v), 'count');
    const sleep = (src, s, e, stage) => rec(T.z, src, s, e, 'HKCategoryValueSleepAnalysis' + stage);
    const rnd = (a, b) => a + r() * (b - a);

    const truth = {
      weddingDay: 12, dupDay: 30, deskDay: 41, blipDays: [8, 15, 23, 37, 50], impossibleDays: [44, 52], darkDays: [20, 21], days
    };

    function night(dayIdx, startMin, endMin, watchHr, skipFrom, skipTo) {
      let m = startMin, c = 0;
      const stages = ['Core', 'Deep', 'REM'], lens = [50, 25, 25];
      while (m < endMin) {
        const k = c % 3, e = Math.min(endMin, m + lens[k]);
        sleep(WATCH, m, e, 'Asleep' + stages[k]);
        m = e;
        if (c % 3 === 2 && m < endMin) { const a = Math.min(endMin, m + 5); sleep(WATCH, m, a, 'Awake'); m = a; }
        c++;
      }
      if (watchHr) for (let t = startMin + 5; t < endMin; t += 10) if (!(t >= skipFrom && t < skipTo)) hr(t, rnd(48, 60));
    }

    for (let i = 0; i < days; i++) {
      const d0 = (start0 + i) * 1440;
      const dark = truth.darkDays.includes(i);
      const wake = d0 + 390 + Math.round(rnd(0, 60));
      const bed = d0 - 1440 + 1365 + Math.round(rnd(0, 60));

      /* sleep ending this morning */
      if (!dark) {
        if (i === truth.weddingDay) {
          night(i, d0 - 60, d0 + 510, true, d0 + 20, d0 + 160);
          for (let t = d0 + 30; t < d0 + 150; t += 5) hr(t, rnd(100, 130)); // dancing
          steps(WATCH, d0 + 40, d0 + 55, 1050); steps(WATCH, d0 + 60, d0 + 75, 1100);
        } else if (i === truth.deskDay) {
          night(i, d0 - 1440 + 1290, d0 + 700, false); // 14h, no pulse
        } else {
          night(i, bed, wake, true);
          if (i === truth.dupDay) sleep(PHONE, bed, wake, 'AsleepUnspecified');
        }
      }

      /* waking day */
      if (!dark) {
        const charge = r() < 0.8;
        const dayStart = charge ? d0 + 500 : wake;
        for (let t = dayStart; t < d0 + 1365; t += Math.round(rnd(5, 8))) hr(t, rnd(62, 88));
      }
      const nBlocks = 7 + Math.floor(r() * 3);
      const used = new Set();
      for (let b = 0; b < nBlocks; b++) {
        const slot = Math.floor(rnd(9 * 4, 21 * 4)); if (used.has(slot)) continue; used.add(slot);
        const s = d0 + slot * 15, e = s + 15, v = rnd(500, 1100);
        if (!dark) {
          steps(WATCH, s, e, v);
          for (let t = s; t < e; t += 3) hr(t + 1, rnd(92, 118));
        }
        if (r() < 0.5) steps(PHONE, s, e, v * 0.7); // phone in pocket: same walk counted twice
      }

      /* workouts every 3rd day */
      if (!dark && i % 3 === 1) {
        const s = d0 + 1080, e = s + 40;
        out.push(`<Workout workoutActivityType="HKWorkoutActivityTypeRunning" duration="40" durationUnit="min" sourceName="${WATCH}" creationDate="${ts(e)}" startDate="${ts(s)}" endDate="${ts(e)}">\n </Workout>`);
        for (let t = s; t < e; t += 2) hr(t, rnd(140, 172));
        steps(WATCH, s, e, 6400);
      }

      /* sensor glitches */
      if (truth.blipDays.includes(i)) { const t = d0 + 14 * 60 + Math.round(rnd(0, 20)) * 2; hr(t, 71); hr(t + 2, 184); hr(t + 4, 73); }
      if (i === truth.impossibleDays[0]) hr(d0 + 15 * 60 + 1, 251);
      if (i === truth.impossibleDays[1]) hr(d0 + 16 * 60 + 1, 14);
    }

    const xml = '<?xml version="1.0" encoding="UTF-8"?>\n<HealthData locale="en_US">\n' + out.join('\n') + '\n</HealthData>\n';
    return { xml, truth };
  }

  return { generate };
});
