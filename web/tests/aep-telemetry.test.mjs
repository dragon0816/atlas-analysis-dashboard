import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventIndex, validateEvent, parseJSONL, derive, quantile } from '../src/platform/aep/events.ts';
import { AepProvider } from '../src/platform/aep/provider.ts';
import { shortestGraphPath, graphPathEdges } from '../src/platform/graphModel.ts';
const event = (sequence, type, attrs = {}, extra = {}) => ({ schema_version:'aep.telemetry.v1', event_id:`event-${sequence}`, run_id:'r1', trace_id:'t1', span_id:'root', parent_span_id:null, sequence, timestamp:`2026-10-10T00:00:${String(sequence).padStart(2,'0')}Z`, event_type:type, state:null, status:type === 'run.started' ? 'started':'succeeded', attributes:attrs, ...extra });
const fixture = () => [
  event(0,'run.started',{strategy_id:'s1',run_kind:'conversation_turn',model_alias:'router'}),
  event(1,'state.entered',{loop_index:1},{span_id:'a',parent_span_id:'root',state:'model',status:'started'}),
  event(2,'llm.completed',{model_alias:'worker',input_tokens:10,output_tokens:5},{span_id:'llm',parent_span_id:'a',state:'model'}),
  event(3,'state.exited',{duration_ms:20},{span_id:'a',parent_span_id:'root',state:'model'}),
  event(4,'state.entered',{loop_index:2},{span_id:'b',parent_span_id:'root',state:'tool',status:'started'}),
  event(5,'tool.completed',{duration_ms:30,failure_code:'fixture_failure'},{span_id:'b',parent_span_id:'root',state:'tool',status:'failed'}),
  event(6,'run.completed',{duration_ms:100,llm_calls:1,token_reports:1}),
];
const indexOf = events => { const index=new EventIndex(); events.forEach(e=>index.add(e)); return index; };
test('schema accepts nullable state and unknown events, rejects malformed envelope',()=>{
  assert.equal(validateEvent(event(0,'future.event',{extra:{safe:true}})).state,null);
  for(const patch of [{schema_version:'aep.telemetry.v2'},{sequence:-1},{timestamp:'2026-10-10'},{state:5},{attributes:[]},{ingest_seq:0},{parent_span_id:undefined}]) assert.throws(()=>validateEvent({...event(0,'x'),...patch}));
});
test('JSONL reports exact bad lines, retains valid records and enforces bounds',()=>{
  const index=parseJSONL('\uFEFF'+JSON.stringify(event(0,'run.started'))+'\nwrong\n'+JSON.stringify({...event(1,'x'),schema_version:'v2'}));
  assert.equal(index.events.size,1); assert.match([...index.warnings].join(' '),/Line 2/); assert.match([...index.warnings].join(' '),/2 invalid lines/);
  assert.throws(()=>parseJSONL('x'.repeat(8*1024*1024+1)),/8 MiB/);
});
test('replay is deterministic for reordered duplicates and rejects conflicting identity',()=>{
  const events=fixture(), ordered=derive(indexOf(events)), reversed=indexOf([...events].reverse().concat(events));
  assert.deepEqual(derive(reversed),ordered); assert.equal(reversed.events.size,events.length);
  assert.throws(()=>reversed.add({...events[0],status:'failed'}),/Conflicting/);
});
test('full run filter retains parents/lifecycle and token coverage',()=>{
  const result=derive(indexOf(fixture()),{model:'worker'});
  assert.equal(result.runs.length,1); assert.equal(result.runs[0].complete,true); assert.equal(result.runs[0].input_tokens,10); assert.equal(result.runs[0].token_coverage,1);
  assert.equal(result.events.length,7); assert.equal(result.spans.find(s=>s.span_id==='llm').depth,2);
  assert.deepEqual(derive(indexOf(fixture()),{model:'absent'}).runs,[]);
});
test('missing events and interrupted runs never invent completion, duration or tokens',()=>{
  const interrupted=derive(indexOf(fixture().slice(0,2)));
  assert.equal(interrupted.runs[0].complete,false); assert.equal(interrupted.runs[0].duration_ms,null); assert.equal(interrupted.runs[0].input_tokens,null);
  assert.equal(interrupted.spans.find(s=>s.span_id==='a').end,null);
  const missing=derive(indexOf(fixture().filter(e=>e.sequence!==2))); assert.equal(missing.runs[0].complete,false); assert.match(missing.warnings.join(' '),/sequence gap/);
});
test('sequence collision is retained and reported rather than silently discarded',()=>{
  const index=indexOf([...fixture(),{...event(2,'unknown'),event_id:'collision'}]);
  assert.equal(index.events.size,8); assert.match(derive(index).warnings.join(' '),/conflicting sequence/);
});
test('transition direction and dwell metrics are based on explicit state entries',()=>{
  const result=derive(indexOf(fixture())); assert.equal(result.transitions.length,1);
  assert.equal(result.transitions[0].source,'model'); assert.equal(result.transitions[0].target,'tool');
  assert.equal(result.state_metrics.find(c=>c.state==='model').dwell_ms,20);
  assert.equal(result.strategy_metrics[0].p95_ms,100);
  const model={nodes:[{id:'a'},{id:'b'}],edges:[{id:'ab',source:'a',target:'b'},{id:'ba',source:'b',target:'a'}]};
  assert.deepEqual([...graphPathEdges(model,['a','b'],true)],['ab']);
  assert.deepEqual(shortestGraphPath({...model,edges:[model.edges[0]]},'b','a',true),[]);
  assert.deepEqual(shortestGraphPath({...model,edges:[model.edges[0]]},'b','a'),['b','a']);
});
test('quantiles use linear interpolation and retain missing populations',()=>{
  assert.equal(quantile([10,20,30,40],.5),25); assert.equal(quantile([10,20,30,40],.95),38.5); assert.equal(quantile([],.95),null);
});
test('missing/cyclic span parents remain bounded and visible',()=>{
  const rows=[event(0,'state.entered',{}, {span_id:'a',parent_span_id:'b'}),event(1,'state.entered',{}, {span_id:'b',parent_span_id:'a'}),event(2,'state.entered',{}, {span_id:'c',parent_span_id:'missing'})];
  const result=derive(indexOf(rows)); assert.equal(result.spans.length,3); assert.match(result.warnings.join(' '),/cyclic/); assert.match(result.warnings.join(' '),/missing span parent/);
});
const response = value => new Response(JSON.stringify(value));
const transportEvents = () => fixture().map((e,i)=>({...e,ingest_seq:i+1}));
const mockFetch = (requests, options={}) => async (url,init) => {
  requests.push({url:String(url),init}); const parsed=new URL(url);
  if(parsed.pathname.endsWith('/health')) return response({last_ingest_seq:100,dropped:0});
  if(parsed.pathname.endsWith('/runs')) return response({runs:[{run_id:'r1',complete:true,status:'succeeded',strategy_id:'s1'}],next_cursor:null});
  if(parsed.pathname.endsWith('/events')) { const after=Number(parsed.searchParams.get('after_ingest_seq')??-1); return response({events:after<=0?transportEvents():[],next_ingest_seq:7,next_sequence:null}); }
  throw Error('unexpected route');
};
const definition={type:'custom',provider:'aep'};
test('REST unwraps envelopes and shares in-flight history across views',async()=>{
  const requests=[], provider=new AepProvider({fetch:mockFetch(requests)}), signal=new AbortController().signal;
  const [runs,spans]=await Promise.all([provider.query(definition,{view:'runs'},signal),provider.query(definition,{view:'spans'},signal)]);
  assert.equal(runs.rows.length,1); assert.ok(spans.rows.length>1); assert.equal(requests.filter(r=>new URL(r.url).pathname.endsWith('/runs')).length,1);
  assert.ok(requests.every(r=>r.init.credentials==='omit' && r.init.redirect==='error')); provider.dispose();
});
test('REST run pagination follows opaque cursor and rejects repeated cursors',async()=>{
  let calls=0; const provider=new AepProvider({fetch:async()=>{calls++; return response({runs:[],next_cursor:'same'});}});
  await assert.rejects(provider.query(definition,{},new AbortController().signal),/cursor did not advance/); assert.equal(calls,2);provider.dispose();
});
test('REST rejects malformed events before acknowledging cursor',async()=>{
  const provider=new AepProvider({fetch:async url=>String(url).includes('/runs?')?response({runs:[],next_cursor:null}):response({events:[{...event(0,'x'),ingest_seq:'bad'}],next_ingest_seq:1})});
  await assert.rejects(provider.query(definition,{},new AbortController().signal),/ingest_seq/); provider.dispose();
});
test('cancelling one shared reader does not abort other consumers',async()=>{
  const requests=[], fetcher=mockFetch(requests);let release;const barrier=new Promise(r=>release=r);
  const provider=new AepProvider({fetch:async(...args)=>{await barrier;return fetcher(...args);}}), first=new AbortController(), second=new AbortController();
  const a=provider.query(definition,{},first.signal), b=provider.query(definition,{},second.signal); first.abort(); await assert.rejects(a);release();assert.equal((await b).rows.length,1);provider.dispose();
});
test('JSONL replay avoids network and matches reducer datasets',async()=>{
  const provider=new AepProvider({fetch:()=>{throw Error('offline must not fetch');}});provider.importJSONL(fixture().map(e=>JSON.stringify(e)).join('\n'));
  const rows=await provider.query(definition,{view:'spans'},new AbortController().signal); assert.equal(rows.rows.length,4);assert.match(rows.meta.warnings.join(' '),/Offline/);provider.dispose();
});
class Socket { onmessage=null;onerror=null;onclose=null;closed=false;constructor(url){this.url=url;} close(){this.closed=true;} sendEvent(value){this.onmessage?.({data:JSON.stringify(value)});} }
test('live subscriptions share one socket, merge duplicates, resume and clean up',async()=>{
  const sockets=[],requests=[],provider=new AepProvider({fetch:mockFetch(requests),websocket:url=>{const s=new Socket(url);sockets.push(s);return s;},retryMs:1});
  await provider.query(definition,{view:'events'},new AbortController().signal);
  const received=[], errors=[], controller=new AbortController();
  const a=provider.subscribe(definition,{view:'events'},{next:d=>received.push(d),error:e=>errors.push(e.message)},controller.signal);
  const b=provider.subscribe(definition,{view:'runs'},{next:()=>{},error:()=>{}},controller.signal);
  provider.setLive(true);assert.equal(sockets.length,1);assert.match(sockets[0].url,/after_ingest_seq=7/);
  sockets[0].sendEvent({...event(7,'future.event'),ingest_seq:8});sockets[0].sendEvent({...event(7,'future.event'),ingest_seq:8});
  await new Promise(r=>setTimeout(r,220));assert.equal(received.at(-1).rows.length,8);
  sockets[0].onclose();await new Promise(r=>setTimeout(r,10));assert.match(sockets[1].url,/after_ingest_seq=8/);
  a();assert.equal(sockets[1].closed,false);b();assert.equal(sockets[1].closed,true);provider.dispose();
});
test('bad live event stops stream without advancing reconnect cursor',async()=>{
  const sockets=[], provider=new AepProvider({fetch:mockFetch([]),websocket:url=>{const s=new Socket(url);sockets.push(s);return s;}});
  await provider.query(definition,{},new AbortController().signal);const errors=[];
  provider.subscribe(definition,{}, {next:d=>errors.push(...d.meta.warnings),error:e=>errors.push(e.message)},new AbortController().signal);provider.setLive(true);
  sockets[0].sendEvent({...event(7,'x'),schema_version:'wrong',ingest_seq:8});assert.equal(sockets[0].closed,true);assert.match(errors.join(' '),/stale/);
  provider.setLive(true);assert.match(sockets[1].url,/after_ingest_seq=7/);provider.dispose();
});


test('terminal span without start does not invent a start timestamp',()=>{
  const result=derive(indexOf([event(0,'tool.completed',{duration_ms:20})]));assert.equal(result.spans[0].start,null);assert.equal(result.spans[0].missing_start,true);
});
test('REST selected run follows per-run pagination independently of ingest cursor',async()=>{
  const requests=[];const provider=new AepProvider({fetch:async url=>{
    const parsed=new URL(url);requests.push(parsed);
    if(parsed.pathname.endsWith('/runs'))return response({runs:[],next_cursor:null});
    const after=Number(parsed.searchParams.get('after_sequence'));
    return response(after===-1?{events:transportEvents().slice(0,3),next_sequence:2}:{events:transportEvents().slice(3),next_sequence:null});
  }});
  const data=await provider.query(definition,{run_id:'r1',view:'events'},new AbortController().signal);assert.equal(data.rows.length,7);assert.ok(requests.some(u=>u.searchParams.get('after_sequence')==='2'));provider.dispose();
});
test('retention limit is explicit and preserves the validated prefix',()=>{
  const index=new EventIndex();index.sizeBytes=8*1024*1024-1;
  assert.throws(()=>index.add(event(0,'run.started')),/retention limit/);assert.equal(index.truncated,true);assert.equal(index.events.size,0);
});
test('cursor mismatch rejects incomplete pagination instead of skipping events',async()=>{
  const provider=new AepProvider({fetch:async url=>String(url).includes('/runs?')?response({runs:[],next_cursor:null}):response({events:transportEvents(),next_ingest_seq:999})});
  await assert.rejects(provider.query(definition,{},new AbortController().signal),/does not match/);provider.dispose();
});
test('health detects a reset cursor, keeps stale data visible and stops streaming',async()=>{
  const sockets=[], received=[], base=mockFetch([]);const provider=new AepProvider({fetch:(url,init)=>String(url).endsWith('/health')?Promise.resolve(response({last_ingest_seq:0,dropped:0})):base(url,init),websocket:url=>{const socket=new Socket(url);sockets.push(socket);return socket;}});
  await provider.query(definition,{},new AbortController().signal);provider.subscribe(definition,{}, {next:d=>received.push(d),error:()=>{}},new AbortController().signal);provider.setLive(true);
  await new Promise(r=>setTimeout(r,20));assert.equal(sockets[0].closed,true);assert.equal(received.at(-1).rows.length,1);assert.match(received.at(-1).meta.warnings.join(' '),/cursor reset/);provider.dispose();
});
test('live cursor gaps are reported without asserting that duplicate insertion gaps prove loss',async()=>{
  const sockets=[],received=[],provider=new AepProvider({fetch:mockFetch([]),websocket:url=>{const socket=new Socket(url);sockets.push(socket);return socket;}});
  await provider.query(definition,{},new AbortController().signal);provider.subscribe(definition,{}, {next:d=>received.push(d),error:()=>{}},new AbortController().signal);provider.setLive(true);
  sockets[0].sendEvent({...event(7,'future.event'),ingest_seq:10});await new Promise(r=>setTimeout(r,220));assert.match(received.at(-1).meta.warnings.join(' '),/duplicate inserts/);provider.dispose();
});

test('source registry integrates AEP views without altering generic snapshots',async()=>{
  const { PlatformRuntime }=await import('../src/platform/runtime.ts');
  const provider=new AepProvider({fetch:mockFetch([])});
  const app={id:'aep',name:'AEP',sources:{events:{type:'custom',provider:'aep',query:{view:'events',run_id:'$run_id'}},plain:{type:'json',data:[{value:42}]}},transforms:{},dashboards:[]};
  const runtime=new PlatformRuntime(app,{providers:{aep:provider}});
  const panel={id:'events',type:'table',datasource:{id:'events'},transform:[],mapping:{},display:{},layout:{x:0,y:0,w:6,h:6}};
  const data=await runtime.query(panel,{run_id:'r1'});assert.equal(data.rows.length,7);
  assert.equal((await runtime.query({...panel,datasource:{id:'plain'}})).rows[0].value,42);runtime.dispose();
});
test('abort/dispose interrupts network and rejects new work',async()=>{
  let networkSignal;const provider=new AepProvider({fetch:(_url,init)=>{networkSignal=init.signal;return new Promise((_resolve,reject)=>init.signal.addEventListener('abort',()=>reject(init.signal.reason),{once:true}));}});
  const pending=provider.query(definition,{},new AbortController().signal);provider.dispose();await assert.rejects(pending);assert.equal(networkSignal.aborted,true);await assert.rejects(provider.query(definition,{},new AbortController().signal),/disposed/);
});
test('summary reports cannot disguise missing token event coverage',()=>{
  const rows=fixture().filter(e=>e.event_type!=='llm.completed');const result=derive(indexOf(rows));assert.equal(result.runs[0].input_tokens,null);assert.equal(result.runs[0].token_coverage,0);assert.match(result.warnings.join(' '),/token report coverage/);
});
