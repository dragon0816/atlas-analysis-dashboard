import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {DurableSimulationState} from '../web/src/platform/atlas/acquisitions.ts';
import {simulationStatistics} from '../web/src/platform/atlas/simulation.ts';
if(!process.argv[2])throw new Error('Pass the Phase 2 Atlas build/simulation-evidence directory');
const root=resolve(process.argv[2]),summary={};
for(const outcome of ['completed','error','stopped']){
 const events=JSON.parse(await readFile(join(root,`${outcome}-durable-events.json`),'utf8'));
 const report=JSON.parse(await readFile(join(root,`${outcome}-durable-report.json`),'utf8'));
 const state=new DurableSimulationState();for(const event of [...events].reverse())state.accept(event);
 for(const event of events)state.accept(event);state.opened();for(const event of events)state.accept(event);
 const snapshot=state.snapshot(),stats=simulationStatistics(snapshot);
 assert.equal(snapshot.rows.length,report.results.length);
 for(const row of snapshot.rows){
  const saved=report.results.find(result=>result.index===row.index);assert.equal(row.run_id,report.metadata.run_id);
  if(row.verdict==='error'){assert.equal(saved.verdict,'ERROR');continue;}
  const measurements=Object.fromEntries(Object.values(saved.results).map(item=>[item.subitem,item]));
  for(const key of ['power_dbm','setpoint_dbm','error_db','frequency_hz','sequence','acquired_at'])assert.equal(row[key],measurements[key].value);
 }
 assert.equal(report.metadata.state,outcome);assert.equal(report.metadata.complete,outcome==='completed');
 if(outcome!=='completed')assert.equal(stats.coverage,'incomplete or stale snapshot');
 summary[outcome]={run_id:report.metadata.run_id,state:outcome,complete:report.metadata.complete,...stats,warnings:snapshot.meta.warnings};
}
await writeFile(join(root,'phase2-dashboard-comparison.json'),JSON.stringify(summary,null,2)+'\n');
console.log(JSON.stringify(summary,null,2));
