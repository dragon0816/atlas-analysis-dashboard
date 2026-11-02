import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';

const directory = await mkdtemp(join(tmpdir(), 'atlas-dashboard-file-'));
const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://127.0.0.1:8127/' });
for (const key of ['window', 'document', 'HTMLElement', 'Event', 'MouseEvent', 'Node']) globalThis[key] = dom.window[key];
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const NativeMessageChannel = globalThis.MessageChannel, channels = [], nativeFetch = globalThis.fetch;
globalThis.MessageChannel = class extends NativeMessageChannel { constructor() { super(); channels.push(this); } };
await build({ stdin: { contents: `export * from './src/platform/dashboardFile'; export {ImportDashboardDialog} from './src/components/dashboard/ImportDashboardDialog'; export {BiControls} from './src/components/aep/BiControls'; export {createElement,act} from 'react'; export {createRoot} from 'react-dom/client';`, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'cjs', loader: { '.css': 'empty' }, outfile: join(directory, 'ui.cjs') });
const ui = (await import(pathToFileURL(join(directory, 'ui.cjs')).href)).default;
after(async () => { globalThis.fetch = nativeFetch; dom.window.close(); for (const channel of channels) { channel.port1.close(); channel.port2.close(); } globalThis.MessageChannel = NativeMessageChannel; await rm(directory, { recursive: true, force: true }); });

const mixedText = await readFile(new URL('./fixtures/atlas_dashboard_golden/dashboard-mixed.json', import.meta.url), 'utf8');
const mixed = JSON.parse(mixedText);
const installed = ['aep_bi', 'sample-application'];

test('a valid dashboard file parses, and what export writes imports again unchanged', () => {
  assert.deepEqual(ui.parseDashboardFile(mixedText, installed), mixed);
  assert.deepEqual(ui.parseDashboardFile(ui.dashboardFileText(mixed), installed), mixed);
});

test('an exported file is the GET body as a document, unwrapped, which is what AEP accepts', () => {
  // dashboard-mixed.json is the exact body of GET /dashboards/{name}.
  const exported = JSON.parse(ui.dashboardFileText(ui.parseDashboardFile(mixedText, installed)));
  assert.deepEqual(exported, mixed);
  assert.deepEqual(Object.keys(exported).sort(), Object.keys(mixed).sort());
  assert.equal(exported.schemaVersion, 2);
  assert.ok(Array.isArray(exported.panels), 'panels sit at the top level, with no wrapper object');
  for (const panel of exported.panels.filter(item => item.datasource.id === 'aep.bi.result')) assert.ok(panel.query.vault && panel.query.slug, 'the read contract identity survives');
});

for (const [name, text, message] of [
  ['not JSON', '{oops', /not valid JSON/],
  ['not an object', '[]', /dashboard/i],
  ['another schema version', JSON.stringify({ ...mixed, schemaVersion: 1 }), /schemaVersion/],
  ['a broken panel', JSON.stringify({ ...mixed, panels: [{ id: 'x' }] }), /./],
  ['an application this install lacks', JSON.stringify({ ...mixed, applicationId: 'other-app' }), /“other-app” is not installed/],
]) test(`an invalid file is refused: ${name}`, () => assert.throws(() => ui.parseDashboardFile(text, installed), message));

test('file names are safe to offer, and the name is only a starting point', () => {
  assert.equal(ui.exportFileName('Q3: a/b'), 'Q3- a-b.json');
  assert.equal(ui.exportFileName('儀表板 v1.2'), '儀表板 v1.2.json');
  assert.equal(ui.exportFileName('///'), '---.json');
  assert.equal(ui.importNameFor('My layout.JSON', mixed), 'My layout');
  assert.equal(ui.importNameFor('.json', mixed), mixed.title);
});

/** A store with the server's real precondition rules. */
function store(initial = {}) {
  const documents = new Map(Object.entries(initial)), calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const name = decodeURIComponent(String(url).split('/').pop()), method = init.method ?? 'GET', headers = init.headers ?? {};
    calls.push({ method, name, headers });
    const json = (body, status, extra = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...extra } });
    if (method === 'GET') return documents.has(name) ? json(documents.get(name).document, 200, { ETag: documents.get(name).etag }) : json({ detail: { message: 'Dashboard was not found' } }, 404);
    if (headers['If-None-Match'] === '*' && documents.has(name)) return json({ detail: { message: 'Dashboard already exists; choose another name' } }, 412);
    if (headers['If-Match'] && documents.get(name)?.etag !== headers['If-Match']) return json({ detail: { message: 'Dashboard changed; reload it before saving' } }, 412);
    const etag = `"${calls.length}"`;
    documents.set(name, { document: JSON.parse(init.body), etag });
    return json({ name }, 200, { ETag: etag });
  };
  return { documents, calls };
}
const openRoots = new Set();
afterEach(async () => { for (const root of openRoots) await ui.act(async () => root.unmount()); openRoots.clear(); });
async function dialog(document = mixed, initialName = 'Existing') {
  const root = ui.createRoot(globalThis.document.getElementById('root')), events = [];
  openRoots.add(root);
  await ui.act(async () => root.render(ui.createElement(ui.ImportDashboardDialog, { document, initialName, onImported: name => events.push(['imported', name]), onCancel: () => events.push(['cancel']) })));
  return events;
}
const button = label => [...document.querySelectorAll('button')].find(item => item.textContent === label);
const submit = () => ui.act(async () => document.querySelector('form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })));
const rename = name => ui.act(async () => { const input = document.querySelector('input'); Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(input, name); input.dispatchEvent(new dom.window.Event('input', { bubbles: true })); });
const old = { document: { ...mixed, title: 'Old' }, etag: '"old"' };

test('a new name is created with If-None-Match only', async () => {
  const { documents, calls } = store(), events = await dialog(mixed, 'Fresh');
  assert.equal(button('Replace existing'), undefined);
  await submit();
  assert.deepEqual(events, [['imported', 'Fresh']]);
  assert.deepEqual(calls.map(call => [call.method, call.headers['If-None-Match'], call.headers['If-Match']]), [['PUT', '*', undefined]]);
  assert.deepEqual(documents.get('Fresh').document, mixed);
});

test('an existing name is never overwritten silently', async () => {
  const { documents, calls } = store({ Existing: old }), events = await dialog();
  await submit();
  assert.deepEqual(events, []);
  assert.equal(documents.get('Existing').document.title, 'Old');
  assert.match(document.querySelector('[role="alert"]').textContent, /“Existing” already exists/);
  assert.ok(button('Replace existing'));
  assert.equal(button('Import').disabled, true, 'pressing Import again cannot repeat the attempt');
  assert.deepEqual(calls.map(call => call.method), ['PUT']);
  await rename('Other');
  assert.equal(button('Replace existing'), undefined, 'a new name withdraws the offer to replace');
  assert.equal(document.querySelector('[role="alert"]'), null);
  await submit();
  assert.deepEqual(events, [['imported', 'Other']]);
  assert.equal(documents.get('Existing').document.title, 'Old');
});

test('replace is explicit and uses If-Match with the stored revision', async () => {
  const { documents, calls } = store({ Existing: old }), events = await dialog();
  await submit();
  await ui.act(async () => button('Replace existing').click());
  assert.deepEqual(events, [['imported', 'Existing']]);
  assert.equal(documents.get('Existing').document.title, mixed.title);
  assert.deepEqual(calls.map(call => [call.method, call.headers['If-Match']]), [['PUT', undefined], ['GET', undefined], ['PUT', '"old"']]);
});

test('a change between reading and replacing is refused, not overwritten', async () => {
  const { documents } = store({ Existing: old }), events = await dialog();
  await submit();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => { const answer = await realFetch(url, init); if ((init.method ?? 'GET') === 'GET') documents.set('Existing', { document: { ...mixed, title: 'Newer' }, etag: '"newer"' }); return answer; };
  await ui.act(async () => button('Replace existing').click());
  assert.deepEqual(events, []);
  assert.equal(documents.get('Existing').document.title, 'Newer');
  assert.match(document.querySelector('[role="alert"]').textContent, /Import failed: Dashboard changed/);
});

test('a refusal from the server is shown and imports nothing', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ detail: { message: 'Dashboard name contains unsupported characters' } }), { status: 400, headers: { 'content-type': 'application/json' } });
  const events = await dialog(mixed, 'a?b');
  await submit();
  assert.deepEqual(events, []);
  assert.match(document.querySelector('[role="alert"]').textContent, /Import failed: Dashboard name contains unsupported characters/);
});

const analysis = (slug, title) => ({ slug, title, question: '', kind: 'sql', digest: `d-${slug}`, chart: { type: 'table' }, params: { domain: { type: 'text', default: '' } }, requires: {} });
const catalog = { vault: 'v', version: { tag: 'v1', commit: 'c' }, order: ['one', 'two', 'three'], analyses: [analysis('one', 'One'), analysis('two', 'Two'), analysis('three', 'Three')] };
const provider = { health: async () => ({ state: 'ready' }), vaults: async () => ({ state: 'ready', data: { vaults: [{ id: 'v', title: 'Vault', reads: catalog.version }] } }), analyses: async () => ({ state: 'ready', data: catalog }) };
const subset = { schemaVersion: 2, id: 'personal', applicationId: 'aep_bi', title: 'Saved', variables: [], values: { 'bi:vault': 'v' }, panels: [{ id: 'kept', title: 'Two', type: 'table', datasource: { id: 'aep.bi.result' }, query: { vault: 'v', slug: 'two', digest: 'd-two' }, mapping: {}, transform: [], display: {}, layout: { x: 0, y: 0, w: 6, h: 8 } }] };
async function controls(props) {
  const root = ui.createRoot(document.getElementById('root')), seen = { reconciled: [], added: [] };
  openRoots.add(root);
  await ui.act(async () => root.render(ui.createElement(ui.BiControls, { provider, board: subset, values: subset.values, disabled: false, onBoard: () => {}, onValue: () => {}, onReconcile: board => seen.reconciled.push(board), onAddAnalysis: (slug, data) => seen.added.push([slug, data.vault]), ...props })));
  return seen;
}
const addSelect = () => [...document.querySelectorAll('label')].find(label => label.textContent.startsWith('Add analysis'))?.querySelector('select');
const paramLabels = () => [...document.querySelectorAll('label')].map(label => label.textContent).filter(text => text.includes(' · '));

test('a saved board gains nothing by itself, and offers the rest quietly', async () => {
  const seen = await controls({ saved: true });
  assert.deepEqual(seen.reconciled, []);
  assert.deepEqual([...addSelect().options].slice(1).map(option => [option.value, option.textContent]), [['one', 'One'], ['three', 'Three']]);
  assert.deepEqual(paramLabels().map(text => text.split(' · ')[0]), ['Two'], 'controls only for what the board shows');
  await ui.act(async () => { const select = addSelect(); select.value = 'three'; select.dispatchEvent(new dom.window.Event('change', { bubbles: true })); });
  assert.deepEqual(seen.added, [['three', 'v']]);
});

test('a live board keeps gaining analyses and offers no picker', async () => {
  const seen = await controls({ saved: false });
  assert.deepEqual(seen.reconciled.at(-1).panels.map(panel => panel.query.slug).sort(), ['one', 'three', 'two']);
  assert.equal(addSelect(), undefined);
});

test('an embed has no picker, even on a saved board', async () => {
  const seen = await controls({ saved: true, onAddAnalysis: undefined, embed: { onStatus: () => {} } });
  assert.deepEqual(seen.reconciled, []);
  assert.equal(addSelect(), undefined);
});
