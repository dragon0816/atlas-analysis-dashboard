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
  await writeFile(join(temporary, 'dashboard.json'), JSON.stringify({ 'Embed fixture': { ...mixed, panels: working }, 'Broken panels': broken }));
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
