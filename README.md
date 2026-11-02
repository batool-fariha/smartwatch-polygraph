# Smartwatch Polygraph

[![test](https://github.com/batool-fariha/smartwatch-polygraph/actions/workflows/test.yml/badge.svg)](https://github.com/batool-fariha/smartwatch-polygraph/actions/workflows/test.yml)

**Is your smartwatch lying to you?** Upload an Apple Health export and Polygraph cross-examines it: your sleep against your heart rate, your phone's steps against your watch's, your heart rate against itself. It lists every place your own data contradicts itself and rolls them into a 0–100 trust score.

**Live:** [smartwatch-polygraph.vercel.app](https://smartwatch-polygraph.vercel.app) · Everything runs in your browser. The export is never uploaded.

![The Smartwatch Polygraph landing page](docs/hero.jpg)

## Why

Wearable data is starting to feed research and clinical workflows, and the file you get out of a phone is messier than the app suggests. The raw Apple Health export contains steps counted by both the phone and the watch, sleep logged while the pulse says you were up, and heart-rate readings no human could produce. Apple's own Health app cleans some of this up. Anything that reads the export directly does not.

Polygraph doesn't need a ground-truth device to catch this. It looks for places where two signals that should agree, don't.

## What it finds

| Check | The contradiction | Example finding |
|---|---|---|
| Sleep vs. body | Heart rate or walking-pace steps inside a window logged as sleep | "Logged 9h 05m of sleep, but your body was up" |
| Sleep vs. itself | Two sources logging the same night, sleeps over 12 hours, sleep with no pulse data | "13h 30m of sleep: the watch was probably on a table" |
| Steps | Phone and watch counting the same minutes twice | "8,379 steps, but you only moved 4,929" |
| Heart rate | Readings outside 30–230 bpm, single-reading spikes outside workouts | "71, then 184, then 73 bpm within minutes" |
| Coverage | Recurring charging gaps and days with no data | "Your watch goes dark around 07:00 on 25 of 61 days" |

## The results screen

Your own watch is the result: each ring is as long as its sub-score, and the number in the middle is the overall score.

![The result: a watch whose four rings show the sleep, steps, heart-rate and coverage scores](docs/results.jpg)

**Where your data comes from** lists every source in the export (watch, phone or other) with its record counts. When two sources counted the same steps it says which ones, how much they added to the raw export, and which one to sum from.

![The sources in an export, with how much the phone and watch overlap on steps](docs/sources.jpg)

**Findings** name the source or sources behind them, say what to do about it, and come with a chart drawn from your own readings: the night's heart rate against its sleeping ceiling, the single reading and the minutes around it, or the raw step total against what you actually walked. Each one ends with a plain "What to do" line. Filter them by sleep, steps, heart rate or coverage.

![Findings with charts and category filters](docs/findings.jpg)

**Every day** is a calendar coloured by day score. Click a day to see its sleep, steps, heart rate, hours of watch data and any findings. **See this day** on a finding jumps straight to it.

![A calendar coloured by day score, with the selected day broken down underneath](docs/calendar.jpg)

**Share card.** **Download share card** draws a 1080 × 1350 image from your own result: your watch with your ring lengths, the grade, the four sub-scores and your top finding. It is drawn in the page, so nothing leaves your browser.

<img src="docs/share-card.jpg" alt="A share card showing the watch, the grade Mostly honest, four sub-scores and a quoted finding" width="360">

## How the score works

Four sub-scores, each 0–100, combined as a weighted mean. A sub-score with no data (for example, no sleep records) drops out and the remaining weights are renormalised.

| Sub-score | Weight | How it is computed |
|---|---|---|
| Sleep | 30% | Mean trust of each night, weighted by hours asleep |
| Steps | 25% | `100 × (1 − min(1, 1.5 × inflation))`, minus up to 20 for implausible cadence |
| Coverage | 25% | Mean over days of `min(1, hours with watch data ÷ 18)` |
| Heart rate | 20% | `100 − min(100, 4000 × bad readings ÷ all readings)` |

| Overall | Grade |
|---|---|
| 90–100 | Trustworthy |
| 75–89 | Mostly honest |
| 55–74 | Gets creative |
| 35–54 | Unreliable narrator |
| 0–34 | Pathological liar |

### The rules in detail

**Sleep.** Asleep intervals are merged into sessions (gaps up to 90 minutes). Sessions with at least 90 minutes asleep are scored. The heart-rate ceiling for a night is `max(90, median sleeping heart rate + 30)`. Conflict minutes are the minutes within two minutes of a reading at or above the ceiling, plus minutes with 40 or more steps (after de-duplication). A night's trust is `1 − penalties`, and a night is flagged below 0.8:

- Conflict: `min(1, 4 × conflict fraction)` when there are at least 15 conflict minutes and the fraction is at least 5%, otherwise a small penalty capped at 0.15.
- Longer than 12 hours asleep: 0.25.
- Duplicate sources, when summed intervals exceed the union by more than 25%: `min(0.4, 0.4 × (ratio − 1))`.
- Logged by a watch with fewer than one heart-rate reading per two hours: 0.2.

**Steps.** Each minute is de-duplicated to the highest of watch, phone and other sources. Inflation is `raw total ÷ de-duplicated total − 1`. A minute above 250 steps counts as implausible cadence.

**Heart rate.** A reading is bad if it falls outside 30–230 bpm, or if it is a blip: it differs by at least 60 bpm from both neighbours, the neighbours are within 25 bpm of each other and within 10 minutes, and it is not inside a workout (padded by 10 minutes).

**Coverage.** An hour counts as covered if it holds at least one heart-rate reading (or any steps, when there are fewer than 100 heart-rate readings). Gaps of 1–5 hours are treated as charging or off-wrist time. A gap is "recurring" when the same start hour appears on at least 30% of days.

**Sources.** Source names containing watch, Fitbit, Garmin, Whoop, Oura, band, Polar, Coros or Suunto are treated as watch; iPhone, phone and iPad as phone; anything else as other.

The weights and thresholds are hand-picked. They have not been validated against a clinical reference.

## How it works

```
export.zip ─▶ stream unzip ─▶ tag parser ─▶ analyzer ─▶ report
 (fflate)      (chunked)      (Record,      steps by minute   scores,
                              Workout)      heart-rate series findings,
                                            sleep intervals   daily map
                                            workouts
```

The file is read as a stream, decoded in chunks and scanned for `Record` and `Workout` tags, so only the records that matter are kept in memory. Steps are held in compact per-day arrays, so memory grows slowly with the size of the export. `analyzer.js` has no browser dependencies and runs in Node as well, which is how the tests run.

## Run it

It is a static site with no build step.

```bash
python3 -m http.server 8741
```

Open <http://localhost:8741>, drop in an `export.zip` or `export.xml`, or press **Use sample data**. Everything the page needs, including the fonts and the unzip library ([fflate](https://github.com/101arrowz/fflate)), is bundled, so it works offline.

To get an export: Health app → your profile picture → **Export All Health Data**.

## Test

There are three layers. The first two need only Node 20 or later.

**Engine test.** `sample.js` generates a synthetic export with known faults planted in it: a night spent dancing, a night logged by two sources, a watch left on a desk, heart-rate glitches, a dead day. `test/engine.test.js` checks that each one is found, that the right source is named for each (the phone for the extra steps, the watch for the glitches), and that a single-source export claims no overlap.

**Rule tests.** `test/rules.test.js` builds tiny exports by hand and pins every rule at its boundary, so changing a threshold fails a test with a clear name. For example: a 59 bpm jump is not a spike but 60 is, a 720 minute sleep is fine but 721 is flagged, a gap at the same hour on 3 of 10 days is recurring but 2 of 10 is not, and splitting the file at every possible byte offset gives the same result.

```bash
node --test test/
```

**Browser tests.** `e2e/e2e.js` drives the real page in Chromium: the landing page makes no third-party requests and loads its fonts; the sample result, filters, calendar and share card work; an `export.xml` and the same export zipped give identical results; a wrong, truncated, empty or non-Health file shows a plain message and the page recovers; the keyboard paths work; and [axe-core](https://github.com/dequelabs/axe-core) finds no accessibility violations on the landing page or the results. With `--stress` it also generates a 70 MB export and loads it as XML and as a zip, failing if it takes over 90 seconds, freezes the page for over 3 seconds or uses over 1 GB.

```bash
cd e2e
npm ci
npx playwright-core install chromium   # or set CHROMIUM_PATH to a Chromium you already have
node e2e.js            # add --stress for the large-file run
```

All three run on every push and pull request (see `.github/workflows/test.yml`).

## Performance

Measured on synthetic exports (`tools/make_big_export.py`) in headless Chromium on a laptop, so treat the numbers as indicative, not a guarantee:

| Input | Time | Peak JS heap | Longest pause |
|---|---|---|---|
| 330 MB `export.xml` (3 years) | 1.3 s | about 190 MB | about 0.1 s |
| 1 GB `export.xml` (7 years) | 3.1 s | about 190 MB | about 0.2 s |
| `export.zip`, 78 MB, 1 GB inside | 6.7 s | about 590 MB | about 0.2 s |

Zips made like an iPhone's (streamed entries, extra files ahead of `export.xml`, zip64) read correctly, and a wrong, truncated, empty or non-Health file gives a plain-language error instead of hanging. Phones have far less memory than a laptop, so export on the phone and open the file on a computer.

## Privacy

The page has no backend. The export is parsed in the tab and nothing is sent anywhere. The page makes no third-party requests at all: the fonts and the unzip library are served from the same origin, so no CDN or font service sees you open it.

## Accessibility

Checked with [axe-core](https://github.com/dequelabs/axe-core) (WCAG 2.1 A and AA plus best practices) on both the landing page and the results screen, with no violations. Orange text uses darker shades (`#b84c00` for small text, `#e05e00` for large) so it meets contrast ratios, while the brand orange stays on fills. There is a skip link, the animated watch replays from the keyboard (Enter or Space), focus moves to the result heading when a result appears, and animations stay still for anyone with reduced motion turned on. This is an automated audit plus manual keyboard checks, not a full screen-reader review.

## Status and limits

- **Tested on synthetic data only.** The thresholds have not yet been calibrated against real exports, so expect false positives and misses until they are.
- **It finds contradictions, not sensor error.** Two signals disagreeing means something is off. It doesn't say which one, or whether the sensor is accurate.
- **Apple Health only.** Fitbit exports (Google Takeout) are daily JSON files whose exact schema could not be confirmed from public documentation. Garmin's account export has sleep and daily summaries but no minute-level heart rate or steps, so the headline checks can't run on it.
- **Not a medical device.** It checks data quality and doesn't diagnose, monitor or advise.

Next: calibrate on real exports, add a Fitbit adapter, and read Garmin FIT files for the checks that need minute-level data.

## Repository

| File | Purpose |
|---|---|
| `index.html` | The interface: hero animation, upload, results, share card |
| `analyzer.js` | Streaming parser and the checks (browser and Node) |
| `sample.js` | Synthetic export generator with known faults |
| `test/` | Engine test and unit tests for every rule |
| `e2e/` | Browser tests (Playwright and axe-core), with their own `package.json` |
| `tools/make_big_export.py` | Generates 300 MB to 1 GB synthetic exports for stress testing |
| `favicon.svg`, `favicon.ico`, `apple-touch-icon.png` | Icons |
| `og.png` | Social preview image (1200×630), used for link previews |
| `fonts/` | Instrument Serif and Inter Tight (WOFF2, Latin subset) with their SIL OFL licences |
| `vendor/` | fflate, the unzip library, with its MIT licence |
| `LICENSE` | MIT licence for the code |
| `.github/workflows/test.yml` | Runs all three test layers on every push and pull request |
| `docs/` | README screenshots, captured at 2× resolution |

## Licence

The code is MIT licensed (see `LICENSE`). The bundled fonts, Instrument Serif and Inter Tight, are under the SIL Open Font License 1.1 (see `fonts/`), and fflate is MIT (see `vendor/`).

## Author

Designed and built by [Fariha Batool](https://www.linkedin.com/in/fariha-batool/) · [GitHub](https://github.com/batool-fariha)
