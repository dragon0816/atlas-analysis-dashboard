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
await build({stdin:{contents:`export {DashboardPage} from './src/pages/DashboardPage'; export {StrictMode,createElement,act} from 'react'; export {createRoot} from 'react-dom/client';`,resolveDir:process.cwd()},bundle:true,platform:'node',format:'cjs',loader:{'.css':'empty'},outfile:join(temporary,'ui.cjs'),plugins:[{name:'application-fixtures',setup(build){build.onLoad({filter:/applications\.ts$/},args=>isApplicationModule(args.path)?({contents:`export const applicationPackages=${JSON.stringify(packages)};`,loader:'ts'}):undefined);}}]});
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
    if (dataset.kind === 'graph') assert.equal(dataset.nodes.length, 7);
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
  await click(button('+ New'));assert.equal(document.querySelectorAll('[data-panel-id]').length,0);await click(button('Table',document.querySelector('.atlas-panel-library')));assert.equal(document.querySelectorAll('[data-panel-id]').length,1);await click(button('Cancel'));
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
    await click(cell);assert.equal(labelInput('Market').value,'AI');assert.equal(labelInput('Product').value,'Tester');
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
