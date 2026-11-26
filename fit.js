/* Garmin FIT activity files -> the record shape analyzer.js reads.
   A small FIT decoder written for this project (no third-party code), following the
   public FIT protocol: file header, definition and data messages, compressed
   timestamp headers and developer fields. It reads only what the checks need:
   heart rate and cadence from `record` messages, the workout span from `session`,
   the wearer's UTC offset from `activity`, and the maker from `file_id`.
   Runs in the browser and in Node. Nothing leaves the page. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.WearableFit = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const FIT_EPOCH = 631065600; // 1989-12-31T00:00:00Z in Unix seconds
  const MSG = { FILE_ID: 0, SESSION: 18, RECORD: 20, ACTIVITY: 34 };
  const SPORT = { RUNNING: 1, WALKING: 11 };
  // base type number -> [size, invalid value] for the integer types we read
  const BASE = { 0: [1, 0xFF], 1: [1, 0x7F], 2: [1, 0xFF], 3: [2, 0x7FFF], 4: [2, 0xFFFF], 5: [4, 0x7FFFFFFF], 6: [4, 0xFFFFFFFF], 10: [1, 0], 11: [2, 0], 12: [4, 0], 13: [1, 0xFF] };
  const SIGNED = { 1: 1, 3: 1, 5: 1 };

  function isFit(bytes) {
    return bytes && bytes.length >= 12 && bytes[8] === 0x2E && bytes[9] === 0x46 && bytes[10] === 0x49 && bytes[11] === 0x54;
  }

  /* Decode every data message into { num, fields: { fieldNum: value } }. */
  function decode(bytes) {
    if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
    if (!isFit(bytes)) throw new Error('Not a FIT file (no ".FIT" signature)');
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const hdr = bytes[0];
    const dataSize = dv.getUint32(4, true);
    const end = Math.min(bytes.length, hdr + dataSize);
    const defs = [];
    const out = [];
    let p = hdr, lastTs = 0;

    function readField(off, size, base, little) {
      const t = base & 0x1F, info = BASE[t];
      if (!info || size < info[0]) return undefined;
      let v;
      if (info[0] === 1) v = SIGNED[t] ? dv.getInt8(off) : dv.getUint8(off);
      else if (info[0] === 2) v = SIGNED[t] ? dv.getInt16(off, little) : dv.getUint16(off, little);
      else v = SIGNED[t] ? dv.getInt32(off, little) : dv.getUint32(off, little);
      const raw = info[0] === 1 ? dv.getUint8(off) : info[0] === 2 ? dv.getUint16(off, little) : dv.getUint32(off, little);
      return raw === info[1] ? undefined : v;
    }

    while (p < end) {
      const h = bytes[p++];
      if (h & 0x80) { // compressed timestamp header: data message with a 5-bit time offset
        const local = (h >> 5) & 0x03, off = h & 0x1F;
        let ts = (lastTs & ~0x1F) + off;
        if (off < (lastTs & 0x1F)) ts += 0x20;
        lastTs = ts;
        const d = defs[local];
        if (!d) throw new Error('FIT data message before its definition');
        const m = readData(d);
        if (m.fields[253] === undefined) m.fields[253] = ts;
        out.push(m);
      } else if (h & 0x40) { // definition message
        const local = h & 0x0F, dev = h & 0x20;
        const little = bytes[p + 1] === 0;
        const num = little ? dv.getUint16(p + 2, true) : dv.getUint16(p + 2, false);
        const n = bytes[p + 4]; p += 5;
        const fields = [];
        for (let i = 0; i < n; i++, p += 3) fields.push([bytes[p], bytes[p + 1], bytes[p + 2]]);
        let devBytes = 0;
        if (dev) { const nd = bytes[p++]; for (let i = 0; i < nd; i++, p += 3) devBytes += bytes[p + 1]; }
        defs[local] = { num, little, fields, devBytes };
      } else { // normal data message
        const d = defs[h & 0x0F];
        if (!d) throw new Error('FIT data message before its definition');
        const m = readData(d);
        if (typeof m.fields[253] === 'number') lastTs = m.fields[253];
        out.push(m);
      }
      if (p > end) throw new Error('FIT file is truncated');
    }
    return out;

    function readData(d) {
      const fields = {};
      for (const [fnum, size, base] of d.fields) {
        if (p + size > end) throw new Error('FIT file is truncated');
        const v = readField(p, size, base, d.little);
        if (v !== undefined) fields[fnum] = v;
        p += size;
      }
      p += d.devBytes;
      return { num: d.num, fields };
    }
  }

  const pad = (n, w) => String(Math.abs(n)).padStart(w || 2, '0');
  // Apple-style timestamp: local wall-clock time plus the UTC offset, e.g. "2026-09-01 07:05:00 +0200"
  function stamp(unixSec, offMin) {
    const d = new Date((unixSec + offMin * 60) * 1000);
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} ${offMin < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(offMin) / 60))}${pad(Math.abs(offMin) % 60)}`;
  }

  /* Convert one FIT activity file into Apple-shaped records and workouts.
     Heart rate: the first valid reading in each minute (sampled, like a watch, not smoothed).
     Steps: only for running and walking, where FIT cadence is per foot, so steps per minute
     is twice the average cadence in that minute. Other sports give heart rate only. */
  function toRecords(bytes) {
    const msgs = decode(bytes);
    const ids = msgs.filter((m) => m.num === MSG.FILE_ID);
    const maker = ids.length ? ids[0].fields[1] : undefined;
    const sourceName = maker === 1 ? 'Garmin watch (FIT)' : 'FIT device';
    const act = msgs.find((m) => m.num === MSG.ACTIVITY && m.fields[253] !== undefined && m.fields[5] !== undefined);
    // local_timestamp - timestamp is the wearer's offset; round to 15 minutes, as real offsets are
    const offMin = act ? Math.round((act.fields[5] - act.fields[253]) / 900) * 15 : 0;
    const sessions = msgs.filter((m) => m.num === MSG.SESSION && m.fields[2] !== undefined);
    const walkingSpans = sessions
      .filter((s) => s.fields[5] === SPORT.RUNNING || s.fields[5] === SPORT.WALKING)
      .map((s) => [s.fields[2], s.fields[2] + (s.fields[7] || 0) / 1000]);
    const onFoot = (t) => walkingSpans.some(([a, b]) => t >= a && t <= b);

    const records = [], workouts = [];
    const hrMin = new Set(), cad = new Map(); // minute -> [sum, n]
    for (const m of msgs) {
      if (m.num !== MSG.RECORD || m.fields[253] === undefined) continue;
      const t = m.fields[253] + FIT_EPOCH, minute = Math.floor(t / 60);
      const hr = m.fields[3];
      if (hr !== undefined && !hrMin.has(minute)) {
        hrMin.add(minute);
        records.push({ type: 'HKQuantityTypeIdentifierHeartRate', sourceName, startDate: stamp(t, offMin), endDate: stamp(t, offMin), value: String(hr) });
      }
      const c = m.fields[4];
      if (c !== undefined && onFoot(m.fields[253])) { const a = cad.get(minute) || [0, 0]; a[0] += c; a[1]++; cad.set(minute, a); }
    }
    for (const [minute, [sum, n]] of cad) {
      const steps = Math.round((sum / n) * 2);
      if (steps > 0) records.push({ type: 'HKQuantityTypeIdentifierStepCount', sourceName, startDate: stamp(minute * 60, offMin), endDate: stamp(minute * 60 + 60, offMin), value: String(steps) });
    }
    for (const s of sessions) {
      const a = s.fields[2] + FIT_EPOCH, b = a + Math.round((s.fields[7] || 0) / 1000);
      if (b > a) workouts.push({ startDate: stamp(a, offMin), endDate: stamp(b, offMin) });
    }
    return { sourceName, offsetMinutes: offMin, records, workouts };
  }

  /* Feed a FIT file into an analyzer from analyzer.js. Returns what was read. */
  function feed(bytes, analyzer) {
    const r = toRecords(bytes);
    r.records.forEach((x) => analyzer.addRecord(x));
    r.workouts.forEach((x) => analyzer.addWorkout(x));
    return { heartRate: r.records.filter((x) => x.type.endsWith('HeartRate')).length, stepMinutes: r.records.filter((x) => x.type.endsWith('StepCount')).length, workouts: r.workouts.length };
  }

  return { isFit, decode, toRecords, feed, FIT_EPOCH };
});
