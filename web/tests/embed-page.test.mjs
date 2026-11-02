import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';
import { embedTargetOrigin, feedStatus, narrowCatalog, panelFeedState, panelValues } from '../src/platform/aep/biEmbed.ts';
import { parameterId, reconcileBiDashboard } from '../src/platform/aep/biDashboard.ts';

const directory = await mkdtemp(join(tmpdir(), 'atlas-embed-page-'));
const portable = value => value.replaceAll('\\', '/');
await build({ stdin: { contents: `export * from './src/platform/applicationLoader';`, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'cjs', outfile: join(directory, 'core.cjs') });
const core = (await import(pathToFileURL(join(directory, 'core.cjs')).href)).default;
const files = {};
async function visit(path) { for (const entry of await readdir(path, { withFileTypes: true })) { const item = join(path, entry.name); if (entry.isDirectory()) await visit(item); else if (/\.(yaml|yml|json|csv)$/.test(item)) files[portable(item)] = await readFile(item, 'utf8'); } }
await visit(resolve('../applications'));
const packages = core.readApplicationPackages(files);

const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://127.0.0.1:8127/embed/panel', pretendToBeVisual: true });
for (const key of ['window', 'document', 'HTMLElement', 'Event', 'MouseEvent', 'Node', 'MutationObserver', 'getComputedStyle', 'SVGElement', 'Element']) globalThis[key] = key === 'window' ? dom.window : key === 'getComputedStyle' ? dom.window.getComputedStyle.bind(dom.window) : dom.window[key];
globalThis.ResizeObserver = class { constructor(callback) { this.callback = callback; } observe(target) { this.callback([{ target, contentRect: { width: 900, height: 320 } }]); } disconnect() {} };
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const NativeMessageChannel = globalThis.MessageChannel, channels = [], nativeFetch = globalThis.fetch;
globalThis.MessageChannel = class extends NativeMessageChannel { constructor() { super(); channels.push(this); } };
await build({ stdin: { contents: `export {EmbedPage} from './src/pages/EmbedPage'; export {parseEmbedRoute} from './src/platform/embedRoute'; export {createElement,act} from 'react'; export {createRoot} from 'react-dom/client';`, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'cjs', loader: { '.css': 'empty' }, outfile: join(directory, 'ui.cjs'), plugins: [{ name: 'application-fixtures', setup(b) { b.onLoad({ filter: /applications\.ts$/ }, args => portable(args.path).endsWith('/src/platform/applications.ts') ? { contents: `export const applicationPackages=${JSON.stringify(packages)};`, loader: 'ts' } : undefined); } }] });
const ui = (await import(pathToFileURL(join(directory, 'ui.cjs')).href)).default;
after(async () => { globalThis.fetch = nativeFetch; dom.window.close(); for (const channel of channels) { channel.port1.close(); channel.port2.close(); } globalThis.MessageChannel = NativeMessageChannel; await rm(directory, { recursive: true, force: true }); });

const goldenFile = async (folder, name) => readFile(new URL(`./fixtures/${folder}/${name}`, import.meta.url), 'utf8');
const feed = name => goldenFile('aep_bi', name);
const manifest = JSON.parse(await feed('requests.json'));
const responses = new Map(await Promise.all(manifest.requests.filter(request => !request.origin).map(async request => [request.url, { status: request.status, body: await feed(request.file) }])));
const catalog = JSON.parse(await feed('analyses.json'));
const mixed = await goldenFile('atlas_dashboard_golden', 'dashboard-mixed.json');
const json = (body, status = 200) => new Response(body, { status, headers: { 'content-type': 'application/json' } });

/** Answers from the producer goldens and records every request the page makes. */
function serve(overrides = {}) {
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input), 'http://127.0.0.1:8127'), path = url.pathname + url.search;
    calls.push({ path, method: init.method ?? 'GET', credentials: init.credentials });
    if (overrides[path]) return overrides[path]();
    if (url.pathname.startsWith('/dashboards/')) return decodeURIComponent(url.pathname) === '/dashboards/Mixed BI layout' ? json(mixed) : json('{"detail":{"message":"Dashboard was not found"}}', 404);
    // The feed computes one result for its defaults, however they are spelled.
    const answer = responses.get(path) ?? responses.get(path.replace('?domain=robotics', ''));
    if (answer) return json(answer.body, answer.status);
    if (path.startsWith('/api/v1/bi/vaults/no-such-vault/')) return json(await feed('error-vault_unknown.json'), 404);
    return json(await feed('error-route_unknown.json'), 404);
  };
  return calls;
}
const offline = () => { throw new TypeError('fetch failed'); };
const settle = async (ms = 60) => ui.act(async () => { await new Promise(done => setTimeout(done, ms)); });
async function until(check, label, timeout = 10_000) { const end = Date.now() + timeout; while (!check()) { if (Date.now() > end) throw new Error(`Timed out: ${label}: ${document.body.textContent.slice(0, 200)}`); await settle(); } }
// A failed test must still stop its page, or its polling keeps this test process alive.
const openRoots = new Set();
afterEach(async () => { for (const root of openRoots) await ui.act(async () => root.unmount()); openRoots.clear(); });
async function open(path, search = '') {
  const element = document.getElementById('root'), root = ui.createRoot(element);
  openRoots.add(root);
  await ui.act(async () => root.render(ui.createElement(ui.EmbedPage, { route: ui.parseEmbedRoute(path, search) })));
  const state = () => element.querySelector('[data-embed-state]').dataset.embedState;
  return { element, state, reach: async expected => until(() => state() === expected, `state ${expected}, now ${state()}`), close: async () => { openRoots.delete(root); await ui.act(async () => root.unmount()); } };
}
const assertReadOnly = calls => { assert.deepEqual(calls.filter(call => call.method !== 'GET'), []); };
const assertNoEditor = element => { for (const label of ['Edit Dashboard', '+ New dashboard', 'Save As', 'Restore default', 'Reload vaults']) assert.ok(![...element.querySelectorAll('button')].some(button => button.textContent.includes(label)), label); };

test('panel embed renders the golden result, from the feed only, without an editor', async () => {
  const calls = serve(), page = await open('/embed/panel', '?vault=feed-fixture&slug=node-coverage');
  await page.reach('ready');
  const result = JSON.parse(await feed('result-node-coverage.json'));
  assert.deepEqual([...page.element.querySelectorAll('tbody tr')].map(row => [...row.querySelectorAll('td')].map(cell => cell.textContent)), result.rows.map(row => row.map(value => value === null ? '—' : String(value))));
  assert.equal(page.element.querySelectorAll('[data-panel-id]').length, 1);
  assert.equal(page.element.querySelector('[aria-label="AEP BI controls"] select option[value="feed-fixture"]'), null);
  assertNoEditor(page.element); assertReadOnly(calls);
  assert.ok(!calls.some(call => call.path.startsWith('/dashboards')), 'a panel embed never touches the dashboard store');
  await page.close();
});

test('panel embed starts from URL parameters, and its control refetches without saving', async () => {
  const calls = serve(), page = await open('/embed/panel', '?vault=feed-fixture&slug=accounts-by-region&domain=AIDC');
  await page.reach('ready');
  assert.ok(calls.some(call => call.path.endsWith('/accounts-by-region/result?domain=AIDC')));
  assert.ok(!calls.some(call => call.path.endsWith('/accounts-by-region/result?domain=robotics')), 'the default is not shown first');
  const select = page.element.querySelector('[aria-label="AEP BI controls"] label select');
  assert.equal(select.value, 'AIDC');
  await ui.act(async () => { select.value = 'robotics'; select.dispatchEvent(new dom.window.Event('change', { bubbles: true })); });
  await until(() => calls.some(call => call.path.endsWith('/accounts-by-region/result?domain=robotics')), 'refetch');
  assertReadOnly(calls);
  await page.close();
});

for (const [name, path, search, state, text] of [
  ['unknown analysis', '/embed/panel', '?vault=feed-fixture&slug=nope', 'unknown_analysis', /no published analysis “nope”/],
  ['unknown vault', '/embed/panel', '?vault=no-such-vault&slug=node-coverage', 'unknown_vault', /no-such-vault/],
  ['unknown parameter', '/embed/panel', '?vault=feed-fixture&slug=node-coverage&region=TW', 'invalid_link', /no parameter “region”/],
  ['invalid enum value', '/embed/panel', '?vault=feed-fixture&slug=node-coverage&domain=bogus', 'invalid_link', /does not allow “bogus”/],
  ['missing slug', '/embed/panel', '?vault=feed-fixture', 'invalid_link', /does not name an analysis/],
  ['unknown route', '/embed/editor', '', 'invalid_link', /not recognised/],
  ['unknown dashboard', '/embed/dashboard/Missing', '', 'unknown_dashboard', /no saved dashboard named “Missing”/],
]) test(`clear state: ${name}`, async () => {
  const calls = serve(), page = await open(path, search);
  await page.reach(state);
  assert.match(page.element.querySelector('[role="alert"]').textContent, text);
  assert.equal(page.element.querySelector('[data-panel-id]'), null);
  assertReadOnly(calls);
  await page.close();
});

test('an Atlas storage failure is an error, not an unknown dashboard', async () => {
  serve({ '/dashboards/Mixed%20BI%20layout': () => json('{"detail":{"message":"Stored dashboard exceeds 2 MB"}}', 413) });
  const page = await open('/embed/dashboard/Mixed%20BI%20layout');
  await page.reach('error');
  assert.match(page.element.querySelector('[role="alert"]').textContent, /exceeds 2 MB/);
  await page.close();
});

test('AEP offline from the start says so', async () => {
  serve({ '/api/v1/bi/health': offline });
  const page = await open('/embed/panel', '?vault=feed-fixture&slug=node-coverage');
  await page.reach('offline');
  assert.match(page.element.querySelector('[role="alert"]').textContent, /AEP is offline/);
  await page.close();
});

test('stopping AEP keeps the last data and reports offline', async () => {
  const result = '/api/v1/bi/vaults/feed-fixture/analyses/node-coverage/result';
  const failing = { value: false }, answer = responses.get(result);
  serve({ [`${result}?domain=robotics`]: () => failing.value ? offline() : json(answer.body, answer.status) });
  const page = await open('/embed/panel', '?vault=feed-fixture&slug=node-coverage');
  await page.reach('ready');
  const rows = page.element.querySelectorAll('tbody tr').length;
  assert.ok(rows > 0);
  failing.value = true;
  await ui.act(async () => page.element.querySelector('button[title="Refresh panel"]').click());
  await page.reach('offline');
  assert.equal(page.element.querySelectorAll('tbody tr').length, rows);
  assert.match(page.element.textContent, /last data retained/);
  await page.close();
});

test('result_not_ready shows waiting, not an error', async () => {
  const path = '/api/v1/bi/vaults/feed-fixture/analyses/tech-updates/result?domain=wireless';
  serve({ [path]: async () => json(await feed('error-result_not_ready.json'), 409) });
  const page = await open('/embed/panel', '?vault=feed-fixture&slug=tech-updates&domain=wireless');
  await page.reach('waiting');
  assert.match(page.element.textContent, /AEP BI waiting:/);
  assert.equal(page.element.querySelector('[role="alert"]'), null);
  await page.close();
});

test('dashboard embed shows the stored layout read-only and reconciles only in memory', async () => {
  const clean = JSON.parse(mixed); clean.panels = clean.panels.filter(panel => panel.datasource.id === 'aep.bi.result' && panel.query.vault === catalog.vault);
  const calls = serve({ '/dashboards/Clean': () => json(JSON.stringify(clean)) }), page = await open('/embed/dashboard/Clean');
  await page.reach('ready');
  // Every panel has answered by now, so ready is not a moment before the results arrive.
  const result = JSON.parse(await feed('result-node-coverage.json'));
  assert.equal(page.element.querySelectorAll('[data-panel-id="bi-coverage"] tbody tr').length, Math.min(5, result.rows.length));
  assert.deepEqual([...page.element.querySelectorAll('[data-panel-id]')].map(panel => panel.dataset.panelId).sort(), ['bi-coverage', 'bi-coverage-copy', 'bi-region', 'bi-tech']);
  assertNoEditor(page.element); assertReadOnly(calls);
  await page.close();
});

test('ready waits for the result: an unanswered read stays loading', async () => {
  serve({ '/api/v1/bi/vaults/feed-fixture/analyses/node-coverage/result?domain=robotics': () => new Promise(() => {}) });
  const page = await open('/embed/panel', '?vault=feed-fixture&slug=node-coverage');
  await until(() => page.element.querySelector('[data-panel-id]'), 'panel placed');
  await settle(300);
  assert.equal(page.state(), 'loading');
  await page.close();
});

test('a dashboard with failing panels reports error and still shows its layout', async () => {
  serve();
  const page = await open('/embed/dashboard/Mixed%20BI%20layout');
  await page.reach('error');
  // The read contract's other-source and other-vault panels fail alone; its own panels and their saved transform run.
  const shows = (id, text) => until(() => text.test(page.element.querySelector(`[data-panel-id="${id}"]`).textContent), `${id} shows ${text}`);
  await shows('non-aep', /Could not render this panel/);
  await shows('bi-other-vault', /AEP BI error:/);
  await until(() => page.element.querySelectorAll('[data-panel-id="bi-coverage"] tbody tr').length > 0, 'working panel rows');
  assert.doesNotMatch(page.element.querySelector('[data-panel-id="bi-coverage"]').textContent, /Could not render/);
  assert.equal(page.element.querySelector('.atlas-embed-message'), null);
  await page.close();
});

test('a republish that removes the analysis turns the panel into a clear state', async () => {
  const empty = JSON.parse(await feed('analyses.json'));
  empty.version = { tag: 'v2', commit: 'second' }; empty.order = empty.order.filter(slug => slug !== 'node-coverage'); empty.analyses = empty.analyses.filter(item => item.slug !== 'node-coverage');
  const vaults = JSON.parse(await feed('vaults.json'));
  let republished = false;
  serve({
    '/api/v1/bi/vaults': () => { const body = structuredClone(vaults); if (republished) body.vaults[0].reads = empty.version; return json(JSON.stringify(body)); },
    '/api/v1/bi/vaults/feed-fixture/analyses': () => json(JSON.stringify(republished ? empty : catalog)),
  });
  const page = await open('/embed/panel', '?vault=feed-fixture&slug=node-coverage');
  await page.reach('ready');
  republished = true;
  await until(() => page.state() === 'unknown_analysis', 'republish reconcile', 25_000);
  assert.equal(page.element.querySelector('[data-panel-id]'), null);
  await page.close();
});

const analysis = { slug: 's', params: { on: { type: 'bool' }, day: { type: 'date' }, kind: { type: 'enum', values: ['a', 'b'] }, q: { type: 'text' } } };
test('URL text becomes typed values, or names the first problem', () => {
  assert.deepEqual(panelValues(analysis, { on: 'false', day: '2026-11-02', kind: 'b', q: '' }).values, { [parameterId('s', 'on')]: false, [parameterId('s', 'day')]: '2026-11-02', [parameterId('s', 'kind')]: 'b', [parameterId('s', 'q')]: '' });
  for (const [params, problem] of [[{ on: 'yes' }, /true or false/], [{ day: '11/02' }, /YYYY-MM-DD/], [{ day: '2026-13-40' }, /YYYY-MM-DD/], [{ kind: 'c' }, /does not allow/], [{ toString: 'x' }, /no parameter/], [JSON.parse('{"__proto__":"x"}'), /no parameter/]]) assert.match(panelValues(analysis, params).problem, problem);
});

test('narrowed reconcile keeps one panel and leaves other analyses out', () => {
  const narrow = narrowCatalog(catalog, 'accounts-by-region');
  assert.deepEqual(narrow.order, ['accounts-by-region']);
  const board = { schemaVersion: 2, id: 'embed-panel', title: 't', applicationId: 'aep_bi', variables: [], values: { 'bi:vault': catalog.vault }, panels: [] };
  const id = parameterId('accounts-by-region', 'domain'), next = reconcileBiDashboard(board, { ...board.values, [id]: 'AIDC' }, narrow);
  assert.deepEqual(next.panels.map(panel => panel.query.slug), ['accounts-by-region']);
  assert.equal(next.values[id], 'AIDC');
  assert.equal(reconcileBiDashboard(next, next.values, narrow), next, 'unchanged digests change nothing');
});

test('feed and panel states map to the contract', () => {
  assert.deepEqual(feedStatus({ state: 'ready' }), { state: 'ready' });
  assert.equal(feedStatus({ state: 'stale', message: 'm' }).state, 'offline');
  assert.equal(feedStatus({ state: 'offline', message: 'm' }).state, 'offline');
  assert.equal(feedStatus({ state: 'error', code: 'vault_unknown', message: 'm' }).state, 'unknown_vault');
  assert.equal(feedStatus({ state: 'error', code: 'internal', message: 'm' }).state, 'error');
  assert.equal(panelFeedState([]), 'ready');
  assert.equal(panelFeedState([[], ['AEP BI waiting: x']]), 'waiting');
  assert.equal(panelFeedState([['AEP BI waiting: x'], ['AEP BI stale: y']]), 'offline');
  assert.equal(panelFeedState([['AEP BI stale: y'], ['AEP BI error: z']]), 'error');
  assert.equal(panelFeedState([['Query row limit reached']]), 'ready');
});

test('the size message targets the parent origin, and is not sent without one', () => {
  const origin = 'http://127.0.0.1:8127', parent = 'http://localhost:53583';
  assert.equal(embedTargetOrigin({ origin, ancestorOrigins: [parent] }, ''), parent);
  assert.equal(embedTargetOrigin({ origin }, `${parent}/chat?x=1`), parent);
  assert.equal(embedTargetOrigin({ origin }, ''), null);
  assert.equal(embedTargetOrigin({ origin }, `${origin}/embed/panel`), null, 'its own origin is not a parent');
  assert.equal(embedTargetOrigin({ origin, ancestorOrigins: ['null'] }, ''), null);
  assert.equal(embedTargetOrigin({ origin }, 'not a url'), null);
});
