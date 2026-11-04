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

  // A timestamp ("2024-05-01 23:10:00 +0200") is local wall-clock time plus the UTC offset in force at that moment.
  // parseTime returns absolute minutes (UTC) so durations and overlaps stay right across daylight saving and travel,
  // and leaves the offset it read in lastOff so the analyzer can map absolute time back to the wearer's local clock.
  let lastOff = 0;
  function parseTime(s) {
    const wall = Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10), +s.slice(11, 13), +s.slice(14, 16)) / 60000;
    let off = 0;
    if (s.length >= 25) {
      const sign = s.charCodeAt(20);
      if (sign === 43 || sign === 45) { off = +s.slice(21, 23) * 60 + +s.slice(23, 25); if (off !== off) off = 0; else if (sign === 45) off = -off; }
    }
    lastOff = off;
    return wall - off;
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
  const joinNames = (a) => a.length < 3 ? a.join(' and ') : a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1];
  const KIND = ['watch', 'phone', 'other'];

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
    const steps = new Map(); // day index -> Float32Array(3 * 1440): watch, phone, other per minute
    const hrRaw = { t: [], v: [], c: [], n: [] };
    const names = [], nameIdx = new Map(), srcCls = [], srcStat = [];   // one entry per sourceName
    function srcId(name, c) {
      let i = nameIdx.get(name);
      if (i === undefined) {
        i = Math.min(names.length, 65534); nameIdx.set(name, i);
        if (i === names.length) { names.push(name); srcCls.push(c); srcStat.push({ steps: 0, hr: 0, sleep: 0 }); }
      }
      return i;
    }
    const sleepRaw = [];
    const workoutRaw = [];
    const counts = { steps: 0, hr: 0, sleep: 0, workouts: 0 };
    const offObs = new Map(); let lastBucket = NaN, lastObsOff = NaN;   // 15-minute bucket -> UTC offset seen there
    function noteOff(t, off) {
      const b = Math.floor(t / 15);
      if (b !== lastBucket || off !== lastObsOff) { offObs.set(b, off); lastBucket = b; lastObsOff = off; }
    }

    function addStep(m, c, v) {
      const di = Math.floor(m / DAY);
      let a = steps.get(di);
      if (!a) { a = new Float32Array(3 * DAY); steps.set(di, a); }
      a[c * DAY + (m - di * DAY)] += v;
    }

    function addRecord(a) {
      if (!a.startDate || !a.endDate) return;
      const t = a.type, s = parseTime(a.startDate); noteOff(s, lastOff);
      const nm = a.sourceName || 'Unknown source', c = srcClass(nm), sid = srcId(nm, c);
      if (t === T_STEPS) {
        const v = +a.value; if (!(v >= 0)) return;
        const e = Math.max(s + 1, parseTime(a.endDate)), dur = e - s; noteOff(e, lastOff);
        counts.steps++; srcStat[sid].steps++;
        if (dur <= 30) { const per = v / dur; for (let m = s; m < e; m++) addStep(m, c, per); }
        else addStep(s, c, v);
      } else if (t === T_HR) {
        const v = +a.value; if (!isFinite(v)) return;
        hrRaw.t.push(s); hrRaw.v.push(v); hrRaw.c.push(c); hrRaw.n.push(sid); srcStat[sid].hr++; counts.hr++;
      } else if (t === T_SLEEP) {
        const val = a.value || '';
        const k = /InBed/.test(val) ? 0 : /Awake/.test(val) ? 2 : 1; // 0 in bed, 1 asleep, 2 awake
        const e = parseTime(a.endDate); noteOff(e, lastOff);
        sleepRaw.push({ s, e, k, c, n: sid }); srcStat[sid].sleep++; counts.sleep++;
      }
    }
    function addWorkout(a) {
      if (!a.startDate || !a.endDate) return;
      const s = parseTime(a.startDate); noteOff(s, lastOff);
      workoutRaw.push([s, parseTime(a.endDate)]); counts.workouts++;
    }

    function finish() {
      /* sort heart rate */
      const n = hrRaw.t.length;
      const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => hrRaw.t[a] - hrRaw.t[b]);
      const ht = new Float64Array(n), hv = new Float32Array(n), hc = new Uint8Array(n), hn = new Uint16Array(n);
      for (let i = 0; i < n; i++) { const j = order[i]; ht[i] = hrRaw.t[j]; hv[i] = hrRaw.v[j]; hc[i] = hrRaw.c[j]; hn[i] = hrRaw.n[j]; }

      /* time range */
      let minAll = Infinity, maxAll = -Infinity;
      if (n) { minAll = ht[0]; maxAll = ht[n - 1]; }
      for (const [uday, a] of steps) {
        let f = -1, l = -1;
        for (let i = 0; i < DAY; i++) if (a[i] || a[DAY + i] || a[2 * DAY + i]) { if (f < 0) f = i; l = i; }
        if (f >= 0) { if (uday * DAY + f < minAll) minAll = uday * DAY + f; if (uday * DAY + l > maxAll) maxAll = uday * DAY + l; }
      }
      for (const x of sleepRaw) { if (x.s < minAll) minAll = x.s; if (x.e > maxAll) maxAll = x.e; }
      if (!isFinite(minAll)) return { empty: true, counts };
      /* the wearer's UTC offset over time, from the offsets the records carry (piecewise constant) */
      const segs = [];
      for (const b of [...offObs.keys()].sort((x, y) => x - y)) { const o = offObs.get(b); if (!segs.length || segs[segs.length - 1].off !== o) segs.push({ from: b * 15, off: o }); }
      const offsetAt = (m) => {
        if (!segs.length || m < segs[0].from) return segs.length ? segs[0].off : 0;
        let lo = 0, hi = segs.length - 1;
        while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (segs[mid].from <= m) lo = mid; else hi = mid - 1; }
        return segs[lo].off;
      };
      const localMin = (m) => m + offsetAt(m);                       // minutes on the wearer's wall clock
      const ldayAbs = (m) => Math.floor(localMin(m) / DAY);          // local calendar day
      const firstDay = ldayAbs(minAll), lastDay = ldayAbs(maxAll), nDays = lastDay - firstDay + 1;

      const ubase = Math.floor(minAll) - 15, usize = Math.ceil(maxAll) - ubase + 31;   // workout flags live on the absolute axis
      const wFlag = new Uint8Array(usize);
      for (const [s, e] of workoutRaw) for (let m = Math.max(ubase, Math.floor(s) - 10); m <= Math.min(ubase + usize - 1, e + 10); m++) wFlag[m - ubase] = 1;
      const inW = (m) => { const k = m - ubase; return k >= 0 && k < usize && wFlag[k] === 1; };
      const stepsAt = (m) => { const di = Math.floor(m / DAY), a = steps.get(di); if (!a) return 0; const i = m - di * DAY; return Math.max(a[i], a[DAY + i], a[2 * DAY + i]); };

      const receipts = [];
      const dayOf = (m) => Math.min(nDays - 1, Math.max(0, ldayAbs(m) - firstDay));
      const around = (m, w) => { const out = []; for (let i = lowerBound(ht, m - w); i < n && ht[i] <= m + w; i++) out.push([ht[i], Math.round(hv[i])]); return out; };

      /* ===== heart rate plausibility ===== */
      const dayBad = new Int32Array(nDays);
      let impossible = 0, blips = 0;
      const blipEv = [], impEv = [];
      for (let i = 0; i < n; i++) {
        const v = hv[i];
        if (v < 30 || v > 230) { impossible++; dayBad[dayOf(ht[i])]++; impEv.push({ m: ht[i], v, sid: hn[i] }); }
        if (i > 0 && i < n - 1) {
          const p = hv[i - 1], nx = hv[i + 1];
          if (ht[i + 1] - ht[i - 1] <= 10 && Math.abs(v - p) >= 60 && Math.abs(v - nx) >= 60 && Math.abs(p - nx) <= 25 &&
              v >= 30 && v <= 230 && !inW(ht[i])) {
            blips++; dayBad[dayOf(ht[i])]++; blipEv.push({ m: ht[i], v, p, nx, sid: hn[i] });
          }
        }
      }
      const hrBad = impossible + blips;
      const hrScore = n >= 100 ? clamp(100 - (hrBad / n) * 4000, 0, 100) : null;
      blipEv.sort((a, b) => Math.abs(b.v - (b.p + b.nx) / 2) - Math.abs(a.v - (a.p + a.nx) / 2));
      for (const b of blipEv.slice(0, 2)) receipts.push({
        kind: 'hr', severity: 62, date: fmtDay(ldayAbs(b.m)), day: ldayAbs(b.m), chart: { type: 'blip', at: b.m, off: offsetAt(b.m), v: Math.round(b.v), pts: around(b.m, 20) },
        sources: [names[b.sid]], fix: 'Check how snugly the band sits. Readings like this are usually a loose strap, and they are safe to filter out.',
        title: `Heart rate "jumped" to ${Math.round(b.v)} bpm for a single reading`,
        detail: `${names[b.sid]} recorded ${Math.round(b.p)}, then ${Math.round(b.v)}, then ${Math.round(b.nx)} bpm within minutes at ${hhmm(localMin(b.m))} on ${fmtDay(ldayAbs(b.m))}, outside any workout. A physiological spike doesn't reverse itself that fast; this is a sensor glitch.`
      });
      impEv.sort((a, b) => Math.abs(b.v - 130) - Math.abs(a.v - 130));
      for (const b of impEv.slice(0, 2)) receipts.push({
        kind: 'hr', severity: 72, date: fmtDay(ldayAbs(b.m)), day: ldayAbs(b.m), chart: { type: 'blip', at: b.m, off: offsetAt(b.m), v: Math.round(b.v), pts: around(b.m, 20) },
        sources: [names[b.sid]], fix: 'Check how snugly the band sits, and filter readings outside 30–230 bpm before averaging.',
        title: `An impossible heart rate: ${Math.round(b.v)} bpm`,
        detail: `${names[b.sid]} recorded this at ${hhmm(localMin(b.m))} on ${fmtDay(ldayAbs(b.m))}. Outside 30–230 bpm isn't a plausible human reading; it's stored in your export all the same.`
      });

      /* ===== sleep vs. body ===== */
      const asl = sleepRaw.filter((x) => x.k === 1).sort((a, b) => a.s - b.s);
      const blocks = [];
      for (const iv of asl) {
        const b = blocks[blocks.length - 1];
        if (b && iv.s <= b.e) { b.e = Math.max(b.e, iv.e); b.raw += iv.e - iv.s; b.cls |= 1 << iv.c; b.srcs.add(iv.n); }
        else blocks.push({ s: iv.s, e: iv.e, raw: iv.e - iv.s, cls: 1 << iv.c, srcs: new Set([iv.n]) });
      }
      const sessions = [];
      for (const b of blocks) {
        const cur = sessions[sessions.length - 1];
        if (cur && b.s - cur.e <= 90) { cur.e = b.e; cur.blocks.push(b); cur.asleepMin += b.e - b.s; cur.raw += b.raw; cur.cls |= b.cls; b.srcs.forEach((x) => cur.srcs.add(x)); }
        else sessions.push({ s: b.s, e: b.e, blocks: [b], asleepMin: b.e - b.s, raw: b.raw, cls: b.cls, srcs: new Set(b.srcs) });
      }
      const scored = sessions.filter((x) => x.asleepMin >= 90);

      const sleepHr = [];
      for (const b of blocks) for (let i = lowerBound(ht, b.s); i < n && ht[i] < b.e; i++) sleepHr.push(hv[i]);
      const medSleepHr = median(sleepHr);
      const thr = Math.max(90, (medSleepHr || 60) + 30);

      let sleepNum = 0, sleepDen = 0, flaggedNights = 0;
      const sleepPenByDay = new Map();
      const sleepInfoByDay = new Map();
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
        const wakeDi = dayOf(ss.e);
        sleepPenByDay.set(wakeDi, Math.max(sleepPenByDay.get(wakeDi) || 0, 1 - trust));
        const prevInfo = sleepInfoByDay.get(wakeDi);
        if (!prevInfo || ss.asleepMin > prevInfo.asleepMin) sleepInfoByDay.set(wakeDi, { trust, asleepMin: ss.asleepMin });
        if (trust < 0.8) {
          flaggedNights++;
          const main = pens.slice().sort((a, b) => b.pen - a.pen)[0].key;
          const dur = fmtDur(ss.asleepMin), day = fmtDay(wakeDi + firstDay);
          const sn = [...ss.srcs].map((i) => names[i]), watchN = [...ss.srcs].filter((i) => srcCls[i] === W).map((i) => names[i]);
          let title, detail, fix;
          if (main === 'conflict') {
            const bits = [];
            if (hrElev) bits.push(`${hrElev} heart-rate readings at ${Math.round(thr)}+ bpm (peak ${Math.round(hrPeak)})`);
            if (walk.size) bits.push(`${walk.size} minutes of walking-pace movement (${Math.round(walkSteps)} steps)`);
            title = `Logged ${dur} of sleep on ${day}, but your body was up`;
            detail = `Your own data inside that sleep window contains ${bits.join(' and ')}. Your normal sleeping heart rate is about ${Math.round(medSleepHr || 0)} bpm. ${watchN.length ? joinNames(watchN) : 'The device'} decided "still wrist = asleep" and ignored the rest of its sensors.`;
            fix = 'Treat this night as unreliable. Sleep detection that leans on a still wrist can log time awake as sleep.';
          } else if (main === 'long') {
            title = `${dur} of "sleep" on ${day}: the watch was probably on a table`;
            detail = `${joinNames(sn)} logged this. That's longer than almost anyone sleeps, and the window holds only ${hrN} heart-rate readings. A still wrist with little pulse data gets logged as sleep.`;
            fix = 'Wear the watch to bed, or ignore sleep sessions that have almost no heart-rate readings.';
          } else if (main === 'dup') {
            title = `Slept ${dur} on ${day}, or ${fmtDur(ss.raw)} if you add up the export`;
            detail = `${sn.length > 1 ? joinNames(sn) + ' both' : 'Two overlapping records from ' + (sn[0] || 'one source')} logged the same night as asleep. Anyone summing the raw export counts it twice.`;
            fix = `Keep sleep tracking on one device or app${watchN.length ? ', ideally ' + watchN[0] : ''}, and sum sleep from a single source.`;
          } else {
            title = `${dur} of sleep on ${day} without any heart-rate data`;
            detail = `${watchN.length ? joinNames(watchN) : 'A watch'} logged the sleep, but only ${hrN} pulse readings exist in that window. Nothing corroborates it.`;
            fix = 'Check the watch was worn and its heart-rate sensor was on overnight.';
          }
          const pts = [];
          for (let i = lowerBound(ht, ss.s); i < n && ht[i] < ss.e; i++) pts.push([ht[i], Math.round(hv[i])]);
          const stp = Math.max(1, Math.ceil(pts.length / 160));
          const chart = { type: 'sleep', s: ss.s, e: ss.e, offS: offsetAt(ss.s), offE: offsetAt(ss.e), thr: Math.round(thr), peak: Math.round(hrPeak),
            pts: pts.filter((p, i) => i % stp === 0 || p[1] >= thr), blocks: ss.blocks.map((b) => [b.s, b.e]) };
          receipts.push({ kind: 'sleep', severity: Math.round((1 - trust) * 100), date: day, day: wakeDi + firstDay, title, detail, fix, sources: sn, chart });
        }
      }
      const sleepScore = sleepDen ? (sleepNum / sleepDen) * 100 : null;

      /* ===== steps: double counting ===== */
      const dayRaw = new Float64Array(nDays), dayDedup = new Float64Array(nDays);
      let rawTot = 0, dedupTot = 0, implaus = 0, minAny = 0, minBoth = 0;
      const extraBy = [0, 0, 0], keptBy = [0, 0, 0];
      for (const [uday, a] of steps) {
        for (let i = 0; i < DAY; i++) {
          const w = a[i], p = a[DAY + i], o = a[2 * DAY + i], raw = w + p + o;
          if (raw === 0) continue;
          const di = dayOf(uday * DAY + i), mx = Math.max(w, p, o);
          dayRaw[di] += raw; dayDedup[di] += mx; rawTot += raw; dedupTot += mx;
          if (mx > 250) implaus++;
          minAny++;
          if ((w > 0) + (p > 0) + (o > 0) >= 2) {
            minBoth++;
            const mi = w >= p && w >= o ? 0 : p >= o ? 1 : 2;
            keptBy[mi] += mx;
            if (mi !== 0) extraBy[0] += w; if (mi !== 1) extraBy[1] += p; if (mi !== 2) extraBy[2] += o;
          }
        }
      }
      const classTop = (c, key) => { let best = -1; names.forEach((nm, i) => { if (srcCls[i] === c && srcStat[i][key] > 0 && (best < 0 || srcStat[i][key] > srcStat[best][key])) best = i; }); return best < 0 ? null : names[best]; };
      const argmax = (a) => (a[0] >= a[1] && a[0] >= a[2] ? 0 : a[1] >= a[2] ? 1 : 2);
      const keepC = argmax(keptBy), extraC = argmax(extraBy);
      const keepName = minBoth ? classTop(keepC, 'steps') : null, extraName = minBoth && extraC !== keepC ? classTop(extraC, 'steps') : null;
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
        kind: 'steps', severity: Math.round(Math.min(100, d.f * 100)), date: fmtDay(d.di + firstDay), day: d.di + firstDay, chart: { type: 'steps', raw: Math.round(d.raw), dedup: Math.round(d.dedup) },
        title: `${Math.round(d.raw).toLocaleString('en-US')} steps on ${fmtDay(d.di + firstDay)}, but you only moved ${Math.round(d.dedup).toLocaleString('en-US')}`,
        sources: [keepName, extraName].filter(Boolean),
        fix: `Sum steps from ${keepName || 'one source'} only. Apple's Health app already merges sources in its own totals, but tools that read the raw export don't.`,
        detail: `${keepName && extraName ? keepName + ' and ' + extraName : 'Phone and watch'} both recorded the same walking, so the raw export overstates the day by ${Math.round(d.f * 100)}%.${extraName ? ' Most of the extra steps came from ' + extraName + '.' : ''}`
      });

      /* ===== coverage / gaps ===== */
      const useHr = n >= 100;
      const hours = new Uint8Array(nDays * 24);
      const hidx = (m) => Math.min(nDays * 24 - 1, Math.max(0, Math.floor(localMin(m) / 60) - firstDay * 24));
      if (useHr) for (let i = 0; i < n; i++) hours[hidx(ht[i])] = 1;
      else for (const [uday, a] of steps) for (let i = 0; i < DAY; i++) if (a[i] + a[DAY + i] + a[2 * DAY + i] > 0) hours[hidx(uday * DAY + i)] = 1;
      // when the clock jumps forward (daylight saving, or flying east) some local hours never happen; they are not gaps in the data
      for (let k = 1; k < segs.length; k++) {
        if (segs[k].off <= segs[k - 1].off) continue;
        for (let h = Math.ceil((segs[k].from + segs[k - 1].off) / 60); h <= Math.floor((segs[k].from + segs[k].off) / 60) - 1; h++) {
          const idx = h - firstDay * 24; if (idx >= 0 && idx < hours.length) hours[idx] = 1;
        }
      }
      let fh = hours.indexOf(1), lh = hours.lastIndexOf(1);
      let coverageScore = null, recurring = null, darkRuns = [], hoursLost = 0, coverageDays = 0, avgHours = 0;
      const covByDay = new Map();
      const topHr = names.length ? names.reduce((best, _, i) => (srcStat[i].hr > srcStat[best].hr ? i : best), 0) : -1;
      const watchName = classTop(W, 'hr') || (topHr >= 0 && srcStat[topHr].hr > 0 ? names[topHr] : null);
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
          kind: 'coverage', severity: 45, date: '', day: null, chart: { type: 'gaps', hour: recurring.hour },
          title: `Your watch goes dark around ${String(recurring.hour).padStart(2, '0')}:00 on ${recurring.days} of ${recurring.of} days`,
          sources: watchName ? [watchName] : [],
          fix: 'Charging at a time you are not wearing it for sleep or a workout keeps those periods covered.',
          detail: `${watchName ? watchName + ' stops recording here. ' : ''}That's the charging window. It silently removes about ${(hoursLost / coverageDays).toFixed(1)} h/day from your record, and anything computed per-day (average heart rate, active time) is computed over a different slice of the day each time.`
        });
        darkRuns.sort((a, b) => b.len - a.len);
        for (const r of darkRuns.slice(0, 1)) receipts.push({
          kind: 'coverage', severity: 55, date: fmtDay(r.from + firstDay), day: r.from + firstDay,
          title: `${r.len} day${r.len > 1 ? 's' : ''} of nothing starting ${fmtDay(r.from + firstDay)}`,
          fix: 'Check whether the watch ran out of battery or was left off that day.',
          detail: `No heart-rate data at all. In a daily summary these days look like "0", not "missing", unless the reader knows to check.`
        });
      }

      /* ===== daily map ===== */
      const daily = [];
      for (let di = 0; di < nDays; di++) {
        const c = covByDay.get(di); // keyed by day index relative to firstDay
        if (c === undefined) { daily.push({ day: firstDay + di, score: null, hours: 0, rawSteps: Math.round(dayRaw[di]), dedupSteps: Math.round(dayDedup[di]), hrBad: dayBad[di], sleepMin: 0, sleepTrust: null }); continue; }
        const sp = (sleepPenByDay.get(di) || 0) * 40;
        const tp = stepPenByDay.get(di) || 0;
        const hp = Math.min(20, dayBad[di] * 8);
        const cp = (1 - Math.min(1, c / 18)) * 30;
        const si = sleepInfoByDay.get(di);
        daily.push({ day: firstDay + di, score: Math.round(clamp(100 - sp - tp - hp - cp, 0, 100)), hours: c, rawSteps: Math.round(dayRaw[di]), dedupSteps: Math.round(dayDedup[di]),
          hrBad: dayBad[di], sleepMin: si ? Math.round(si.asleepMin) : 0, sleepTrust: si ? si.trust : null });
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
          darkDays: darkRuns.reduce((a, r) => a + r.len, 0), longestDark: darkRuns[0] ? darkRuns[0].len : 0,
          sources: names.map((nm, i) => ({ name: nm, kind: KIND[srcCls[i]], steps: srcStat[i].steps, hr: srcStat[i].hr, sleep: srcStat[i].sleep }))
            .sort((a, b) => (b.steps + b.hr + b.sleep) - (a.steps + a.hr + a.sleep)).slice(0, 8),
          stepOverlap: { minutesAny: minAny, minutesBoth: minBoth, share: minAny ? minBoth / minAny : 0, extra: Math.round(rawTot - dedupTot), keep: keepName, extraFrom: extraName }
        },
        receipts: top, daily
      };
    }

    return { addRecord, addWorkout, finish, counts };
  }

  return { createAnalyzer, createParser, fmtDay, fmtDur, hhmm };
});
