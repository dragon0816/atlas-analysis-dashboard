import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';
const temporary = await mkdtemp(join(tmpdir(), 'atlas-workspace-'));
after(() => rm(temporary, { recursive: true, force: true }));
await build({ stdin: { contents: `export * from './src/platform/applicationLoader'; export * from './src/platform/runtime'; export * from './src/platform/layout'; export * from './src/platform/actions'; export * from './src/platform/documents';`, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'cjs', outfile: join(temporary, 'core.cjs') });
const core = (await import(pathToFileURL(join(temporary, 'core.cjs')).href)).default;
const files = {};
const portablePath = value => value.replaceAll("\\", "/");
const isApplicationModule = value => portablePath(value).endsWith('/src/platform/applications.ts');
async function visit(directory) { for (const entry of await readdir(directory, { withFileTypes: true })) { const path = join(directory, entry.name); if (entry.isDirectory()) await visit(path); else if (/\.(yaml|yml|json|csv)$/.test(path)) files[portablePath(path)] = await readFile(path, 'utf8'); } }
await visit(resolve('../applications'));
const packages = core.readApplicationPackages(files);

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url:'http://atlas.test/', pretendToBeVisual:true });
// Bundled React act uses MessageChannel fallback; track and close only the
// channels created by this harness so node:test can exit without forced exit.
const NativeMessageChannel = globalThis.MessageChannel;
const testChannels = [];
globalThis.MessageChannel = class extends NativeMessageChannel { constructor(){super();testChannels.push(this);} };
after(() => { dom.window.close(); for(const channel of testChannels){channel.port1.close();channel.port2.close();} globalThis.MessageChannel = NativeMessageChannel; });
for(const name of ['window','document','HTMLElement','HTMLInputElement','HTMLSelectElement','HTMLTextAreaElement','HTMLDialogElement','Event','MouseEvent','KeyboardEvent','CustomEvent','Node','MutationObserver']) globalThis[name]=dom.window[name];
Object.defineProperty(globalThis,'navigator',{value:dom.window.navigator,configurable:true});
Object.defineProperty(dom.window.HTMLElement.prototype,'clientWidth',{get(){return 900;},configurable:true});
Object.defineProperty(dom.window.HTMLElement.prototype,'clientHeight',{get(){return 320;},configurable:true});
dom.window.HTMLElement.prototype.getBoundingClientRect=function(){return {x:0,y:0,left:0,top:0,right:900,bottom:320,width:900,height:320,toJSON(){return this;}};};
class ResizeObserver { constructor(callback){this.callback=callback;} observe(target){this.callback([{target,contentRect:{width:900,height:320}}]);} disconnect(){} }
globalThis.ResizeObserver=ResizeObserver;
globalThis.requestAnimationFrame=callback=>setTimeout(()=>callback(performance.now()),1);globalThis.cancelAnimationFrame=clearTimeout;
let streams=0;
class EventSource { constructor(){streams++;} addEventListener(){} close(){streams--;} }
globalThis.EventSource=EventSource;
globalThis.confirm=()=>true;
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
dom.window.HTMLDialogElement.prototype.showModal=function(){this.open=true;};dom.window.HTMLDialogElement.prototype.close=function(){this.open=false;};
const stored=new Map();let saveCount=0;let saveBarrier=null;
globalThis.fetch=async(url,init={})=>{
  if(String(url)==='/dashboards')return new Response(JSON.stringify([...stored.keys()]),{headers:{'Content-Type':'application/json'}});
  if(String(url).startsWith('/dashboards/')){
    const name=decodeURIComponent(String(url).slice('/dashboards/'.length));
    if(init.method==='PUT') {saveCount++;if(saveBarrier)await saveBarrier;const parsed=JSON.parse(init.body);if(init.headers['If-None-Match']==='*'&&stored.has(name))return new Response(JSON.stringify({detail:{message:'Already exists'}}),{status:412});stored.set(name,parsed);return new Response('null',{headers:{ETag:'"revision-1"'}});}
    if(stored.has(name))return new Response(JSON.stringify(stored.get(name)),{headers:{ETag:'"revision-1"'}});
  }
  throw new Error(`Unexpected mocked request: ${url}`);
};
await build({stdin:{contents:`export {DashboardPage} from './src/pages/DashboardPage'; export {DashboardCanvas} from './src/components/dashboard/DashboardCanvas'; export {StrictMode,createElement,act} from 'react'; export {createRoot} from 'react-dom/client';`,resolveDir:process.cwd()},bundle:true,platform:'node',format:'cjs',loader:{'.css':'empty'},outfile:join(temporary,'ui.cjs'),plugins:[{name:'application-fixtures',setup(build){build.onLoad({filter:/applications\.ts$/},args=>isApplicationModule(args.path)?({contents:`export const applicationPackages=${JSON.stringify(packages)};`,loader:'ts'}):undefined);}}]});
const ui=(await import(pathToFileURL(join(temporary,'ui.cjs')).href)).default;
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const settle=()=>ui.act(async()=>{await sleep(35);});
const click=async(node)=>{assert.ok(node,'Click target exists');await ui.act(async()=>{node.dispatchEvent(new dom.window.MouseEvent('click',{bubbles:true}));});await settle();};
const button=(text,scope=document)=>[...scope.querySelectorAll('button')].find(el=>el.textContent.trim()===text || el.textContent.trim().endsWith(text));
const inputValue=async(node,value)=>{assert.ok(node);const proto=node.tagName==='SELECT'?dom.window.HTMLSelectElement.prototype:dom.window.HTMLInputElement.prototype;await ui.act(async()=>{Object.getOwnPropertyDescriptor(proto,'value').set.call(node,value);node.dispatchEvent(new dom.window.Event(node.tagName==='SELECT'?'change':'input',{bubbles:true}));});await settle();};
const labelInput=(label,scope=document)=>[...scope.querySelectorAll('label')].find(el=>el.querySelector('span')?.textContent===label)?.querySelector('input,select,textarea');

test('application packages are data-only, valid, isolated and all mock panels run', async () => {
  assert.deepEqual(packages.errors, []);
  assert.equal(packages.applications.length, 2);
  for (const app of packages.applications.filter(app => app.demo)) {
    const runtime = new core.PlatformRuntime(app);
    for (const dashboard of app.dashboards) {
      core.validateDashboardDocument(dashboard);
      for (const panel of dashboard.panels) {
        const dataset = await runtime.query(panel, {});
        assert.ok(dataset.kind === 'table' || dataset.kind === 'graph');
        assert.ok(dataset.meta.warnings.every(w => typeof w === 'string'));
      }
    }
    runtime.dispose();
  }
  const rs = packages.applications.find(a => a.id === 'rs_knowledge');
  const runtime = new core.PlatformRuntime(rs);
  const dashboard = rs.dashboards[0];
  for (const panel of dashboard.panels) {
    const dataset = await runtime.query(panel, { market: 'AI', product: 'Tester' });
    if (dataset.kind === 'graph') { assert.equal(dataset.nodes.filter(n => n.scenario === 'sparse').length, 7); assert.ok(dataset.nodes.some(n => n.id === 'connected:cal')); assert.equal(dataset.meta.revision, 'synthetic-comparison-v1'); }
  }
  const matrix = await runtime.query(dashboard.panels.find(p => p.id === 'matrix'), { market: 'AI', product: 'Tester' });
  assert.equal(matrix.rows.length, 1); assert.equal(matrix.rows[0].market, 'AI'); assert.equal(matrix.rows[0].product, 'Tester');
  const again = core.readApplicationPackages({ ...files, '/escape/application.yaml': 'id: bad\nname: Bad\ndatasources: ../secrets.yaml\ndashboards: [x.yaml]' });
  assert.equal(again.applications.length, 2); assert.match(again.errors.join(' '), /within its package/);
  runtime.dispose();
});

test('layout collisions, min sizes, responsive layouts, actions and safe URLs', () => {
  const panel = (id, x, y, w=6, h=4) => ({ id, layout: {x,y,w,h}, type:'table' });
  const panels = [panel('a',0,0), panel('b',6,0), panel('c',0,4,12,5)];
  const moved = core.settlePanels([ {...panels[0], layout: {x:6,y:0,w:6,h:4}}, panels[1], panels[2] ], 'a');
  for(let i=0;i<moved.length;i++) for(let j=i+1;j<moved.length;j++) assert.equal(core.overlaps(moved[i].layout,moved[j].layout),false);
  assert.deepEqual(moved[0].layout.x,6); assert.equal(core.clampLayout({x:-10,y:-4,w:99,h:0}).w,12);
  for(const columns of [1,6,12]) for(const p of core.responsivePanels(panels,columns)) assert.ok(p.layout.x+p.layout.w<=columns);
  const event={entity:'cell',values:{x:'AI',y:'Tester'}};
  assert.deepEqual(core.applyFilterAction({}, {action:'set_filter',values:{market:'$x',product:'$y'}},event,['market','product']), {market:'AI',product:'Tester'});
  assert.throws(()=>core.applyFilterAction({}, {action:'set_filter',values:{missing:1}},event,[]),/Unknown/);
  assert.throws(()=>core.safeLink('javascript:alert(1)'),/HTTP/); assert.throws(()=>core.safeLink('https://user:secret@example.org'),/credentials/);
});

test('workspace DOM: StrictMode, editor cancel, add/duplicate/remove, Save As roundtrip and save lock',async()=>{
  const root=ui.createRoot(document.getElementById('root'));let dirty=false;
  try {
  await ui.act(async()=>{root.render(ui.createElement(ui.StrictMode,null,ui.createElement(ui.DashboardPage,{onDirtyChange:v=>{dirty=v;}})));});await settle();
  assert.match(document.body.textContent,/RS Knowledge Observatory/);assert.equal(streams,0);assert.doesNotMatch(document.body.textContent,/was disposed|Could not render/);
  assert.ok(document.querySelector('[data-panel-kind="heatmap"]'));assert.ok(document.querySelector('[data-panel-kind="network"]'));
  await click(document.querySelector('[aria-controls="atlas-dashboard-controls"]'));
  const count=document.querySelectorAll('[data-panel-id]').length;
  await click(button('Edit Dashboard'));await click(button('Heatmap',document.querySelector('.atlas-panel-library')));assert.equal(document.querySelectorAll('[data-panel-id]').length,count+1);assert.equal(dirty,true);
  await click(button('Duplicate'));assert.equal(document.querySelectorAll('[data-panel-id]').length,count+2);await click(button('Remove'));assert.equal(document.querySelectorAll('[data-panel-id]').length,count+1);
  await click(button('Cancel'));assert.equal(document.querySelectorAll('[data-panel-id]').length,count);assert.equal(dirty,false);
  await click(button('Edit Dashboard'));await click(button('Dashboard settings'));await inputValue(labelInput('Title'),'Saved review');assert.match(document.querySelector('h1').textContent,/Saved review/);
  await click(button('Save'));await inputValue(labelInput('Dashboard name'),'review-one');
  let release;saveBarrier=new Promise(resolve=>{release=resolve;});
  await ui.act(async()=>{document.querySelector('.atlas-modal form').dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true}));});await settle();
  assert.equal(labelInput('Application').disabled,true);assert.ok(document.querySelector('.atlas-workspace-body').hasAttribute('inert'));assert.equal(saveCount,1);
  await ui.act(async()=>{release();saveBarrier=null;});await settle();assert.equal(stored.get('review-one').title,'Saved review');assert.equal(dirty,false);assert.match(document.body.textContent,/Saved “review-one”/);
  await click(button('+ New dashboard'));assert.equal(document.querySelectorAll('[data-panel-id]').length,0);await click(button('Table',document.querySelector('.atlas-panel-library')));assert.equal(document.querySelectorAll('[data-panel-id]').length,1);await click(button('Cancel'));
  await inputValue(labelInput('Saved dashboard'),'review-one');assert.equal(document.querySelector('h1').textContent,'Saved review');assert.equal(document.querySelectorAll('[data-panel-id]').length,count);
  await click(button('Restore default'));assert.equal(document.querySelector('h1').textContent,'RS Knowledge Observatory');
  await click(button('Cancel'));assert.equal(document.querySelector('h1').textContent,'Saved review');
  await inputValue(labelInput('Application'),'agent_validation');assert.match(document.body.textContent,/Agent Validation Lab/);assert.doesNotMatch(document.body.textContent,/Could not render/);
  } finally { await ui.act(async()=>{root.unmount();await sleep(10);}); } await sleep(5);assert.equal(streams,0);
});

test('workspace cross-filters, details, drag/resize interruption, and restore default remain reversible',async()=>{
  const root=ui.createRoot(document.getElementById('root'));
  const pointer=async(target,type,x=10,y=10)=>{await ui.act(async()=>{target.dispatchEvent(new dom.window.MouseEvent(type,{bubbles:true,button:0,clientX:x,clientY:y}));});await settle();};
  try {
    await ui.act(async()=>root.render(ui.createElement(ui.DashboardPage)));await settle();
    const cell=[...document.querySelectorAll('[data-panel-kind="heatmap"] [role="button"]')].find(node=>node.getAttribute('aria-label').includes('AI')&&node.getAttribute('aria-label').includes('Tester'));
    await click(cell);assert.equal(labelInput('Market').value,'AI');assert.equal(labelInput('Product').value,'Tester');assert.match(document.querySelector('[aria-label="Active filters"]').textContent,/Market: AI/);assert.equal(document.querySelector('.atlas-filter-count').textContent,'2');
    const dialog=document.querySelector('dialog[open]');assert.ok(dialog);assert.match(dialog.textContent,/Selected item/);assert.match(dialog.textContent,/Tester/);
    await click(document.querySelector('[aria-label="Close details"]'));assert.equal(document.querySelector('dialog'),null);
    await click(button('Reset filters'));assert.equal(labelInput('Market').value,'');
    const firstTable=document.querySelector('[data-panel-kind="table"] tbody tr');await click(firstTable);assert.ok(document.querySelector('dialog[open]'));await click(document.querySelector('[aria-label="Close details"]'));
    await click(button('Edit Dashboard'));
    const panel=document.querySelector('[data-panel-id="coverage"]'), original=panel.getAttribute('style');
    await pointer(panel.querySelector('.atlas-drag'),'pointerdown');await pointer(window,'pointermove',90,110);assert.notEqual(panel.getAttribute('style'),original);
    await ui.act(async()=>window.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true})));await settle();assert.equal(panel.getAttribute('style'),original);
    await pointer(panel.querySelector('.atlas-resize'),'pointerdown');await pointer(window,'pointermove',160,110);assert.notEqual(panel.getAttribute('style'),original);
    await pointer(window,'pointercancel');assert.equal(panel.getAttribute('style'),original);
    await click(button('Dashboard settings'));await inputValue(labelInput('Title'),'Temporary edited title');
    await click(button('Restore default'));assert.equal(document.querySelector('h1').textContent,'RS Knowledge Observatory');
    await click(button('Cancel'));assert.equal(document.querySelector('h1').textContent,'RS Knowledge Observatory');
    assert.doesNotMatch(document.body.textContent,/Could not render|was disposed/);
  } finally {await ui.act(async()=>root.unmount());await sleep(5);}
});


test('application fixture interception accepts Windows and POSIX module paths',()=>{
  assert.equal(isApplicationModule('/workspace/web/src/platform/applications.ts'),true);
  assert.equal(isApplicationModule('C:\\workspace\\web\\src\\platform\\applications.ts'),true);
  assert.equal(isApplicationModule('C:\\workspace\\web\\src\\other\\applications.ts'),false);
  assert.equal(isApplicationModule('/workspace/web/src/platform/applications.tsx'),false);
  assert.equal(portablePath('C:\\fixtures\\application.yaml'),'C:/fixtures/application.yaml');
});


test('compact controls: collapsed defaults, independent toggles, filter summary and UI-only persistence', async () => {
  const key = 'atlas.dashboard.controls.v1';
  dom.window.localStorage.clear();
  let root = ui.createRoot(document.getElementById('root')); let dirty = false;
  const mount = async () => { await ui.act(async () => root.render(ui.createElement(ui.DashboardPage, { onDirtyChange: value => { dirty = value; } }))); await settle(); };
  const dashboardToggle = () => document.querySelector('[aria-controls="atlas-dashboard-controls"]');
  const filterToggle = () => document.querySelector('[aria-controls="atlas-filter-controls"]');
  const summary = () => document.querySelector('[aria-label="Active filters"]');
  try {
    await mount();
    assert.equal(dashboardToggle().getAttribute('aria-expanded'), 'false');
    assert.equal(filterToggle().getAttribute('aria-expanded'), 'false');
    assert.equal(document.getElementById('atlas-dashboard-controls').hidden, true);
    assert.equal(document.getElementById('atlas-filter-controls').hidden, true);
    assert.equal(document.querySelector('.atlas-workspace-header p'), null);
    assert.equal(document.querySelector('.atlas-demo-label').textContent, 'Synthetic data');
    assert.match(summary().textContent, /All data/);
    assert.equal(document.querySelector('.atlas-filter-count').textContent, '0');
    assert.ok(button('Reset filters').closest('.atlas-control-strip'));

    await click(filterToggle());
    assert.equal(filterToggle().getAttribute('aria-expanded'), 'true');
    assert.equal(document.getElementById('atlas-filter-controls').hidden, false);
    assert.equal(document.getElementById('atlas-dashboard-controls').hidden, true);
    await inputValue(labelInput('Market'), 'AI');
    await inputValue(labelInput('Product'), 'Tester');
    await click(filterToggle());
    assert.equal(document.getElementById('atlas-filter-controls').hidden, true);
    assert.equal(document.querySelector('.atlas-filter-count').textContent, '2');
    assert.match(summary().textContent, /Market: AI/);
    assert.match(summary().textContent, /Product: Tester/);
    assert.equal(labelInput('Market').value, 'AI');
    await click(button('Reset filters'));
    assert.equal(labelInput('Market').value, '');
    assert.equal(document.querySelector('.atlas-filter-count').textContent, '0');

    await click(button('Edit Dashboard'));
    assert.equal(dirty, false);
    await click(dashboardToggle());
    await click(filterToggle());
    assert.equal(dirty, false, 'Opening controls is not a dashboard edit');
    await click(button('Dashboard settings'));
    await inputValue(labelInput('Title'), 'Temporary compact test');
    assert.equal(dirty, true);
    await click(dashboardToggle());
    await click(filterToggle());
    assert.equal(dirty, true, 'Closing controls must not clear unsaved changes');
    await click(button('Cancel'));
    assert.equal(dirty, false);
    assert.equal(document.querySelector('h1').textContent, 'RS Knowledge Observatory');
    assert.equal(document.getElementById('atlas-dashboard-controls').hidden, true);
    await click(filterToggle());
    assert.deepEqual(JSON.parse(dom.window.localStorage.getItem(key)), { dashboards: false, filters: true });
    await ui.act(async () => root.unmount());
    root = ui.createRoot(document.getElementById('root'));
    await mount();
    assert.equal(document.getElementById('atlas-dashboard-controls').hidden, true);
    assert.equal(document.getElementById('atlas-filter-controls').hidden, false, 'Expanded preference survives remount');
    assert.equal(document.querySelector('.atlas-filter-count').textContent, '0', 'Preference does not persist filter values');
  } finally { await ui.act(async () => root.unmount()); dom.window.localStorage.clear(); }
});

test('compact controls remain usable when browser preference storage is blocked or malformed', async () => {
  const key = 'atlas.dashboard.controls.v1';
  dom.window.localStorage.setItem(key, '{invalid');
  const originalSet = dom.window.Storage.prototype.setItem;
  dom.window.Storage.prototype.setItem = () => { throw new Error('Storage blocked'); };
  const root = ui.createRoot(document.getElementById('root'));
  try {
    await ui.act(async () => root.render(ui.createElement(ui.DashboardPage))); await settle();
    assert.equal(document.getElementById('atlas-filter-controls').hidden, true);
    await click(document.querySelector('[aria-controls="atlas-filter-controls"]'));
    assert.equal(document.getElementById('atlas-filter-controls').hidden, false);
    assert.doesNotMatch(document.body.textContent, /Could not render/);
  } finally { await ui.act(async () => root.unmount()); dom.window.Storage.prototype.setItem = originalSet; dom.window.localStorage.clear(); }
});

test('compact CSS removes collapsed sections from layout and keeps mobile controls bounded', async () => {
  const css = await readFile(resolve('src/platform/dashboard.css'), 'utf8');
  assert.match(css, /\.atlas-source-bar\[hidden\],\.atlas-variables\[hidden\]\s*\{\s*display:none/);
  assert.match(css, /\.atlas-filter-summary[^}]*min-width:0[^}]*overflow-x:auto/);
  assert.match(css, /@media\(max-width:600px\)[\s\S]*\.atlas-source-bar,\.atlas-variables\s*\{[^}]*max-height:40vh;\s*overflow:auto/);
});

test('appearance edits preview immediately, cancel cleanly, and persist in saved dashboard JSON',async()=>{
  dom.window.localStorage.clear();
  const root=ui.createRoot(document.getElementById('root'));
  const firstCell=()=>document.querySelector('[data-panel-id="matrix"] [role="button"]');
  try {
    await ui.act(async()=>root.render(ui.createElement(ui.DashboardPage)));await settle();
    await click(document.querySelector('[aria-controls="atlas-dashboard-controls"]'));
    const before=firstCell().getAttribute('fill');
    await click(button('Edit Dashboard'));
    await click(document.querySelector('[data-panel-id="matrix"] .atlas-panel-header h2'));
    await inputValue(document.querySelector('[aria-label="Heatmap base color hex"]'),'#c026d3');
    await inputValue(document.querySelector('[aria-label="Fill opacity"]'),'45');
    assert.notEqual(firstCell().getAttribute('fill'),before);
    assert.equal(firstCell().getAttribute('fill-opacity'),'0.45');
    await click(button('Cancel'));
    assert.equal(firstCell().getAttribute('fill'),before);
    assert.equal(firstCell().getAttribute('fill-opacity'),'1');
    await click(button('Edit Dashboard'));
    await click(document.querySelector('[data-panel-id="matrix"] .atlas-panel-header h2'));
    await inputValue(document.querySelector('[aria-label="Heatmap base color hex"]'),'#c026d3');
    await inputValue(document.querySelector('[aria-label="Fill opacity"]'),'45');
    const barPanel=document.querySelector('[data-panel-kind="bar"]').closest('[data-panel-id]');
    const barId=barPanel.getAttribute('data-panel-id');
    await click(barPanel.querySelector('.atlas-panel-header h2'));
    await inputValue(document.querySelector('[aria-label="Bar fill color hex"]'),'#ef4444');
    await inputValue(document.querySelector('[aria-label="Fill opacity"]'),'60');
    const bar=barPanel.querySelector('svg rect[role="button"]');
    assert.equal(bar.getAttribute('fill'),'#ef4444'); assert.equal(bar.getAttribute('fill-opacity'),'0.6');
    await click(button('Save'));
    await inputValue(labelInput('Dashboard name'),'appearance-review');
    await ui.act(async()=>document.querySelector('.atlas-modal form').dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true})));await settle();
    const saved=stored.get('appearance-review');
    assert.equal(saved.panels.find(p=>p.id==='matrix').display.heatmapBaseColor,'#c026d3');
    assert.equal(saved.panels.find(p=>p.id==='matrix').display.fillOpacity,.45);
    assert.equal(saved.panels.find(p=>p.id===barId).display.fillColor,'#ef4444');
    assert.equal(saved.panels.find(p=>p.id===barId).display.fillOpacity,.6);
    await inputValue(labelInput('Saved dashboard'),'appearance-review');
    assert.equal(firstCell().getAttribute('fill-opacity'),'0.45');
    assert.doesNotMatch(document.body.textContent,/Could not render/);
  } finally {await ui.act(async()=>root.unmount());await sleep(5);}
});

test('panel header Remove works without selection, preserves selection, restores Cancel and persists Save/Save As', async () => {
  dom.window.localStorage.clear();
  const root=ui.createRoot(document.getElementById('root'));
  const cards=()=>[...document.querySelectorAll('[data-panel-id]')];
  const remove=id=>document.querySelector(`[data-panel-id="${id}"] .atlas-panel-remove`);
  const saveAs=async name=>{await click(button('Save As'));await inputValue(labelInput('Dashboard name'),name);await ui.act(async()=>document.querySelector('.atlas-modal form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));await settle();};
  try {
    await ui.act(async()=>root.render(ui.createElement(ui.StrictMode,null,ui.createElement(ui.DashboardPage))));await settle();
    const original=cards().map(card=>card.dataset.panelId);
    assert.equal(document.querySelector('.atlas-panel-remove'),null,'View mode cannot remove panels');
    await click(button('Edit Dashboard'));
    assert.equal(document.querySelectorAll('.atlas-panel-remove').length,original.length);
    const selected=document.querySelector('.atlas-panel.is-selected').dataset.panelId;
    const other=original.find(id=>id!==selected);
    await click(remove(other));
    assert.equal(remove(other),null);
    assert.equal(document.querySelector('.atlas-panel.is-selected').dataset.panelId,selected,'Removing unselected panel preserves editor selection');
    assert.equal(labelInput('Title').value,document.querySelector('.atlas-panel.is-selected h2').textContent);
    assert.match(document.querySelector('.atlas-status').textContent,/from the draft.*Cancel to restore/);
    // Native buttons are keyboard-focusable. JSDOM does not synthesize browser
    // Enter/Space default activation, so use its equivalent detail=0 click.
    const selectedRemove=remove(selected);selectedRemove.focus();assert.equal(document.activeElement,selectedRemove);
    await ui.act(async()=>selectedRemove.dispatchEvent(new MouseEvent('click',{bubbles:true,detail:0})));await settle();
    assert.equal(remove(selected),null);
    assert.ok(document.activeElement.matches('.atlas-panel-remove'));
    assert.notEqual(document.querySelector('.atlas-panel.is-selected')?.dataset.panelId,selected);
    await click(button('Cancel'));assert.deepEqual(cards().map(card=>card.dataset.panelId),original);
    await click(button('Edit Dashboard'));await click(remove(other));
    await saveAs('remove-save-as');
    assert.equal(stored.get('remove-save-as').panels.some(p=>p.id===other),false);
    await click(document.querySelector('[aria-controls="atlas-dashboard-controls"]'));
    await inputValue(labelInput('Saved dashboard'),'remove-save-as');assert.equal(remove(other),null);assert.equal(cards().some(card=>card.dataset.panelId===other),false);
    await click(button('Edit Dashboard'));await click(remove(selected));await click(button('Save'));
    assert.equal(stored.get('remove-save-as').panels.some(p=>p.id===selected),false);
    await inputValue(labelInput('Saved dashboard'),'remove-save-as');assert.equal(cards().some(card=>card.dataset.panelId===selected),false);
    await click(button('Edit Dashboard'));
    while(cards().length) await click(cards()[0].querySelector('.atlas-panel-remove'));
    assert.ok(document.querySelector('.atlas-empty-board'));assert.equal(document.querySelector('.atlas-panel.is-selected'),null);
    assert.equal(document.querySelector('[aria-label="Panel properties"]'),null);
    assert.ok(document.activeElement.closest('.atlas-panel-library'));
    await click(button('Save'));assert.deepEqual(stored.get('remove-save-as').panels,[]);
    await inputValue(labelInput('Saved dashboard'),'remove-save-as');assert.equal(cards().length,0);
    assert.match(document.querySelector('.atlas-empty-board').textContent,/Edit Dashboard/);
    await click(button('Edit Dashboard'));await click(button('Table',document.querySelector('.atlas-panel-library')));assert.equal(cards().length,1);
    await click(button('Cancel'));assert.equal(cards().length,0);
    assert.doesNotMatch(document.body.textContent,/Could not render|was disposed/);
  } finally {await ui.act(async()=>root.unmount());await sleep(5);}
});

test('removal stops active drag so later pointer events cannot restore removed panels', async () => {
  const root=ui.createRoot(document.getElementById('root'));
  const pointer=async(target,type,x=10)=>{await ui.act(async()=>target.dispatchEvent(new MouseEvent(type,{bubbles:true,button:0,clientX:x,clientY:10})));await settle();};
  try {
    await ui.act(async()=>root.render(ui.createElement(ui.DashboardPage)));await settle();await click(button('Edit Dashboard'));
    const card=document.querySelector('[data-panel-id]');const id=card.dataset.panelId;
    await pointer(card.querySelector('.atlas-drag'),'pointerdown');
    await click(card.querySelector('.atlas-panel-remove'));
    await pointer(window,'pointermove',200);await pointer(window,'pointerup',200);
    assert.equal(document.querySelector(`[data-panel-id="${id}"]`),null);
    await click(button('Cancel'));assert.ok(document.querySelector(`[data-panel-id="${id}"]`));
  } finally {await ui.act(async()=>root.unmount());}
});

test('Remove is visible text with mobile touch target and edit workspace access', async () => {
  const css=await readFile(resolve('src/platform/dashboard.css'),'utf8');
  assert.match(css,/\.atlas-panel-remove\s*\{[^}]*min-height:44px; min-width:64px/);
  assert.match(css,/\.atlas-workspace-body\.is-editing\s*\{ display:block; overflow:auto/);
  assert.match(css,/\.atlas-panel-header\.is-editing\s*\{ flex-wrap:wrap/);
});


test('removed panel aborts queries and releases subscriptions; late results stay removed', async () => {
  const root=ui.createRoot(document.getElementById('root'));
  let subscriptions=0, aborted=0, resolveLate;
  const dataset={kind:'table',fields:[],rows:[],meta:{warnings:[]}};
  const panel=id=>({id,title:id,type:'text',datasource:{id:'mock'},transform:[],mapping:{},display:{text:'Notes'},layout:{x:0,y:0,w:6,h:5}});
  const received=[];
  const runtime={query:(_panel,_vars,signal)=>{signal.addEventListener('abort',()=>aborted++);return _panel.id==='late'?new Promise(resolve=>{resolveLate=resolve;}):Promise.resolve(dataset);},subscribe:()=>{subscriptions++;return()=>subscriptions--;},invalidate:()=>{}};
  const render=async panels=>{await ui.act(async()=>root.render(ui.createElement(ui.DashboardCanvas,{panels,variables:{},runtime,editing:true,selected:null,refreshKey:0,onSelect:()=>{},onPanels:()=>{},onRemove:()=>{},onEvent:()=>{},onData:id=>received.push(id)})));await settle();};
  try {
    await render([panel('live'),panel('late')]);assert.equal(subscriptions,1);
    await render([]);assert.equal(subscriptions,0);assert.equal(aborted,2);
    await ui.act(async()=>resolveLate(dataset));await settle();
    assert.deepEqual(received,['live']);assert.equal(document.querySelector('[data-panel-id]'),null);assert.equal(subscriptions,0);
  } finally {await ui.act(async()=>root.unmount());}
});

test('prominent New dashboard creates a blank current-app draft; Cancel returns and new saves never overwrite', async () => {
  dom.window.localStorage.clear();
  let root=ui.createRoot(document.getElementById('root'));
  const mount=async()=>{await ui.act(async()=>root.render(ui.createElement(ui.DashboardPage)));await settle();};
  const cards=()=>document.querySelectorAll('[data-panel-id]');
  const submit=async()=>{await ui.act(async()=>document.querySelector('.atlas-modal form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));await settle();};
  const openControls=async()=>{if(document.getElementById('atlas-dashboard-controls').hidden)await click(document.querySelector('[aria-controls="atlas-dashboard-controls"]'));};
  let confirms=0;const beforeConfirm=globalThis.confirm;
  try {
    await mount();const initialCount=cards().length,initialTitle=document.querySelector('h1').textContent;
    assert.equal(document.getElementById('atlas-dashboard-controls').hidden,true);
    assert.ok(button('+ New dashboard').closest('.atlas-workspace-header'));
    await click(button('+ New dashboard'));assert.equal(cards().length,0);assert.ok(document.querySelector('.atlas-panel-library'));assert.match(document.body.textContent,/EDIT MODE/);
    await click(button('Cancel'));assert.equal(cards().length,initialCount);assert.equal(document.querySelector('h1').textContent,initialTitle);
    await click(button('Edit Dashboard'));await click(document.querySelector('.atlas-panel-remove'));
    globalThis.confirm=()=>{confirms++;return false;};await click(button('+ New dashboard'));assert.equal(cards().length,initialCount-1);assert.equal(confirms,1);
    globalThis.confirm=()=>{confirms++;return true;};await click(button('+ New dashboard'));assert.equal(cards().length,0);assert.equal(confirms,2);
    await click(button('+ New dashboard'));assert.equal(cards().length,0);assert.equal(confirms,3,'Even a new blank draft is guarded');
    await click(button('Cancel'));assert.equal(cards().length,initialCount,'Cancel returns to pre-edit baseline after explicit discard');
    await openControls();await inputValue(labelInput('Application'),'agent_validation');
    const appTitle=document.querySelector('h1').textContent;
    await click(button('+ New dashboard'));await click(button('Table',document.querySelector('.atlas-panel-library')));
    assert.ok(Object.keys(packages.applications.find(app=>app.id==='agent_validation').sources).includes(labelInput('Logical source').value));
    await click(button('Save'));await inputValue(labelInput('Dashboard name'),'new-dashboard-test');await submit();
    const saved=structuredClone(stored.get('new-dashboard-test'));
    assert.equal(saved.applicationId,'agent_validation');assert.equal(saved.title,'new-dashboard-test');assert.equal(saved.panels.length,1);
    assert.ok(!packages.applications.flatMap(app=>app.dashboards).some(board=>board.id===saved.id));
    await click(button('+ New dashboard'));assert.equal(cards().length,0);
    await click(button('Save'));await inputValue(labelInput('Dashboard name'),'new-dashboard-test');await submit();
    assert.deepEqual(stored.get('new-dashboard-test'),saved);assert.match(document.querySelector('.atlas-modal [role="alert"]').textContent,/Already exists/);
    await inputValue(labelInput('Dashboard name'),'new-empty-test');await submit();assert.deepEqual(stored.get('new-empty-test').panels,[]);
    assert.notEqual(stored.get('new-empty-test').id,saved.id);
    await inputValue(labelInput('Saved dashboard'),'new-dashboard-test');
    await click(button('Edit Dashboard'));await click(document.querySelector('.atlas-panel-remove'));assert.equal(cards().length,0);
    await click(button('+ New dashboard'));assert.equal(cards().length,0);await click(button('Cancel'));assert.equal(cards().length,1);assert.equal(document.querySelector('h1').textContent,'new-dashboard-test');
    await ui.act(async()=>root.unmount());root=ui.createRoot(document.getElementById('root'));await mount();await openControls();await inputValue(labelInput('Saved dashboard'),'new-dashboard-test');
    assert.equal(document.querySelector('h1').textContent,'new-dashboard-test');assert.equal(cards().length,1);assert.equal(labelInput('Application').value,'agent_validation');
    assert.deepEqual(stored.get('new-dashboard-test'),saved);assert.notEqual(appTitle,'new-dashboard-test');
  } finally {globalThis.confirm=beforeConfirm;await ui.act(async()=>root.unmount());}
});

test('Save returns to Preview only after success; pending, canceled dialog, duplicate, stale and network failures retain editable draft', async () => {
  const root=ui.createRoot(document.getElementById('root'));
  const fetchBefore=globalThis.fetch;
  const mode=()=>document.querySelector('.atlas-mode').textContent;
  const submit=async()=>{await ui.act(async()=>document.querySelector('.atlas-modal form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));await settle();};
  try {
    await ui.act(async()=>root.render(ui.createElement(ui.DashboardPage)));await settle();
    await click(button('Edit Dashboard'));await click(button('Save'));assert.equal(mode(),'EDIT MODE');
    await click(button('Cancel',document.querySelector('.atlas-modal')));assert.equal(mode(),'EDIT MODE');assert.ok(document.querySelector('[aria-label="Panel properties"]'));
    await click(button('Save'));await inputValue(labelInput('Dashboard name'),'save-preview-test');
    let release;saveBarrier=new Promise(resolve=>{release=resolve;});const before=saveCount;
    await submit();await submit();assert.equal(saveCount,before+1,'Repeated pending submits are locked');assert.equal(mode(),'EDIT MODE');assert.ok(document.querySelector('.atlas-workspace-body').hasAttribute('inert'));
    await ui.act(async()=>{release();saveBarrier=null;});await settle();
    assert.equal(mode(),'PREVIEW');assert.equal(document.querySelector('.atlas-modal'),null);assert.equal(document.querySelector('[aria-label="Panel properties"]'),null);assert.equal(document.querySelector('.atlas-panel-library'),null);
    const saved=structuredClone(stored.get('save-preview-test'));
    await click(button('Edit Dashboard'));await click(button('Dashboard settings'));await inputValue(labelInput('Title'),'Pending draft title');
    for(const failure of ['stale','network']) {
      globalThis.fetch=async(url,init={})=>init.method==='PUT'?(failure==='stale'?new Response(JSON.stringify({detail:{message:'Dashboard changed. Reload before saving.'}}),{status:412}):Promise.reject(new Error('Network unavailable'))):fetchBefore(url,init);
      await click(button('Save'));assert.equal(mode(),'EDIT MODE');assert.equal(document.querySelector('h1').textContent,'Pending draft title');assert.match(document.querySelector('.atlas-status').textContent,/Save failed:/);assert.deepEqual(stored.get('save-preview-test'),saved);assert.equal(button('Save').disabled,false);
    }
    globalThis.fetch=fetchBefore;
    await click(button('Save As'));await inputValue(labelInput('Dashboard name'),'save-preview-test');await submit();assert.equal(mode(),'EDIT MODE');assert.match(document.querySelector('.atlas-modal [role="alert"]').textContent,/Already exists/);assert.deepEqual(stored.get('save-preview-test'),saved);
    await click(button('Cancel',document.querySelector('.atlas-modal')));assert.equal(mode(),'EDIT MODE');assert.equal(document.querySelector('h1').textContent,'Pending draft title');
    await click(button('Save'));assert.equal(mode(),'PREVIEW');assert.equal(stored.get('save-preview-test').title,'Pending draft title');assert.equal(document.querySelector('.atlas-workspace-title').textContent.includes('Unsaved'),false);
    await click(button('Edit Dashboard'));await click(button('Dashboard settings'));await inputValue(labelInput('Title'),'Unsaved next edit');await click(button('Cancel'));assert.equal(document.querySelector('h1').textContent,'Pending draft title');assert.equal(mode(),'PREVIEW');
  } finally {globalThis.fetch=fetchBefore;saveBarrier=null;await ui.act(async()=>root.unmount());}
});
