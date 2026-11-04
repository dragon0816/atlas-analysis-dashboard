import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parse} from 'yaml';
import {SimulationState,AtlasSimulationProvider,simulationStatistics} from '../src/platform/atlas/simulation.ts';
import {PlatformRuntime} from '../src/platform/runtime.ts';
import {parseDashboardDocument} from '../src/platform/documents.ts';
const mux=(event,data,runner=1)=>({runner,event,data:JSON.stringify(data)});
const start=count=>mux('start',{testcases:count});
const result=(index,delta=0,checked=true)=>mux('result',{
  index,total:4,name:'Simulated power sample',stats:{verdict:delta>=-1&&delta<=1},results:{Simulation:{
    contract:['atlas.simulation.power.v1',null],sequence:[index,null],acquired_at:[`2026-01-01T00:00:00.${String(index*100).padStart(3,'0')}Z`,null],timestamp_kind:['synthetic',null],
    power_dbm:[-60+delta,'dBm'],setpoint_dbm:[-60,'dBm'],frequency_hz:[2412e6,'Hz'],
    error_db:checked?[delta,'dB',-1,1,null,delta>=-1,delta<=1,null,delta>=-1&&delta<=1]:[delta,'dB'],
  }}
});
const definition={type:'custom',provider:'atlas_simulation',url:'/atlas-api/instances/events',query:{runner:1}};
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));

test('scalar adapter retains sequence/time/units and counts checked measurements only',()=>{
  const state=new SimulationState();state.opened();state.accept(start(4));state.accept(result(1,0));state.accept(result(2,2));state.accept(result(3,0.5,false));
  state.accept(mux('result',{index:4,name:'Simulated power sample',stats:{error:'injected'},results:{}}));state.accept(mux('end',{}));
  const data=state.snapshot(),stats=simulationStatistics(data);
  assert.equal(data.rows.length,4);assert.equal(data.rows[0].sequence,1);assert.equal(data.rows[0].timestamp_kind,'synthetic');assert.equal(data.fields.find(f=>f.name==='power_dbm').unit,'dBm');
  assert.deepEqual([stats.pass,stats.fail,stats.unchecked,stats.error,stats.pass_rate],[1,1,1,1,0.5]);
  assert.equal(data.rows[3].power_dbm,null);assert.equal(data.rows[3].verdict,'error');assert.ok(stats.sample_sigma_db>0);
  assert.equal(stats.cpk,null); // unchecked row has no comparable limits.
});
test('replay is idempotent, reconnect rebuilds, and gaps/conflicts/early end are visible',()=>{
  const state=new SimulationState();state.accept(start(3));state.accept(result(1));state.accept(result(1));state.accept(result(3));
  assert.equal(state.snapshot().rows.length,2);assert.match(state.snapshot().meta.warnings.join(),/Missing result/);
  state.accept(result(1,2));assert.match(state.snapshot().meta.warnings.join(),/Conflicting replay/);
  state.accept(mux('end',{}));assert.match(state.snapshot().meta.warnings.join(),/2\/3/);
  state.disconnected();assert.match(state.snapshot().meta.warnings.join(),/STALE/);
  state.opened();state.accept(start(1));state.accept(result(1));state.accept(mux('end',{}));assert.equal(state.snapshot().rows.length,1);
  state.accept(result(2,0, true));assert.equal(state.snapshot().rows.length,2);
});
test('malformed units, missing timestamps, summary trace and wrong runners never become measurements',()=>{
  const state=new SimulationState();state.accept(start(1));
  const bad=result(1);let inner=JSON.parse(bad.data);inner.results.Simulation.power_dbm[1]='W';assert.throws(()=>state.accept(mux('result',inner)),/unit/);
  inner=JSON.parse(result(1).data);inner.results.Simulation.acquired_at=[null,null];assert.throws(()=>state.accept(mux('result',inner)),/metadata/);
  inner=JSON.parse(result(1).data);inner.results.Simulation.power_dbm=[{trace_samples:1024},'dBm'];assert.throws(()=>state.accept(mux('result',inner)),/Non-numeric/);
  const other=result(1);other.runner=2;state.accept(other);assert.equal(state.snapshot().rows.length,0);
  state.accept(mux('result',{index:5001,results:{},stats:{}}));assert.equal(state.snapshot().meta.truncated,true);
});
test('panels share one EventSource; disconnect publishes stale data, AbortSignal closes it',async()=>{
  let created=0,closed=0,source;
  const provider=new AtlasSimulationProvider(url=>{assert.equal(url,definition.url);created++;source={addEventListener:(_event,fn)=>{source.mux=fn;},close:()=>closed++,onopen:null,onerror:null};return source;});
  const a=new AbortController(),b=new AbortController();let samples,stats;
  const stop=provider.subscribe(definition,{runner:1},{next:data=>samples=data,error:assert.fail},a.signal);
  provider.subscribe(definition,{runner:1,view:'statistics'},{next:data=>stats=data,error:assert.fail},b.signal);
  assert.equal(created,1);source.onopen(new Event('open'));source.mux({data:JSON.stringify(start(1))});source.mux({data:JSON.stringify(result(1))});
  await pause(120);assert.equal(samples.rows.length,1);assert.equal(stats.rows[0].samples,1);
  source.onerror(new Event('error'));await pause(120);assert.match(samples.meta.warnings.join(),/STALE/);
  a.abort();stop();assert.equal(closed,0);b.abort();await pause(150);assert.equal(closed,1);provider.dispose();assert.equal(closed,1);
  await assert.rejects(()=>provider.query(definition,{runner:0},new AbortController().signal),/runner 1/);
});
test('application preset and pipelines execute with simulation provider snapshots',async()=>{
  const root=new URL('../../applications/atlas_simulation/',import.meta.url);
  const app={...parse(readFileSync(new URL('application.yaml',root),'utf8')),sources:parse(readFileSync(new URL('datasources.yaml',root),'utf8')),transforms:{},dashboards:[parseDashboardDocument(parse(readFileSync(new URL('dashboards/live.yaml',root),'utf8')))]};
  const state=new SimulationState();state.accept(start(1));state.accept(result(1));
  const runtime=new PlatformRuntime(app,{providers:{atlas_simulation:{query:async(_d,q)=>q.view==='statistics'?{kind:'table',fields:[{name:'pass_rate',type:'number'}],rows:[{pass_rate:1}],meta:{warnings:[],sourceRows:1,truncated:false}}:state.snapshot()}}});
  for(const panel of app.dashboards[0].panels)assert.equal((await runtime.query(panel)).kind,'table');runtime.dispose();
});
