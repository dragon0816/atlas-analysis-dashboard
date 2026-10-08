import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><div id="test"></div>', { pretendToBeVisual: true, url: 'http://localhost/' });
for (const key of ['window', 'document', 'HTMLElement', 'Element', 'SVGElement', 'Event', 'MouseEvent', 'KeyboardEvent']) globalThis[key] = dom.window[key];
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const OriginalMessageChannel = globalThis.MessageChannel, channels = [];
globalThis.MessageChannel = class extends OriginalMessageChannel { constructor() { super(); channels.push(this); } };
const directory = await mkdtemp(join(tmpdir(), 'panel-appearance-'));
after(async () => { dom.window.close(); for (const channel of channels) { channel.port1.close(); channel.port2.close(); } globalThis.MessageChannel = OriginalMessageChannel; await rm(directory, { recursive: true, force: true }); });
await build({ stdin: { contents: `export { HeatmapPanel } from './src/components/panels/HeatmapPanel'; export { BasicPanel } from './src/components/panels/BasicPanels'; export { PanelAppearanceControls } from './src/components/panels/PanelAppearanceControls'; export * from './src/components/panels/panelAppearance'; export { heatmapColor } from './src/platform/heatmapModel'; export { SERIES_COLORS, CHROME } from './src/components/panels/PanelUi'; export { createElement, act } from 'react'; export { createRoot } from 'react-dom/client'; export { renderToStaticMarkup } from 'react-dom/server';`, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'cjs', outfile: join(directory, 'appearance.cjs') });
const { HeatmapPanel, BasicPanel, PanelAppearanceControls, normalizeHexColor, panelFillOpacity, heatmapAppearance, heatmapTextColor, heatmapColor, SERIES_COLORS, CHROME, createElement, act, createRoot, renderToStaticMarkup } = (await import(pathToFileURL(join(directory, 'appearance.cjs')).href)).default;
const panel = (type, display = {}) => ({ id: 'generic', title: 'Appearance example', type, datasource: { id: 'rows' }, transform: [], mapping: { x: 'category', y: 'group', value: 'value', category: 'category', series: 'group' }, display, layout: { x: 0, y: 0, w: 8, h: 4 } });
const dataset = { kind: 'table', rows: [{ category: 'One', group: 'A', value: 0 }, { category: 'Two', group: 'B', value: 100 }], fields: [{ name: 'category', type: 'string' }, { name: 'group', type: 'string' }, { name: 'value', type: 'number' }], meta: { warnings: [], sourceRows: 2, truncated: false } };
function inspect(type, display, check) { const rendered = new JSDOM(renderToStaticMarkup(createElement(type === 'heatmap' ? HeatmapPanel : BasicPanel, { panel: panel(type, display), dataset }))); try { check(rendered.window.document); } finally { rendered.window.close(); } }

test('appearance sanitizers clamp opacity, preserve zero, and accept only opaque hex colors', () => {
  for (const value of [NaN, Infinity, -Infinity, '0.5', null, undefined, {}, []]) assert.equal(panelFillOpacity({ fillOpacity: value }), 1);
  for (const [value, expected] of [[0, 0], [-3, 0], [0.45, 0.45], [2, 1]]) assert.equal(panelFillOpacity({ fillOpacity: value }), expected);
  assert.equal(normalizeHexColor(' #aBc '), '#aabbcc'); assert.equal(normalizeHexColor('#ABC123'), '#abc123');
  for (const value of ['red', 'transparent', 'url(#foreign)', '#1234', '#00000000', '#zzzzzz', 4, null, 'rgb(1, 2, 3)']) assert.equal(normalizeHexColor(value), undefined);
});

test('heatmap preserves legacy palettes and creates a distinct sequential custom ramp for any base', () => {
  for (const palette of ['blue', 'green', 'purple', 'gray', 'unknown']) for (const value of [0, 25, 50, 75, 100]) assert.equal(heatmapAppearance({ color_scale: palette }).color(value, 0, 100), heatmapColor(value, 0, 100, palette));
  for (const base of ['#000000', '#ffffff', '#fe0000', '#04a080']) {
    const appearance = heatmapAppearance({ heatmapBaseColor: base }), colors = [0, 25, 50, 75, 100].map(value => appearance.color(value, 0, 100));
    assert.equal(new Set(colors).size, 5);
    const channels = colors.map(value => value.match(/\d+/g).map(Number));
    for (let index = 1; index < channels.length; index++) for (let channel = 0; channel < 3; channel++) assert.ok(channels[index][channel] <= channels[index - 1][channel]);
    assert.equal(appearance.color(null, 0, 100), '#182235');
  }
  assert.equal(heatmapAppearance({ heatmapBaseColor: 'url(#foreign)' }).color(50, 0, 100), heatmapColor(50, 0, 100));
  for (const palette of ['__proto__', 'constructor', 'toString', {}, []]) assert.equal(heatmapAppearance({ color_scale: palette }).color(50, 0, 100), heatmapColor(50, 0, 100));
});

test('bar changes only fills and opacity, retaining series colors unless explicitly overridden', () => {
  inspect('bar', {}, document => assert.deepEqual([...document.querySelectorAll('rect[role="button"]')].map(rect => rect.getAttribute('fill')), SERIES_COLORS.slice(0, 2)));
  for (const opacity of [0, 0.35, 1]) inspect('bar', { fillColor: '#FA1', fillOpacity: opacity }, document => {
    assert.ok([...document.querySelectorAll('rect[role="button"]')].every(rect => rect.getAttribute('fill') === '#ffaa11' && rect.getAttribute('fill-opacity') === String(opacity)));
    assert.ok(document.querySelectorAll('svg text').length > 0);
    assert.ok([...document.querySelectorAll('svg, svg text, svg g, svg line')].every(node => !node.hasAttribute('opacity') && !node.hasAttribute('fill-opacity')));
  });
  inspect('bar', { fillColor: 'url(#foreign)', fillOpacity: NaN }, document => { assert.equal(document.querySelector('rect').getAttribute('fill'), SERIES_COLORS[0]); assert.equal(document.querySelector('rect').getAttribute('fill-opacity'), '1'); });
});

test('heatmap legend reflects appearance while missing cells, text and thresholds stay visible', () => {
  for (const opacity of [0, 0.35, 1]) inspect('heatmap', { heatmapBaseColor: '#e44d87', fillOpacity: opacity, threshold: 50, min: 0, max: 100 }, document => {
    const cells = [...document.querySelectorAll('rect[role="button"]')], appearance = heatmapAppearance({ heatmapBaseColor: '#e44d87' });
    assert.deepEqual(cells.map(cell => cell.getAttribute('fill')), [appearance.color(0, 0, 100), appearance.color(100, 0, 100)]);
    assert.ok(cells.every(cell => cell.getAttribute('fill-opacity') === String(opacity)));
    assert.equal(cells[0].getAttribute('stroke'), CHROME.limit); assert.equal(cells[0].getAttribute('stroke-width'), '2');
    const missing = [...document.querySelectorAll('rect')].filter(rect => rect.getAttribute('fill')?.startsWith('url('));
    assert.equal(missing.length, 2); assert.ok(missing.every(rect => rect.getAttribute('fill-opacity') === '1'));
    const legend = document.querySelector('[aria-label="Color scale 0 to 100"]');
    assert.match(legend.innerHTML, new RegExp(`rgba\\([^)]*, ${opacity}\\)`));
    assert.ok([...document.querySelectorAll('svg, svg text, svg g, [aria-label="Color scale 0 to 100"]')].every(node => !node.hasAttribute('opacity') && !node.hasAttribute('fill-opacity') && !node.style.opacity));
    if (opacity === 0) assert.equal(document.querySelector('svg g text').getAttribute('fill'), '#ffffff');
  });
  assert.equal(heatmapTextColor('#ffffff', 0, CHROME.surface), '#ffffff'); assert.equal(heatmapTextColor('#ffffff', 1, CHROME.surface), '#000000');
});
const change = async (element, value) => { Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(element, value); await act(async () => element.dispatchEvent(new dom.window.Event('input', { bubbles: true }))); };

test('controls emit live display patches, validate hex, support reset and isolate panel settings', async () => {
  const host = document.getElementById('test'), root = createRoot(host);
  let display = {}, type = 'bar', updates = [];
  const draw = () => root.render(createElement(PanelAppearanceControls, { type, display, onChange: patch => { updates.push(patch); display = { ...display, ...patch }; draw(); } }));
  try {
    await act(async () => draw()); assert.equal(host.querySelector('[aria-label="Fill opacity"]').value, '100');
    await change(host.querySelector('[aria-label="Fill opacity"]'), '0'); assert.equal(display.fillOpacity, 0); assert.match(host.textContent, /0% hides the fills/);
    await change(host.querySelector('[aria-label="Fill opacity"]'), '37'); assert.equal(display.fillOpacity, 0.37); assert.equal(host.querySelector('svg rect').getAttribute('fill-opacity'), '0.37');
    await change(host.querySelector('[aria-label="Bar fill color"]'), '#aabbcc'); assert.equal(display.fillColor, '#aabbcc');
    await change(host.querySelector('[aria-label="Bar fill color hex"]'), '#123'); assert.equal(display.fillColor, '#112233'); assert.equal(host.querySelector('[aria-label="Bar fill color hex"]').value, '#123', 'Shorthand remains editable into six-digit hex');
    await change(host.querySelector('[aria-label="Bar fill color hex"]'), '#123456'); assert.equal(display.fillColor, '#123456');
    const updateCount = updates.length;
    await change(host.querySelector('[aria-label="Bar fill color hex"]'), 'invalid'); assert.equal(updates.length, updateCount); assert.equal(host.querySelector('[aria-label="Bar fill color hex"]').getAttribute('aria-invalid'), 'true');
    await act(async () => host.querySelector('[aria-label="Bar fill color hex"]').dispatchEvent(new dom.window.FocusEvent('focusout', { bubbles: true })));
    assert.equal(host.querySelector('[aria-label="Bar fill color hex"]').value, '#123456');
    assert.deepEqual(JSON.parse(JSON.stringify(panel('bar', display))).display, { fillColor: '#123456', fillOpacity: 0.37 });
    await act(async () => host.querySelector('button').click()); assert.equal(display.fillColor, undefined); assert.equal(display.fillOpacity, undefined); assert.equal(host.querySelector('[aria-label="Fill opacity"]').value, '100');
    type = 'heatmap'; display = { color_scale: 'green' }; await act(async () => draw()); assert.equal(host.querySelector('[aria-label="Heatmap base color"]').value, '#065f46');
    await change(host.querySelector('[aria-label="Heatmap base color"]'), '#ffc0cb'); assert.equal(display.heatmapBaseColor, '#ffc0cb'); assert.equal(display.fillColor, undefined); assert.equal(host.querySelector('[role="img"]').children.length, 5);
    await act(async () => host.querySelector('button').click()); assert.equal(display.heatmapBaseColor, undefined); assert.equal(display.color_scale, 'green');
  } finally { await act(async () => root.unmount()); }
});

test('fully transparent cells and bars retain click and keyboard actions', async () => {
  const host = document.getElementById('test'), root = createRoot(host);
  try {
    for (const type of ['heatmap', 'bar']) {
      const events = []; await act(async () => root.render(createElement(type === 'heatmap' ? HeatmapPanel : BasicPanel, { panel: panel(type, { fillOpacity: 0 }), dataset, onEvent: event => events.push(event) })));
      const rect = host.querySelector('rect[role="button"]');
      await act(async () => rect.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
      await act(async () => rect.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })));
      assert.equal(events.length, 2); assert.equal(events[0].values.value, 0);
    }
  } finally { await act(async () => root.unmount()); }
});
