/* Browser tests: drive the real page in Chromium.
   Run:  cd e2e && npm ci && npx playwright-core install chromium && node e2e.js [--stress]
   Set CHROMIUM_PATH to use a Chromium you already have. Exits 1 if anything fails. */
const http = require('http'), fs = require('fs'), os = require('os'), path = require('path'), { execFileSync } = require('child_process');
const { chromium } = require('playwright-core');
const axe = require('axe-core');
const fflate = require('../vendor/fflate.min.js');
const { generate } = require('../sample.js');

const ROOT = path.resolve(__dirname, '..');
const STRESS = process.argv.includes('--stress');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'polygraph-e2e-'));
const results = [];
let browser, base, server;

const server_ = () => new Promise((resolve) => {
  server = http.createServer((req, res) => {
    const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const file = path.join(ROOT, rel.endsWith('/') ? rel + 'index.html' : rel);
    if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
    fs.readFile(file, (e, buf) => {
      if (e) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' }); res.end(buf);
    });
  }).listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}/`));
});

async function test(name, fn) {
  const t0 = Date.now();
  try { await fn(); results.push([true, name]); console.log(`  ✔ ${name} (${((Date.now() - t0) / 1000).toFixed(1)}s)`); }
  catch (e) { results.push([false, name]); console.log(`  ✖ ${name}\n      ${String(e.message).split('\n').join('\n      ')}`); }
}
const ok = (cond, msg) => { if (!cond) throw new Error(msg); };
const eq = (a, b, msg) => { if (a !== b) throw new Error(`${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };

async function open(opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: true, ...opts });
  const page = await ctx.newPage();
  const errors = [], hosts = new Set();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('request', (r) => hosts.add(new URL(r.url()).host));
  await page.addInitScript(() => {
    window.__long = []; try { new PerformanceObserver((l) => l.getEntries().forEach((e) => window.__long.push(e.duration))).observe({ entryTypes: ['longtask'] }); } catch (e) {}
    window.__heap = 0; setInterval(() => { if (performance.memory) window.__heap = Math.max(window.__heap, performance.memory.usedJSHeapSize); }, 50);
  });
  await page.goto(base, { waitUntil: 'networkidle' });
  return { page, ctx, errors, hosts };
}
const sampleXml = generate({ days: 60, seed: 7 }).xml;
const write = (name, data) => { const f = path.join(tmp, name); fs.writeFileSync(f, data); return f; };
const u8 = (s) => fflate.strToU8(s);
const zip = (files) => Buffer.from(fflate.zipSync(files));
async function upload(page, file) {
  await page.setInputFiles('#file', file);
  await page.waitForFunction(() => getComputedStyle(document.getElementById('out')).display !== 'none' || getComputedStyle(document.getElementById('err')).display !== 'none', null, { timeout: 120000 });
  return page.evaluate(() => ({ done: getComputedStyle(document.getElementById('out')).display !== 'none', err: document.getElementById('err').textContent, sum: document.getElementById('sum').textContent, span: document.getElementById('span').textContent, grade: document.getElementById('grade').textContent }));
}

(async () => {
  base = await server_();
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--enable-precise-memory-info'] });
  console.log('\nLanding page');

  await test('loads with no errors, no third-party requests, and the bundled fonts', async () => {
    const { page, ctx, errors, hosts } = await open();
    eq([...hosts].join(','), new URL(base).host, 'hosts requested');
    eq(errors.length, 0, 'console or page errors: ' + errors.join(' | '));
    const f = await page.evaluate(async () => { await document.fonts.ready; return ['40px "Instrument Serif"', 'italic 40px "Instrument Serif"', '600 16px "Inter Tight"'].map((x) => document.fonts.check(x)); });
    ok(f.every(Boolean), 'fonts not loaded: ' + f);
    ok(/lying/.test(await page.textContent('h1')), 'headline');
    await ctx.close();
  });

  await test('has a title, description, link-preview tags and icons that all resolve', async () => {
    const { page, ctx } = await open();
    const meta = await page.evaluate(() => ({ title: document.title, desc: !!document.querySelector('meta[name=description]'), og: document.querySelector('meta[property="og:image"]').content, card: document.querySelector('meta[name="twitter:card"]').content, icons: [...document.querySelectorAll('link[rel*=icon]')].map((l) => l.getAttribute('href')) }));
    ok(/Smartwatch Polygraph/.test(meta.title) && meta.desc, 'title or description');
    ok(/^https:\/\/.+\/og\.png$/.test(meta.og), 'og:image must be an absolute https URL, got ' + meta.og);
    eq(meta.card, 'summary_large_image', 'twitter card');
    for (const href of [...meta.icons, 'og.png']) eq(await page.evaluate(async (h) => (await fetch(h)).status, href), 200, 'status of ' + href);
    await ctx.close();
  });

  await test('keyboard: skip link comes first, the watch replays with Enter and Space', async () => {
    const { page, ctx } = await open();
    await page.keyboard.press('Tab');
    eq(await page.evaluate(() => document.activeElement.textContent.trim()), 'Skip to content', 'first tab stop');
    await page.focus('#stage');
    for (const key of ['Enter', 'Space']) {
      await page.evaluate(() => document.getElementById('stage').classList.remove('go'));
      await page.keyboard.press(key);
      ok(await page.evaluate(() => document.getElementById('stage').classList.contains('go')), key + ' did not replay');
    }
    await ctx.close();
  });

  console.log('\nSample result');
  await test('sample data renders the score, sources, findings with charts, and the calendar', async () => {
    const { page, ctx, errors } = await open();
    await page.click('#demo'); await page.waitForSelector('#out', { state: 'visible' });
    const n = await page.evaluate(() => ({ cards: document.querySelectorAll('#cards .card').length, rc: document.querySelectorAll('.rc').length, cv: document.querySelectorAll('.cv').length, days: document.querySelectorAll('.hd').length, srcs: document.querySelectorAll('#srcs .srow').length, fix: document.querySelectorAll('.fixl').length, h1: document.activeElement.id, score: document.getElementById('rscore').textContent }));
    eq(n.cards, 4, 'score cards'); ok(n.rc >= 8, 'findings ' + n.rc); ok(n.cv >= 5, 'charts ' + n.cv); ok(n.days >= 60, 'days ' + n.days);
    eq(n.srcs, 2, 'sources'); eq(n.fix, n.rc, 'every finding has a what-to-do line'); eq(n.h1, 'grade', 'focus moves to the result heading');
    eq(errors.length, 0, 'errors: ' + errors.join(' | '));
    await ctx.close();
  });

  await test('filters, "See this day" and calendar clicks work, and "Check another" returns', async () => {
    const { page, ctx } = await open();
    await page.click('#demo'); await page.waitForSelector('#out', { state: 'visible' });
    const all = await page.locator('.rc').count();
    await page.click('.fb[data-k="steps"]');
    const stepsOnly = await page.locator('.rc').count();
    ok(stepsOnly > 0 && stepsOnly < all, `steps filter: ${stepsOnly} of ${all}`);
    ok(await page.evaluate(() => [...document.querySelectorAll('.rc .tag')].every((t) => /steps/i.test(t.textContent))), 'filter shows other kinds');
    await page.click('.fb[data-k="all"]');
    const before = await page.textContent('#daydetail .dd-h b');
    await page.locator('.lnk').nth(3).click();
    const after = await page.textContent('#daydetail .dd-h b');
    ok(after !== before, 'See this day did not change the selected day');
    await page.locator('.hd').nth(5).click();
    ok(await page.locator('.hd.sel').count() === 1, 'one selected day');
    await page.click('#again');
    ok(await page.isVisible('#drop'), 'landing not shown again');
    await ctx.close();
  });

  await test('the share card draws at 1080 x 1350, is not blank, and downloads', async () => {
    const { page, ctx, errors } = await open();
    await page.click('#demo'); await page.waitForSelector('#out', { state: 'visible' });
    const r = await page.evaluate(async () => { const c = await buildShareCard(); const g = c.getContext('2d'); const d = g.getImageData(0, 0, c.width, c.height).data; const seen = new Set(); for (let i = 0; i < d.length; i += 4 * 997) seen.add(d[i] + ',' + d[i + 1] + ',' + d[i + 2]); return { w: c.width, h: c.height, colours: seen.size }; });
    eq(r.w, 1080, 'width'); eq(r.h, 1350, 'height'); ok(r.colours > 200, 'card looks blank: ' + r.colours + ' colours');
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#share')]);
    eq(dl.suggestedFilename(), 'smartwatch-polygraph-score.png', 'download name');
    eq(errors.length, 0, 'errors: ' + errors.join(' | '));
    await ctx.close();
  });

  console.log('\nUploads');
  await test('an export.xml and the same export zipped give identical results', async () => {
    const a = await open(), b = await open();
    const x = await upload(a.page, write('export.xml', sampleXml));
    const z = await upload(b.page, write('export.zip', zip({ 'apple_health_export/export_cda.xml': u8('<ClinicalDocument/>'), 'apple_health_export/export.xml': u8(sampleXml) })));
    ok(x.done && z.done, 'results not shown: ' + x.err + ' / ' + z.err);
    eq(z.sum, x.sum, 'summary'); eq(z.span, x.span, 'span'); eq(z.grade, x.grade, 'grade');
    eq(a.errors.length + b.errors.length, 0, 'errors');
    await a.ctx.close(); await b.ctx.close();
  });

  const bad = [
    ['a zip with no export.xml', () => write('wrong.zip', zip({ 'photos/readme.txt': u8('hi') })), /No export\.xml found/],
    ['a truncated zip', () => write('trunc.zip', zip({ 'apple_health_export/export.xml': u8(sampleXml) }).subarray(0, 4000)), /Could not read that file/],
    ['an empty file', () => write('empty.xml', ''), /No steps, heart-rate or sleep records/],
    ['an html file', () => write('page.xml', '<html><body>hello</body></html>'), /No steps, heart-rate or sleep records/],
    ['an export with only body-mass records', () => write('mass.xml', '<HealthData><Record type="HKQuantityTypeIdentifierBodyMass" startDate="2026-01-01 10:00:00 +0000" endDate="2026-01-01 10:00:00 +0000" value="70"/></HealthData>'), /No steps, heart-rate or sleep records/]
  ];
  for (const [name, make, expect] of bad) {
    await test(`${name} shows a plain message and no results`, async () => {
      const { page, ctx } = await open();
      const r = await upload(page, make());
      ok(!r.done, 'showed results for a bad file'); ok(expect.test(r.err), 'message was: ' + r.err);
      ok(await page.isVisible('#err'), 'error not visible');
      const good = await upload(page, write('good.xml', sampleXml));   // and the page recovers
      ok(good.done, 'page did not recover after an error');
      await ctx.close();
    });
  }

  console.log('\nPhones');
  const phoneCtx = (w) => ({ viewport: { width: w, height: 812 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const audit = (page) => page.evaluate(() => {
    const vw = document.documentElement.clientWidth, bad = { overflow: document.documentElement.scrollWidth - vw, small: [], tiny: [] };
    for (const el of document.querySelectorAll('body *')) {
      const cs = getComputedStyle(el); if (cs.display === 'none' || cs.visibility === 'hidden' || el.closest('.sr')) continue;
      const b = el.getBoundingClientRect(); if (!b.width || !b.height) continue;
      if (['A', 'BUTTON', 'LABEL', 'SUMMARY'].includes(el.tagName) || el.getAttribute('role') === 'button') {
        const min = el.classList.contains('hd') ? 24 : 40;          // calendar cells are 24px apart, the WCAG 2.2 minimum
        if ((b.height < min || b.width < min) && !(cs.position === 'absolute' && b.left < 0)) bad.small.push(`${(el.textContent || el.getAttribute('aria-label') || el.id || el.tagName).trim().slice(0, 24)} ${Math.round(b.width)}x${Math.round(b.height)}`);
      }
      if (el.children.length === 0 && (el.textContent || '').trim()) {
        let px = parseFloat(cs.fontSize);
        if (el.tagName === 'text') { const svg = el.ownerSVGElement, vb = svg.viewBox.baseVal; if (vb && vb.width) px *= svg.getBoundingClientRect().width / vb.width; }
        if (px < (vw < 340 ? 9 : 10)) bad.tiny.push(`${el.textContent.trim().slice(0, 20)} ${px.toFixed(1)}px`);
      }
    }
    return bad;
  });
  for (const w of [320, 375, 414]) {
    await test(`${w}px wide: no sideways scrolling, tap targets of 40px or more, readable chart text`, async () => {
      const { page, ctx } = await open(phoneCtx(w));
      for (const state of ['landing', 'results']) {
        if (state === 'results') { await page.click('#demo'); await page.waitForSelector('#out', { state: 'visible' }); await page.waitForTimeout(500); }
        const a = await audit(page);
        ok(a.overflow <= 0, `${state}: page is ${a.overflow}px wider than the screen`);
        eq(a.small.length, 0, `${state}: small tap targets: ${[...new Set(a.small)].slice(0, 6).join(', ')}`);
        eq(a.tiny.length, 0, `${state}: text too small: ${[...new Set(a.tiny)].slice(0, 6).join(', ')}`);
      }
      await ctx.close();
    });
  }
  await test('phone: the jump bar scrolls to each section, and the sections are all there', async () => {
    const { page, ctx } = await open(phoneCtx(375));
    await page.click('#demo'); await page.waitForSelector('#out', { state: 'visible' });
    await page.evaluate(() => { document.documentElement.style.scrollBehavior = 'auto'; });
    for (const [label, id] of [['Findings', 'sec-findings'], ['Days', 'sec-days'], ['Sources', 'sec-sources'], ['Score', 'sec-score']]) {
      await page.click(`#jump a:text-is("${label}")`);
      // wait for the scroll to settle with the heading just under the sticky bars, instead of sleeping a fixed time
      await page.waitForFunction((i) => { const t = document.getElementById(i).getBoundingClientRect().top; return t >= 60 && t < 260; }, id, { timeout: 4000 }).catch(() => {});
      const top = await page.evaluate((i) => Math.round(document.getElementById(i).getBoundingClientRect().top), id);
      ok(top >= 60 && top < 260, `${label}: heading is at ${top}px, not just under the sticky bars`);
    }
    await ctx.close();
  });
  await test('phone: charts are drawn compactly and redrawn when the screen is widened', async () => {
    const { page, ctx } = await open(phoneCtx(375));
    await page.click('#demo'); await page.waitForSelector('#out', { state: 'visible' });
    const vb = () => page.evaluate(() => document.querySelector('.rc .cv svg').getAttribute('viewBox').split(' ')[2]);
    eq(await vb(), '300', 'phone chart width');
    await page.setViewportSize({ width: 900, height: 800 }); await page.waitForTimeout(300);
    eq(await vb(), '520', 'desktop chart width after resize');
    await ctx.close();
  });
  await test('phone: the share button opens the native share sheet with the card as a file', async () => {
    const { page, ctx } = await open({ ...phoneCtx(375) });
    await page.addInitScript(() => { navigator.canShare = () => true; navigator.share = async (d) => { window.__shared = { name: d.files[0].name, type: d.files[0].type, size: d.files[0].size }; }; });
    await page.reload({ waitUntil: 'networkidle' });
    await page.click('#demo'); await page.waitForSelector('#out', { state: 'visible' });
    eq((await page.textContent('#share')).trim(), 'Share card', 'button label on a touch device');
    await page.click('#share'); await page.waitForFunction(() => window.__shared);
    const f = await page.evaluate(() => window.__shared);
    eq(f.name, 'smartwatch-polygraph-score.png', 'shared file name'); eq(f.type, 'image/png', 'type'); ok(f.size > 20000, 'file too small: ' + f.size);
    await ctx.close();
  });

  console.log('\nAccessibility (axe-core, WCAG 2.2 A and AA plus best practices)');
  for (const state of ['landing', 'results']) {
    await test(`${state} has no violations`, async () => {
      const { page, ctx } = await open();
      if (state === 'results') { await page.click('#demo'); await page.waitForSelector('#out', { state: 'visible' }); }
      await page.waitForTimeout(4000);                  // let animations settle so contrast is measured on final colours
      await page.evaluate(axe.source);
      const v = await page.evaluate(async () => (await axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa', 'best-practice'] })).violations.map((x) => `${x.id} (${x.nodes.length}): ${x.nodes[0].target.join(' ')}`));
      eq(v.length, 0, 'violations:\n' + v.join('\n'));
      await ctx.close();
    });
  }

  if (STRESS) {
    console.log('\nStress (synthetic export, about 70 MB)');
    const gen = path.join(tmp, 'big'); fs.mkdirSync(gen);
    execFileSync('python3', [path.join(ROOT, 'tools', 'make_big_export.py'), gen, '200'], { stdio: 'inherit' });
    for (const f of ['export.xml', 'export.zip']) {
      await test(`${f} loads in time without freezing the page`, async () => {
        const { page, ctx, errors } = await open();
        const t0 = Date.now(); const r = await upload(page, path.join(gen, f)); const secs = (Date.now() - t0) / 1000;
        ok(r.done, 'no result: ' + r.err); ok(/of 200 nights/.test(r.sum), 'summary: ' + r.sum);
        const m = await page.evaluate(() => ({ longest: Math.max(0, ...window.__long), heapMB: Math.round(window.__heap / 1048576) }));
        console.log(`      ${secs.toFixed(1)} s, longest pause ${Math.round(m.longest)} ms, peak heap ${m.heapMB} MB`);
        ok(secs < 90, 'took ' + secs + ' s'); ok(m.longest < 3000, 'page froze for ' + Math.round(m.longest) + ' ms'); ok(m.heapMB < 1000, 'heap ' + m.heapMB + ' MB');
        eq(errors.length, 0, 'errors: ' + errors.join(' | '));
        await ctx.close();
      });
    }
  }

  await browser.close(); server.close(); fs.rmSync(tmp, { recursive: true, force: true });
  const failed = results.filter(([p]) => !p).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
