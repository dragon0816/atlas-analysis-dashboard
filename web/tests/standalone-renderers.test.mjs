import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';
import { buildBoxes, buildHistogram, buildSeries, numericRows, quantile, reduceValues } from '../src/components/panels/BasicModels.ts';

const panel = (type, mapping = {}, display = {}) => ({ id: 'independent', title: 'Test dataset', type, datasource: { id: 'rows' }, transform: [], mapping, display, layout: { x: 0, y: 0, w: 8, h: 4 } });
const table = (rows, fields) => ({ kind: 'table', rows, fields: fields.map(([name, type]) => ({ name, type })), meta: { sourceRows: rows.length, warnings: [], truncated: false } });
const data = table([{ category: 'Red', x: 1, value: 8, lower: 3, upper: 7, group: 'A' }, { category: 'Blue', x: 2, value: 4, lower: 2, upper: 6, group: 'B' }], [['category', 'string'], ['x', 'number'], ['value', 'number'], ['lower', 'number'], ['upper', 'number'], ['group', 'string']]);

const bootstrapDOM = new JSDOM('<!doctype html><body></body>');
globalThis.window = bootstrapDOM.window;
globalThis.document = bootstrapDOM.window.document;
const OriginalMessageChannel = globalThis.MessageChannel, channels = [];
globalThis.MessageChannel = class extends OriginalMessageChannel { constructor() { super(); channels.push(this); } };
after(() => { bootstrapDOM.window.close(); for (const channel of channels) { channel.port1.close(); channel.port2.close(); } globalThis.MessageChannel = OriginalMessageChannel; delete globalThis.window; delete globalThis.document; });
const directory = await mkdtemp(join(tmpdir(), 'standalone-renderer-check-'));
after(() => rm(directory, { recursive: true, force: true }));
await build({ stdin: { contents: `export { DatasetPanel } from './src/components/dashboard/DatasetPanel'; export { linearScale } from './src/components/panels/PanelUi'; export { createElement, act } from 'react'; export { createRoot } from 'react-dom/client'; export { renderToStaticMarkup } from 'react-dom/server';`, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'cjs', outfile: join(directory, 'renderers.cjs') });
const { DatasetPanel, linearScale, createElement, act, createRoot, renderToStaticMarkup } = (await import(pathToFileURL(join(directory, 'renderers.cjs')).href)).default;
const markup = (dataset, specification) => renderToStaticMarkup(createElement(DatasetPanel, { dataset, panel: specification }));

test('independent basic models preserve numeric zero, strict inputs, caps, summaries and inclusive final histogram bin', () => {
  const source = table([{ value: 0 }, { value: -2 }, { value: '4' }, { value: null }, { value: Infinity }], [['value', 'number']]);
  const numeric = numericRows(source, panel('stat', { value: 'value' }));
  assert.deepEqual(numeric.values.map(item => item.value), [0, -2]);
  assert.match(numeric.warnings.join(' '), /3 rows/);
  assert.match(numericRows(source, panel('stat', { value: 'absent' })).error, /existing/);
  assert.equal(quantile([0, 2, 4, 6], 0.25), 1.5);
  assert.equal(reduceValues([2, 4, 6], 'mean'), 4);
  assert.equal(reduceValues([Number.MAX_VALUE, Number.MAX_VALUE], 'sum'), null);
  assert.equal(reduceValues([], 'last'), null);
  assert.deepEqual(buildHistogram([0, 1, 2, 3, 4], 2).map(bin => bin.count), [2, 3]);
  assert.deepEqual(buildHistogram([3, 3, 3], 40), [{ min: 3, max: 3, count: 3 }]);
  assert.equal(buildHistogram([-1e308, 1e308], 4).length, 0);
  const many = table(Array.from({ length: 2001 }, (_, value) => ({ value })), [['value', 'number']]);
  assert.equal(numericRows(many, panel('stat')).values.length, 2000);
  assert.match(numericRows(many, panel('stat')).warnings.join(' '), /first 2,000/);
});

test('line/mask model maps time, categories, series and field limit metadata without legacy adapters', () => {
  const mapped = buildSeries(data, panel('mask', { x: 'x', y: 'value', series: 'group', lower: 'lower', upper: 'upper' }));
  assert.equal(mapped.series.length, 2);
  assert.equal(mapped.series[0].points[0].high, 7);
  const temporal = table([{ t: '2026-10-07T10:00:00Z', value: 2 }, { t: 'bad', value: 3 }], [['t', 'time'], ['value', 'number']]);
  temporal.fields[1].limits = { lower: 1, upper: 4 };
  const timed = buildSeries(temporal, panel('mask', { x: 't', y: 'value' }));
  assert.equal(timed.series[0].points.length, 1);
  assert.equal(timed.series[0].points[0].x, Date.parse('2026-10-07T10:00:00Z'));
  assert.equal(timed.series[0].points[0].low, 1);
  assert.match(timed.warnings.join(' '), /1 rows/);
});

test('box supports mapped summaries without a value column and rejects invalid order', () => {
  const summaries = table([{ name: 'Good', bottom: 0, a: 1, b: 2, c: 3, top: 5 }, { name: 'Bad', bottom: 3, a: 1, b: 2, c: 3, top: 5 }], [['name', 'string'], ['bottom', 'number'], ['a', 'number'], ['b', 'number'], ['c', 'number'], ['top', 'number']]);
  const result = buildBoxes(summaries, panel('box', { category: 'name', low: 'bottom', q1: 'a', median: 'b', q3: 'c', high: 'top' }));
  assert.equal(result.error, '');
  assert.equal(result.boxes.length, 1);
  assert.equal(result.boxes[0].median, 2);
  assert.match(result.warnings.join(' '), /invalid box summaries/);
  assert.match(buildBoxes(summaries, panel('box', { q1: 'a' })).error, /median/);
  const samples = table([0, 2, 4, 6].map(value => ({ value })), [['value', 'number']]);
  assert.equal(buildBoxes(samples, panel('box', { value: 'value' })).boxes[0].q1, 1.5);
});



test('gauge uses mapped bounds, clear invalid bounds, and finite chart coordinates at numeric extremes', () => {
  const dataset = table([{ reading: 12, lo: 10, hi: 20 }], [['reading', 'number'], ['lo', 'number'], ['hi', 'number']]);
  assert.match(markup(dataset, panel('gauge', { value: 'reading', min: 'lo', max: 'hi' })), /scale 10 to 20/);
  assert.match(markup(dataset, panel('gauge', { value: 'reading' }, { min: 20, max: 10 })), /role="alert"/);
  assert.match(markup(dataset, panel('gauge', { value: 'reading' }, { min: -1e308, max: 1e308 })), /finite range/);
  for (const value of [Number.MAX_VALUE, -Number.MAX_VALUE, 0]) {
    const scale = linearScale([value, value], [0, 100]);
    assert.ok(Number.isFinite(scale.at(value)));
  }
  const summaries = table([{ a: 1, b: 2, c: 3 }], [['a', 'number'], ['b', 'number'], ['c', 'number']]);
  assert.doesNotMatch(markup(summaries, panel('box', { q1: 'a', median: 'b', q3: 'c' })), /role="alert"/);
});

async function withDOM(run) {
  const dom = new JSDOM('<!doctype html><div id="test"></div>', { pretendToBeVisual: true, url: 'http://localhost/' });
  const keys = ['window', 'document', 'HTMLElement', 'Element', 'SVGElement', 'Event', 'MouseEvent', 'KeyboardEvent', 'IS_REACT_ACT_ENVIRONMENT'];
  const previous = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const key of keys) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: key === 'IS_REACT_ACT_ENVIRONMENT' ? true : dom.window[key] });
  dom.window.SVGElement.prototype.getBoundingClientRect = () => ({ width: 720, height: 440, left: 0, top: 0, right: 720, bottom: 440 });
  dom.window.SVGElement.prototype.setPointerCapture = function (id) { this.capture = id; };
  dom.window.SVGElement.prototype.hasPointerCapture = function (id) { return this.capture === id; };
  dom.window.SVGElement.prototype.releasePointerCapture = function () { this.capture = undefined; };
  const host = document.querySelector('#test'), root = createRoot(host);
  try { await run({ dom, host, root }); }
  finally { await act(async () => root.unmount()); dom.window.close(); for (const [key, descriptor] of previous) descriptor ? Object.defineProperty(globalThis, key, descriptor) : delete globalThis[key]; }
}
const changeValue = async (element, value, window) => { const prototype = element.tagName === 'SELECT' ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, value); await act(async () => element.dispatchEvent(new window.Event(element.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }))); };

test('all independently authored basic charts emit mapped keyboard/click events', async () => withDOM(async ({ dom, host, root }) => {
  for (const kind of ['line', 'mask', 'bar', 'box', 'histogram', 'stat', 'gauge']) {
    const events = [], mapping = { x: 'x', y: 'value', value: 'value', category: 'category', lower: 'lower', upper: 'upper' };
    await act(async () => root.render(createElement(DatasetPanel, { dataset: data, panel: panel(kind, mapping), onEvent: event => events.push(event) })));
    const target = host.querySelector('svg [role="button"]') ?? host.querySelector('button');
    assert.ok(target, `${kind} has an interactive mark`);
    await act(async () => target.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })));
    assert.equal(events.length, 1, `${kind} dispatches once`);
    assert.equal(events[0].entity, 'mark');
    if (target.tagName.toLowerCase() !== 'button') { await act(async () => target.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))); assert.equal(events.length, 2, `${kind} supports keyboard`); }
  }
}));

test('table supports sorting, bounded pagination, search and accessible row actions', async () => withDOM(async ({ dom, host, root }) => {
  const events = [], dataset = table(Array.from({ length: 12 }, (_, index) => ({ label: `Row ${index + 1}`, score: 12 - index })), [['label', 'string'], ['score', 'number']]);
  await act(async () => root.render(createElement(DatasetPanel, { dataset, panel: panel('table', {}, { pageSize: 5 }), onEvent: event => events.push(event) })));
  assert.equal(host.querySelectorAll('tbody tr').length, 5);
  const score = [...host.querySelectorAll('th button')].find(button => button.textContent === 'score');
  await act(async () => score.click());
  assert.equal(host.querySelector('tbody tr td:last-child').textContent, '1');
  const firstRow = host.querySelector('tbody tr');
  await act(async () => firstRow.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
  assert.equal(events[0].entity, 'row'); assert.equal(events[0].values.score, 1);
  await act(async () => [...host.querySelectorAll('button')].find(button => button.textContent === 'Next').click());
  assert.match(host.textContent, /Page 2 of 3/);
  await changeValue(host.querySelector('input'), 'Row 12', dom.window);
  assert.equal(host.querySelectorAll('tbody tr').length, 1);
  assert.match(host.textContent, /Page 1 of 1/);
}));

test('heatmap excludes missing cells from actions and emits zero values unchanged', async () => withDOM(async ({ dom, host, root }) => {
  const events = [], dataset = table([{ a: 'One', b: 'First', score: 0 }, { a: 'Two', b: 'Second', score: 10 }], [['a', 'string'], ['b', 'string'], ['score', 'number']]);
  await act(async () => root.render(createElement(DatasetPanel, { dataset, panel: panel('heatmap', { x: 'a', y: 'b', value: 'score' }), onEvent: event => events.push(event) })));
  assert.equal(host.querySelectorAll('svg rect[role="button"]').length, 2);
  const zero = [...host.querySelectorAll('svg rect[role="button"]')].find(element => element.getAttribute('aria-label').endsWith(': 0'));
  await act(async () => zero.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: ' ', bubbles: true })));
  assert.equal(events[0].values.score, 0); assert.equal(events[0].values.value, 0);
}));

test('network controls support search, type/community filters, paths, fit, zoom, dragging and cancellation', async () => withDOM(async ({ dom, host, root }) => {
  const events = [], dataset = { kind: 'graph', nodes: [{ id: 'a', label: 'Alpha', type: 'person', community: 'one' }, { id: 'b', label: 'Beta', type: 'person', community: 'one' }, { id: 'c', label: 'Gamma', type: 'team', community: 'two' }], edges: [{ id: 'ab', source: 'a', target: 'b', type: 'knows' }, { id: 'bc', source: 'b', target: 'c', type: 'owns' }], meta: { warnings: [], truncated: false, sourceRows: 5 } };
  await act(async () => root.render(createElement(DatasetPanel, { dataset, panel: panel('network'), onEvent: event => events.push(event) })));
  const node = () => host.querySelector('svg g[role="button"]');
  await act(async () => node().dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
  assert.equal(events[0].entity, 'node'); assert.equal(events[0].values.id, 'a');
  await changeValue(host.querySelector('[aria-label="Highlight path to node"]'), 'c', dom.window);
  assert.match(host.textContent, /2 hops/);
  const view = () => host.querySelector('svg > g').getAttribute('transform');
  const initialView = view();
  await act(async () => host.querySelector('[aria-label="Zoom in"]').click());
  assert.notEqual(view(), initialView);
  await act(async () => [...host.querySelectorAll('button')].find(button => button.textContent === 'Fit').click());
  assert.match(view(), /scale\(/);
  const pointer = (target, type, x, y) => { const event = new dom.window.MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 }); Object.defineProperty(event, 'pointerId', { value: 1 }); target.dispatchEvent(event); };
  const before = node().getAttribute('transform'), svg = host.querySelector('svg');
  await act(async () => pointer(node(), 'pointerdown', 100, 100));
  await act(async () => pointer(svg, 'pointermove', 160, 150));
  assert.notEqual(node().getAttribute('transform'), before);
  await act(async () => pointer(svg, 'pointercancel', 160, 150));
  assert.equal(node().getAttribute('transform'), before);
  const beforePan = view();
  await act(async () => pointer(svg, 'pointerdown', 20, 20));
  await act(async () => pointer(svg, 'pointermove', 50, 70));
  assert.notEqual(view(), beforePan);
  await act(async () => pointer(svg, 'pointercancel', 50, 70));
  assert.equal(view(), beforePan);
  await changeValue(host.querySelector('[aria-label="Search nodes"]'), 'Gamma', dom.window);
  assert.match(host.textContent, /1 search matches/);
  await act(async () => host.querySelector('[aria-label="Search nodes"]').dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
  assert.equal(events.at(-1).values.id, 'c');
  const wheelView = view();
  await act(async () => svg.dispatchEvent(new dom.window.WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -120, clientX: 360, clientY: 220 })));
  assert.notEqual(view(), wheelView);
  await changeValue(host.querySelector('[aria-label="Edge type filter"]'), 'knows', dom.window);
  assert.match(host.textContent, /3 nodes · 1 edges/);
  await changeValue(host.querySelector('[aria-label="Edge type filter"]'), '', dom.window);
  const labelControl = host.querySelector('[aria-label="Node label visibility"]');
  assert.equal(labelControl.value, 'focus');
  await changeValue(labelControl, 'all', dom.window);
  assert.equal(host.querySelectorAll('[data-node-label]').length, 3);
  await changeValue(labelControl, 'focus', dom.window);
  const neighborsCheckbox = [...host.querySelectorAll('label')].find(label => label.textContent === 'Neighbors').querySelector('input');
  await act(async () => neighborsCheckbox.click());
  assert.equal(neighborsCheckbox.checked, false);
  await changeValue(host.querySelector('[aria-label="Node type filter"]'), 'person', dom.window);
  assert.match(host.textContent, /2 nodes · 1 edges/);
  await changeValue(host.querySelector('[aria-label="Community filter"]'), 'two', dom.window);
  assert.match(host.textContent, /No nodes match/);
}));

test('graph readability defaults, accessible focus, region filters, drag envelopes and settings', async () => withDOM(async ({dom,host,root})=>{
  const dataset={kind:'graph',nodes:[{id:'a',label:'Alpha',group:'People',community:'First',size:3},{id:'b',label:'Beta',group:'People',community:'First',size:2},{id:'c',label:'Gamma',group:'Tools',community:'Second',size:1}],edges:[{source:'a',target:'b',type:'knows'}],meta:{warnings:[],truncated:false,sourceRows:4}};
  // Legacy persisted showLabels must not restore the original unreadable default.
  await act(async()=>root.render(createElement(DatasetPanel,{dataset,panel:panel('network',{}, {showLabels:true})})));
  assert.equal(host.querySelectorAll('[data-node-label]').length,0);
  assert.equal(host.querySelector('[data-graph-boundaries]').getAttribute('pointer-events'),'none');
  assert.equal(host.querySelectorAll('[data-region-id]').length,2);
  assert.equal(host.querySelector('svg > g').firstElementChild.getAttribute('data-graph-boundaries'),'true');
  assert.ok([...host.querySelectorAll('[data-node-dot]')].every(e=>Number(e.getAttribute('r'))<=6));
  const first=()=>host.querySelector('[data-node-id="a"]');
  await act(async()=>first().dispatchEvent(new dom.window.FocusEvent('focusin',{bubbles:true})));
  assert.equal(host.querySelectorAll('[data-node-label]').length,1);
  await act(async()=>first().dispatchEvent(new dom.window.FocusEvent('focusout',{bubbles:true})));
  assert.equal(host.querySelectorAll('[data-node-label]').length,0);
  await changeValue(host.querySelector('[aria-label="Region filter"]'),'Second',dom.window);
  assert.equal(host.querySelectorAll('[data-node-id]').length,1);
  assert.equal(host.querySelectorAll('[data-region-id]').length,1);
  assert.match(host.textContent,/1 nodes · 0 edges/);
  await changeValue(host.querySelector('[aria-label="Region filter"]'),'',dom.window);
  const region=()=>host.querySelector('[data-region-id="First"] path');
  const original=region().getAttribute('d');
  const pointer=(target,type,x,y)=>{const event=new dom.window.MouseEvent(type,{bubbles:true,clientX:x,clientY:y,button:0});Object.defineProperty(event,'pointerId',{value:4});target.dispatchEvent(event);};
  await act(async()=>pointer(first(),'pointerdown',100,100));
  await act(async()=>pointer(host.querySelector('svg'),'pointermove',300,300));
  assert.notEqual(region().getAttribute('d'),original);
  await act(async()=>pointer(host.querySelector('svg'),'pointercancel',300,300));
  assert.equal(region().getAttribute('d'),original);
  const before=Number(first().querySelector('[data-node-dot]').getAttribute('r'));
  await changeValue(host.querySelector('[aria-label="Node size"]'),'1.5',dom.window);
  assert.ok(Number(first().querySelector('[data-node-dot]').getAttribute('r'))>before);
  await changeValue(host.querySelector('[aria-label="Node label visibility"]'),'all',dom.window);
  await changeValue(host.querySelector('[aria-label="Label size"]'),'16',dom.window);
  assert.equal(host.querySelectorAll('[data-node-label]').length,3);
  assert.equal(host.querySelector('[data-node-label]').getAttribute('font-size'),'16');
  const boundaryToggle=[...host.querySelectorAll('label')].find(e=>e.textContent==='Group boundaries').querySelector('input');
  await act(async()=>boundaryToggle.click());
  assert.equal(host.querySelector('[data-graph-boundaries]'),null);
  await changeValue(host.querySelector('[aria-label="Boundary grouping"]'),'components',dom.window);
  assert.match(host.textContent,/undirected connected components/);
}));
