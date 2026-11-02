const WT = require('../analyzer.js');
const { generate } = require('../sample.js');
const assert = require('assert');

const { xml, truth } = generate({ days: 60, seed: 7 });
const an = WT.createAnalyzer();
const parser = WT.createParser(an);
// feed in awkward chunk sizes to exercise the tag-boundary handling
for (let i = 0; i < xml.length; i += 997) parser.feed(xml.slice(i, i + 997));
const rep = an.finish();

console.log('counts', rep.counts);
console.log('scores', Object.fromEntries(Object.entries(rep.scores).map(([k, v]) => [k, v === null ? null : +v.toFixed(1)])), rep.grade);
console.log('facts', rep.facts);
rep.receipts.forEach((r) => console.log(`[${r.kind} ${r.severity}] ${r.title}\n    ${r.detail}`));

const titles = rep.receipts.map((r) => r.title + ' ' + r.date).join('\n');
const day = (i) => WT.fmtDay(Date.UTC(2026, 8, 1) / 86400000 + i);

assert(rep.counts.hr > 1000, 'parsed heart rate');
assert(rep.receipts.some((r) => r.kind === 'sleep' && r.date === day(truth.weddingDay)), 'wedding night flagged');
assert(rep.receipts.some((r) => r.kind === 'sleep' && r.date === day(truth.deskDay)), 'desk night flagged');
assert(rep.receipts.some((r) => r.kind === 'sleep' && r.date === day(truth.dupDay)), 'duplicate night flagged');
assert(rep.facts.hrImpossible === 2, 'impossible HR count = ' + rep.facts.hrImpossible);
assert(rep.facts.hrBlips === truth.blipDays.length, 'blip count = ' + rep.facts.hrBlips);
assert(rep.facts.darkDays >= 1, 'dark days found');
assert(!/1970/.test(titles), 'dates are real');
assert(rep.facts.inflation > 0.1, 'step inflation found');
assert(rep.scores.overall > 30 && rep.scores.overall < 90, 'overall plausible');

/* source attribution */
const WATCH = 'Sam’s Apple Watch', PHONE = 'Sam’s iPhone';
assert(rep.facts.sources.length === 2 && rep.facts.sources[0].kind === 'watch' && rep.facts.sources[1].kind === 'phone', 'sources listed with kinds');
assert(rep.facts.stepOverlap.keep === WATCH && rep.facts.stepOverlap.extraFrom === PHONE, 'extra steps are attributed to the phone');
assert(rep.facts.stepOverlap.share > 0.3 && rep.facts.stepOverlap.extra > 0, 'overlap measured');
const dupR = rep.receipts.find((r) => r.kind === 'sleep' && r.date === day(truth.dupDay));
assert(dupR.sources.includes(WATCH) && dupR.sources.includes(PHONE), 'duplicate night names both sources');
assert(rep.receipts.filter((r) => r.kind === 'steps').every((r) => r.detail.includes(PHONE) && r.fix.includes(WATCH)), 'step findings name the phone and advise the watch');
assert(rep.receipts.filter((r) => r.kind === 'hr').every((r) => r.sources[0] === WATCH && r.detail.includes(WATCH)), 'heart-rate findings name the watch');
assert(rep.receipts.every((r) => typeof r.fix === 'string' && r.fix.length > 10), 'every finding says what to do');

/* a single-source export must not claim any overlap */
{
  const one = WT.createAnalyzer(), pr = WT.createParser(one);
  let x = '<HealthData>';
  for (let d = 0; d < 5; d++) for (let m = 600; m < 900; m += 15) x += `<Record type="HKQuantityTypeIdentifierStepCount" sourceName="Only Watch" unit="count" startDate="2026-09-0${d + 1} ${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}:00 +0000" endDate="2026-09-0${d + 1} ${String(Math.floor((m + 15) / 60)).padStart(2, '0')}:${String((m + 15) % 60).padStart(2, '0')}:00 +0000" value="300"/>`;
  pr.feed(x + '</HealthData>');
  const r1 = one.finish();
  assert(r1.facts.sources.length === 1 && r1.facts.stepOverlap.minutesBoth === 0 && r1.facts.stepOverlap.keep === null && r1.facts.stepOverlap.extraFrom === null, 'single source: no overlap claimed');
  assert(r1.facts.inflation === 0, 'single source: no inflation');
}

console.log('\nALL ASSERTIONS PASSED');
