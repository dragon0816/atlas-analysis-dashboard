import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';
const directory=await mkdtemp(join(tmpdir(),'atlas-3d-ui-')); after(()=>rm(directory,{recursive:true,force:true}));
const dataset = { kind: 'graph', nodes: Array.from({length: 25}, (_,i) => ({id:`n${i}`, label:`Node ${i}`, community:`g${i%5}`, group:`type${i%3}`, size: i%4})), edges: Array.from({length:20}, (_,i) => ({id:`e${i}`,source:`n${i}`,target:`n${i+5}`,type:'link'})) };
// React integration uses a renderer double: this is lifecycle/state coverage, not a GPU/browser test.
const bootstrap=new JSDOM('<body></body>');globalThis.window=bootstrap.window;globalThis.document=bootstrap.window.document;
const OriginalChannel=globalThis.MessageChannel,channels=[];globalThis.MessageChannel=class extends OriginalChannel{constructor(){super();channels.push(this);}};
after(()=>{bootstrap.window.close();for(const c of channels){c.port1.close();c.port2.close();}globalThis.MessageChannel=OriginalChannel;delete globalThis.window;delete globalThis.document;});
await build({stdin:{contents:`export {NetworkGraphPanel} from './src/components/panels/NetworkGraphPanel';export {createElement,act,StrictMode} from 'react';export {createRoot} from 'react-dom/client';`,resolveDir:process.cwd()},bundle:true,platform:'node',format:'cjs',outfile:join(directory,'graph-view.cjs'),plugins:[{name:'mock-renderer-boundary',setup(build){build.onResolve({filter:/graph3DRenderer$/},()=>({path:'renderer-double',namespace:'double'}));build.onLoad({filter:/.*/,namespace:'double'},()=>({contents:`export function createGraph3D(host,options,unavailable){if(globalThis.__fail3D)throw new Error('No WebGL');const record={options,disposed:0,zoom:0,focus:[],unavailable};globalThis.__3DInstances.push(record);return {update(next){record.options=next;},dispose(){record.disposed++;},fit(){record.fit=true;},zoom(){record.zoom++;},focus(id){record.focus.push(id);}};}`,loader:'js'}));}}]});
globalThis.window=bootstrap.window;globalThis.document=bootstrap.window.document;
const {NetworkGraphPanel,createElement,act,StrictMode,createRoot}=(await import(pathToFileURL(join(directory,'graph-view.cjs')).href)).default;
test('2D/3D toggles preserve filters, selection, path and 2D camera; accessible events and repeated cleanup work',async()=>{
 const dom=new JSDOM('<div id="root"></div>',{pretendToBeVisual:true,url:'http://localhost/'}),keys=['window','document','HTMLElement','Element','SVGElement','Event','MouseEvent','KeyboardEvent','IS_REACT_ACT_ENVIRONMENT'];
 const before=new Map(keys.map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)]));for(const k of keys)Object.defineProperty(globalThis,k,{configurable:true,writable:true,value:k==='IS_REACT_ACT_ENVIRONMENT'?true:dom.window[k]});
 const host=document.getElementById('root'),root=createRoot(host),events=[];globalThis.__3DInstances=[];
 const panel={id:'g',title:'Graph',type:'network',mapping:{},display:{},layout:{x:0,y:0,w:8,h:4},datasource:{id:'g'},transform:[]};
 const click=async text=>act(async()=>[...host.querySelectorAll('button')].find(b=>b.textContent===text).click());
 const change=async(el,value)=>{const proto=el.tagName==='SELECT'?dom.window.HTMLSelectElement.prototype:dom.window.HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(el,value);await act(async()=>el.dispatchEvent(new dom.window.Event(el.tagName==='SELECT'?'change':'input',{bubbles:true})));};
 try{
  await act(async()=>root.render(createElement(StrictMode,null,createElement(NetworkGraphPanel,{dataset,panel,onEvent:e=>events.push(e)}))));
  assert.equal(host.querySelector('[data-graph-dimension="3d"]'),null);
  await click('+');const transform=host.querySelector('svg > g').getAttribute('transform');
  await change(host.querySelector('[aria-label="Community filter"]'),'g0');
  await act(async()=>host.querySelector('[data-node-id="n0"]').dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Enter',bubbles:true})));
  await change(host.querySelector('[aria-label="Highlight path to node"]'),'n5');
  await click('3D');assert.ok(host.querySelector('[data-graph-dimension="3d"]'));
  const record=globalThis.__3DInstances.at(-1);assert.equal(record.options.visible.nodes.length,5);assert.equal(record.options.selected,'n0');assert.ok(record.options.pathNodes.has('n5'));
  await change(host.querySelector('[aria-label="Search nodes"]'),'Node 5');await act(async()=>host.querySelector('[aria-label="Search nodes"]').dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Enter',bubbles:true})));assert.deepEqual(record.focus,['n5']);
  await click('+');assert.equal(record.zoom,1);
  const edgeSelect=host.querySelector('[aria-label="3D accessible edge selection"]');await change(edgeSelect,'e0');assert.equal(edgeSelect.value,'e0');await change(edgeSelect,'e5');assert.equal(edgeSelect.value,'e5');assert.equal(events.at(-1).entity,'edge');
  await click('2D');assert.equal(record.disposed,1);assert.equal(host.querySelector('svg > g').getAttribute('transform'),transform);assert.equal(host.querySelector('[aria-label="Community filter"]').value,'g0');
  await click('3D');const record2=globalThis.__3DInstances.at(-1);assert.notEqual(record2,record);await act(async()=>record2.unavailable());assert.equal(record2.disposed,1);assert.ok(host.querySelector('svg'));assert.match(host.textContent,/Returned to 2D/);
  globalThis.__fail3D=true;await click('3D');assert.ok(host.querySelector('svg'));assert.match(host.textContent,/WebGL 2/);globalThis.__fail3D=false;
  await click('3D');const record3=globalThis.__3DInstances.at(-1);await act(async()=>root.unmount());assert.equal(record3.disposed,1);
 }finally{await act(async()=>root.unmount());dom.window.close();delete globalThis.__3DInstances;delete globalThis.__fail3D;for(const[k,v]of before)v?Object.defineProperty(globalThis,k,v):delete globalThis[k];}
});

test('real synthetic scenarios switch in both dimensions without mutating configurations; graph filters and selection reset',async()=>{
 const {readFile}=await import('node:fs/promises');const raw=JSON.parse(await readFile(new URL('../../applications/rs_knowledge/data/graph_comparison.json',import.meta.url),'utf8'));
 const comparison={kind:'graph',...raw};
 const dom=new JSDOM('<div id="root"></div>',{pretendToBeVisual:true,url:'http://localhost/'}),keys=['window','document','HTMLElement','Element','SVGElement','Event','MouseEvent','KeyboardEvent','IS_REACT_ACT_ENVIRONMENT'];
 const before=new Map(keys.map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)]));for(const k of keys)Object.defineProperty(globalThis,k,{configurable:true,writable:true,value:k==='IS_REACT_ACT_ENVIRONMENT'?true:dom.window[k]});
 const host=document.getElementById('root'),root=createRoot(host);globalThis.__3DInstances=[];
 const panel={id:'g',title:'Graph',type:'network',mapping:{},display:{maxNodes:250,maxEdges:500},layout:{x:0,y:0,w:8,h:4},datasource:{id:'knowledge.graph'},transform:[]};const snapshot=JSON.stringify(panel);
 const click=async text=>act(async()=>[...host.querySelectorAll('button')].find(b=>b.textContent===text).click());
 const change=async(label,value)=>{const el=host.querySelector(`[aria-label="${label}"]`);await act(async()=>{Object.getOwnPropertyDescriptor(dom.window.HTMLSelectElement.prototype,'value').set.call(el,value);el.dispatchEvent(new dom.window.Event('change',{bubbles:true}));});};
 try{
  await act(async()=>root.render(createElement(NetworkGraphPanel,{dataset:comparison,panel})));
  assert.equal(host.querySelector('[aria-label="Synthetic graph scenario"]').value,'connected');assert.equal(host.querySelector('[aria-label="Graph layout"]').value,'topology');assert.equal(host.querySelectorAll('[data-node-id]').length,67);assert.match(host.textContent,/138 cross-region/);
  await act(async()=>host.querySelector('[data-node-id="connected:cal"]').dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Enter',bubbles:true})));assert.match(host.textContent,/Domains: AI, Automotive/);
  await change('Highlight path to node','connected:a0');await click('3D');const record=globalThis.__3DInstances.at(-1);assert.equal(record.options.layoutMode,'topology');assert.ok(record.options.pathNodes.size>1);
  await change('Graph layout','grouped');assert.equal(record.options.layoutMode,'grouped');
  await change('Synthetic graph scenario','sparse');assert.equal(record.options.model.nodes.length,140);assert.equal(record.options.selected,null);assert.equal(record.options.pathNodes.size,0);assert.equal(record.options.layoutMode,'grouped');
  await change('Community filter','AI');assert.ok(record.options.visible.nodes.every(n=>n.community==='AI'));
  await change('Synthetic graph scenario','connected');assert.equal(host.querySelector('[aria-label="Community filter"]').value,'');assert.equal(record.options.model.nodes.length,67);assert.equal(record.options.layoutMode,'topology');
  await click('2D');assert.equal(host.querySelectorAll('[data-node-id]').length,67);assert.equal(host.querySelectorAll('[data-region-id]').length,6);assert.equal(JSON.stringify(panel),snapshot);
 }finally{await act(async()=>root.unmount());dom.window.close();delete globalThis.__3DInstances;for(const[k,v]of before)v?Object.defineProperty(globalThis,k,v):delete globalThis[k];}
});
