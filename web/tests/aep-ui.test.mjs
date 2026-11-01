import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';
const directory=await mkdtemp(join(tmpdir(),'atlas-aep-ui-'));
const dom=new JSDOM('<!doctype html><div id="root"></div>',{url:'http://127.0.0.1:8127'});
for(const key of ['window','document','HTMLElement','Event','MouseEvent','Node'])globalThis[key]=dom.window[key];
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const NativeMessageChannel=globalThis.MessageChannel,channels=[];
globalThis.MessageChannel=class extends NativeMessageChannel{constructor(){super();channels.push(this);}};
after(async()=>{dom.window.close();for(const channel of channels){channel.port1.close();channel.port2.close();}globalThis.MessageChannel=NativeMessageChannel;await rm(directory,{recursive:true,force:true});});
await build({stdin:{contents:`export {NestedTimeline} from './src/components/aep/NestedTimeline'; export {AepControls} from './src/components/aep/AepControls'; export {BiControls} from './src/components/aep/BiControls'; export {createElement,act,StrictMode} from 'react'; export {createRoot} from 'react-dom/client';`,resolveDir:process.cwd()},bundle:true,platform:'node',format:'cjs',outfile:join(directory,'ui.cjs')});
const ui=(await import(pathToFileURL(join(directory,'ui.cjs')).href)).default;
test('nested timeline exposes open/missing spans and keyboard-accessible details',async()=>{
  const root=ui.createRoot(document.getElementById('root')),events=[];
  const dataset={kind:'table',fields:[],meta:{warnings:[],truncated:false,sourceRows:2},rows:[{run_id:'r',span_id:'parent',label:'Parent',depth:0,start:'2026-10-10T00:00:00Z',end:null,open:true,duration_ms:null},{run_id:'r',span_id:'child',label:'Child',depth:1,start:null,end:'2026-10-10T00:00:02Z',missing_start:true,missing_parent:true,duration_ms:20}]};
  await ui.act(async()=>root.render(ui.createElement(ui.NestedTimeline,{dataset,panel:{},onEvent:e=>events.push(e)})));
  const buttons=document.querySelectorAll('button');assert.equal(buttons.length,2);assert.match(buttons[0].textContent,/open.*duration unknown/);assert.match(buttons[1].textContent,/missing start.*missing parent/);assert.equal(buttons[1].querySelector('span').style.paddingLeft,'12px');
  await ui.act(async()=>buttons[1].click());assert.equal(events[0].values.span_id,'child');await ui.act(async()=>root.unmount());
});
test('controls switch recent window and import JSONL without sending its contents to the server',async()=>{
  const root=ui.createRoot(document.getElementById('root')),calls=[],ranges=[];
  const provider={setLive:value=>calls.push(['live',value]),useServer:()=>calls.push(['server']),importJSONL:text=>{calls.push(['import',text]);return {events:1,warnings:[]};}};
  await ui.act(async()=>root.render(ui.createElement(ui.StrictMode,{},ui.createElement(ui.AepControls,{provider,refresh:()=>calls.push(['refresh']),setTimeRange:range=>ranges.push(range)}))));
  const select=document.querySelector('select');await ui.act(async()=>{select.value='15';select.dispatchEvent(new dom.window.Event('change',{bubbles:true}));});assert.equal(ranges.length,1);assert.match(ranges[0],/Z\/$/);
  const input=document.querySelector('input[type="file"]');Object.defineProperty(input,'files',{configurable:true,value:[{size:10,text:async()=>'{"fixture":true}'}]});
  await ui.act(async()=>input.dispatchEvent(new dom.window.Event('change',{bubbles:true})));assert.ok(calls.some(c=>c[0]==='import'));assert.match(document.body.textContent,/Offline replay/);assert.equal(document.querySelector('input[type="checkbox"]').disabled,true);
  await ui.act(async()=>root.unmount());
});
test('BI controls load published vaults and expose bool/date parameters without replacing a saved layout', async () => {
  const root=ui.createRoot(document.getElementById('root')), boards=[], changes=[];
  const catalog={vault:'v',version:{tag:'v1',commit:'c'},order:['counts'],analyses:[{slug:'counts',title:'Counts',chart:{type:'table'},params:{sample:{type:'bool',default:false},today:{type:'date',default:'2026-11-01'}}}]};
  const provider={health:async()=>({state:'ready'}),vaults:async()=>({state:'ready',data:{vaults:[{id:'v',title:'Fixture vault'}]}}),analyses:async()=>({state:'ready',data:catalog})};
  const board={schemaVersion:2,id:'personal',applicationId:'aep_bi',title:'Saved',variables:[],values:{'bi:vault':'v'},panels:[{id:'kept',layout:{x:2,y:3,w:4,h:5}}]};
  await ui.act(async()=>root.render(ui.createElement(ui.StrictMode,{},ui.createElement(ui.BiControls,{provider,board,values:board.values,disabled:false,onBoard:value=>boards.push(value),onValue:(id,value)=>changes.push([id,value])}))));
  assert.match(document.body.textContent,/Fixture vault/); assert.equal(boards.length,0); assert.equal(document.querySelector('input[type="date"]').value,'2026-11-01');
  await ui.act(async()=>document.querySelector('input[type="checkbox"]').click()); assert.equal(changes[0][1],true);
  await ui.act(async()=>root.unmount());
});

test('BI enum controls offer exactly producer choices, select defaults and emit namespaced changes', async () => {
  const root = ui.createRoot(document.getElementById('root')), changes = [];
  const choices = ['wireless', 'AIDC', 'robotics', 'mobile', 'aerospace'];
  const catalog = { vault: 'v', order: ['counts'], analyses: [{ slug: 'counts', title: 'Counts', params: { domain: { type: 'enum', default: 'robotics', values_from: 'Account.domain', values: choices } } }] };
  const provider = { health: async () => ({ state: 'ready' }), vaults: async () => ({ state: 'ready', data: { vaults: [{ id: 'v', title: 'Vault' }] } }), analyses: async () => ({ state: 'ready', data: catalog }) };
  const board = { panels: [{ id: 'saved' }], values: { 'bi:vault': 'v' } };
  const props = { provider, board, values: board.values, disabled: false, onBoard: () => assert.fail('Saved layout replaced'), onValue: (id, value) => changes.push([id, value]) };
  try {
    await ui.act(async () => root.render(ui.createElement(ui.BiControls, props)));
    const select = [...document.querySelectorAll('label')].find(label => label.textContent.includes('Counts · domain')).querySelector('select');
    assert.equal(select.disabled, false);
    assert.equal(select.value, 'robotics');
    assert.deepEqual([...select.options].map(option => option.value), choices);
    assert.deepEqual([...select.options].map(option => option.textContent), choices);
    await ui.act(async () => { select.value = 'wireless'; select.dispatchEvent(new dom.window.Event('change', { bubbles: true })); });
    assert.equal(changes.length, 1);
    assert.equal(changes[0][1], 'wireless');
    const id = changes[0][0];
    assert.equal(id, 'bi.63-6f-75-6e-74-73.64-6f-6d-61-69-6e');
    await ui.act(async () => root.render(ui.createElement(ui.BiControls, { ...props, values: { ...board.values, [id]: 'AIDC' }, disabled: true })));
    assert.equal(select.value, 'AIDC');
    assert.equal(select.disabled, true);
    assert.deepEqual([...select.options].map(option => option.value), choices);
  } finally { await ui.act(async () => root.unmount()); }
});
