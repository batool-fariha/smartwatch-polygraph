# Security policy

Smartwatch Polygraph runs entirely in the browser. It has no backend, makes no third-party requests, and never uploads the Apple Health export you give it. The privacy model is described in the [README](README.md#privacy).

## What counts as a vulnerability

Please report anything that could expose or damage a user's data or browser, for example:

- a crafted `export.xml` or `export.zip` that runs script in the page, reads other files, or leaks content to another origin;
- a way to make the page send any part of an export, or any identifying value, over the network;
- the "Report a problem" flow including dates, source names or file contents (a test is meant to prevent this, so a failing case is a real bug);
- a zip or XML input that hangs or crashes the tab in a way the plain-language error handling should have caught.

Wrong scores and false positives are not security issues. Please use the [false-positive form](.github/ISSUE_TEMPLATE/false-positive.yml) for those.

## How to report

Use [GitHub private vulnerability reporting](https://github.com/batool-fariha/smartwatch-polygraph/security/advisories/new) rather than a public issue. Include steps to reproduce and the impact you see. **Do not attach a real health export.** Describe the shape of the input instead, or use a synthetic one from `sample.js` or `tools/make_big_export.py`.

You can expect an acknowledgement within a few days. This is a small, maintained-in-spare-time project, so fixes are made as soon as practical rather than on a fixed schedule.

## Supported versions

Only the latest release, and the deployed site, receive fixes. The project is on 0.x, so please check you are on the newest version before reporting.
