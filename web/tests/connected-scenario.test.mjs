import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {connectedFixture} from '../../scripts/generate-connected-fixture.mjs';
import {buildGraphModel,groupGraph,forceLayout,filterGraph,graphBoundaries,shortestGraphPath} from '../src/platform/graphModel.ts';
import {layoutGraph3D,envelopes3D} from '../src/platform/graph3DModel.ts';
import {filterDataset} from '../src/platform/transforms.ts';
const all=JSON.parse(readFileSync(new URL('../../applications/rs_knowledge/data/graph_comparison.json',import.meta.url),'utf8'));
const original=JSON.parse(readFileSync(new URL('../../applications/rs_knowledge/data/graph.json',import.meta.url),'utf8'));
const dense={kind:'graph',...connectedFixture(),meta:{warnings:[],truncated:false,sourceRows:273}};
const model=buildGraphModel(dense,{}, {maxNodes:250,maxEdges:500}),grouping=groupGraph(model);
test('comparison is reproducible, original is retained, identities are unique, and limits never truncate either scenario',()=>{
 assert.deepEqual(connectedFixture(),connectedFixture());
 assert.deepEqual(all.nodes.filter(n=>n.scenario==='sparse').map(({scenario,...n})=>n),original.nodes);
 assert.deepEqual(all.edges.filter(n=>n.scenario==='sparse').map(({scenario,...n})=>n),original.edges);
 assert.deepEqual(all.nodes.filter(n=>n.scenario==='connected'),dense.nodes);
 for(const scenario of ['sparse','connected']){
  const d={kind:'graph',nodes:all.nodes.filter(n=>n.scenario===scenario),edges:all.edges.filter(n=>n.scenario===scenario)};
  const m=buildGraphModel(d,{}, {maxNodes:250,maxEdges:500});assert.deepEqual(m.warnings,[]);
  assert.equal(new Set(d.nodes.map(n=>n.id)).size,d.nodes.length);assert.equal(new Set(d.edges.map(n=>n.id)).size,d.edges.length);
  const ids=new Set(d.nodes.map(n=>n.id));assert.ok(d.edges.every(e=>ids.has(e.source)&&ids.has(e.target)));
 }
 assert.equal(model.nodes.length,67);assert.equal(model.edges.length,206);
 const cross=model.edges.filter(e=>grouping.membership.get(e.source)!==grouping.membership.get(e.target));assert.equal(cross.length,138);
 assert.equal(model.nodes.filter(n=>n.row.domain_memberships.length>1).length,21);
 assert.equal(model.nodes.filter(n=>n.label==='Calibration').length,1);
 assert.equal(new Set(model.edges.filter(e=>e.target==='connected:cal').map(e=>model.nodes.find(n=>n.id===e.source).community)).size,6);
 assert.equal(shortestGraphPath(model,'connected:isolated','connected:cal').length,0);
 assert.ok(shortestGraphPath(model,'connected:a0','connected:a4').length>0);
});
test('global market bindings include array memberships; primary-community filters and boundaries stay exclusive',()=>{
 const data=filterDataset(dense,{market:'Automotive'},true);
 assert.ok(data.nodes.some(n=>n.id==='connected:cal'));assert.ok(data.nodes.some(n=>n.id==='connected:disputed'));
 assert.ok(!data.nodes.some(n=>n.id==='connected:a0'));assert.ok(data.nodes.some(n=>n.id==='connected:a1'));
 assert.ok(filterDataset(dense,{market:['AI','Automotive']},true).nodes.length>data.nodes.length);
 const selected=filterGraph(model,{community:'AI'});assert.ok(selected.nodes.every(n=>n.community==='AI'));assert.ok(!selected.nodes.some(n=>n.id==='connected:cal'));
 const nodeFilter=filterGraph(model,{nodeType:'measurement',edgeType:'supports'});assert.ok(nodeFilter.nodes.every(n=>n.type==='measurement'));assert.ok(nodeFilter.edges.every(e=>e.type==='supports'));
 for(const mode of ['community','group','components']){
  const g=groupGraph(model,mode),points=forceLayout(model,720,440,mode,1,'topology');
  const visible=new Set(selected.nodes.map(n=>n.id));const b=graphBoundaries(g,visible,id=>points.get(id));assert.equal(b.reduce((n,x)=>n+x.count,0),visible.size);
  const p3=layoutGraph3D(g,1,model,'topology'),volumes=envelopes3D(g,visible,p3);assert.deepEqual(new Set(volumes.flatMap(v=>v.members)),visible);
  for(const v of volumes)for(const id of v.members){const p=p3.get(id);assert.ok(Math.hypot(p.x-v.center.x,p.y-v.center.y,p.z-v.center.z)<=v.radius);}
 }
});
test('connection layout responds to links and weights, not group assignments, and remains deterministic in both dimensions',()=>{
 const changed={...model,nodes:model.nodes.map(n=>({...n,community:'One group'}))};
 for(const dim of [2,3]){
  const get=m=>dim===2?forceLayout(m,720,440,'auto',1,'topology'):layoutGraph3D(groupGraph(m),1,m,'topology');
  const p=get(model);assert.deepEqual(p,get(model));assert.deepEqual(p,get(changed));
  assert.notDeepEqual(p,get({...model,edges:[]}));assert.notDeepEqual(p,get({...model,edges:model.edges.map(e=>({...e,weight:e.weight*0.1}))}));
  assert.ok([...p.values()].every(v=>Object.values(v).every(Number.isFinite)));
  if(dim===3)assert.ok(new Set([...p.values()].map(v=>v.z)).size>50);
 }
});
