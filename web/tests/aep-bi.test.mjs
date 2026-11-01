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
