import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseDashboardDocument } from '../src/platform/documents.ts';
import { biDashboard } from '../src/platform/aep/biDashboard.ts';

const root = new URL('./fixtures/atlas_dashboard_golden/', import.meta.url);
const read = async name => JSON.parse(await readFile(new URL(name, root), 'utf8'));

test('Atlas read producer mixed and legacy goldens load without schema additions', async () => {
  assert.deepEqual(await read('list.json'), ['Legacy overview', 'Mixed BI layout']);
  for (const name of ['dashboard-mixed.json', 'dashboard-legacy.json']) {
    const original = await read(name), loaded = parseDashboardDocument(original);
    assert.deepEqual(loaded, original);
    assert.equal(loaded.schemaVersion, 2);
  }
  const legacy = parseDashboardDocument(await read('dashboard-legacy.json'));
  assert.ok(legacy.panels.every(panel => panel.datasource.id !== 'aep.bi.result'));
});

test('generated BI panels expose the documented logical source, vault and analysis slug', async () => {
  const catalog = JSON.parse(await readFile(new URL('./fixtures/aep_bi/analyses.json', import.meta.url), 'utf8'));
  const board = parseDashboardDocument(biDashboard(catalog));
  assert.deepEqual(board.panels.map(panel => ({ source: panel.datasource.id, vault: panel.query.vault, slug: panel.query.slug })), catalog.order.map(slug => ({ source: 'aep.bi.result', vault: 'feed-fixture', slug })));
});

test('Atlas mixed producer fixture sorts geometry before first-occurrence de-duplication', async () => {
  const board = parseDashboardDocument(await read('dashboard-mixed.json'));
  const eligible = board.panels.filter(panel => panel.datasource.id === 'aep.bi.result' && panel.query?.vault === 'feed-fixture' && typeof panel.query.slug === 'string' && panel.query.slug.length > 0);
  eligible.sort((left, right) => left.layout.y - right.layout.y || left.layout.x - right.layout.x || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  assert.deepEqual(eligible.map(panel => panel.id), ['bi-tech', 'bi-coverage', 'bi-region', 'bi-coverage-copy']);
  assert.notDeepEqual(board.panels.filter(panel => eligible.includes(panel)).map(panel => panel.id), eligible.map(panel => panel.id));
  const seen = new Set(), order = [], duplicates = [];
  for (const panel of eligible) {
    const key = JSON.stringify([panel.query.vault, panel.query.slug]);
    if (seen.has(key)) duplicates.push(panel.id);
    else { seen.add(key); order.push(panel.query.slug); }
  }
  assert.deepEqual(order, ['tech-updates', 'node-coverage', 'accounts-by-region']);
  assert.deepEqual(duplicates, ['bi-coverage-copy']);
});
