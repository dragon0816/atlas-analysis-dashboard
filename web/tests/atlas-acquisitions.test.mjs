import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DurableSimulationState,DurableAtlasSimulationProvider} from '../src/platform/atlas/acquisitions.ts';
import {simulationStatistics} from '../src/platform/atlas/simulation.ts';
const id='a'.repeat(32),other='b'.repeat(32);
const envelope=(event,data,sequence,run=id)=>({runner:1,event,data:JSON.stringify({...data,run_id:run,event_sequence:sequence,received_at:'2026-11-04T00:00:00Z',acquisition_contract:'atlas.acquisition.v1'})});
const start=(count=2,run=id)=>envelope('start',{testcases:count},1,run);
const sample=(index,sequence=index+1,run=id)=>envelope('result',{index,name:'Simulated power sample',stats:{verdict:true},results:{Simulation:{contract:['atlas.simulation.power.v1',null],sequence:[index,null],acquired_at:[`2026-01-01T00:00:0${index}Z`,null],timestamp_kind:['synthetic',null],power_dbm:[-60.1,'dBm'],setpoint_dbm:[-60,'dBm'],error_db:[-0.1,'dB',-1,1,null,true,true,null,true],frequency_hz:[2412e6,'Hz']}}},sequence,run);
const end=(state='completed',sequence=4,run=id)=>envelope('end',{state,complete:state==='completed'},sequence,run);
const definition={type:'custom',provider:'atlas_simulation',url:'/atlas-api/instances/events',query:{runner:1}};
const response=value=>new Response(JSON.stringify(value));
const page=events=>({schemaVersion:1,run_id:id,runner:1,events,next_after:null,state:'completed',complete:true,expected:2,received:2,warnings:[]});
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));

test('durable replay is idempotent across reconnects and JSON property ordering',()=>{
 const state=new DurableSimulationState();const events=[start(),sample(1),sample(2),end()];
 for(const event of events)state.accept(event);state.opened();for(const event of events)state.accept(event);
 const alternate=sample(1);alternate.data=JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(alternate.data)).reverse()));state.accept(alternate);
 assert.equal(state.snapshot().rows.length,2);assert.equal(state.snapshot().rows[0].run_id,id);assert.equal(state.sequence(),4);
 assert.doesNotMatch(state.snapshot().meta.warnings.join(),/Conflicting|Reconnecting/);
});
test('out-of-order records wait for a contiguous prefix and missing events can be recovered',()=>{
 const state=new DurableSimulationState();state.accept(start());state.accept(sample(2));state.accept(end());
 assert.equal(state.snapshot().rows.length,0);assert.match(state.snapshot().meta.warnings.join(),/Missing event 2/);
 state.accept(sample(1));assert.equal(state.gap(),false);assert.equal(state.snapshot().rows.length,2);assert.equal(state.sequence(),4);
});
test('conflicts, retired runs and incomplete terminal states never produce a false completed run',()=>{
 const state=new DurableSimulationState();state.accept(start(100));state.accept(sample(1));state.accept(end('stopped',3));
 assert.match(state.snapshot().meta.warnings.join(),/stopped/);assert.equal(simulationStatistics(state.snapshot()).coverage,'incomplete or stale snapshot');
 const conflict=sample(1);const data=JSON.parse(conflict.data);data.results.Simulation.power_dbm[0]=999;conflict.data=JSON.stringify(data);state.accept(conflict);
 assert.equal(state.snapshot().rows[0].power_dbm,-60.1);assert.match(state.snapshot().meta.warnings.join(),/Conflicting/);
 state.accept(start(1,other));state.accept(sample(2));assert.equal(state.snapshot().rows.length,0);assert.equal(state.runId,other);
 assert.match(state.snapshot().meta.warnings.join(),/previous execution/);
 const failedSave=new DurableSimulationState();failedSave.accept(start(1));failedSave.accept(sample(1));
 failedSave.accept({runner:1,event:'end',data:JSON.stringify({state:'error',complete:false,persistence_error:'report directory unavailable'})});
 assert.equal(simulationStatistics(failedSave.snapshot()).coverage,'incomplete or stale snapshot');
});
test('fresh provider restores saved pages without a live execution and shares one stream',async()=>{
 let connections=0,closed=0,stream,requests=[];
 const events=[start(),sample(1),sample(2),end()];
 const provider=new DurableAtlasSimulationProvider({fetch:async path=>{requests.push(path);return path.includes('?runner=')?response({files:[{run_id:id}]}):response(page(events));},eventSource:()=>{connections++;stream={onopen:null,onerror:null,addEventListener:(_name,fn)=>{stream.mux=fn;},close:()=>closed++};return stream;}});
 const controller=new AbortController();let samples,stats;
 const initial=await provider.query(definition,{runner:1},controller.signal);assert.equal(initial.rows.length,2);
 provider.subscribe(definition,{runner:1},{next:data=>samples=data,error:assert.fail},controller.signal);
 provider.subscribe(definition,{runner:1,view:'statistics'},{next:data=>stats=data,error:assert.fail},controller.signal);
 assert.equal(connections,1);stream.onopen(new Event('open'));for(const event of events)stream.mux({data:JSON.stringify(event)});
 await pause(130);assert.equal(samples.rows.length,2);assert.equal(stats.rows[0].samples,2);
 stream.onerror(new Event('error'));await pause(130);assert.match(samples.meta.warnings.join(),/STALE/);
 stream.onopen(new Event('open'));for(const event of events)stream.mux({data:JSON.stringify(event)});await pause(130);
 assert.equal(samples.rows.length,2);assert.doesNotMatch(samples.meta.warnings.join(),/STALE|Reconnecting/);
 controller.abort();await pause(140);assert.equal(closed,1);provider.dispose();
});
test('live event gaps request the fixed read-only recovery API and merge without duplication',async()=>{
 let stream,recoveries=0;
 const events=[start(),sample(1),sample(2),end()];
 const provider=new DurableAtlasSimulationProvider({fetch:async path=>{if(path.includes('?runner='))return response({files:[]});recoveries++;assert.ok(path.startsWith(`/atlas-api/acquisitions/${id}?after=0&limit=1000`));return response(page(events));},eventSource:()=>{stream={onopen:null,onerror:null,addEventListener:(_name,fn)=>{stream.mux=fn;},close(){}};return stream;}});
 const signal=new AbortController();await provider.query(definition,{runner:1},signal.signal);let latest;
 provider.subscribe(definition,{runner:1},{next:data=>latest=data,error:assert.fail},signal.signal);stream.onopen(new Event('open'));
 stream.mux({data:JSON.stringify(start())});stream.mux({data:JSON.stringify(sample(2))});await pause(140);
 assert.equal(recoveries,1);assert.equal(latest.rows.length,2);assert.doesNotMatch(latest.meta.warnings.join(),/Missing event/);provider.dispose();
});
test('a late saved response cannot roll back a newer live run; dispose aborts further work',async()=>{
 let release,stream;
 const saved=new Promise(resolve=>release=resolve);
 const provider=new DurableAtlasSimulationProvider({fetch:async path=>path.includes('?runner=')?response({files:[{run_id:id}]}):saved,eventSource:()=>{stream={onopen:null,onerror:null,addEventListener:(_name,fn)=>{stream.mux=fn;},close(){}};return stream;}});
 const controller=new AbortController();const pending=provider.query(definition,{runner:1},controller.signal);
 provider.subscribe(definition,{runner:1},{next(){},error:assert.fail},controller.signal);
 stream.mux({data:JSON.stringify(start(1,other))});stream.mux({data:JSON.stringify(sample(1,2,other))});
 release(response(page([start(),sample(1),sample(2),end()])));
 const result=await pending;assert.equal(result.rows.length,1);assert.equal(result.rows[0].run_id,other);
 provider.dispose();await assert.rejects(()=>provider.query(definition,{runner:1},controller.signal),/disposed/);
});

test('a transient recovery failure retries without another live event and stops after disposal',async()=>{
 let stream,recoveries=0,latest;
 const events=[start(),sample(1),sample(2),end()];
 const provider=new DurableAtlasSimulationProvider({fetch:async path=>{
  if(path.includes('?runner='))return response({files:[]});
  if(++recoveries===1)throw new Error('temporary disconnect');
  return response(page(events));
 },eventSource:()=>{stream={onopen:null,onerror:null,addEventListener:(_name,fn)=>{stream.mux=fn;},close(){}};return stream;}});
 const controller=new AbortController();await provider.query(definition,{runner:1},controller.signal);
 provider.subscribe(definition,{runner:1},{next:data=>latest=data,error:assert.fail},controller.signal);
 stream.mux({data:JSON.stringify(start())});stream.mux({data:JSON.stringify(sample(2))});
 await pause(1200);assert.equal(recoveries,2);assert.equal(latest.rows.length,2);
 assert.doesNotMatch(latest.meta.warnings.join(),/Missing event/);
 provider.dispose();await pause(130);assert.equal(recoveries,2);
});

test('unavailable recovery has a bounded retry budget and an explicit incomplete warning',async()=>{
 let stream,recoveries=0,latest;
 const provider=new DurableAtlasSimulationProvider({fetch:async path=>{
  if(path.includes('?runner='))return response({files:[]});
  recoveries++;throw new Error('offline');
 },eventSource:()=>{stream={onopen:null,onerror:null,addEventListener:(_name,fn)=>{stream.mux=fn;},close(){}};return stream;}});
 const controller=new AbortController();await provider.query(definition,{runner:1},controller.signal);
 provider.subscribe(definition,{runner:1},{next:data=>latest=data,error:assert.fail},controller.signal);
 stream.mux({data:JSON.stringify(start())});stream.mux({data:JSON.stringify(sample(2))});
 await pause(2400);assert.equal(recoveries,3);
 assert.equal(latest.rows.length,0);assert.match(latest.meta.warnings.join(),/retry limit reached/);
 assert.equal(simulationStatistics(latest).coverage,'incomplete or stale snapshot');provider.dispose();
});
