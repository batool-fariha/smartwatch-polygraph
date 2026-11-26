/* Builds small synthetic FIT activity files for tests. No real data.
   Exercises the parts of the protocol fit.js has to handle: little- and big-endian
   definitions, a developer field, compressed timestamp headers, invalid values. */
'use strict';

const FIT_EPOCH = 631065600;
const CRC_TABLE = [0x0000, 0xCC01, 0xD801, 0x1400, 0xF001, 0x3C00, 0x2800, 0xE401, 0xA001, 0x6C00, 0x7800, 0xB401, 0x5000, 0x9C01, 0x8801, 0x4400];
function crc16(bytes) {
  let crc = 0;
  for (const b of bytes) {
    let t = CRC_TABLE[crc & 0xF]; crc = (crc >> 4) & 0x0FFF; crc = crc ^ t ^ CRC_TABLE[b & 0xF];
    t = CRC_TABLE[crc & 0xF]; crc = (crc >> 4) & 0x0FFF; crc = crc ^ t ^ CRC_TABLE[(b >> 4) & 0xF];
  }
  return crc;
}

// field spec: [fieldNum, size, baseType]
function encoder() {
  const body = [];
  const defs = {};
  return {
    define(local, num, fields, opts) {
      const big = opts && opts.bigEndian, dev = opts && opts.devFieldSize;
      body.push(0x40 | local | (dev ? 0x20 : 0), 0, big ? 1 : 0);
      body.push(...(big ? [num >> 8, num & 0xFF] : [num & 0xFF, num >> 8]), fields.length);
      for (const f of fields) body.push(...f);
      if (dev) body.push(1, 0, dev, 0);
      defs[local] = { fields, big, dev: dev || 0 };
    },
    data(local, values, compressedOffset) {
      const d = defs[local];
      body.push(compressedOffset === undefined ? local : 0x80 | (local << 5) | (compressedOffset & 0x1F));
      d.fields.forEach(([, size], i) => {
        const v = values[i];
        for (let k = 0; k < size; k++) {
          const shift = d.big ? (size - 1 - k) * 8 : k * 8;
          body.push(Math.floor(v / 2 ** shift) & 0xFF);
        }
      });
      for (let k = 0; k < d.dev; k++) body.push(0xAB);
    },
    bytes() {
      const hdr = [14, 0x20, 0x08, 0x08, ...[0, 8, 16, 24].map((s) => (body.length >>> s) & 0xFF), 0x2E, 0x46, 0x49, 0x54];
      const hcrc = crc16(hdr);
      const all = [...hdr, hcrc & 0xFF, hcrc >> 8, ...body];
      const c = crc16(all);
      return new Uint8Array([...all, c & 0xFF, c >> 8]);
    },
  };
}

const fitTime = (iso) => Date.parse(iso) / 1000 - FIT_EPOCH;

/* A run: `minutes` long, one record per second, heart rate and cadence.
   opts.spikeAt: minute index whose first reading is opts.spikeBpm.
   opts.offsetMin: wearer's UTC offset. opts.sport: FIT sport enum (1 running, 2 cycling). */
function activity(opts) {
  const o = Object.assign({ start: '2026-09-03T06:00:00Z', minutes: 30, offsetMin: 120, sport: 1, cadence: 85, baseHr: 140, spikeAt: -1, spikeBpm: 220, maker: 1 }, opts);
  const e = encoder();
  const t0 = fitTime(o.start);
  e.define(0, 0, [[0, 1, 0], [1, 2, 132], [2, 2, 132], [4, 4, 134]]);                      // file_id: type, manufacturer, product, time_created
  e.data(0, [4, o.maker, 3990, t0]);
  e.define(1, 20, [[253, 4, 134], [3, 1, 2], [4, 1, 2]], { devFieldSize: 2 });               // record: timestamp, heart_rate, cadence (+ a dev field)
  e.define(2, 20, [[3, 1, 2], [4, 1, 2]]);                                                    // record with compressed timestamp
  for (let s = 0; s < o.minutes * 60; s++) {
    const t = t0 + s, minute = Math.floor(s / 60);
    const hr = s % 60 === 0 && minute === o.spikeAt ? o.spikeBpm : o.baseHr + (s % 7);
    const cadence = s === 5 ? 0xFF : o.cadence; // one invalid cadence value
    if (s % 10 === 5) e.data(2, [hr, cadence], t & 0x1F);
    else e.data(1, [t, hr, cadence]);
  }
  const end = t0 + o.minutes * 60;
  e.define(3, 18, [[253, 4, 134], [2, 4, 134], [5, 1, 0], [7, 4, 134]], { bigEndian: true }); // session: timestamp, start_time, sport, total_elapsed_time
  e.data(3, [end, t0, o.sport, o.minutes * 60 * 1000]);
  e.define(4, 34, [[253, 4, 134], [5, 4, 134]]);                                              // activity: timestamp, local_timestamp
  e.data(4, [end, end + o.offsetMin * 60]);
  return e.bytes();
}

module.exports = { activity, encoder, crc16, fitTime, FIT_EPOCH };
