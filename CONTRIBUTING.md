# Contributing to Smartwatch Polygraph

Thanks for helping. Polygraph cross-checks a wearable export for places where the data contradicts itself. It is a **data-quality checker, not a medical device**: please don't add diagnostic, monitoring or treatment claims.

## Privacy rules

- **Never post a real health export**, or real readings from one, in an issue, pull request or test fixture. Use the synthetic generators: `sample.js` (small exports with known faults) and `tools/make_big_export.py` (300 MB to 1 GB, for stress tests).
- Nothing may leave the page. No analytics, no third-party requests, no uploads. The "Report a problem" text must never contain dates, source names or file contents, and a test fails if it does.
- If you are adding a check, it should work from the export alone, with no network call.

## Setup

There is no build step and the engine has no dependencies. You need Node 20 or newer.

```bash
git clone https://github.com/batool-fariha/smartwatch-polygraph.git
cd smartwatch-polygraph
node --test test/          # engine test and a unit test for every rule
```

To view the page, open `index.html` in a browser or serve the folder with any static server.

The browser tests have their own `package.json`:

```bash
cd e2e
npm ci
npx playwright-core install chromium
node e2e.js                # uploads, bad files and accessibility (axe-core)
node e2e.js --stress       # adds the large-export run, as CI does
```

## Where things live

| Path | Purpose |
|---|---|
| `analyzer.js` | Streaming parser and the checks (runs in the browser and in Node) |
| `fit.js` | Garmin FIT decoder and adapter into analyzer records |
| `index.html` | The interface: hero animation, upload, results, share card |
| `sample.js` | Synthetic export generator with known faults |
| `test/` | Engine test and unit tests for every rule |
| `e2e/` | Browser tests (Playwright and axe-core) |
| `tools/make_big_export.py` | Large synthetic exports for stress testing |

## Ground rules

1. **Every rule gets a unit test at its boundary**, for example just below and just above a threshold. Thresholds are documented in the README's [How the score works](README.md#how-the-score-works), so change both together.
2. **Say what is wrong, and what to do about it.** A finding names the source or sources behind it and ends with a plain "What to do" line.
3. **A finding is a contradiction, not a diagnosis.** Two signals disagreeing means something is off; it does not say which sensor is accurate.
4. **The thresholds are not calibrated on real exports yet.** If you change one, explain the evidence in the pull request, and note it in [CHANGELOG.md](CHANGELOG.md) because it can change the score a given export gets.
5. **Keep it accessible.** The browser tests run axe-core (WCAG 2.2 A and AA) on the landing page and the results screen. Keep tap targets at least 24 px apart and respect reduced motion.

## Adding a rule

Each finding in `analyzer.js` is a receipt with a `rule` id (for example `heart-rate.spike`), a `severity`, a short `title`, `detail` and `fix`, the `sources` behind it, and a flat `data` object.

1. Add the check in `analyzer.js` and push a receipt with a new rule id in the form `category.name`.
2. Put **only finite numbers** in `data` (for example `{ valueBpm: 184 }`). Never put a date, a source name or any other text in it: `data` is what a "Report a problem" message is built from.
3. Add the new id to the `RULES` set in `test/report.test.js`. That test fails for an unknown rule id, a non-numeric value, or a year, month, weekday or source name anywhere in the data.
4. Add unit tests for the rule in `test/rules.test.js`, just below and just above its threshold.
5. If the synthetic generator in `sample.js` cannot trigger the rule, extend it with a known fault so `test/engine.test.js` can check that the rule fires.
6. Describe the rule and its threshold in the README (the table under [What it finds](README.md#what-it-finds) and the rules in detail), and add a line under **Unreleased** in [CHANGELOG.md](CHANGELOG.md).

## Before opening a pull request

```bash
node --test test/
cd e2e && node e2e.js --stress
```

CI runs the same two commands on every push and pull request.

## Good first contributions

- Calibrate thresholds against a real export you own, and report only the numbers (see the issue on calibration).
- Add a Fitbit (Google Takeout) adapter.
- Check FIT support against a real Garmin activity file you own, and report only whether it read and what counts it gave.

## Releases

Releases follow [Semantic Versioning](https://semver.org/). The project stays on **0.x** until the thresholds have been calibrated on real exports: a minor version may change the score a given export gets, and a patch version is fixes only. Every user-visible change goes under **Unreleased** in the changelog.
