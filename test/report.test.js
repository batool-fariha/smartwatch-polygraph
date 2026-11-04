/* What a user can report must never carry anything identifying. Every finding exposes a rule id and a flat set
   of numbers, and nothing else is allowed into a report. */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const WT = require('../analyzer.js');
const { generate } = require('../sample.js');

const run = () => { const a = WT.createAnalyzer(); WT.createParser(a).feed(generate({ days: 60, seed: 7 }).xml); return a.finish(); };
const RULES = new Set(['sleep.conflict', 'sleep.long', 'sleep.dup', 'sleep.noev', 'heart-rate.spike', 'heart-rate.impossible', 'steps.double-count', 'coverage.recurring-gap', 'coverage.dark-days']);
const MONTHS = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\b/i, DAYS = /\b(mon|tue|wed|thu|fri|sat|sun)[a-z]*\b/i;

describe('every finding is reportable without identifying anyone', () => {
  const r = run();
  it('has a known rule id and a flat object of finite numbers', () => {
    assert.ok(r.receipts.length >= 8);
    for (const x of r.receipts) {
      assert.ok(RULES.has(x.rule), 'unknown rule ' + x.rule);
      assert.ok(x.data && Object.keys(x.data).length > 0, x.rule + ' has no data');
      for (const [k, v] of Object.entries(x.data)) assert.ok(typeof v === 'number' && Number.isFinite(v), `${x.rule}.${k} is not a finite number: ${v}`);
    }
  });
  it('carries no source names, dates, months or weekdays', () => {
    const names = r.facts.sources.map((s) => s.name);
    for (const x of r.receipts) {
      const blob = x.rule + JSON.stringify(x.data);
      for (const n of names) assert.ok(!blob.includes(n) && !blob.includes(n.split(' ')[0] + '’'), `${x.rule} leaks a source name`);
      assert.ok(!/20\d\d/.test(blob), `${x.rule} contains a year`);
      assert.ok(!MONTHS.test(blob.replace(/\bmax\b/g, '')) , `${x.rule} contains a month`);
      assert.ok(!DAYS.test(blob), `${x.rule} contains a weekday`);
    }
  });
  it('the facts used in a report are numbers and types only', () => {
    assert.equal(typeof r.facts.tzChanges, 'number');
    assert.ok(r.facts.sources.every((s) => ['watch', 'phone', 'other'].includes(s.kind)));
    assert.match(WT.version, /^\d+\.\d+\.\d+(-[a-z0-9.]+)?$/);
  });
  it('every rule the analyzer can produce is in the list the report form knows', () => {
    // the sample data exercises most rules; the rest are covered by the rule tests, so just check nothing outside the set appears
    assert.ok([...new Set(r.receipts.map((x) => x.rule))].every((x) => RULES.has(x)));
  });
});
