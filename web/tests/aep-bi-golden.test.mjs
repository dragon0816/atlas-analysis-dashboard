import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFile, readdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';
import { AepBiProvider, validateCatalog, validateHealth, validateVaults, validateResult, resultDataset } from '../src/platform/aep/bi.ts';
import { biDashboard } from '../src/platform/aep/biDashboard.ts';

const fixtures = new URL('./fixtures/aep_bi/', import.meta.url);
const golden = async name => JSON.parse(await readFile(new URL(name, fixtures), 'utf8'));
const manifest = await golden('requests.json'), catalog = validateCatalog(await golden('analyses.json'));
const directory = await mkdtemp(join(tmpdir(), 'atlas-bi-golden-'));
const dom = new JSDOM('<div id="root"></div>', { url: 'http://127.0.0.1:8127' });
for (const key of ['window', 'document', 'HTMLElement', 'Event', 'Node']) globalThis[key] = dom.window[key];
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const NativeMessageChannel = globalThis.MessageChannel, channels = [];
globalThis.MessageChannel = class extends NativeMessageChannel { constructor() { super(); channels.push(this); } };
await build({ stdin: { contents: `export {DatasetPanel} from './src/components/dashboard/DatasetPanel'; export {BiControls} from './src/components/aep/BiControls'; export {createElement,act} from 'react'; export {createRoot} from 'react-dom/client'; export {renderToStaticMarkup} from 'react-dom/server';`, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'cjs', outfile: join(directory, 'ui.cjs') });
const ui = (await import(pathToFileURL(join(directory, 'ui.cjs')).href)).default;
after(async () => { dom.window.close(); for (const channel of channels) { channel.port1.close(); channel.port2.close(); } globalThis.MessageChannel = NativeMessageChannel; await rm(directory, { recursive: true, force: true }); });
const board = biDashboard(catalog), health = await golden('health.json'), vaults = await golden('vaults.json');

test('golden request manifest covers every vendored response exactly once', async () => {
  assert.equal(manifest.format, 'aep.bi.analysis_feed/v1');
  assert.deepEqual(manifest.requests.map(item => item.file).sort(), (await readdir(fixtures)).filter(name => name.endsWith('.json') && name !== 'requests.json').sort());
  assert.equal(manifest.requests.length, 16);
  assert.deepEqual(board.panels.map(panel => panel.title), catalog.order.map(slug => catalog.analyses.find(a => a.slug === slug).title));
});

for (const request of manifest.requests) test(`producer golden A1/A2: ${request.file}`, async () => {
  const data = await golden(request.file), signal = new AbortController().signal;
  const provider = new AepBiProvider({ fetch: async () => new Response(JSON.stringify(data), { status: request.status, headers: { 'content-type': 'application/json' } }) });
  let snapshot;
  try {
    if (request.file === 'health.json') { assert.deepEqual(validateHealth(data), data); snapshot = await provider.health(signal); }
    else if (request.file === 'vaults.json') { assert.deepEqual(validateVaults(data), data); snapshot = await provider.vaults(signal); }
    else if (request.file === 'analyses.json') { assert.deepEqual(validateCatalog(data), data); snapshot = await provider.analyses(data.vault, signal); }
    else if (request.file.startsWith('result-')) {
      assert.deepEqual(validateResult(data), data);
      snapshot = await provider.result(catalog.vault, data.slug, data.params, signal);
      const dataset = resultDataset(snapshot), panel = board.panels.find(panel => panel.query.slug === data.slug);
      assert.deepEqual(dataset.rows, data.rows.map(row => Object.fromEntries(data.columns.map((name, i) => [name, row[i]]))));
      const markup = ui.renderToStaticMarkup(ui.createElement(ui.DatasetPanel, { dataset, panel }));
      assert.doesNotMatch(markup, /role="alert"/);
      const rendered = new JSDOM(markup).window.document;
      if (panel.type === 'table') assert.deepEqual([...rendered.querySelectorAll('tbody tr')].map(row => [...row.querySelectorAll('td')].map(cell => cell.textContent)), data.rows.map(row => row.map(value => value === null ? '—' : String(value))));
      else for (const row of data.rows) {
        const x = row[data.columns.indexOf(panel.mapping.x)], y = row[data.columns.indexOf(panel.mapping.y)];
        assert.ok([...rendered.querySelectorAll('[role="button"]')].some(mark => mark.getAttribute('aria-label')?.includes(`${x}: ${y}`)), `${request.file}: missing rendered ${x}: ${y}`);
      }
      rendered.defaultView.close();
    } else {
      snapshot = await provider.health(signal);
      assert.equal(snapshot.state, request.status === 409 ? 'waiting' : 'error');
      assert.equal(snapshot.message, data.message);
      const markup = ui.renderToStaticMarkup(ui.createElement(ui.DatasetPanel, { dataset: resultDataset(snapshot), panel: board.panels[0] }));
      const rendered = new JSDOM(markup);
      assert.ok(rendered.window.document.body.textContent.includes(data.message)); rendered.window.close();
      return;
    }
    assert.equal(snapshot.state, 'ready'); assert.deepEqual(snapshot.data, data);
    if (['health.json', 'vaults.json', 'analyses.json'].includes(request.file)) {
      const controlsProvider = { health: async () => ({ state: 'ready', data: health }), vaults: async () => ({ state: 'ready', data: vaults }), analyses: async () => ({ state: 'ready', data: catalog }) };
      const root = ui.createRoot(document.getElementById('root'));
      try {
        await ui.act(async () => root.render(ui.createElement(ui.BiControls, { provider: controlsProvider, board, values: board.values, disabled: false, onBoard: () => assert.fail('Layout replaced'), onValue: () => {} })));
        assert.ok(document.body.textContent.includes((await golden('vaults.json')).vaults[0].title));
        assert.match(document.body.textContent, /Published analyses/);
        const selects = [...document.querySelectorAll('select')].slice(1);
        assert.equal(selects.length, catalog.analyses.length);
        selects.forEach((select, i) => { assert.equal(select.value, catalog.analyses[i].params.domain.default); assert.deepEqual([...select.options].map(o => o.value), catalog.analyses[i].params.domain.values); });
      } finally { await ui.act(async () => root.unmount()); }
    }
  } finally { provider.dispose(); }
});
