# Changelog

All notable changes to Smartwatch Polygraph. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Releases follow [Semantic Versioning](https://semver.org/). Because the thresholds have not been calibrated on real exports yet (see [Status and limits](README.md#status-and-limits)), the project stays on **0.x**: minor versions may change what scores a given export gets, and patch versions are fixes only. Work before the first tag is grouped by date.

## Unreleased

### Added
- A privacy-safe way to report false positives and misses. Every finding has a **Report a problem** link, and there is a general one for things it missed. A dialog shows exactly what a report contains (the rule, the numbers behind it, source types, scores, app version and browser, never dates, source names or file contents) and opens a prefilled GitHub issue form or copies the text. Nothing is sent from the page, and a test fails if a name, year, month or weekday ever appears in a report.

## [0.1.0] - 2026-11-05

The first tagged release. Everything below this heading was built before tagging and is kept as dated history.

### Added
- Daylight-saving and time-zone handling: the timeline of UTC offsets is inferred from the records themselves, so travel and clock changes no longer look like faults.
- Phone layout: readable charts, bigger tap targets, a jump bar and a share sheet.

## 2026-11-03

### Added
- Each finding names the source or sources behind it.
- Stronger automated tests: unit tests at every rule boundary, browser tests (uploads, bad files, accessibility) and a stress run, all in CI.

## 2026-11-02

### Added
- Accessibility pass checked with axe-core; self-hosted fonts and unzip library, so the page makes no third-party requests; MIT licence.
- A share card redrawn to match the site.

### Changed
- Much lower memory use for large exports, with measured performance documented in the README.

## 2026-11-01

### Added
- First version: an Apple Health export checker that cross-checks sleep against heart rate and steps, the phone's steps against the watch's, heart-rate spikes, and coverage gaps. It runs entirely in the browser; the export is never uploaded.
- Results screen with your own watch drawn from the scores, findings with charts and filters, a per-day calendar with day detail, and a downloadable share card.
- Animated watch hero, favicon and link previews, a README with screenshots, and a test workflow.

[0.1.0]: https://github.com/batool-fariha/smartwatch-polygraph/releases/tag/v0.1.0
