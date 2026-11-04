/** Compare the real Atlas HTTP test evidence with the production adapter/statistics. */
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {SimulationState,simulationStatistics} from '../web/src/platform/atlas/simulation.ts';

if(!process.argv[2])throw new Error('Usage: node --experimental-strip-types scripts/check-atlas-simulation.mjs <Atlas build/simulation-evidence>');
const directory=resolve(process.argv[2]);
const read=async name=>JSON.parse(await readFile(join(directory,name),'utf8'));
const results={};
for(const name of ['sim_contract_success','sim_contract_error','sim_contract_stop']) {
  const events=(await readFile(join(directory,`${name}.jsonl`),'utf8')).trim().split(/\r?\n/).map(line=>JSON.parse(line));
  const state=new SimulationState();state.opened();for(const event of events)state.accept(event);
  const snapshot=state.snapshot(),stats=simulationStatistics(snapshot),report=await read(`${name}-report.json`);
  if(name==='sim_contract_success') {
    const expected=await read('expected-statistics.json');
    assert.equal(stats.samples,expected.samples);assert.equal(stats.pass,expected.checked_pass);
    for(const key of ['mean_error_db','sample_sigma_db','cpk'])assert.ok(Math.abs(stats[key]-expected[key])<1e-12,`${key} differs from Python statistics`);
    assert.equal(report.results.length,snapshot.rows.length);
    for(const [index,entry]of report.results.entries()) {
      const measurements=Object.fromEntries(Object.values(entry.results).map(item=>[item.subitem,item]));
      for(const key of ['sequence','acquired_at','power_dbm','setpoint_dbm','error_db','frequency_hz'])assert.equal(snapshot.rows[index][key],measurements[key].value);
    }
    const before=JSON.stringify(stats);state.opened();for(const event of events)state.accept(event);assert.equal(JSON.stringify(simulationStatistics(state.snapshot())),before);
  } else if(name==='sim_contract_error') {
    assert.equal(stats.samples,3);assert.equal(stats.error,1);assert.equal(stats.pass,2);assert.equal(stats.pass_rate,1);
    assert.match(snapshot.meta.warnings.join(),/3\/8/);
  } else {
    assert.ok(stats.samples>0&&stats.samples<100);assert.equal(report,null);assert.match(snapshot.meta.warnings.join(),/Execution ended with/);
  }
  results[name]={...stats,warnings:snapshot.meta.warnings,archiveReadable:report!==null};
}
await writeFile(join(directory,'dashboard-comparison.json'),JSON.stringify(results,null,2)+'\n');
console.log(JSON.stringify(results,null,2));
