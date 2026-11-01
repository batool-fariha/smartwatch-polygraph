/* Wearable data-trust analyzer (Apple Health export.xml).
   Streaming parser + cross-signal consistency checks. Runs in browser and node. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.WearableTrust = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DAY = 1440;
  const W = 0, P = 1, O = 2; // source classes: watch/band, phone, other
  const T_STEPS = 'HKQuantityTypeIdentifierStepCount';
  const T_HR = 'HKQuantityTypeIdentifierHeartRate';
  const T_SLEEP = 'HKCategoryTypeIdentifierSleepAnalysis';

  // Timestamps are read as wall-clock time ("2024-05-01 23:10:00 +0200" -> 23:10), in minutes.
  function parseTime(s) {
    return Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10), +s.slice(11, 13), +s.slice(14, 16)) / 60000;
  }
  function srcClass(name) {
    const n = name.toLowerCase();
    if (/watch|fitbit|garmin|whoop|oura|band|polar|coros|suunto/.test(n)) return W;
    if (/iphone|phone|ipad/.test(n)) return P;
    return O;
  }
  function lowerBound(arr, x) {
    let lo = 0, hi = arr.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] < x) lo = mid + 1; else hi = mid; }
    return lo;
  }
  function median(a) {
    if (!a.length) return null;
    const s = Float64Array.from(a).sort();
    return s[s.length >> 1];
  }
  const fmtDur = (min) => `${Math.floor(min / 60)}h ${String(Math.round(min % 60)).padStart(2, '0')}m`;
  const fmtDay = (di) => new Date(di * 86400000).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  const hhmm = (min) => new Date(min * 60000).toISOString().slice(11, 16);
  const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

  /* ---------- streaming XML parser ---------- */
  function createParser(analyzer) {
    let buf = '';
    const attrRe = /([A-Za-z]+)="([^"]*)"/g;
    const tagRe = /<(Record|Workout)\s([^>]*)>/g;
    function attrs(t) {
      const o = {}; attrRe.lastIndex = 0; let m;
      while ((m = attrRe.exec(t))) o[m[1]] = m[2];
      return o;
    }
    function feed(chunk) {
      buf += chunk;
      tagRe.lastIndex = 0;
      let m, last = 0;
      while ((m = tagRe.exec(buf))) {
        last = tagRe.lastIndex;
        const body = m[2];
        if (m[1] === 'Record') {
          if (body.includes('StepCount') || body.includes('HeartRate') || body.includes('SleepAnalysis')) analyzer.addRecord(attrs(body));
        } else analyzer.addWorkout(attrs(body));
      }
      buf = buf.slice(Math.max(last, buf.lastIndexOf('<')));
    }
    return { feed };
  }

  /* ---------- analyzer ---------- */
  function createAnalyzer() {
    const steps = new Map(); // minute -> [watch, phone, other]
    const hrRaw = { t: [], v: [], c: [] };
    const sleepRaw = [];
    const workoutRaw = [];
    const counts = { steps: 0, hr: 0, sleep: 0, workouts: 0 };

    function addStep(m, c, v) {
      let a = steps.get(m);
      if (!a) { a = [0, 0, 0]; steps.set(m, a); }
      a[c] += v;
    }

    function addRecord(a) {
      if (!a.startDate || !a.endDate) return;
      const t = a.type, s = parseTime(a.startDate);
      const c = srcClass(a.sourceName || '');
      if (t === T_STEPS) {
        const v = +a.value; if (!(v >= 0)) return;
        const e = Math.max(s + 1, parseTime(a.endDate)), dur = e - s;
        counts.steps++;
        if (dur <= 30) { const per = v / dur; for (let m = s; m < e; m++) addStep(m, c, per); }
        else addStep(s, c, v);
      } else if (t === T_HR) {
        const v = +a.value; if (!isFinite(v)) return;
        hrRaw.t.push(s); hrRaw.v.push(v); hrRaw.c.push(c); counts.hr++;
      } else if (t === T_SLEEP) {
        const val = a.value || '';
        const k = /InBed/.test(val) ? 0 : /Awake/.test(val) ? 2 : 1; // 0 in bed, 1 asleep, 2 awake
        sleepRaw.push({ s, e: parseTime(a.endDate), k, c }); counts.sleep++;
      }
    }
    function addWorkout(a) {
      if (!a.startDate || !a.endDate) return;
      workoutRaw.push([parseTime(a.startDate), parseTime(a.endDate)]); counts.workouts++;
    }

    function finish() {
      /* sort heart rate */
      const n = hrRaw.t.length;
      const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => hrRaw.t[a] - hrRaw.t[b]);
      const ht = new Float64Array(n), hv = new Float32Array(n), hc = new Uint8Array(n);
      for (let i = 0; i < n; i++) { const j = order[i]; ht[i] = hrRaw.t[j]; hv[i] = hrRaw.v[j]; hc[i] = hrRaw.c[j]; }

      /* time range */
      let minAll = Infinity, maxAll = -Infinity;
      if (n) { minAll = ht[0]; maxAll = ht[n - 1]; }
      for (const m of steps.keys()) { if (m < minAll) minAll = m; if (m > maxAll) maxAll = m; }
      for (const x of sleepRaw) { if (x.s < minAll) minAll = x.s; if (x.e > maxAll) maxAll = x.e; }
      if (!isFinite(minAll)) return { empty: true, counts };
      const firstDay = Math.floor(minAll / DAY), lastDay = Math.floor(maxAll / DAY), nDays = lastDay - firstDay + 1;
      const base = firstDay * DAY;

      const wFlag = new Uint8Array(nDays * DAY + 1);
      for (const [s, e] of workoutRaw) for (let m = Math.max(base, Math.floor(s) - 10); m <= Math.min(base + nDays * DAY, e + 10); m++) wFlag[m - base] = 1;
      const inW = (m) => wFlag[m - base] === 1;
      const stepsAt = (m) => { const a = steps.get(m); return a ? Math.max(a[0], a[1], a[2]) : 0; };

      const receipts = [];
      const dayOf = (m) => Math.floor(m / DAY) - firstDay;

      /* ===== heart rate plausibility ===== */
      const dayBad = new Int32Array(nDays);
      let impossible = 0, blips = 0;
      const blipEv = [], impEv = [];
      for (let i = 0; i < n; i++) {
        const v = hv[i];
        if (v < 30 || v > 230) { impossible++; dayBad[dayOf(ht[i])]++; impEv.push({ m: ht[i], v }); }
        if (i > 0 && i < n - 1) {
          const p = hv[i - 1], nx = hv[i + 1];
          if (ht[i + 1] - ht[i - 1] <= 10 && Math.abs(v - p) >= 60 && Math.abs(v - nx) >= 60 && Math.abs(p - nx) <= 25 &&
              v >= 30 && v <= 230 && !inW(ht[i])) {
            blips++; dayBad[dayOf(ht[i])]++; blipEv.push({ m: ht[i], v, p, nx });
          }
        }
      }
      const hrBad = impossible + blips;
      const hrScore = n >= 100 ? clamp(100 - (hrBad / n) * 4000, 0, 100) : null;
      blipEv.sort((a, b) => Math.abs(b.v - (b.p + b.nx) / 2) - Math.abs(a.v - (a.p + a.nx) / 2));
      for (const b of blipEv.slice(0, 2)) receipts.push({
        kind: 'hr', severity: 62, date: fmtDay(Math.floor(b.m / DAY)),
        title: `Heart rate "jumped" to ${Math.round(b.v)} bpm for a single reading`,
        detail: `At ${hhmm(b.m)} on ${fmtDay(Math.floor(b.m / DAY))} it read ${Math.round(b.p)}, then ${Math.round(b.v)}, then ${Math.round(b.nx)} bpm within minutes, outside any workout. A physiological spike doesn't reverse itself that fast; this is a sensor glitch (usually a loose strap).`
      });
      impEv.sort((a, b) => Math.abs(b.v - 130) - Math.abs(a.v - 130));
      for (const b of impEv.slice(0, 2)) receipts.push({
        kind: 'hr', severity: 72, date: fmtDay(Math.floor(b.m / DAY)),
        title: `An impossible heart rate: ${Math.round(b.v)} bpm`,
        detail: `Recorded at ${hhmm(b.m)} on ${fmtDay(Math.floor(b.m / DAY))}. Outside 30–230 bpm isn't a plausible human reading; it's stored in your export all the same.`
      });

      /* ===== sleep vs. body ===== */
      const asl = sleepRaw.filter((x) => x.k === 1).sort((a, b) => a.s - b.s);
      const blocks = [];
      for (const iv of asl) {
        const b = blocks[blocks.length - 1];
        if (b && iv.s <= b.e) { b.e = Math.max(b.e, iv.e); b.raw += iv.e - iv.s; b.cls |= 1 << iv.c; }
        else blocks.push({ s: iv.s, e: iv.e, raw: iv.e - iv.s, cls: 1 << iv.c });
      }
      const sessions = [];
      for (const b of blocks) {
        const cur = sessions[sessions.length - 1];
        if (cur && b.s - cur.e <= 90) { cur.e = b.e; cur.blocks.push(b); cur.asleepMin += b.e - b.s; cur.raw += b.raw; cur.cls |= b.cls; }
        else sessions.push({ s: b.s, e: b.e, blocks: [b], asleepMin: b.e - b.s, raw: b.raw, cls: b.cls });
      }
      const scored = sessions.filter((x) => x.asleepMin >= 90);

      const sleepHr = [];
      for (const b of blocks) for (let i = lowerBound(ht, b.s); i < n && ht[i] < b.e; i++) sleepHr.push(hv[i]);
      const medSleepHr = median(sleepHr);
      const thr = Math.max(90, (medSleepHr || 60) + 30);

      let sleepNum = 0, sleepDen = 0, flaggedNights = 0;
      const sleepPenByDay = new Map();
      for (const ss of scored) {
        let hrN = 0, hrElev = 0, hrPeak = 0;
        const elev = new Set(), walk = new Set();
        let walkSteps = 0;
        for (const b of ss.blocks) {
          for (let i = lowerBound(ht, b.s); i < n && ht[i] < b.e; i++) {
            const v = hv[i]; hrN++; if (v > hrPeak) hrPeak = v;
            if (v >= thr) {
              hrElev++;
              for (let d = -2; d <= 2; d++) { const m = ht[i] + d; if (m >= b.s && m < b.e) elev.add(m); }
            }
          }
          for (let m = Math.ceil(b.s); m < b.e; m++) { const st = stepsAt(m); if (st >= 40) { walk.add(m); walkSteps += st; } }
        }
        let conflict = walk.size;
        for (const m of elev) if (!walk.has(m)) conflict++;
        const fraction = conflict / ss.asleepMin;
        const pens = [];
        pens.push({ key: 'conflict', pen: conflict >= 15 && fraction >= 0.05 ? Math.min(1, fraction * 4) : Math.min(0.15, fraction * 2) });
        if (ss.asleepMin > 720) pens.push({ key: 'long', pen: 0.25 });
        if (ss.raw / ss.asleepMin > 1.25) pens.push({ key: 'dup', pen: Math.min(0.4, (ss.raw / ss.asleepMin - 1) * 0.4) });
        if ((ss.cls & 1) && hrN < Math.max(1, ss.asleepMin / 120)) pens.push({ key: 'noev', pen: 0.2 });
        const trust = clamp(1 - pens.reduce((a, p) => a + p.pen, 0), 0, 1);
        sleepNum += trust * ss.asleepMin; sleepDen += ss.asleepMin;
        const wakeDi = Math.floor(ss.e / DAY) - firstDay;
        sleepPenByDay.set(wakeDi, Math.max(sleepPenByDay.get(wakeDi) || 0, 1 - trust));
        if (trust < 0.8) {
          flaggedNights++;
          const main = pens.slice().sort((a, b) => b.pen - a.pen)[0].key;
          const dur = fmtDur(ss.asleepMin), day = fmtDay(wakeDi + firstDay);
          let title, detail;
          if (main === 'conflict') {
            const bits = [];
            if (hrElev) bits.push(`${hrElev} heart-rate readings at ${Math.round(thr)}+ bpm (peak ${Math.round(hrPeak)})`);
            if (walk.size) bits.push(`${walk.size} minutes of walking-pace movement (${Math.round(walkSteps)} steps)`);
            title = `Logged ${dur} of sleep on ${day}, but your body was up`;
            detail = `Your own data inside that sleep window contains ${bits.join(' and ')}. Your normal sleeping heart rate is about ${Math.round(medSleepHr || 0)} bpm. The watch decided "still wrist = asleep" and ignored the rest of its sensors.`;
          } else if (main === 'long') {
            title = `${dur} of "sleep" on ${day}: the watch was probably on a table`;
            detail = `That's longer than almost anyone sleeps, and the window holds only ${hrN} heart-rate readings. A still wrist with little pulse data gets logged as sleep.`;
          } else if (main === 'dup') {
            title = `Slept ${dur} on ${day}, or ${fmtDur(ss.raw)} if you add up the export`;
            detail = `Two sources (e.g. phone and watch) both logged the same night as asleep. Anyone summing the raw export counts it twice.`;
          } else {
            title = `${dur} of sleep on ${day} without any heart-rate data`;
            detail = `A watch logged the sleep, but only ${hrN} pulse readings exist in that window. Nothing corroborates it.`;
          }
          receipts.push({ kind: 'sleep', severity: Math.round((1 - trust) * 100), date: day, title, detail });
        }
      }
      const sleepScore = sleepDen ? (sleepNum / sleepDen) * 100 : null;

      /* ===== steps: double counting ===== */
      const dayRaw = new Float64Array(nDays), dayDedup = new Float64Array(nDays);
      let rawTot = 0, dedupTot = 0, implaus = 0;
      for (const [m, a] of steps) {
        const di = dayOf(m), raw = a[0] + a[1] + a[2], mx = Math.max(a[0], a[1], a[2]);
        dayRaw[di] += raw; dayDedup[di] += mx; rawTot += raw; dedupTot += mx;
        if (mx > 250) implaus++;
      }
      const infl = dedupTot ? rawTot / dedupTot - 1 : 0;
      const stepsScore = dedupTot ? clamp(100 * (1 - Math.min(1, infl * 1.5)) - Math.min(20, implaus / 10), 0, 100) : null;
      const stepPenByDay = new Map();
      const stepDays = [];
      for (let di = 0; di < nDays; di++) {
        if (dayDedup[di] > 0) {
          const f = dayRaw[di] / dayDedup[di] - 1;
          stepPenByDay.set(di, Math.min(30, f * 60));
          if (f > 0.2 && dayRaw[di] - dayDedup[di] > 500) stepDays.push({ di, raw: dayRaw[di], dedup: dayDedup[di], f });
        }
      }
      stepDays.sort((a, b) => b.raw - b.dedup - (a.raw - a.dedup));
      for (const d of stepDays.slice(0, 3)) receipts.push({
        kind: 'steps', severity: Math.round(Math.min(100, d.f * 100)), date: fmtDay(d.di + firstDay),
        title: `${Math.round(d.raw).toLocaleString('en-US')} steps on ${fmtDay(d.di + firstDay)}, but you only moved ${Math.round(d.dedup).toLocaleString('en-US')}`,
        detail: `Phone and watch both recorded the same walking, so the raw export overstates the day by ${Math.round(d.f * 100)}%. Apple's own Health app de-duplicates this, but anyone analysing the raw export (apps, researchers, clinical pipelines) doesn't.`
      });

      /* ===== coverage / gaps ===== */
      const useHr = n >= 100;
      const hours = new Uint8Array(nDays * 24);
      if (useHr) for (let i = 0; i < n; i++) hours[Math.floor(ht[i] / 60) - firstDay * 24] = 1;
      else for (const [m, a] of steps) if (a[0] + a[1] + a[2] > 0) hours[Math.floor(m / 60) - firstDay * 24] = 1;
      let fh = hours.indexOf(1), lh = hours.lastIndexOf(1);
      let coverageScore = null, recurring = null, darkRuns = [], hoursLost = 0, coverageDays = 0, avgHours = 0;
      const covByDay = new Map();
      if (fh >= 0) {
        const d0 = Math.floor(fh / 24), d1 = Math.floor(lh / 24);
        let sum = 0;
        const dark = [];
        for (let d = d0; d <= d1; d++) {
          let c = 0; for (let h = 0; h < 24; h++) c += hours[d * 24 + h];
          sum += Math.min(1, c / 18); avgHours += c; covByDay.set(d, c);
          if (c === 0) dark.push(d);
        }
        coverageDays = d1 - d0 + 1; avgHours /= coverageDays;
        coverageScore = (sum / coverageDays) * 100;
        const startHist = new Array(24).fill(0);
        for (let h = fh; h <= lh;) {
          if (hours[h]) { h++; continue; }
          let e = h; while (e <= lh && !hours[e]) e++;
          const L = e - h;
          if (L <= 5 && Math.floor(h / 24) === Math.floor((e - 1) / 24)) { startHist[h % 24]++; hoursLost += L; }
          h = e;
        }
        let bestH = 0; for (let h = 1; h < 24; h++) if (startHist[h] > startHist[bestH]) bestH = h;
        if (startHist[bestH] / coverageDays >= 0.3) recurring = { hour: bestH, days: startHist[bestH], of: coverageDays };
        for (let i = 0; i < dark.length;) {
          let j = i; while (j + 1 < dark.length && dark[j + 1] === dark[j] + 1) j++;
          darkRuns.push({ from: dark[i], len: j - i + 1 }); i = j + 1;
        }
        if (recurring) receipts.push({
          kind: 'coverage', severity: 45, date: '',
          title: `Your watch goes dark around ${String(recurring.hour).padStart(2, '0')}:00 on ${recurring.days} of ${recurring.of} days`,
          detail: `That's the charging window. It silently removes about ${(hoursLost / coverageDays).toFixed(1)} h/day from your record, and anything computed per-day (average heart rate, active time) is computed over a different slice of the day each time.`
        });
        darkRuns.sort((a, b) => b.len - a.len);
        for (const r of darkRuns.slice(0, 1)) receipts.push({
          kind: 'coverage', severity: 55, date: fmtDay(r.from + firstDay),
          title: `${r.len} day${r.len > 1 ? 's' : ''} of nothing starting ${fmtDay(r.from + firstDay)}`,
          detail: `No heart-rate data at all. In a daily summary these days look like "0", not "missing", unless the reader knows to check.`
        });
      }

      /* ===== daily map ===== */
      const daily = [];
      for (let di = 0; di < nDays; di++) {
        const c = covByDay.get(di); // keyed by day index relative to firstDay
        if (c === undefined) { daily.push({ day: firstDay + di, score: null }); continue; }
        const sp = (sleepPenByDay.get(di) || 0) * 40;
        const tp = stepPenByDay.get(di) || 0;
        const hp = Math.min(20, dayBad[di] * 8);
        const cp = (1 - Math.min(1, c / 18)) * 30;
        daily.push({ day: firstDay + di, score: Math.round(clamp(100 - sp - tp - hp - cp, 0, 100)) });
      }

      /* ===== overall ===== */
      const parts = [['sleep', sleepScore, 0.3], ['steps', stepsScore, 0.25], ['hr', hrScore, 0.2], ['coverage', coverageScore, 0.25]];
      let ws = 0, wt = 0; for (const [, s, w] of parts) if (s !== null) { ws += s * w; wt += w; }
      const overall = wt ? ws / wt : null;
      const grade = overall === null ? null : overall >= 90 ? 'Trustworthy' : overall >= 75 ? 'Mostly honest' : overall >= 55 ? 'Gets creative' : overall >= 35 ? 'Unreliable narrator' : 'Pathological liar';

      /* diversify receipts */
      const cap = { sleep: 4, steps: 2, hr: 3, coverage: 2 };
      const used = { sleep: 0, steps: 0, hr: 0, coverage: 0 };
      const top = receipts.sort((a, b) => b.severity - a.severity).filter((r) => (used[r.kind]++ < cap[r.kind])).slice(0, 12);

      return {
        empty: false, counts,
        span: { firstDay, lastDay, days: nDays, from: fmtDay(firstDay), to: fmtDay(lastDay) },
        scores: { overall, sleep: sleepScore, steps: stepsScore, hr: hrScore, coverage: coverageScore },
        grade,
        facts: {
          nights: scored.length, flaggedNights, sleepHrThreshold: Math.round(thr), medianSleepHr: medSleepHr,
          rawSteps: Math.round(rawTot), dedupSteps: Math.round(dedupTot), inflation: infl, implausibleStepMinutes: implaus,
          hrSamples: n, hrImpossible: impossible, hrBlips: blips,
          coverageDays, avgHoursWithData: avgHours, hoursLostToShortGaps: hoursLost, recurringGap: recurring,
          darkDays: darkRuns.reduce((a, r) => a + r.len, 0), longestDark: darkRuns[0] ? darkRuns[0].len : 0
        },
        receipts: top, daily
      };
    }

    return { addRecord, addWorkout, finish, counts };
  }

  return { createAnalyzer, createParser, fmtDay, fmtDur };
});
