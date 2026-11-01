# Smartwatch Polygraph

Is your smartwatch lying to you? Smartwatch Polygraph reads an Apple Health export and lists the places where your own sleep, steps and heart-rate data contradict each other, then rolls them into a 0–100 data trust score.

Everything runs in the browser. The export is parsed as a stream in the tab and is never uploaded.

## What it checks

| Check | Weight | What it looks for |
|---|---|---|
| Sleep | 30% | Heart rate or walking-pace steps inside a logged sleep window, duplicate sleep sources, sleeps over 12 h, sleep with no pulse data |
| Steps | 25% | Phone and watch counting the same minutes twice in the raw export |
| Coverage | 25% | Hours of each day with watch data (against an 18 h day), recurring charging gaps, dead days |
| Heart rate | 20% | Readings outside 30–230 bpm and single-reading spikes outside workouts |

Weights and thresholds are hand-picked, not validated against a clinical reference. The tool finds contradictions, not sensor error, and it is not a medical device.

## Run it

It is a static site with no build step.

```bash
python3 -m http.server 8741
```

Open http://localhost:8741 and drop in an `export.zip` or `export.xml`, or use the built-in sample data.

## Test

`sample.js` generates a synthetic export with known faults (a wedding night, a double-logged night, a watch left on a desk, heart-rate glitches, a dead day). `test.js` checks the analyzer finds each one.

```bash
node test.js
```

## Files

- `index.html`: the interface
- `analyzer.js`: streaming parser and checks (browser and Node)
- `sample.js`: synthetic export generator
- `test.js`: engine test

## Scope

Apple Health only. Fitbit and Garmin exports are laid out differently, and Garmin's account export does not include minute-level data.
