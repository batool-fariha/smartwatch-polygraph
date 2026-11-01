const WT = require('./analyzer.js');
const { generate } = require('./sample.js');
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
console.log('\nALL ASSERTIONS PASSED');
