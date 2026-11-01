import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFile, writeFile, mkdir, mkdtemp, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkGolden } from './check-aep-bi.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const aep = process.env.AEP_REPO;
if (!aep) throw new Error('Set AEP_REPO to the AEP main checkout');
const scratch = resolve(root, '.scratch/aep-bi-i1');
await mkdir(scratch, { recursive: true });
const profile = await mkdtemp(join(tmpdir(), 'atlas-bi-browser-'));
const fixtures = resolve(root, 'web/tests/fixtures/aep_bi');
const golden = async name => JSON.parse(await readFile(resolve(fixtures, name), 'utf8'));
const catalog = await golden('analyses.json');
const results = [], children = [];
let socket, send, evaluate, republishServer;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const result = await check(); if (result) return result; await delay(100); }
  throw new Error(`Timed out: ${label}`);
}
function start(command, args, cwd, env = {}) {
  const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.output = ''; child.on('error', error => { child.failure = error; });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { child.output = (child.output + data).slice(-20000); });
  children.push(child); return child;
}
async function ready(child, pattern) {
  return until(() => { if (child.failure || child.exitCode !== null) throw new Error(child.failure?.message ?? child.output); return child.output.match(pattern); }, 'process ready', 60000);
}
async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child, 'exit'); child.kill(); await closed;
}
async function screenshot(name) {
  const { data } = await send('Page.captureScreenshot', { captureBeyondViewport: true });
  await writeFile(resolve(scratch, `${name}.png`), Buffer.from(data, 'base64'));
}
async function select(selector, value) {
  await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw new Error('Missing select'); el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('change', {bubbles:true})); })()`);
}
const panelSelector = slug => `[data-panel-id="bi-${slug}"]`;
async function panelData(slug) {
  return evaluate(`(() => { const el = document.querySelector(${JSON.stringify(panelSelector(slug))}); return el ? {text:el.textContent, rows:[...el.querySelectorAll('tbody tr')].map(r=>[...r.querySelectorAll('td')].map(c=>c.textContent)), marks:[...el.querySelectorAll('svg [role="button"]')].map(m=>m.getAttribute('aria-label'))} : null; })()`);
}
async function assertPanel(file) {
  const expected = await golden(file), analysis = catalog.analyses.find(a => a.slug === expected.slug);
  await until(async () => {
    const actual = await panelData(expected.slug); if (!actual) return false;
    if (analysis.chart.type === 'table') return JSON.stringify(actual.rows) === JSON.stringify(expected.rows.map(row => row.map(v => v === null ? '—' : String(v))));
    return expected.rows.every(row => actual.marks.some(mark => mark.includes(`${row[expected.columns.indexOf(analysis.chart.x)]}: ${row[expected.columns.indexOf(analysis.chart.y)]}`))) && actual.marks.length === expected.rows.length;
  }, `golden panel ${file}`);
}
function pass(name, evidence) { results.push({ name, outcome: 'passed', evidence }); console.log(`PASS ${name}: ${evidence}`); }

try {
  assert.equal(await checkGolden(aep), 17);
  const fixture = start(resolve(aep, '.venv/Scripts/python.exe'), ['-B', 'scripts/bi_feed_server.py', '--port', '53611'], aep, { PYTHONDONTWRITEBYTECODE: '1' });
  await ready(fixture, /ready http:\/\/127\.0\.0\.1:53611\/api\/v1\/bi/);
  const vite = start(process.execPath, [resolve(root, 'web/node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', '5179', '--strictPort'], resolve(root, 'web'), { VITE_AEP_BI_PORT: '53611' });
  await ready(vite, /http:\/\/127\.0\.0\.1:5179/);
  const executable = process.env.BI_BROWSER ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
  await access(executable);
  const browser = start(executable, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], root);
  const endpoint = (await ready(browser, /DevTools listening on (ws:\/\/[^\s]+)/))[1];
  const browserPort = new URL(endpoint).port;
  const tabs = await (await fetch(`http://127.0.0.1:${browserPort}/json/list`)).json();
  socket = new WebSocket(tabs.find(tab => tab.type === 'page').webSocketDebuggerUrl);
  await once(socket, 'open');
  let sequence = 0; const pending = new Map(), network = [], exceptions = [];
  socket.addEventListener('message', event => {
    const message = JSON.parse(String(event.data));
    if (message.id) { const task = pending.get(message.id); if (task) { pending.delete(message.id); clearTimeout(task.timer); message.error ? task.reject(new Error(JSON.stringify(message.error))) : task.resolve(message.result); } }
    if (message.method === 'Network.responseReceived' && message.params.response.url.includes('/api/v1/bi/')) network.push({ url: message.params.response.url, status: message.params.response.status });
    if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails);
  });
  send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++sequence; const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 15000); pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params })); });
  evaluate = async expression => { const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails)); return result.result.value; };
  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: 'http://127.0.0.1:5179' });
  await until(() => evaluate(`!!document.querySelector('#atlas-dashboard-controls select option[value="aep_bi"]')`), 'Atlas application loaded');
  // Expand the normal application controls before selecting AEP BI.
  await evaluate(`document.querySelector('[aria-controls="atlas-dashboard-controls"]')?.click()`);
  await select('#atlas-dashboard-controls select', 'aep_bi');
  await until(() => evaluate(`!!document.querySelector('[aria-label="AEP BI controls"] option[value="feed-fixture"]')`), 'fixture vault listed');
  const vaultTitles = await evaluate(`[...document.querySelectorAll('[aria-label="AEP BI controls"] select:first-of-type option')].map(o=>o.textContent)`);
  assert.ok(vaultTitles.includes((await golden('vaults.json')).vaults[0].title));
  pass('vault list', 'published fictional vault listed');
  await select('[aria-label="AEP BI controls"] select', 'feed-fixture');
  await until(() => evaluate(`document.querySelectorAll('[data-panel-id]').length === 3`), 'ordered panels');
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('[data-panel-id]')].map(el=>el.getAttribute('data-panel-id'))`), catalog.order.map(slug => `bi-${slug}`));
  for (const slug of catalog.order) await assertPanel(`result-${slug}.json`);
  const coverage = await panelData('node-coverage'); assert.match(coverage.text, /gap: 1/); assert.match(coverage.text, /warning: 2/);
  pass('golden panels', 'all table cells, bar marks and line points equal golden defaults; feed order and level badges verified');
  await screenshot('01-defaults');
  const changeDomain = async (slug, value) => {
    const title = catalog.analyses.find(a=>a.slug===slug).title;
    await evaluate(`(() => { const label = [...document.querySelectorAll('[aria-label="AEP BI controls"] label')].find(l=>l.textContent.startsWith(${JSON.stringify(title + ' · domain')})); const el=label.querySelector('select'); el.value=${JSON.stringify(value)}; el.dispatchEvent(new Event('change',{bubbles:true})); })()`);
  };
  await changeDomain('accounts-by-region', 'AIDC');
  await assertPanel('result-accounts-by-region-domain-AIDC.json');
  assert.ok(network.some(item => item.url.includes('accounts-by-region/result?domain=AIDC') && item.status === 200));
  pass('parameter refetch', 'AIDC requested from live fixture and rendered TW=2, US=2');
  await changeDomain('tech-updates', 'wireless');
  await until(async () => (await panelData('tech-updates'))?.text.includes('AEP BI waiting:'), '409 waiting state', 10000);
  assert.ok(network.some(item => item.url.includes('tech-updates/result?domain=wireless') && item.status === 409));
  await screenshot('02-waiting');
  await assertPanel('result-tech-updates-domain-wireless.json');
  pass('result_not_ready', '409 displayed as waiting, bounded retries reached queued golden result');
  await changeDomain('node-coverage', 'wireless'); await assertPanel('result-node-coverage-domain-wireless.json');
  const refused = await fetch('http://127.0.0.1:53611/api/v1/bi/vaults', { headers: { Origin: 'https://example.com' } });
  assert.equal(refused.status, 403); assert.deepEqual(await refused.json(), await golden('error-origin_refused.json'));
  pass('non-local Origin', '403 and exact error-origin_refused.json');
  await screenshot('03-parameters');
  await stop(fixture);
  await evaluate(`document.querySelector(${JSON.stringify(panelSelector('accounts-by-region') + ' button[title="Refresh panel"]')}).click()`);
  await until(async () => (await panelData('accounts-by-region'))?.text.includes('AEP BI stale:'), 'stale data after shutdown');
  await assertPanel('result-accounts-by-region-domain-AIDC.json');
  assert.match((await panelData('accounts-by-region')).text, /last data retained/);
  await evaluate(`document.querySelector('[aria-label="AEP BI controls"] button').click()`);
  await until(() => evaluate(`document.querySelector('[aria-label="AEP BI controls"]').textContent.includes('AEP BI stale:')`), 'offline health status');
  pass('offline retention', 'stopped fixture; refresh shows stale/disconnected health and unchanged last AIDC marks');
  await screenshot('04-offline');
  assert.deepEqual(exceptions, []);
  await writeFile(resolve(scratch, 'network.json'), JSON.stringify(network, null, 2));
  // Atlas-only, golden-shaped two-version stub: never modify AEP or its goldens.
  let revision = 1;
  const health = await golden('health.json'), vaults = await golden('vaults.json');
  const defaults = Object.fromEntries(await Promise.all(catalog.order.map(async slug => [slug, await golden(`result-${slug}.json`)])));
  republishServer = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1:53611');
    const version = revision === 1 ? catalog.version : { tag: `stub-v${revision}`, commit: `stub-commit-${revision}` };
    const listing = structuredClone(catalog); listing.version = version;
    if (revision > 1) {
      const analysis = listing.analyses.find(a => a.slug === 'accounts-by-region');
      analysis.digest = `stub-digest-${revision}`; analysis.title = `Republished accounts ${revision}`;
      analysis.question = `Republished question ${revision}`;
      analysis.chart = { type: revision === 2 ? 'line' : 'bar', x: 'month', y: 'accounts' };
      analysis.params.domain = { type: 'enum', default: 'wireless', values: ['wireless', 'mobile'] };
    }
    let data;
    if (url.pathname.endsWith('/health')) data = health;
    else if (url.pathname.endsWith('/vaults')) { data = structuredClone(vaults); data.vaults[0].reads = version; }
    else if (url.pathname.endsWith('/analyses')) data = listing;
    else {
      const slug = decodeURIComponent(url.pathname.split('/').at(-2));
      data = structuredClone(defaults[slug]);
      if (!data) { response.writeHead(404); response.end(); return; }
      data.version = version;
      if (revision > 1 && slug === 'accounts-by-region') {
        data.digest = `stub-digest-${revision}`; data.columns = ['month', 'accounts']; data.rows = [['2026-10', 8], ['2026-11', 12]];
      }
      data.params.domain = url.searchParams.get('domain') ?? listing.analyses.find(a => a.slug === slug).params.domain.default;
    }
    response.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': 'http://127.0.0.1:5179' }); response.end(JSON.stringify(data));
  });
  await new Promise((resolve, reject) => { republishServer.once('error', reject); republishServer.listen(53611, '127.0.0.1', resolve); });
  await evaluate(`document.querySelector('[aria-label="AEP BI controls"] button').click()`);
  await until(() => evaluate(`document.querySelector('[aria-label="AEP BI controls"]').textContent.includes('Published analyses')`), 'stub recovery');
  const geometry = await evaluate(`document.querySelector(${JSON.stringify(panelSelector('accounts-by-region'))}).getAttribute('style')`);
  revision = 2;
  await until(() => evaluate(`document.querySelector(${JSON.stringify(panelSelector('accounts-by-region') + ' h2')}).textContent === 'Republished accounts 2'`), 'automatic published catalog reconcile', 35000);
  await until(async () => (await panelData('accounts-by-region'))?.marks.some(mark => mark.includes('2026-11: 12')), 'republished rows rendered');
  const revised = await panelData('accounts-by-region');
  assert.ok(revised.marks.some(mark => mark.includes('2026-10: 8'))); assert.ok(revised.marks.some(mark => mark.includes('2026-11: 12')));
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(panelSelector('accounts-by-region') + ' [data-panel-kind]')}).getAttribute('data-panel-kind')`), 'line');
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(panelSelector('accounts-by-region') + ' h2')}).title`), 'Republished accounts 2\nRepublished question 2');
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(panelSelector('accounts-by-region'))}).getAttribute('style')`), geometry);
  const choice = await evaluate(`(() => { const label=[...document.querySelectorAll('[aria-label="AEP BI controls"] label')].find(l=>l.textContent.startsWith('Republished accounts 2')); const el=label.querySelector('select'); return {value:el.value,choices:[...el.options].map(o=>o.value)}; })()`);
  assert.deepEqual(choice, { value: 'wireless', choices: ['wireless', 'mobile'] });
  await screenshot('05-republished');
  revision = 3;
  await evaluate(`document.querySelector('[aria-label="AEP BI controls"] button').click()`);
  await until(() => evaluate(`document.querySelector(${JSON.stringify(panelSelector('accounts-by-region') + ' h2')}).textContent === 'Republished accounts 3'`), 'manual reload reconcile');
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(panelSelector('accounts-by-region') + ' [data-panel-kind]')}).getAttribute('data-panel-kind')`), 'bar');
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(panelSelector('accounts-by-region'))}).getAttribute('style')`), geometry);
  pass('published catalog reconciliation', 'Atlas-only stub: automatic v2 bar→line/title/question/mapping/enum fallback; manual reload v3 line→bar; geometry retained');
  assert.deepEqual(exceptions, []);
  await writeFile(resolve(scratch, 'network.json'), JSON.stringify(network, null, 2));
  console.log('I1: 6/6 fixture cases and published-version stub passed');
} catch (error) {
  if (send) { await screenshot('failure').catch(() => {}); await writeFile(resolve(scratch, 'failure-dom.txt'), String(await evaluate('document.body.innerText').catch(() => 'unavailable'))); }
  results.push({ name: 'I1', outcome: 'failed', evidence: error.stack });
  console.error(error.stack); process.exitCode = 1;
} finally {
  if (republishServer) { republishServer.closeAllConnections(); await new Promise(resolve => republishServer.close(resolve)); }
  if (send && socket?.readyState === WebSocket.OPEN) await send('Browser.close').catch(() => {});
  socket?.close();
  for (const child of children.reverse()) await stop(child).catch(() => {});
  await writeFile(resolve(scratch, 'report.json'), JSON.stringify({ producer: 'b6a139c5cfae4b21ac42c27f471e9b028e3679b1', results }, null, 2));
}
