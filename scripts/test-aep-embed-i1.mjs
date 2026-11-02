// Headless check that real Atlas embeds work when framed from another loopback port.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkGolden } from './check-aep-bi.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const aep = process.env.AEP_REPO;
if (!aep) throw new Error('Set AEP_REPO to the AEP main checkout');
const python = process.env.ATLAS_PYTHON ?? 'python';
const scratch = resolve(root, '.scratch/aep-embed-i1');
await mkdir(scratch, { recursive: true });
const temporary = await mkdtemp(join(tmpdir(), 'atlas-embed-i1-'));
const fixtures = resolve(root, 'web/tests/fixtures');
const feed = async name => JSON.parse(await readFile(resolve(fixtures, 'aep_bi', name), 'utf8'));
const catalog = await feed('analyses.json');
const FEED_PORT = 53611, ATLAS_PORT = 53612, ALLOWED_PORT = 53613, REFUSED_PORT = 53614;
const ATLAS = `http://127.0.0.1:${ATLAS_PORT}`;
const results = [], children = [], hosts = [];
let socket, send, diagnose;
const delay = ms => new Promise(done => setTimeout(done, ms));
async function until(check, label, timeout = 30000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) { try { last = await check(); if (last) return last; } catch (error) { if (error.fatal) throw error; last = error.message; } await delay(150); }
  throw new Error(`Timed out: ${label}; last=${JSON.stringify(last)}`);
}
function start(command, args, cwd, env = {}) {
  const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.output = ''; child.on('error', error => { child.failure = error; });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { child.output = (child.output + data).slice(-20000); });
  children.push(child); return child;
}
const ready = (child, pattern) => until(() => { if (child.failure || child.exitCode !== null) throw Object.assign(new Error(child.failure?.message ?? child.output), { fatal: true }); return child.output.match(pattern); }, `process ready ${pattern}`, 120000);
// Edge and venv launchers leave real processes behind a plain kill, and those keep our pipes open.
async function stop(child) {
  if (child.exitCode === null && child.signalCode === null) {
    const closed = once(child, 'exit');
    if (process.platform === 'win32') await once(spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }), 'exit'); else child.kill();
    await closed;
  }
  child.stdout?.destroy(); child.stderr?.destroy();
}
function pass(name, evidence) { results.push({ name, outcome: 'passed', evidence }); console.log(`PASS ${name}: ${evidence}`); }
const frameUrl = path => `${ATLAS}${path}`;
const PANEL = `/embed/panel?vault=${catalog.vault}&slug=node-coverage`;
const PARAM_PANEL = `/embed/panel?vault=${catalog.vault}&slug=accounts-by-region&domain=AIDC`;
const WAITING_PANEL = `/embed/panel?vault=${catalog.vault}&slug=tech-updates&domain=wireless`;
const DASHBOARD = '/embed/dashboard/Embed%20fixture';

/** The parent page: same security posture as Agent Web (no-referrer), one iframe from ?src=. */
async function hostOn(port) {
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://host.invalid');
    const src = url.searchParams.get('src') ?? '', policy = url.searchParams.get('referrer');
    const attribute = policy ? ` referrerpolicy="${policy}"` : '';
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'referrer-policy': 'no-referrer', 'cache-control': 'no-store' });
    response.end(`<!doctype html><title>host</title><body style="margin:0"><script>window.sizes=[];addEventListener('message',e=>{if(e.source===document.querySelector('iframe').contentWindow)sizes.push({origin:e.origin,data:e.data})})</script><iframe id="embed" src="${src.replaceAll('&', '&amp;')}"${attribute} style="width:900px;height:520px;border:0"></iframe>`);
  });
  await new Promise((done, fail) => { server.once('error', fail); server.listen(port, '127.0.0.1', done); });
  hosts.push(server);
}

try {
  assert.equal(await checkGolden(aep), 17);
  const build = start(process.execPath, [resolve(root, 'web/node_modules/vite/bin/vite.js'), 'build', '--outDir', join(temporary, 'dist'), '--emptyOutDir'], resolve(root, 'web'), { VITE_AEP_BI_PORT: String(FEED_PORT) });
  await once(build, 'exit'); assert.equal(build.exitCode, 0, build.output);
  // The real server on a temporary store; the owner's Atlas data directory is never opened.
  const data = join(temporary, 'data');
  const seed = `
import json, sys
from pathlib import Path
from server.storage import DashboardStore
store = DashboardStore(Path(sys.argv[1]))
for name, document in json.loads(Path(sys.argv[2]).read_bytes()).items():
    store.put(name, document, if_none_match="*")
store.close()
`;
  // Fictional layouts from the read contract: one that works, and one with each kind of broken panel.
  const mixed = JSON.parse(await readFile(resolve(fixtures, 'atlas_dashboard_golden/dashboard-mixed.json'), 'utf8'));
  const working = mixed.panels.filter(panel => panel.datasource.id === 'aep.bi.result' && panel.query.vault === catalog.vault);
  const coverage = working.find(panel => panel.id === 'bi-coverage');
  const broken = { ...mixed, values: { 'bi:vault': 'no-such-vault' }, panels: [coverage, { ...coverage, id: 'bad-transform', transform: [{ op: 'limit', n: -1 }], layout: { ...coverage.layout, x: 0, y: 8 } }, { ...coverage, id: 'gone-vault', query: { ...coverage.query, vault: 'no-such-vault' }, layout: { ...coverage.layout, x: 6, y: 8 } }] };
  // A saved subset: one current analysis, plus one the feed no longer publishes.
  const subset = { ...mixed, panels: [{ ...coverage, layout: { x: 0, y: 0, w: 6, h: 8 } }, { ...coverage, id: 'bi-unpublished', title: 'Unpublished', query: { ...coverage.query, slug: 'no-longer-published' }, layout: { x: 6, y: 0, w: 6, h: 8 } }] };
  // A saved board current with version 1, for the republish case: tech-updates is left off it on purpose.
  const savedPanel = (id, slug, x) => ({ ...coverage, id, title: catalog.analyses.find(item => item.slug === slug).title, query: { vault: catalog.vault, slug, params: { domain: 'robotics' }, digest: catalog.analyses.find(item => item.slug === slug).digest }, transform: [], layout: { x, y: 0, w: 6, h: 8 } });
  const republish = { ...mixed, panels: [savedPanel('saved-coverage', 'node-coverage', 0), savedPanel('saved-region', 'accounts-by-region', 6)] };
  await writeFile(join(temporary, 'dashboard.json'), JSON.stringify({ 'Embed fixture': { ...mixed, panels: working }, 'Broken panels': broken, Subset: subset, Republish: republish }));
  const seeded = start(python, ['-B', '-c', seed, data, join(temporary, 'dashboard.json')], root);
  await once(seeded, 'exit'); assert.equal(seeded.exitCode, 0, seeded.output);
  const allowed = [`http://127.0.0.1:${ALLOWED_PORT}`, `http://localhost:${ALLOWED_PORT}`];
  const atlas = start(python, ['-B', '-m', 'server', '--port', String(ATLAS_PORT), '--data-dir', data, '--static-dir', join(temporary, 'dist'), ...allowed.flatMap(origin => ['--allow-frame-ancestor', origin])], root, { ATLAS_DASHBOARD_DATA_DIR: data });
  await ready(atlas, /Atlas Analysis Dashboard:/);
  const fixture = start(resolve(aep, '.venv/Scripts/python.exe'), ['-B', 'scripts/bi_feed_server.py', '--port', String(FEED_PORT), '--queue-delay', '6'], aep, { PYTHONDONTWRITEBYTECODE: '1' });
  await ready(fixture, new RegExp(`ready http://127\\.0\\.0\\.1:${FEED_PORT}/api/v1/bi`));
  await hostOn(ALLOWED_PORT); await hostOn(REFUSED_PORT);

  const executable = process.env.BI_BROWSER ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
  await access(executable);
  const browser = start(executable, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${join(temporary, 'profile')}`, 'about:blank'], root);
  const endpoint = (await ready(browser, /DevTools listening on (ws:\/\/[^\s]+)/))[1];
  const tabs = await (await fetch(`http://127.0.0.1:${new URL(endpoint).port}/json/list`)).json();
  socket = new WebSocket(tabs.find(tab => tab.type === 'page').webSocketDebuggerUrl);
  await once(socket, 'open');
  let sequence = 0;
  const pending = new Map(), responses = [], exceptions = [], sessions = new Set([undefined]), writes = [];
  socket.addEventListener('message', event => {
    const message = JSON.parse(String(event.data));
    if (message.id) { const task = pending.get(message.id); if (task) { pending.delete(message.id); clearTimeout(task.timer); message.error ? task.reject(new Error(JSON.stringify(message.error))) : task.resolve(message.result); } }
    if (message.method === 'Target.attachedToTarget') {
      const session = message.params.sessionId; sessions.add(session);
      for (const method of ['Page.enable', 'Runtime.enable', 'Network.enable']) send(method, {}, session).catch(() => {});
      send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, session).catch(() => {});
    }
    if (message.method === 'Target.detachedFromTarget') sessions.delete(message.params.sessionId);
    if (message.method === 'Network.responseReceived') responses.push({ url: message.params.response.url, status: message.params.response.status, headers: message.params.response.headers, type: message.params.type });
    if (message.method === 'Network.requestWillBeSent' && !['GET', 'HEAD', 'OPTIONS'].includes(message.params.request.method)) writes.push(`${message.params.request.method} ${message.params.request.url}`);
    if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails);
  });
  send = (method, params = {}, sessionId) => new Promise((done, fail) => { const id = ++sequence; const timer = setTimeout(() => { pending.delete(id); fail(new Error(`CDP timeout: ${method}`)); }, 20000); pending.set(id, { resolve: done, reject: fail, timer }); socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); });
  for (const method of ['Page.enable', 'Runtime.enable', 'Network.enable']) await send(method);
  await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  await send('Emulation.setDeviceMetricsOverride', { width: 1000, height: 700, deviceScaleFactor: 1, mobile: false });
  const top = async expression => { const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails)); return result.result.value; };
  // A cross-site frame lives in its own target; search every attached session for it.
  const inFrame = async expression => {
    for (const session of [...sessions]) {
      const tree = await send('Page.getFrameTree', {}, session).catch(() => null);
      const walk = node => !node ? [] : [node.frame, ...(node.childFrames ?? []).flatMap(child => walk(child))];
      const frame = walk(tree?.frameTree).find(item => item.url.startsWith(ATLAS));
      if (!frame) continue;
      const { executionContextId } = await send('Page.createIsolatedWorld', { frameId: frame.id, worldName: `check-${++sequence}` }, session);
      const result = await send('Runtime.evaluate', { expression, contextId: executionContextId, returnByValue: true, awaitPromise: true }, session);
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result.value;
    }
    return null;
  };
  const open = async (hostOrigin, path, referrer) => {
    responses.length = 0;
    const url = `${hostOrigin}/?src=${encodeURIComponent(frameUrl(path))}${referrer ? `&referrer=${referrer}` : ''}`;
    const { errorText } = await send('Page.navigate', { url });
    assert.equal(errorText, undefined, `navigating to ${url}`);
    // Until the new page commits, a check would still be reading the previous page's frame.
    await until(async () => (await top('location.href')) === url, `committed ${url}`, 60000);
  };
  diagnose = async () => ({
    top: await top('location.href').catch(error => error.message),
    frames: await Promise.all([...sessions].map(async session => { const tree = await send('Page.getFrameTree', {}, session).catch(error => ({ error: error.message })); const walk = node => !node ? [] : [node.frame?.url, ...(node.childFrames ?? []).flatMap(walk)]; return { session: session ?? 'main', urls: walk(tree.frameTree), error: tree.error }; })),
    responses: responses.slice(-20).map(({ url, status }) => ({ url, status })),
  });
  const state = () => inFrame(`document.querySelector('[data-embed-state]')?.dataset.embedState ?? null`);
  const reach = (expected, timeout) => until(async () => (await state()) === expected, `state ${expected}`, timeout);
  const panelRows = slug => inFrame(`[...document.querySelectorAll('[data-panel-id="bi-${slug}"] tbody tr')].map(r=>[...r.querySelectorAll('td')].map(c=>c.textContent))`);
  const panelMarks = slug => inFrame(`[...document.querySelectorAll('[data-panel-id="bi-${slug}"] svg [role="button"]')].map(m=>m.getAttribute('aria-label'))`);
  const shot = async name => { const { data } = await send('Page.captureScreenshot', { captureBeyondViewport: true }); await writeFile(resolve(scratch, `${name}.png`), Buffer.from(data, 'base64')); };
  const sameSite = `http://127.0.0.1:${ALLOWED_PORT}`, crossSite = `http://localhost:${ALLOWED_PORT}`;
  const documentResponse = path => responses.find(item => item.url === frameUrl(path));

  // Panel, framed same-site from another port.
  await open(sameSite, PANEL);
  await reach('ready');
  const expected = (await feed('result-node-coverage.json')).rows.map(row => row.map(value => value === null ? '—' : String(value)));
  await until(async () => JSON.stringify(await panelRows('node-coverage')) === JSON.stringify(expected), 'panel golden rows');
  const headers = documentResponse(PANEL).headers, lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  assert.equal(lower['x-frame-options'], undefined);
  assert.match(lower['content-security-policy'], new RegExp(`frame-ancestors ${sameSite} ${crossSite};`));
  assert.equal(await inFrame(`document.querySelector('[aria-label="AEP BI controls"] select option[value="${catalog.vault}"]')`), null);
  assert.equal(await inFrame(`[...document.querySelectorAll('button')].some(b=>/Edit Dashboard|New dashboard|Save As|Reload vaults/.test(b.textContent))`), false);
  pass('panel embed', 'same-site frame on another port: golden rows, frame-ancestors header, no editor, no vault picker');

  // The panel fills its frame and posts a height to exactly the parent's origin.
  const fill = await inFrame(`(() => { const p=document.querySelector('[data-panel-id]').getBoundingClientRect(); return {bottom:p.bottom,right:p.right,w:innerWidth,h:innerHeight,overflow:document.documentElement.scrollHeight>innerHeight}; })()`);
  assert.ok(fill.h - fill.bottom < 24 && fill.w - fill.right < 24 && !fill.overflow, `panel does not fill: ${JSON.stringify(fill)}`);
  const sizes = await until(async () => { const value = await top('sizes'); return value.length ? value : null; }, 'size message');
  for (const size of sizes) { assert.equal(size.origin, ATLAS); assert.equal(size.data.type, 'atlas-embed-size'); assert.ok(Number.isInteger(size.data.height) && size.data.height > 0, JSON.stringify(size)); }
  const before = sizes.at(-1).data.height;
  await top(`document.querySelector('iframe').style.height='300px'`);
  await delay(800);
  assert.equal((await top('sizes')).at(-1).data.height, before, 'preferred height must not follow the frame');
  await top(`document.querySelector('iframe').style.height=${before}+'px'`);
  await delay(800);
  assert.equal((await top('sizes')).at(-1).data.height, before, 'following the message must not change it');
  pass('sizing', `fills the frame (${JSON.stringify(fill)}); posts ${before}px to the parent, stable when the frame resizes`);
  await shot('01-panel-same-site');

  // Parameter from the URL, then an in-memory control change.
  await open(sameSite, PARAM_PANEL);
  await reach('ready');
  const marks = async file => { const data = await feed(file), analysis = catalog.analyses.find(item => item.slug === data.slug); return data.rows.map(row => `${row[data.columns.indexOf(analysis.chart.x)]}: ${row[data.columns.indexOf(analysis.chart.y)]}`); };
  const hasMarks = async (slug, file) => { const want = await marks(file), have = await panelMarks(slug); return have.length === want.length && want.every(mark => have.some(item => item.includes(mark))); };
  await until(() => hasMarks('accounts-by-region', 'result-accounts-by-region-domain-AIDC.json'), 'URL parameter marks');
  await inFrame(`(() => { const el=document.querySelector('[aria-label="AEP BI controls"] label select'); el.value='robotics'; el.dispatchEvent(new Event('change',{bubbles:true})); })()`);
  await until(() => hasMarks('accounts-by-region', 'result-accounts-by-region.json'), 'control refetch marks');
  pass('parameters', 'URL domain=AIDC rendered golden marks; the control refetched robotics golden marks');

  // result_not_ready: the fixture's 6 s delay outlasts the three retries, so exhaustion is deterministic.
  await open(sameSite, WAITING_PANEL);
  await reach('waiting');
  const notReady = () => responses.filter(item => item.url.includes('tech-updates/result?domain=wireless') && item.status === 409).length;
  await until(() => notReady() === 4, 'first read plus three retries, all 409');
  await delay(2500);
  const answered = notReady();
  assert.equal(answered, 4, 'retries stop after three');
  assert.equal(await state(), 'waiting');
  assert.equal(await inFrame(`document.querySelector('[role="alert"]')`), null);
  await shot('02-waiting-exhausted');
  // One click per answer: a click cancels the read before it, so clicking on a timer can starve it.
  const waitingReads = () => responses.filter(item => item.url.includes('tech-updates/result?domain=wireless'));
  const refreshed = [];
  await until(async () => {
    if ((await state()) === 'ready') return true;
    const seen = waitingReads().length;
    await inFrame(`document.querySelector('button[title="Refresh panel"]').click()`);
    await until(() => waitingReads().length > seen, 'answer to Refresh', 20000);
    refreshed.push(waitingReads().at(-1).status);
    await delay(300);
    return false;
  }, `Refresh after retries stop; statuses ${JSON.stringify(refreshed)}`, 60000);
  await until(() => hasMarks('tech-updates', 'result-tech-updates-domain-wireless.json'), 'queued result marks');
  pass('result_not_ready', `${answered}x 409 then retries stop and the state stays waiting without an alert; Refresh answered ${JSON.stringify(refreshed)} and rendered the golden result`);

  // Clear states, framed.
  for (const [path, want, text] of [
    [`/embed/panel?vault=${catalog.vault}&slug=no-such-analysis`, 'unknown_analysis', 'no-such-analysis'],
    ['/embed/panel?vault=no-such-vault&slug=node-coverage', 'unknown_vault', 'no-such-vault'],
    [`/embed/panel?vault=${catalog.vault}&slug=node-coverage&domain=bogus`, 'invalid_link', 'bogus'],
    ['/embed/dashboard/No%20such%20dashboard', 'unknown_dashboard', 'No such dashboard'],
  ]) {
    await open(sameSite, path);
    await reach(want);
    assert.ok((await inFrame(`document.querySelector('[role="alert"]').textContent`)).includes(text), path);
  }
  await shot('03-unknown-dashboard');
  pass('clear states', 'unknown analysis, unknown vault, invalid parameter and unknown dashboard each show their message');

  // Dashboard, framed cross-site: the Referer attribute is what makes this pass.
  await open(crossSite, DASHBOARD, 'origin');
  await reach('ready');
  await until(async () => (await inFrame(`document.querySelectorAll('[data-panel-id]').length`)) >= 4, 'dashboard panels');
  assert.equal(documentResponse(DASHBOARD).status, 200);
  assert.deepEqual(await until(async () => { const value = await inFrame(`['bi-region','bi-coverage','bi-tech','bi-coverage-copy'].map(id=>!!document.querySelector('[data-panel-id="'+id+'"]'))`); return value?.every(Boolean) ? value : null; }, 'saved panels'), [true, true, true, true]);
  assert.equal(await inFrame(`[...document.querySelectorAll('button')].some(b=>/Edit Dashboard|New dashboard|Save As/.test(b.textContent))`), false);
  await until(async () => JSON.stringify(await panelRows('coverage')) === JSON.stringify(expected.slice(0, 5)), 'dashboard panel golden rows, under its saved limit');
  assert.equal(await inFrame(`document.querySelector('[data-panel-id="bi-coverage"]').textContent.includes('Could not render')`), false);
  const dashboardSizes = await until(async () => { const value = await top('sizes'); return value.length ? value : null; }, 'dashboard size message');
  assert.equal(dashboardSizes.at(-1).origin, ATLAS);
  await shot('04-dashboard-cross-site');
  pass('dashboard embed', 'cross-site frame with referrerpolicy=origin: saved panels shown, no editor, height posted');

  // Panel failures and a vanished vault: the layout stays, the root says error, working panels work.
  await open(sameSite, '/embed/dashboard/Broken%20panels');
  await reach('error');
  await until(async () => JSON.stringify(await panelRows('coverage')) === JSON.stringify(expected.slice(0, 5)), 'working panel beside broken ones');
  assert.match(await until(() => inFrame(`document.querySelector('[data-panel-id="bad-transform"]').textContent`), 'bad panel'), /Could not render this panel.*Invalid limit/s);
  assert.match(await until(() => inFrame(`document.querySelector('[data-panel-id="gone-vault"]').textContent`), 'gone vault panel'), /AEP BI error:.*no-such-vault/s);
  assert.equal(await inFrame(`document.querySelector('.atlas-embed-message')`), null, 'no page-level message replaces the layout');
  assert.match(await inFrame(`document.querySelector('[aria-label="AEP BI controls"] [role="status"]').textContent`), /no-such-vault/);
  await shot('05-broken-panels');
  pass('dashboard failures', 'bad transform and missing vault each report in their own card, root state error, working panel keeps golden rows');

  // Cross-site with the parent's no-referrer and no attribute: Atlas refuses.
  await open(crossSite, PANEL);
  const missing = await until(() => documentResponse(PANEL), 'refused document response');
  assert.equal(missing.status, 403);
  pass('cross-site without Referer', '403 from Atlas, as the contract says');

  // A loopback parent that is not a frame ancestor: Atlas answers, the browser refuses to render it.
  responses.length = 0;
  await open(`http://127.0.0.1:${REFUSED_PORT}`, PANEL);
  const blocked = await until(() => documentResponse(PANEL), 'blocked document response');
  assert.equal(blocked.status, 200);
  await delay(1500);
  assert.equal(await state(), null, 'the frame must not run Atlas');
  const parent = await top(`(() => { try { return document.querySelector('iframe').contentDocument?.querySelector('[data-embed-state]') ?? null; } catch { return null; } })()`);
  assert.equal(parent, null);
  await shot('06-refused-ancestor');
  pass('other ancestor', 'same-site parent not in frame-ancestors: the browser did not render the embed');

  // A saved dashboard is what was saved: no analysis arrives by itself, in an embed or in the app.
  const stored = async name => (await fetch(`${ATLAS}/dashboards/${encodeURIComponent(name)}`)).json();
  const panelIds = expression => expression(`[...document.querySelectorAll('[data-panel-id]')].map(el=>el.dataset.panelId)`);
  const titleOf = slug => catalog.analyses.find(item => item.slug === slug).title;
  await open(sameSite, '/embed/dashboard/Subset');
  await reach('ready');
  assert.deepEqual(await panelIds(inFrame), ['bi-coverage'], 'unpublished removed, nothing appended');
  assert.equal(await inFrame(`document.querySelector('[data-panel-id="bi-coverage"] h2').textContent`), titleOf('node-coverage'), 'a stale panel still updates');
  assert.equal((await stored('Subset')).panels.length, 2, 'an embed reconciles in memory only');
  pass('saved subset in an embed', 'one panel of three, updated from the catalog; unpublished one removed in memory; stored document untouched');

  assert.deepEqual(writes, [], 'no embed page has written so far');
  const appUrl = `${ATLAS}/`;
  const openApp = async () => { await send('Page.navigate', { url: appUrl }); await until(async () => (await top('location.href')) === appUrl && await top(`!!document.querySelector('#atlas-dashboard-controls select option[value="aep_bi"]')`), 'Atlas app loaded'); };
  const choose = (select, value) => top(`(() => { const el = ${select}; if (!el) throw new Error('Missing select'); el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  const controlSelect = index => `document.querySelectorAll('#atlas-dashboard-controls select')[${index}]`;
  const addPicker = `[...document.querySelectorAll('[aria-label="AEP BI controls"] label')].find(l=>l.textContent.startsWith('Add analysis'))?.querySelector('select')`;
  const clickButton = label => top(`(() => { const el = [...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(label)}); if (!el) throw new Error('Missing button ' + ${JSON.stringify(label)}); el.click(); })()`);

  // The unsaved live board keeps showing everything.
  await openApp();
  await choose(controlSelect(0), 'aep_bi');
  await until(() => top(`!!document.querySelector('[aria-label="AEP BI controls"] option[value="${catalog.vault}"]')`), 'vault listed');
  await choose(`document.querySelector('[aria-label="AEP BI controls"] select')`, catalog.vault);
  await until(async () => JSON.stringify(await panelIds(top)) === JSON.stringify(catalog.order.map(slug => `bi-${slug}`)), 'live board in feed order');
  assert.equal(await top(`!!${addPicker}`), false);
  pass('live board', 'choosing a vault shows every analysis in feed order, with no picker');

  // Open the saved subset in the app; add by hand through the editor.
  await choose(controlSelect(2), 'Subset');
  await until(async () => JSON.stringify(await panelIds(top)) === JSON.stringify(['bi-coverage']), 'saved subset in the app');
  await until(() => top(`!!${addPicker}`), 'add analysis picker');
  assert.deepEqual(await top(`[...${addPicker}.options].slice(1).map(o=>o.value)`), ['accounts-by-region', 'tech-updates']);
  await delay(16500);
  assert.deepEqual(await panelIds(top), ['bi-coverage'], 'still a subset after the next catalog poll');
  await choose(addPicker, 'accounts-by-region');
  await until(async () => (await panelIds(top)).includes('bi-accounts-by-region'), 'hand-picked panel');
  assert.match(await top(`document.querySelector('.atlas-mode').textContent`), /EDIT MODE/);
  await clickButton('Cancel');
  await until(async () => JSON.stringify(await panelIds(top)) === JSON.stringify(['bi-coverage']), 'Cancel removes the hand-picked panel');
  assert.equal((await stored('Subset')).panels.length, 2, 'Cancel wrote nothing');
  await choose(addPicker, 'accounts-by-region');
  await until(async () => (await panelIds(top)).includes('bi-accounts-by-region'), 'hand-picked panel again');
  await clickButton('Save');
  await until(async () => JSON.stringify((await stored('Subset')).panels.map(panel => panel.query.slug)) === JSON.stringify(['node-coverage', 'accounts-by-region']), 'Save stores the choice');
  pass('saved subset in the app', 'stays a subset across a catalog poll; the picker adds through the editor, Cancel undoes it, Save stores it');

  // Export writes a real file, which imports again; a name in use is never overwritten silently.
  const downloads = join(temporary, 'downloads');
  await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });
  await until(() => top(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Export')?.disabled === false`), 'preview mode');
  await clickButton('Export');
  const exportedPath = join(downloads, 'Subset.json');
  const exportedText = await until(() => readFile(exportedPath, 'utf8'), 'downloaded file');
  assert.deepEqual(JSON.parse(exportedText).panels.map(panel => panel.query.slug), ['node-coverage', 'accounts-by-region']);
  assert.deepEqual(JSON.parse(exportedText), await stored('Subset'), 'the exported file is the GET body as a document, unwrapped');
  const chooseFile = async path => { const { result } = await send('Runtime.evaluate', { expression: `document.querySelector('input[aria-label="Dashboard file to import"]')` }); await send('DOM.setFileInputFiles', { files: [path], objectId: result.objectId }); };
  const dialogOpen = () => top(`!!document.querySelector('[aria-label="Import dashboard"]')`);
  const rename = name => top(`(() => { const el = document.querySelector('[aria-label="Import dashboard"] input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(name)}); el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  const importFile = `document.querySelector('[aria-label="Import dashboard"] button.primary').click()`;
  const storedSubset = JSON.stringify(await stored('Subset'));
  await chooseFile(exportedPath);
  await until(dialogOpen, 'import dialog');
  assert.equal(await top(`document.querySelector('[aria-label="Import dashboard"] input').value`), 'Subset');
  await top(importFile);
  await until(() => top(`document.querySelector('[aria-label="Import dashboard"] [role="alert"]')?.textContent.includes('already exists') ?? false`), 'name in use');
  assert.equal(JSON.stringify(await stored('Subset')), storedSubset, 'a name in use is not overwritten');
  await rename('Imported copy');
  await top(importFile);
  await until(async () => (await top(controlSelect(2) + '.value')) === 'Imported copy', 'imported dashboard opened');
  assert.equal(await dialogOpen(), false);
  assert.deepEqual((await stored('Imported copy')).panels.map(panel => panel.query.slug), ['node-coverage', 'accounts-by-region']);
  pass('export and import', 'a real downloaded file equals the GET body as a document and imports again; the name in use was refused and kept; the new name opened in the app');

  // Explicit replace.
  const replacement = join(temporary, 'Subset.json');
  await writeFile(replacement, JSON.stringify({ ...JSON.parse(exportedText), title: 'Replaced title' }));
  await chooseFile(replacement);
  await until(dialogOpen, 'import dialog for replace');
  await top(importFile);
  await until(() => top(`[...document.querySelectorAll('[aria-label="Import dashboard"] button')].some(b=>b.textContent==='Replace existing')`), 'replace offered');
  assert.equal(JSON.stringify(await stored('Subset')), storedSubset);
  await clickButton('Replace existing');
  await until(async () => (await stored('Subset')).title === 'Replaced title', 'explicit replace stored');
  await until(async () => (await top(`document.querySelector('h1').textContent`)) === 'Replaced title', 'replaced dashboard opened');
  pass('explicit replace', 'Replace existing stored the file with If-Match and opened it');

  // Invalid files are refused with a message, and nothing opens or is stored.
  const namesBefore = await (await fetch(`${ATLAS}/dashboards`)).json();
  for (const [file, text, message] of [['bad.json', '{oops', 'not valid JSON'], ['old.json', JSON.stringify({ ...JSON.parse(exportedText), schemaVersion: 1 }), 'schemaVersion'], ['other.json', JSON.stringify({ ...JSON.parse(exportedText), applicationId: 'other-app' }), 'not installed']]) {
    const path = join(temporary, file);
    await writeFile(path, text);
    await chooseFile(path);
    await until(() => top(`[...document.querySelectorAll('.atlas-status')].some(el => el.textContent.includes(${JSON.stringify(file)}) && el.textContent.includes(${JSON.stringify(message)}))`), `refusal of ${file}`);
    assert.equal(await dialogOpen(), false);
  }
  assert.deepEqual(await (await fetch(`${ATLAS}/dashboards`)).json(), namesBefore);
  pass('invalid files', 'bad JSON, another schema version and an uninstalled application are each refused with a message; nothing stored');

  // A file naming things this PC lacks: it imports, and each panel fails alone.
  const brokenFile = join(temporary, 'Imported broken.json');
  await writeFile(brokenFile, JSON.stringify(await stored('Broken panels')));
  await chooseFile(brokenFile);
  await until(dialogOpen, 'import dialog for the broken file');
  await top(importFile);
  await until(async () => (await top(controlSelect(2) + '.value')) === 'Imported broken', 'broken file opened');
  await until(() => top(`/AEP BI error:.*no-such-vault/s.test(document.querySelector('[data-panel-id="gone-vault"]')?.textContent ?? '')`), 'error card in the app');
  await shot('08-imported-in-app');
  assert.deepEqual(exceptions, []);
  for (const write of writes) assert.match(write, new RegExp(`^PUT ${ATLAS}/dashboards/`), 'the app only writes dashboards');
  writes.length = 0;

  // Both imports open at their embed address; embeds stay read-only.
  await open(sameSite, '/embed/dashboard/Imported%20copy');
  await reach('ready');
  assert.deepEqual([...await panelIds(inFrame)].sort(), ['bi-accounts-by-region', 'bi-coverage']);
  await open(sameSite, '/embed/dashboard/Imported%20broken');
  await reach('error');
  assert.match(await until(() => inFrame(`document.querySelector('[data-panel-id="gone-vault"]').textContent`), 'gone vault card'), /AEP BI error:.*no-such-vault/s);
  await until(async () => JSON.stringify(await panelRows('coverage')) === JSON.stringify(expected.slice(0, 5)), 'working panel of the imported file');
  pass('imported dashboards embed', 'an imported dashboard opens at /embed/dashboard/<name>; a missing vault stays its own error card beside a working panel');

  // Stopping AEP keeps the last data, and the frame says offline.
  await open(sameSite, PANEL);
  await reach('ready');
  await until(async () => JSON.stringify(await panelRows('node-coverage')) === JSON.stringify(expected), 'rows before stopping');
  await stop(fixture);
  await inFrame(`document.querySelector('button[title="Refresh panel"]').click()`);
  await reach('offline');
  // The status poll can report offline before the refreshed panel's own read gives up.
  await until(async () => /last data retained/.test(await inFrame(`document.querySelector('[data-panel-id]').textContent`)), 'panel keeps its last data');
  assert.deepEqual(await panelRows('node-coverage'), expected);
  await shot('07-offline');
  pass('AEP offline', 'stopped fixture: state offline, golden rows kept, last-data warning shown');

  // AEP was never running for this page load.
  await open(sameSite, PANEL);
  await reach('offline');
  assert.match(await inFrame(`document.querySelector('[role="alert"]').textContent`), /AEP is offline/);
  pass('AEP offline from the start', 'clear offline message');

  // A real republish, from an Atlas-only stub on the feed's port; AEP and its goldens are untouched.
  // Version 2 changes node-coverage's digest, removes accounts-by-region and adds brand-new.
  let revision = 1;
  const health = await feed('health.json'), vaultList = await feed('vaults.json');
  const defaultResults = Object.fromEntries(await Promise.all(catalog.order.map(async slug => [slug, await feed(`result-${slug}.json`)])));
  const secondVersion = { tag: 'stub-v2', commit: 'stub-commit-2' };
  const listing = () => {
    if (revision === 1) return catalog;
    const next = structuredClone(catalog);
    next.version = secondVersion;
    next.analyses = next.analyses.filter(item => item.slug !== 'accounts-by-region').map(item => item.slug === 'node-coverage' ? { ...item, digest: 'stub-digest-2', title: 'Republished coverage' } : item);
    next.analyses.push({ ...next.analyses.find(item => item.slug === 'node-coverage'), slug: 'brand-new', title: 'Brand new analysis', digest: 'stub-digest-new' });
    next.order = ['brand-new', ...next.order.filter(slug => slug !== 'accounts-by-region')];
    return next;
  };
  const stub = createServer((request, response) => {
    const url = new URL(request.url, 'http://stub.invalid'), slug = decodeURIComponent(url.pathname.split('/').at(-2));
    const version = listing().version;
    let data;
    if (url.pathname.endsWith('/health')) data = health;
    else if (url.pathname.endsWith('/vaults')) { data = structuredClone(vaultList); data.vaults[0].reads = version; }
    else if (url.pathname.endsWith('/analyses')) data = listing();
    else {
      const analysis = listing().analyses.find(item => item.slug === slug);
      if (!analysis) { response.writeHead(404, { 'content-type': 'application/json', 'access-control-allow-origin': ATLAS }); response.end(JSON.stringify({ ok: false, code: 'analysis_unknown', message: `no analysis ${slug}` })); return; }
      data = { ...structuredClone(defaultResults[slug === 'brand-new' ? 'node-coverage' : slug]), slug, digest: analysis.digest, version };
    }
    response.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': ATLAS }); response.end(JSON.stringify(data));
  });
  await new Promise((done, fail) => { stub.once('error', fail); stub.listen(FEED_PORT, '127.0.0.1', done); });
  hosts.push(stub);
  const storedRepublish = JSON.stringify(await stored('Republish'));
  const newlyRead = () => responses.filter(item => item.url.includes('/brand-new/'));
  // The same steps for a saved board, wherever it is shown.
  const meetsRepublish = async (evaluate, place) => {
    await until(async () => JSON.stringify(await panelIds(evaluate)) === JSON.stringify(['saved-coverage', 'saved-region']), `${place}: version 1 layout`);
    await until(async () => (await evaluate(`document.querySelector('[data-panel-id="saved-region"] tbody tr') !== null || document.querySelector('[data-panel-id="saved-region"] [role="button"]') !== null`)), `${place}: version 1 rows`);
    const geometry = await evaluate(`document.querySelector('[data-panel-id="saved-coverage"]').getAttribute('style')`);
    revision = 2;
    await until(async () => (await evaluate(`document.querySelector('[data-panel-id="saved-coverage"] h2')?.textContent`)) === 'Republished coverage', `${place}: changed digest updates`, 40000);
    assert.deepEqual(await panelIds(evaluate), ['saved-coverage'], `${place}: removed goes, added and missing do not appear`);
    assert.equal(await evaluate(`document.querySelector('[data-panel-id="saved-coverage"]').getAttribute('style')`), geometry, `${place}: the changed panel keeps its place`);
    assert.equal(await evaluate(`[...document.querySelectorAll('[aria-label="AEP BI controls"] label')].some(l=>l.textContent.startsWith('Brand new analysis'))`), false, `${place}: the added analysis has no controls`);
    assert.deepEqual(newlyRead(), [], `${place}: the added analysis is not even read`);
    assert.equal(JSON.stringify(await stored('Republish')), storedRepublish, `${place}: reconciling writes nothing`);
  };
  await open(sameSite, '/embed/dashboard/Republish');
  await reach('ready');
  await meetsRepublish(inFrame, 'embed');
  await shot('09-republished-embed');
  pass('republish, saved dashboard embed', 'version 2: changed panel updated in place, removed one gone, added one neither shown nor read; stored document untouched');

  revision = 1;
  await openApp();
  responses.length = 0;
  await choose(controlSelect(2), 'Republish');
  await meetsRepublish(top, 'app');
  await until(async () => JSON.stringify(await top(`[...${addPicker}.options].slice(1).map(o=>o.value)`)) === JSON.stringify(['brand-new', 'tech-updates']), 'the added analysis is offered by hand');
  await shot('10-republished-app');
  pass('republish, saved dashboard in the app', 'the same, and the picker offers the added analysis by hand');

  // The control: the same version on a live board does show it, so its absence above means something.
  await openApp();
  await choose(controlSelect(0), 'aep_bi');
  await until(() => top(`!!document.querySelector('[aria-label="AEP BI controls"] option[value="${catalog.vault}"]')`), 'vault listed for the control');
  await choose(`document.querySelector('[aria-label="AEP BI controls"] select')`, catalog.vault);
  await until(async () => JSON.stringify(await panelIds(top)) === JSON.stringify(listing().order.map(slug => `bi-${slug}`)), 'live board shows version 2');
  await until(() => newlyRead().length > 0, 'the added analysis is read on a live board');
  pass('republish, live board', 'the same version on an unsaved board shows the added analysis, in feed order');

  assert.deepEqual(writes, [], 'an embed page must not write');
  assert.deepEqual(exceptions, []);
  pass('read-only', 'no request other than GET, HEAD or OPTIONS across every case; no browser exceptions');
  console.log(`Embed I1: ${results.length} cases passed`);
} catch (error) {
  if (send) await send('Page.captureScreenshot', {}).then(({ data }) => writeFile(resolve(scratch, 'failure.png'), Buffer.from(data, 'base64'))).catch(() => {});
  if (diagnose) await diagnose().then(value => writeFile(resolve(scratch, 'failure-diagnostic.json'), JSON.stringify(value, null, 2))).catch(() => {});
  results.push({ name: 'I1', outcome: 'failed', evidence: error.stack });
  console.error(error.stack); process.exitCode = 1;
} finally {
  socket?.close();
  for (const child of children.reverse()) await stop(child).catch(() => {});
  for (const server of hosts) { server.closeAllConnections(); await new Promise(done => server.close(done)); }
  await writeFile(resolve(scratch, 'report.json'), JSON.stringify({ results }, null, 2));
  await delay(500);
  await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }).catch(error => console.error(`Temporary cleanup: ${error.message}`));
}
