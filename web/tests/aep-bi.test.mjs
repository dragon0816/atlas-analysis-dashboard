import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AepBiProvider, validateCatalog, validateHealth, validateResult, validateVaults, resultDataset } from '../src/platform/aep/bi.ts';
import { biDashboard, levelCounts, parameterId } from '../src/platform/aep/biDashboard.ts';
import { resolveVariables } from '../src/platform/transforms.ts';
import { checkGolden } from '../../scripts/check-aep-bi.mjs';

// Synthetic consumer examples, not AEP golden fixtures. F1 is still pending.
const version = { tag: 'v1', commit: 'fixture-commit' };
const analysis = { slug: 'counts', title: 'Counts', question: 'How many?', kind: 'sql', chart: { type: 'bar', x: 'domain', y: 'count', series: 'level' }, params: { include_sample: { type: 'bool', default: false }, today: { type: 'date', default: '2026-11-01' } }, requires: {}, digest: 'digest' };
const catalog = { vault: 'fixture', version, order: ['counts'], analyses: [analysis] };
const result = { slug: 'counts', digest: 'digest', version, params: {}, columns: ['domain', 'count', 'level'], rows: [['robotics', 7, 'gap'], ['software', 3, 'warning']], truncated: false, computed_at: '2026-11-01T00:00:00Z' };
const response = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });

test('BI validates recognized structure and retains additive keys', () => {
  assert.equal(validateHealth({ format: 'aep.bi.analysis_feed/v1', ok: true, extra: 7 }).extra, 7);
  assert.equal(validateVaults({ vaults: [{ id: 'v', dataset: 'd', title: 't', purpose: 'p', schema: 'schema', reads: version, extra: true }] }).vaults[0].extra, true);
  assert.equal(validateCatalog({ ...catalog, extra: 7 }).extra, 7);
  assert.equal(validateResult({ ...result, extra: 7 }).extra, 7);
  assert.throws(() => validateCatalog({ ...catalog, order: ['missing'] }));
  assert.throws(() => validateResult({ ...result, rows: [[1]] }));
  assert.throws(() => validateResult({ ...result, columns: ['x', 'x'] }));
});
test('BI retains last exact-query result when offline and encodes changed parameters', async () => {
  const calls = []; let offline = false;
  const provider = new AepBiProvider({ fetch: async (url, init) => { calls.push([String(url), init]); if (offline) throw new TypeError('connection refused'); return response(result); } });
  const signal = new AbortController().signal;
  assert.equal((await provider.result('fixture', 'counts', { include_sample: false }, signal)).state, 'ready');
  offline = true;
  const retained = await provider.result('fixture', 'counts', { include_sample: false }, signal);
  assert.equal(retained.state, 'stale'); assert.equal(retained.data.rows[0][1], 7);
  assert.equal((await provider.result('fixture', 'counts', { include_sample: true }, signal)).data, undefined);
  assert.match(calls.at(-1)[0], /include_sample=true$/); assert.equal(calls[0][1].method, 'GET'); assert.equal(calls[0][1].credentials, 'omit');
  provider.dispose();
});
test('409 waiting is a normal dataset state; parameter errors remain errors', async () => {
  let status = 409;
  const provider = new AepBiProvider({ fetch: async () => response({ ok: false, code: status === 409 ? 'result_not_ready' : 'param_invalid', message: 'fixture' }, status) });
  const signal = new AbortController().signal;
  const waiting = await provider.result('v', 'counts', {}, signal); assert.equal(waiting.state, 'waiting');
  assert.match(resultDataset(waiting).meta.warnings[0], /waiting/);
  status = 400; assert.equal((await provider.result('v', 'counts', {}, signal)).state, 'error'); provider.dispose();
});
test('BI rejects oversized and malformed responses and honors caller cancellation', async () => {
  const provider = new AepBiProvider({ fetch: async () => new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': String(8 * 1024 * 1024 + 1) } }) });
  assert.match((await provider.health(new AbortController().signal)).message, /8 MiB/);
  const controller = new AbortController(); controller.abort(); await assert.rejects(provider.health(controller.signal), { name: 'AbortError' }); provider.dispose();
  const wrong = new AepBiProvider({ fetch: async () => response({ ...result, slug: 'wrong' }) });
  assert.match((await wrong.result('v', 'counts', {}, new AbortController().signal)).message, /Wrong BI analysis/); wrong.dispose();
});
test('a saved board updates and removes analyses but gains none; a hand-picked one is added', async () => {
  const { reconcileBiDashboard, biDashboard, missingAnalyses, parameterId } = await import('../src/platform/aep/biDashboard.ts');
  const analysis = (slug, digest = `d-${slug}`, title = slug) => ({ slug, title, question: '', kind: 'sql', digest, chart: { type: 'table' }, params: { domain: { type: 'text', default: 'x' } }, requires: {} });
  const catalog = (...analyses) => ({ vault: 'v', version: { tag: null, commit: 'c' }, order: analyses.map(item => item.slug), analyses });
  const full = biDashboard(catalog(analysis('one'), analysis('two'), analysis('gone')));
  const saved = { ...full, panels: full.panels.filter(panel => panel.query.slug !== 'one'), variables: full.variables.filter(variable => variable.id !== parameterId('one', 'domain')) };
  const republished = catalog(analysis('one'), analysis('two', 'd-new', 'Two, renamed'), analysis('three'));
  assert.deepEqual(missingAnalyses(saved, republished).map(item => item.slug), ['one', 'three']);
  const next = reconcileBiDashboard(saved, saved.values, republished, { append: false });
  assert.deepEqual(next.panels.map(panel => panel.query.slug), ['two'], 'gone is removed, one and three are not appended');
  assert.equal(next.panels[0].title, 'Two, renamed');
  assert.deepEqual(next.panels[0].layout, saved.panels[0].layout);
  assert.ok(!next.variables.some(variable => variable.id === parameterId('three', 'domain')), 'no controls for an analysis not on the board');
  const unchanged = { ...saved, panels: saved.panels.filter(panel => panel.query.slug === 'two') };
  assert.equal(reconcileBiDashboard(unchanged, unchanged.values, catalog(analysis('two'), analysis('more')), { append: false }), unchanged, 'nothing changed, the same board');
  const empty = { ...saved, panels: [], variables: [] };
  assert.equal(reconcileBiDashboard(empty, empty.values, republished, { append: false }), empty, 'an empty saved board stays empty');
  const picked = reconcileBiDashboard(next, next.values, republished, { append: ['three'] });
  assert.deepEqual(picked.panels.map(panel => panel.query.slug), ['two', 'three']);
  assert.ok(picked.panels[1].layout.y >= next.panels[0].layout.y + next.panels[0].layout.h, 'placed below');
  assert.ok(picked.variables.some(variable => variable.id === parameterId('three', 'domain')));
  assert.deepEqual(reconcileBiDashboard(next, next.values, republished).panels.map(panel => panel.query.slug), ['two', 'one', 'three'], 'a live board still gains everything');
});
test('waiting retries stop after three attempts; disposal cancels pending polling', async () => {
  let calls = 0; const values = [];
  const provider = new AepBiProvider({ retryMs: 5, fetch: async () => { calls++; return response({ ok: false, code: 'result_not_ready', message: 'Waiting' }, 409); } });
  const controller = new AbortController();
  provider.subscribe({ type: 'custom' }, { vault: 'v', slug: 'counts' }, { next: value => values.push(value), error: error => assert.fail(error.message) }, controller.signal);
  await new Promise(resolve => setTimeout(resolve, 100)); assert.equal(calls, 3); assert.equal(values.length, 3);
  assert.ok(values.every(value => value.meta.warnings[0].includes('waiting')));
  provider.subscribe({ type: 'custom' }, { vault: 'v', slug: 'counts' }, { next: () => assert.fail('Disposed subscription emitted'), error: () => assert.fail('Disposed subscription errored') }, controller.signal);
  provider.dispose(); await new Promise(resolve => setTimeout(resolve, 25)); assert.equal(calls, 3);
});
test('BI mapping follows feed order and uses namespaced parameters; levels remain explicit', () => {
  const board = biDashboard({ ...catalog, order: ['line', 'counts'], analyses: [analysis, { ...analysis, slug: 'line', chart: { type: 'line', x: 'domain', y: 'count' } }] });
  assert.deepEqual(board.panels.map(panel => panel.type), ['line', 'bar']);
  assert.equal(board.panels[1].mapping.category, 'domain'); assert.equal(board.panels[1].mapping.series, 'level');
  assert.equal(board.panels[1].query.params.include_sample, `$${parameterId('counts', 'include_sample')}`);
  const values = Object.fromEntries(board.variables.map(variable => [variable.id, variable.default]));
  assert.equal(resolveVariables(board.panels[1].query, values).params.include_sample, false);
  assert.deepEqual(levelCounts(resultDataset({ state: 'ready', data: result }).rows), { gap: 1, warning: 1 });
});
test('BI drift check compares exact filenames and bytes and fails missing fixtures', async () => {
  const root = await mkdtemp(join(tmpdir(), 'atlas-bi-drift-'));
  try {
    const upstream = join(root, 'tests/fixtures/bi_feed/golden'), local = join(root, 'vendor');
    await mkdir(upstream, { recursive: true }); await mkdir(local);
    await assert.rejects(checkGolden(root, local), /missing/);
    await writeFile(join(upstream, 'health.json'), '{}'); await writeFile(join(local, 'health.json'), '{}'); assert.equal(await checkGolden(root, local), 1);
    await writeFile(join(local, 'health.json'), '{ }'); await assert.rejects(checkGolden(root, local), /differs/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('BI enum parameters require resolved string choices and retain producer metadata', () => {
  const withDomain = domain => ({ ...catalog, analyses: [{ ...analysis, params: { domain } }] });
  const domain = { type: 'enum', default: 'robotics', values_from: 'Account.domain', values: ['wireless', 'AIDC', 'robotics', 'mobile', 'aerospace'], extra: true };
  assert.deepEqual(validateCatalog(withDomain(domain)).analyses[0].params.domain, domain);
  for (const values of [undefined, null, 'robotics', {}, [1], ['robotics', false]]) {
    assert.throws(() => validateCatalog(withDomain({ ...domain, values })));
  }
  assert.deepEqual(validateCatalog(withDomain({ ...domain, values: [] })).analyses[0].params.domain.values, []);
  const board = biDashboard(validateCatalog(withDomain(domain)));
  const variables = Object.fromEntries(board.variables.map(variable => [variable.id, variable.default]));
  assert.equal(resolveVariables(board.panels[0].query, variables).params.domain, 'robotics');
  variables[parameterId('counts', 'domain')] = 'wireless';
  assert.equal(resolveVariables(board.panels[0].query, variables).params.domain, 'wireless');
});

test('BI fixture port configuration keeps the fixed loopback host and validates port bounds', async () => {
  const { biBase } = await import('../src/platform/aep/bi.ts');
  assert.equal(biBase(), 'http://127.0.0.1:53583/api/v1/bi');
  assert.equal(biBase('53611'), 'http://127.0.0.1:53611/api/v1/bi');
  for (const value of ['0', '65536', '-1', '1.5', 'https://example.com', '53611/path', '']) assert.throws(() => biBase(value));
});

const republished = (changes = {}) => ({ ...catalog, version: { tag: 'v2', commit: 'next-commit' }, ...changes });
const domainAnalysis = { ...analysis, params: { domain: { type: 'enum', default: 'robotics', values: ['robotics', 'wireless'] } } };
test('BI reconciliation updates changed digest metadata in place and retains valid user values', async () => {
  const { reconcileBiDashboard } = await import('../src/platform/aep/biDashboard.ts');
  const original = biDashboard({ ...catalog, analyses: [domainAnalysis] });
  original.panels[0].layout = { x: 3, y: 7, w: 8, h: 11 };
  original.panels[0].display.fillColor = '#123456';
  original.panels[0].transform = [{ op: 'limit', count: 10 }];
  const next = republished({ analyses: [{ ...domainAnalysis, digest: 'new-digest', title: 'New title', question: 'New question', chart: { type: 'line', x: 'month', y: 'count' } }] });
  const id = parameterId('counts', 'domain');
  const result = reconcileBiDashboard(original, { ...original.values, [id]: 'wireless' }, next);
  assert.equal(result.panels[0].type, 'line'); assert.equal(result.panels[0].title, 'New title');
  assert.equal(result.panels[0].display.aepBiQuestion, 'New question');
  assert.deepEqual(result.panels[0].mapping, { x: 'month', y: 'count' });
  assert.equal(result.panels[0].query.digest, 'new-digest');
  assert.strictEqual(result.panels[0].layout, original.panels[0].layout);
  assert.strictEqual(result.panels[0].transform, original.panels[0].transform);
  assert.equal(result.panels[0].display.fillColor, '#123456');
  assert.equal(result.values[id], 'wireless'); assert.equal(result.id, original.id);
  assert.equal(original.panels[0].type, 'bar');
});
test('BI reconciliation leaves unchanged digests and personal layout references untouched', async () => {
  const { reconcileBiDashboard } = await import('../src/platform/aep/biDashboard.ts');
  const original = biDashboard(catalog);
  assert.strictEqual(reconcileBiDashboard(original, original.values, republished()), original);
});
test('BI reconciliation appends added slugs in feed order below personal panels', async () => {
  const { reconcileBiDashboard } = await import('../src/platform/aep/biDashboard.ts');
  const original = biDashboard(catalog); original.panels[0].layout.y = 12;
  const next = republished({ order: ['second', 'counts', 'third'], analyses: [analysis, { ...analysis, slug: 'third' }, { ...analysis, slug: 'second' }] });
  const result = reconcileBiDashboard(original, original.values, next);
  assert.deepEqual(result.panels.map(panel => panel.query.slug), ['counts', 'second', 'third']);
  assert.strictEqual(result.panels[0], original.panels[0]);
  assert.equal(result.panels[1].layout.y, 20); assert.equal(result.panels[2].layout.y, 28);
});
test('BI reconciliation removes missing slugs and their parameters while retaining unrelated panels', async () => {
  const { reconcileBiDashboard } = await import('../src/platform/aep/biDashboard.ts');
  const original = biDashboard(catalog), id = parameterId('counts', 'include_sample');
  const personal = { ...original.panels[0], id: 'personal', datasource: { id: 'other' } };
  original.panels.push(personal); original.variables.push({ id: 'personal-filter', default: 'kept' });
  const result = reconcileBiDashboard(original, { ...original.values, [id]: true, 'personal-filter': 'kept' }, republished({ order: [], analyses: [] }));
  assert.deepEqual(result.panels, [personal]); assert.strictEqual(result.panels[0], personal);
  assert.equal(result.values[id], undefined); assert.equal(result.values['personal-filter'], 'kept');
  assert.deepEqual(result.variables, [{ id: 'personal-filter', default: 'kept' }]);
});
test('BI reconciliation falls back to new enum default and updates added/removed parameter controls', async () => {
  const { reconcileBiDashboard } = await import('../src/platform/aep/biDashboard.ts');
  const original = biDashboard({ ...catalog, analyses: [domainAnalysis] });
  const id = parameterId('counts', 'domain');
  const next = republished({ analyses: [{ ...domainAnalysis, digest: 'new', params: { domain: { type: 'enum', default: 'mobile', values: ['mobile'] }, sample: { type: 'bool', default: true } } }] });
  const result = reconcileBiDashboard(original, { ...original.values, [id]: 'wireless' }, next);
  assert.equal(result.values[id], 'mobile'); assert.equal(result.values[parameterId('counts', 'sample')], true);
  assert.equal(result.variables.find(v => v.id === id).default, 'mobile');
  assert.deepEqual(Object.keys(result.panels[0].query.params), ['domain', 'sample']);
  const removed = reconcileBiDashboard(result, result.values, republished({ analyses: [{ ...domainAnalysis, digest: 'last', params: {} }] }));
  assert.deepEqual(removed.variables, []); assert.equal(removed.values[id], undefined);
});


test('BI reconciliation populates an empty saved board without replacing its identity', async () => {
  const { reconcileBiDashboard } = await import('../src/platform/aep/biDashboard.ts');
  const original = { schemaVersion: 2, id: 'saved-empty', title: 'Personal board', applicationId: 'aep_bi', variables: [], values: { 'bi:vault': 'fixture' }, panels: [] };
  const next = { ...catalog, order: ['counts', 'second'], analyses: [analysis, { ...analysis, slug: 'second' }] };
  const result = reconcileBiDashboard(original, original.values, next);
  assert.equal(result.id, 'saved-empty'); assert.equal(result.title, 'Personal board');
  assert.deepEqual(result.panels.map(panel => panel.layout), biDashboard(next).panels.map(panel => panel.layout));
});
