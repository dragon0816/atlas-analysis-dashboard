import { readFileSync, writeFileSync } from 'node:fs';
// Fabricated, deterministic relationships. No private Atlas/Vault input or product specifications.
export function connectedFixture() {
 const nodes=[],edges=[],domains=['AI','Automotive','Connectivity','Aerospace','Industrial'];
 const add=(id,label,type,community,memberships,extra={})=>nodes.push({id:`connected:${id}`,label,type,group:type,community,domain_memberships:memberships,market:memberships,size:2,synthetic:true,scenario:'connected',...extra});
 const link=(a,b,type='uses',weight=1,state='')=>edges.push({id:`connected:e${edges.length}`,source:`connected:${a}`,target:`connected:${b}`,type,weight,state,scenario:'connected',synthetic:true});
 const shared=[['fft','FFT processing','technology'],['sync','Time synchronization','technology'],['sdr','Software-defined radio','technology'],['ml','Anomaly detection','technology'],['cal','Calibration','measurement'],['evm','Modulation error analysis','measurement'],['phase','Phase noise analysis','measurement'],['latency','Latency measurement','measurement'],['power','Power measurement','measurement'],['sweep','Frequency sweep','measurement'],['stream','Streaming acquisition','capability'],['trigger','Synchronized triggering','capability'],['report','Automated reporting','capability'],['iq','I/Q capture','capability'],['remote','Remote control','capability'],['uncertainty','Uncertainty budget','knowledge'],['reference','Shared reference procedure','knowledge'],['workflow','Automated measurement workflow','capability']];
 shared.forEach(([id,label,type],i)=>add(id,label,type,'Shared foundations',domains,{size:5+i%4,role:'Shared hub: one identity reused across domains'}));
 const applications=['Adaptive link validation','Radar scenario evaluation','Wireless device validation','Telemetry validation','Sensor network validation'];
 domains.forEach((domain,d)=>{
  add(`d${d}`,domain,'domain',domain,[domain],{size:8});
  add(`a${d}`,applications[d],'application',domain,[domain]);
  ['Signal acquisition','Timing validation','Interference analysis','Automated regression','Evidence review','Measurement planning','Result traceability'].forEach((label,i)=>add(`task${d}-${i}`,`${domain} · ${label}`,'workflow',domain,[domain],{size:2+i%3}));
  link(`d${d}`,`a${d}`,'includes',1.8);
  for(let i=0;i<7;i++) {
   link(`a${d}`,`task${d}-${i}`,'requires',1.4);
   // Multiple shared methods/capabilities are reused, never copied for each domain.
   for(let k=0;k<3;k++) link(`task${d}-${i}`,shared[(i*2+d*3+k*5)%shared.length][0],k===1?'measured_by':'uses',0.8+((i+d+k)%5)*0.25);
  }
  for(const id of ['cal','sync','workflow','reference']) link(`a${d}`,id,'uses',1.8);
  link(`task${d}-3`,`task${(d+1)%5}-3`,'shares_method',1.2);
  link(`task${d}-5`,`a${(d+2)%5}`,'informs',0.6,'weak');
 });
 shared.forEach(([id],i)=>{link(id,shared[(i+1)%shared.length][0],'supports',1.1);if(i%2===0)link(id,shared[(i+5)%shared.length][0],'integrates',0.9);});
 add('legacy','Legacy procedure','knowledge','Shared foundations',['AI','Industrial'],{state:'stale'});link('legacy','reference','superseded_by',0.25,'stale');
 add('disputed','Unresolved timing assumption','knowledge','Aerospace',['Aerospace','Automotive'],{state:'conflict'});link('disputed','sync','challenges',0.35,'conflict');link('disputed','task1-1','affects',0.5,'conflict');
 add('isolated','Unlinked lab note','knowledge','Industrial',['Industrial'],{state:'isolated'});
 add('weak','Tentative acquisition method','measurement','Connectivity',['Connectivity','AI'],{state:'weak'});link('weak','stream','candidate_for',0.12,'weak');
 // Illustrative size only; it is not an evidence score.
 return {nodes,edges};
}
if(process.argv[1]?.endsWith('generate-connected-fixture.mjs')) {
 const sparse=JSON.parse(readFileSync(new URL('../applications/rs_knowledge/data/graph.json',import.meta.url),'utf8'));
 const dense=connectedFixture();
 const output={meta:{revision:'synthetic-comparison-v1'},nodes:[...sparse.nodes.map(n=>({...n,scenario:'sparse'})),...dense.nodes],edges:[...sparse.edges.map(e=>({...e,scenario:'sparse'})),...dense.edges]};
 writeFileSync(new URL('../applications/rs_knowledge/data/graph_comparison.json',import.meta.url),JSON.stringify(output,null,2)+'\n');
 console.log('Connected',dense.nodes.length,dense.edges.length);
}
