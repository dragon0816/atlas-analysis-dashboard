import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDataset, normalizeTable, normalizeGraph, parseCSV } from '../src/platform/dataset.ts';
import { executePipeline } from '../src/platform/transforms.ts';
import { PlatformRuntime } from '../src/platform/runtime.ts';
import { SourceRegistry, sourceURL } from '../src/platform/sources.ts';
import { parseDashboardDocument, validateDashboardDocument } from '../src/platform/documents.ts';
const meta = () => ({warnings:[],truncated:false,sourceRows:0});
const panel = (id='rows', transform=[]) => ({id:'p',title:'P',type:'table',datasource:{id},transform,mapping:{},display:{},layout:{x:0,y:0,w:6,h:8}});
const app = (sources, transforms={}) => ({id:'generic',name:'Generic',sources,transforms,dashboards:[]});
const board = () => ({schemaVersion:2,id:'d',title:'D',applicationId:'generic',variables:[],panels:[panel()]});
const sleep = ms => new Promise(resolve=>setTimeout(resolve,ms));

test('normalization preserves schema, null/NaN, metadata and generic units/limits', () => {
  const data=normalizeTable([{value:'1',valid:'true'},{value:'bad',valid:'false'},{value:NaN}],{fields:[{name:'value',type:'number',unit:'units',limits:{lower:0,upper:3}},{name:'valid',type:'boolean'}]});
  assert.deepEqual(data.rows.map(r=>r.value),[1,null,null]);
  assert.deepEqual(data.rows.map(r=>r.valid),[true,false,null]);
  assert.equal(data.meta.warnings.length,1);
  assert.equal(data.fields[0].unit,'units'); assert.deepEqual(data.fields[0].limits,{lower:0,upper:3});
  assert.equal(normalizeTable([{x:1},{x:'a'}]).fields[0].type,'other');
  assert.equal(normalizeTable([],{fields:[{name:'n',type:'number'}]}).fields[0].name,'n');
  assert.throws(()=>normalizeTable([1]),/object/);
  assert.equal(normalizeTable([{x:1},{x:2}],{maxRows:1}).meta.truncated,true);
});

test('CSV supports quoted commas, escaped quotes, multiline, BOM and rejects malformed input', () => {
  assert.deepEqual(parseCSV('\ufeffname,note\r\n"a,b","say ""hi""\nnow"\r\n'),[{name:'a,b',note:'say "hi"\nnow'}]);
  assert.throws(()=>parseCSV('a,a\n1,2'),/unique/);
  assert.throws(()=>parseCSV('a,b\n1'),/column count/);
  assert.throws(()=>parseCSV('a\n"x'),/Unterminated/);
  assert.throws(()=>parseCSV('a\n"x"z'),/quoting/);
  assert.equal(normalizeTable(parseCSV('a\n1\n2\n3',1)).kind,'table');
});

test('graph normalization rejects duplicate ids, drops dangling edges and bounds expansion', () => {
  const graph=normalizeGraph({nodes:[{id:1},{id:2},{id:3}],edges:[{source:1,target:2},{source:2,target:9}]},{maxRows:2});
  assert.equal(graph.nodes[0].id,'1'); assert.equal(graph.edges.length,1); assert.equal(graph.meta.truncated,true); assert.match(graph.meta.warnings.join(),/dangling/);
  assert.throws(()=>normalizeGraph({nodes:[{id:'a'},{id:'a'}],edges:[]}),/Duplicate/);
});

test('ordered filter normalize join aggregate calculate sort limit composes without eval', async () => {
  const data=normalizeTable([{id:'a',group:'x',v:'2'},{id:'a',group:'x',v:'4'},{id:'b',group:'y',v:'9'}]);
  const out=await executePipeline(data,[
    {op:'filter',field:'group',operator:'eq',value:'$group'},
    {op:'normalize',fields:{v:'number'}},
    {op:'join',source:'weights',on:{left:'id',right:'id'}},
    {op:'calculate',as:'weighted',fn:'scale',from:['v'],factor:2},
    {op:'aggregate',by:['group'],metrics:[{field:'weighted',function:'mean',as:'average'},{function:'count',as:'n'}]},
    {op:'sort',by:'average',desc:true},{op:'limit',n:1},
  ],{variables:{group:'x'},getSource:async()=>normalizeTable([{id:'a',weight:5}])});
  assert.deepEqual(out.rows,[{group:'x',average:6,n:2}]);
  await assert.rejects(()=>executePipeline(data,[{op:'calculate',as:'bad',fn:'eval',from:['v']}]),/Unsupported/);
  await assert.rejects(()=>executePipeline(data,[{op:'sort',by:'missing'}]),/unavailable/);
  await assert.rejects(()=>executePipeline(data,[{op:'ref',id:'a'}],{transforms:{a:[{op:'ref',id:'a'}]}}),/Cyclic/);
});

test('null arithmetic, aggregate types, mixed units, output names and bounds are explicit', async () => {
  const data=normalizeTable([{a:2,b:0},{a:null,b:2},{a:4,b:2}]);
  const out=await executePipeline(data,[{op:'derive',as:'r',fn:'ratio',from:['a','b']}]);
  assert.deepEqual(out.rows.map(r=>r.r),[null,null,2]);
  const empty=await executePipeline(normalizeTable([]),[{op:'aggregate',by:[],metrics:[{function:'count',as:'count'}]}]); assert.equal(empty.rows[0].count,0);
  await assert.rejects(()=>executePipeline(normalizeTable([{value:1,unit:'dB'},{value:2,unit:'%'}]),[{op:'group',by:[],metrics:[{field:'value',op:'mean',as:'m'}]}]),/Mixed units/);
  const joined=await executePipeline(normalizeTable([{id:1},{id:1},{id:1}]),[{op:'join',source:'r',on:'id'}],{maxRows:2,getSource:async()=>normalizeTable([{id:1},{id:1}])});
  assert.equal(joined.rows.length,2); assert.equal(joined.meta.truncated,true); assert.equal(joined.rows[0]['right.id'],1);
  await assert.rejects(()=>executePipeline(normalizeTable([{id:1,'right.id':2}]),[{op:'join',source:'r',on:'id'}],{getSource:async()=>normalizeTable([{id:1}])}),/collision/);
  const abort=new AbortController(); abort.abort(); await assert.rejects(()=>executePipeline(data,[],{signal:abort.signal}),{name:'AbortError'});
});

test('shared source fetches are cached; one consumer abort does not cancel another', async () => {
  let calls=0, transportAborted=false;
  const registry=new SourceRegistry(app({rows:{type:'rest',url:'https://example.test/data'}}),{fetch:async(_url,{signal})=>{calls++;signal.addEventListener('abort',()=>transportAborted=true);await sleep(15);return new Response('[{"x":1}]');}});
  const a=new AbortController(), first=registry.query('rows',{},a.signal), second=registry.query('rows');a.abort();
  await assert.rejects(first,{name:'AbortError'});assert.equal((await second).rows[0].x,1);assert.equal(calls,1);assert.equal(transportAborted,false);
  await registry.query('rows');assert.equal(calls,1);registry.dispose();
});

test('REST bounded payloads, URL safety, and unknown providers fail clearly', async () => {
  assert.throws(()=>sourceURL('file:///tmp/data'),/protocol/);assert.throws(()=>sourceURL('https://a:b@example.test'),/credentials/);assert.throws(()=>sourceURL('https://example.test?token=abc'),/secrets/);
  const source=new SourceRegistry(app({rows:{type:'rest',url:'/data'}}),{maxBytes:4,fetch:async()=>new Response('[{"a":1}]')});
  await assert.rejects(()=>source.query('rows'),/size limit/);source.dispose();
  const missing=new SourceRegistry(app({rows:{type:'custom',provider:'missing'}}));await assert.rejects(()=>missing.query('rows'),/Unknown custom provider/);missing.dispose();
});

test('application bindings and transform variables filter table and graph consistently', async () => {
  const graph={nodes:[{id:'a',market:'US'},{id:'b',market:'EU'},{id:'c',market:'US'}],edges:[{source:'a',target:'b'},{source:'a',target:'c'}]};
  const runtime=new PlatformRuntime(app({rows:{type:'json',data:[{market:'US',n:2},{market:'EU',n:5}],bindings:{market:'market'}},graph:{type:'json',format:'graph',data:graph,bindings:{market:'market'}}}));
  assert.equal((await runtime.query(panel(),{market:'US'})).rows.length,1);
  assert.equal((await runtime.query(panel(),{market:'*'})).rows.length,2);
  const g=await runtime.query(panel('graph'),{market:'US'});assert.equal(g.nodes.length,2);assert.equal(g.edges.length,1);
  assert.equal((await runtime.query(panel('rows',[{op:'filter',field:'market',operator:'eq',value:'$market'}]),{market:'EU'})).rows[0].n,5);
  runtime.dispose();await assert.rejects(()=>runtime.query(panel()),/disposed/);
});

test('WebSocket panels share one connection and release it after unsubscribe', async () => {
  const sockets=[];
  const runtime=new PlatformRuntime(app({live:{type:'websocket',url:'wss://example.test/live'}}),{websocket:()=>{const s={close(){this.closed=true;},closed:false};sockets.push(s);return s;}});
  const first=[],second=[];
  const stop1=runtime.subscribe(panel('live'),{}, {next:v=>first.push(v),error:e=>{throw e;}});
  const stop2=runtime.subscribe(panel('live'),{}, {next:v=>second.push(v),error:e=>{throw e;}});
  assert.equal(sockets.length,1);sockets[0].onmessage({data:'[{"v":3}]'});await sleep(0);assert.equal(first[0].rows[0].v,3);assert.equal(second[0].rows[0].v,3);
  stop1();await sleep(120);assert.equal(sockets[0].closed,false);stop2();await sleep(120);assert.equal(sockets[0].closed,true);runtime.dispose();
});

test('v2 documents round trip metadata and reject unsupported schemas', () => {
  const valid=board();valid.customMetadata={owner:'lab'};assert.deepEqual(parseDashboardDocument(valid),valid);
  const empty=board();empty.panels=[];validateDashboardDocument(empty);
  for (const change of [b=>b.panels[0].layout.w=0,b=>b.panels[0].mapping.x=3,b=>b.panels[0].datasource.url='https://x',b=>b.panels.push({...b.panels[0]}),b=>b.panels[0].transform=[{op:'eval'}],b=>b.values={x:Infinity}]) {const b=board();change(b);assert.throws(()=>validateDashboardDocument(b));}
  assert.throws(()=>parseDashboardDocument({schemaVersion:1,panels:[]}),/schemaVersion/);
});

test('immediate retry after sole consumer abort starts a fresh shared request', async () => {
  let calls=0;
  const registry=new SourceRegistry(app({rows:{type:'rest',url:'/data'}}),{fetch:async(_url,{signal})=>{
    const call=++calls;
    return new Promise((resolve,reject)=>{const timer=setTimeout(()=>resolve(new Response(JSON.stringify([{call}]))),15);signal.addEventListener('abort',()=>{clearTimeout(timer);reject(signal.reason);},{once:true});});
  }});
  const abort=new AbortController();const first=registry.query('rows',{},abort.signal);abort.abort();
  const second=registry.query('rows');await assert.rejects(first,{name:'AbortError'});assert.equal((await second).rows[0].call,2);assert.equal(calls,2);registry.dispose();
});

test('source default query is applied before panel pipeline and explicit invalidation refreshes', async () => {
  let calls=0;
  const runtime=new PlatformRuntime(app({rows:{type:'rest',url:'/data',query:{filter:{market:'US'}}}}),{fetch:async()=>{calls++;return new Response('[{"market":"US","v":1},{"market":"EU","v":2}]');}});
  assert.equal((await runtime.query(panel())).rows.length,1);await runtime.query(panel());assert.equal(calls,1);
  runtime.invalidate('rows');await runtime.query(panel());assert.equal(calls,2);
  const overriding={...panel(),query:{filter:{market:'EU'}}};assert.equal((await runtime.query(overriding)).rows[0].v,2);runtime.dispose();
});

test('custom adapters are registerable and timeout even if a provider ignores cancellation', async () => {
  const registry=new SourceRegistry(app({rows:{type:'custom',provider:'local'}}),{timeoutMs:15});
  let disposed=false;registry.registerProvider('local',{query:async()=>new Promise(()=>{}),dispose:()=>disposed=true});
  await assert.rejects(()=>registry.query('rows'),/timed out/);registry.dispose();assert.equal(disposed,true);
  const ok=new SourceRegistry(app({rows:{type:'custom',provider:'local'}}),{providers:{local:{query:async()=>({kind:'table',rows:[{x:2}],fields:[{name:'x',type:'number',unit:'Hz'}],meta:{warnings:['Simulated'],truncated:true,sourceRows:42}})}}});
  const data=await ok.query('rows');assert.equal(data.fields[0].unit,'Hz');assert.equal(data.meta.sourceRows,42);assert.equal(data.meta.truncated,true);assert.deepEqual(data.meta.warnings,['Simulated']);ok.dispose();
});

test('literal null filters match null while unset variable placeholders remain unfiltered', async () => {
  const data=normalizeTable([{x:null},{x:1}]);
  assert.deepEqual((await executePipeline(data,[{op:'filter',field:'x',operator:'eq',value:null}])).rows,[{x:null}]);
  assert.equal((await executePipeline(data,[{op:'filter',field:'x',operator:'eq',value:'$x'}],{variables:{x:null}})).rows.length,2);
});

test('invalidation and polling never abort independent active query keys', async () => {
  let calls=0,aborted=0;
  const registry=new SourceRegistry(app({rows:{type:'custom',provider:'local',refresh:.01}}),{providers:{local:{query:async(_definition,_query,signal)=>new Promise((resolve,reject)=>{
    calls++;const timer=setTimeout(()=>resolve([{v:1}]),50);signal.addEventListener('abort',()=>{aborted++;clearTimeout(timer);reject(signal.reason);},{once:true});
  })}}});
  const first=registry.query('rows',{k:1});registry.invalidate('rows');const second=registry.query('rows',{k:2});registry.invalidate('rows');
  assert.equal((await first).rows[0].v,1);assert.equal((await second).rows[0].v,1);assert.equal(aborted,0);
  const errors=[],values=[];
  const a=registry.subscribe('rows',{k:1},{next:v=>values.push(v),error:e=>errors.push(e)}), b=registry.subscribe('rows',{k:2},{next:v=>values.push(v),error:e=>errors.push(e)});
  await sleep(340);assert.ok(values.length>=2);assert.equal(errors.length,0);assert.equal(aborted,0);assert.ok(calls>=4);a();b();registry.dispose();
});

test('normalize cap keeps truncation metadata and validates limits/field types', async () => {
  const data=normalizeTable([{v:'1'},{v:'2'},{v:'3'}]);
  const out=await executePipeline(data,[{op:'normalize',fields:{v:'number'}}],{maxRows:1});
  assert.equal(out.rows.length,1);assert.equal(out.meta.truncated,true);assert.equal(out.meta.sourceRows,3);assert.match(out.meta.warnings.join(),/capped/);
  assert.throws(()=>normalizeTable([{v:1}],{fields:[{name:'v',type:'number',limits:{lower:0,upper:NaN}}]}),/limits/);
});

test('custom graph identity fields survive normalization and variable/limit filtering', async () => {
  const raw={nodes:[{key:'a',market:'US'},{key:'b',market:'EU'},{key:'c',market:'US'}],edges:[{from:'a',to:'b'},{from:'a',to:'c'}]};
  const runtime=new PlatformRuntime(app({rows:{type:'json',format:'graph',data:raw,bindings:{market:'market'}}}));
  const mapped={...panel(),mapping:{nodeId:'key',edgeSource:'from',edgeTarget:'to'}};
  const data=await runtime.query(mapped,{market:'US'});assert.deepEqual(data.nodes.map(n=>n.key),['a','c']);assert.deepEqual(data.edges,[{from:'a',to:'c'}]);
  const limited=await runtime.query({...mapped,transform:[{op:'limit',n:1}]},{market:'US'});assert.equal(limited.nodes.length,1);assert.equal(limited.edges.length,0);runtime.dispose();
});

test('source default query variables resolve for both base and join sources', async () => {
  const runtime=new PlatformRuntime(app({rows:{type:'json',data:[{id:1,n:1},{id:2,n:2}],query:{filter:{n:'$n'}}},joined:{type:'json',data:[{id:1,label:'selected'},{id:2,label:'other'}],query:{filter:{id:'$n'}}}}));
  const data=await runtime.query(panel('rows',[{op:'join',source:'joined',on:'id'}]),{n:1});
  assert.equal(data.rows.length,1);assert.equal(data.rows[0].label,'selected');runtime.dispose();
});

test('disposing a runtime suppresses already queued live pipeline notifications', async () => {
  let socket;const runtime=new PlatformRuntime(app({rows:{type:'websocket',url:'wss://example.test/live'}}),{websocket:()=>socket={close(){}}});
  const output=[];runtime.subscribe(panel(),{}, {next:v=>output.push(v),error:e=>output.push(e)});socket.onmessage({data:'[{"v":1}]'});runtime.dispose();await sleep(0);assert.deepEqual(output,[]);
});


test('time_range variables apply inclusive ISO intervals with open endpoints', async () => {
  const runtime=new PlatformRuntime(app({rows:{type:'json',data:[{started:'2026-10-01T00:00:00Z'},{started:'2026-10-02T00:00:00Z'},{started:'2026-10-03T00:00:00Z'},{started:null}],bindings:{started:'window'}}}),{variableDefinitions:[{id:'window',type:'time_range'}]});
  assert.equal((await runtime.query(panel(),{window:'2026-10-01/2026-10-02'})).rows.length,2);
  assert.equal((await runtime.query(panel(),{window:'/2026-10-01'})).rows.length,1);
  assert.equal((await runtime.query(panel(),{window:'2026-10-03/'})).rows.length,1);
  assert.equal((await runtime.query(panel(),{window:'/'})).rows.length,4);
  await assert.rejects(()=>runtime.query(panel(),{window:'2026-10-03/2026-10-01'}),/start must not follow/);
  await assert.rejects(()=>runtime.query(panel(),{window:'not-a-date/'}),/ISO dates/);runtime.dispose();
});

test('explicit join prefix namespaces every right field, not just collisions', async () => {
  const data=await executePipeline(normalizeTable([{id:1,value:3}]),[{op:'join',source:'r',on:'id',prefix:'budget_'}],{getSource:async()=>normalizeTable([{id:1,budget_ms:5}])});
  assert.deepEqual(data.rows,[{id:1,value:3,budget_id:1,budget_budget_ms:5}]);
});

test('panel identity mappings do not lose edges when canonical-looking metadata also exists', async () => {
  const runtime=new PlatformRuntime(app({rows:{type:'json',format:'graph',data:{nodes:[{id:1,key:'a'},{id:2,key:'b'}],edges:[{source:'a',target:'b'}]}}}));
  const data=await runtime.query({...panel(),mapping:{nodeId:'key'}});assert.equal(data.edges.length,1);assert.equal(data.nodes[0].id,1);runtime.dispose();
});

test('runtime reads edited time variable definitions from the supplied callback', async () => {
  let definitions=[];
  const runtime=new PlatformRuntime(app({rows:{type:'json',data:[{started:'2026-10-01T00:00:00Z'}],bindings:{started:'window'}}}),{variableDefinitions:()=>definitions});
  definitions=[{id:'window',type:'time_range'}];assert.equal((await runtime.query(panel(),{window:'2026-10-01/'})).rows.length,1);runtime.dispose();
});

test('panels with different local filters share the same raw REST snapshot', async () => {
  let calls=0;const runtime=new PlatformRuntime(app({rows:{type:'rest',url:'/data'}}),{fetch:async()=>{calls++;return new Response('[{"market":"US"},{"market":"EU"}]');}});
  const [us,eu]=await Promise.all([runtime.query({...panel(),query:{filter:{market:'US'}}}),runtime.query({...panel(),query:{filter:{market:'EU'}}})]);
  assert.equal(calls,1);assert.equal(us.rows[0].market,'US');assert.equal(eu.rows[0].market,'EU');runtime.dispose();
});

test('unknown source type and invalid source bindings fail before loading', async () => {
  for (const definition of [{type:'script',data:[]},{type:'json',data:[],bindings:{x:4}},{type:'json',data:[],refresh:-1}]) {
    const runtime=new PlatformRuntime(app({rows:definition}));await assert.rejects(()=>runtime.query(panel()));runtime.dispose();
  }
});

test('JSON field names cannot mutate object prototypes during normalization or aggregation', async () => {
  const data=normalizeTable([{n:2}],{fields:[{name:'__proto__',type:'number'}]});assert.equal(Object.hasOwn(data.rows[0],'__proto__'),true);assert.equal(data.rows[0].__proto__,null);assert.equal(Object.getPrototypeOf(data.rows[0]),Object.prototype);
  const out=await executePipeline(normalizeTable([{n:2}]),[{op:'aggregate',by:[],metrics:[{op:'sum',field:'n',as:'__proto__'}]}]);assert.equal(out.rows[0].__proto__,2);assert.equal(Object.getPrototypeOf(out.rows[0]),Object.prototype);
});

test('shared standalone contract fixtures agree on valid and invalid documents', async()=>{
  const {readFile}=await import('node:fs/promises');
  const fixtures=JSON.parse(await readFile(new URL('../../tests/fixtures/dashboard-contract.json',import.meta.url),'utf8'));
  for(const item of fixtures) {
    if(item.valid) assert.doesNotThrow(()=>validateDashboardDocument(item.document),item.name);
    else assert.throws(()=>validateDashboardDocument(item.document),undefined,item.name);
  }
});
