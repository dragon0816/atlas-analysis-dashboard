import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildHeatmapModel, heatmapColor, heatmapCellValues } from '../src/platform/heatmapModel.ts';
import { buildGraphModel, filterGraph, forceLayout, graphNeighborhood, shortestGraphPath, graphPathEdges, graphNodeValues, graphEdgeValues } from '../src/platform/graphModel.ts';
import { chartMarks, chartSlices, timelineEvents } from '../src/platform/simpleChartModel.ts';

const meta = { warnings: [], truncated: false, sourceRows: 0 };
const table = (rows, fields = [['x', 'string'], ['y', 'string'], ['value', 'number']]) => ({ kind: 'table', rows, fields: fields.map(([name, type]) => ({name, type})), meta });
const heatmap = (rows, display = {}) => buildHeatmapModel(table(rows), {x:'x', y:'y', value:'value'}, display);
const graph = (nodes, edges = []) => ({ kind:'graph', nodes, edges, meta });

test('heatmap aggregates duplicate cells and distinguishes a zero from a missing cell', () => {
  const input = [{ x:'a', y:'r1', value:2, market:'demo' }, { x:'a', y:'r1', value:6, market:'demo' }, { x:'b', y:'r2', value:0 }];
  const model = heatmap(input);
  assert.equal(model.cells.find(c => c.x.value === 'a' && c.y.value === 'r1').value, 4);
  assert.equal(model.cells.find(c => c.x.value === 'b' && c.y.value === 'r2').value, 0);
  assert.equal(model.cells.filter(c => c.missing).length, 2);
  assert.notEqual(heatmapColor(null, 0, 6), heatmapColor(0, 0, 6));
  for (const [aggregate, expected] of [['sum',8],['min',2],['max',6],['count',2],['last',6]]) assert.equal(heatmap(input,{aggregate}).cells[0].value, expected);
  assert.deepEqual(heatmapCellValues(model.cells[0]), {x:'a', y:'r1', value:4, market:'demo', count:2});
  assert.equal(input[0].value, 2);
});

test('heatmap respects fixed scales, numeric metadata, typed categories and safe bounds', () => {
  assert.deepEqual([heatmap([{x:'a',y:'b',value:8}],{min:0,max:100}).min, heatmap([{x:'a',y:'b',value:8}],{min:0,max:100}).max], [0,100]);
  assert.match(heatmap([],{min:5,max:1}).errors.join(''), /minimum/);
  assert.ok(!heatmapColor(1e308,-1e308,1e308).includes("NaN"));
  assert.ok(!heatmapColor(Number.MIN_VALUE,0,Number.MIN_VALUE).includes("NaN"));
  assert.equal(heatmap([{x:1,y:'a',value:0},{x:'1',y:'a',value:1}]).x.length, 2);
  const capped = heatmap(Array.from({length:100}, (_,i)=>({x:`x${i}`,y:`y${i}`,value:i})), {maxCells:4});
  assert.equal(capped.cells.length,4); assert.match(capped.warnings.join(''),/limited/);
  const invalid = heatmap([{x:null,y:'a',value:2},{x:'a',y:'b',value:NaN},{x:'a',y:'b',value:null}]);
  assert.equal(invalid.cells[0].value,null); assert.match(invalid.warnings.join(''),/invalid categories/);
  assert.match(buildHeatmapModel(table([]),{x:'missing',y:'y',value:'value'}).errors.join(''), /existing field/);
  assert.match(buildHeatmapModel(table([], [['x','string'],['y','string'],['value','string']]),{x:'x',y:'y',value:'value'}).errors.join(''), /numeric/);
  assert.equal(heatmap([{x:'a',y:'b',value:1e308},{x:'a',y:'b',value:1e308}]).cells[0].value, 1e308);
  assert.equal(heatmap([{x:'a',y:'b',value:1e308},{x:'a',y:'b',value:1e308}],{aggregate:'sum'}).cells[0].missing, true);
});

test('graph mappings preserve generic payloads and diagnose IDs, dangling edges and caps', () => {
  const input = graph([{key:'a',name:'Alpha',kind:'person',score:9,cluster:'A',context:'custom'}, {key:'b',name:'Beta',kind:'team'}, {key:'a'}, {key:null}, {key:'c'}], [{from:'a',to:'b',kind:'owns',score:2,state:'pending'}, {from:'b',to:'missing'}, {from:'b',to:'c'}]);
  const model = buildGraphModel(input, {nodeId:'key',nodeLabel:'name',nodeGroup:'kind',nodeSize:'score',nodeColor:'kind',nodeCommunity:'cluster',edgeSource:'from',edgeTarget:'to',edgeType:'kind',edgeWeight:'score'}, {maxNodes:2,maxEdges:1});
  assert.equal(model.nodes.length,2); assert.equal(model.edges.length,1);
  assert.equal(model.nodes[0].size,9); assert.equal(model.nodes[0].community,'A');
  assert.match(model.warnings.join(''), /duplicate/); assert.match(model.warnings.join(''), /dangling/); assert.match(model.warnings.join(''), /Render limit/);
  assert.equal(graphNodeValues(model.nodes[0]).id,'a'); assert.equal(graphNodeValues(model.nodes[0]).context,'custom');
  assert.equal(graphEdgeValues(model.edges[0]).weight,2); assert.equal(graphEdgeValues(model.edges[0]).source,'a');
  assert.equal(buildGraphModel(graph([{id:'default'}]),{nodeId:''}).nodes[0].id,'default');
  const colliding = buildGraphModel(graph([{id:'a'},{id:'b'}],[{id:'x:2',source:'a',target:'b'},{id:'x',source:'a',target:'b'},{id:'x',source:'a',target:'b'}]));
  assert.equal(new Set(colliding.edges.map(edge=>edge.id)).size,3);
});

test('graph filters, neighborhood and shortest-path edges are deterministic', () => {
  const model = buildGraphModel(graph([{id:'a',type:'person',community:'one'},{id:'b',type:'person',community:'one'},{id:'c',type:'team',community:'two'},{id:'d',type:'team'}], [{id:'ab',source:'a',target:'b',type:'knows'}, {id:'bc',source:'b',target:'c',type:'owns'}, {id:'ac',source:'a',target:'c',type:'knows'}]));
  assert.deepEqual([...graphNeighborhood(model,'b')].sort(),['a','b','c']);
  assert.deepEqual(shortestGraphPath(model,'c','a'),['c','a']);
  assert.deepEqual(shortestGraphPath(model,'a','d'),[]);
  assert.deepEqual([...graphPathEdges(model,['a','b','c'])],['ab','bc']);
  assert.equal(filterGraph(model,{nodeType:'person'}).edges.length,1);
  assert.equal(filterGraph(model,{edgeType:'knows'}).edges.length,2);
  assert.equal(filterGraph(model,{community:'two'}).nodes.length,1);
  const positions = forceLayout(model);
  assert.deepEqual(forceLayout(model),positions);
  for (const p of positions.values()) assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y) && p.x >= 24 && p.y >= 24);
  assert.equal(new Set([...positions.values()].map(p=>JSON.stringify(p))).size,4);
});

test('large graph work is bounded before force state allocation', () => {
  const input=graph(Array.from({length:2500},(_,i)=>({id:String(i)})),Array.from({length:4000},(_,i)=>({source:String(i%2500),target:String((i+1)%2500)})));
  const model=buildGraphModel(input,{}, {maxNodes:5000,maxEdges:10000});
  assert.equal(model.nodes.length,1000); assert.ok(model.edges.length<=3000);
  assert.match(model.warnings.join(''),/sampled repulsion/);
  assert.equal(forceLayout(model).size,1000);
});

test('supplemental chart preprocessing rejects misleading data and honors timeline aliases', () => {
  const data=table([{category:'a',value:2,time:'2026-10-07T00:00:00Z'},{category:'a',value:3,time:'2026-10-08T00:00:00Z'},{category:'b',value:-4,time:'bad'}],[['category','string'],['value','number'],['time','time']]);
  assert.equal(chartSlices(data,{category:'category',value:'value'}).slices[0].value,5);
  assert.match(chartSlices(data,{category:'category',value:'value'}).warnings.join(''),/negative/);
  assert.equal(chartMarks(data,{x:'time',y:'value'},'scatter').marks.length,2);
  assert.match(chartMarks(data,{x:'category',y:'value'},'scatter').errors.join(''),/numeric or time/);
  assert.equal(timelineEvents(data,{time:'time',label:'category'}).events.length,2);
  assert.equal(timelineEvents(table([{start:1e100}], [['start','number']]),{}).events.length,0);
});

const dir = await mkdtemp(join(tmpdir(),'atlas-platform-panels-'));
after(()=>rm(dir,{recursive:true,force:true}));
await build({stdin:{contents:`export { DatasetPanel } from './src/components/dashboard/DatasetPanel'; export { createElement } from 'react'; export { renderToStaticMarkup } from 'react-dom/server';`,resolveDir:process.cwd()},bundle:true,platform:'node',format:'cjs',outfile:join(dir,'panels.cjs')});
const { DatasetPanel, createElement, renderToStaticMarkup }=(await import(pathToFileURL(join(dir,'panels.cjs')).href)).default;
const panel=(type,mapping={},display={})=>({id:'test',title:'Example',type,datasource:{id:'fixture'},transform:[],mapping,display,layout:{x:0,y:0,w:6,h:4}});
const render=(dataset,p)=>renderToStaticMarkup(createElement(DatasetPanel,{dataset,panel:p}));

test('DatasetPanel SSR routes all eighteen standalone renderers without errors', () => {
  const data=table([{category:'a',x:1,y:2,value:5,min:0,max:10,q1:2,median:4,q3:6,start:'2026-10-07T00:00:00Z',label:'One'}],[['category','string'],['x','number'],['y','number'],['value','number'],['min','number'],['max','number'],['q1','number'],['median','number'],['q3','number'],['start','time'],['label','string']]);
  const kinds={line:{x:'x',y:'value'},mask:{x:'x',y:'value'},bar:{category:'category',value:'value'},box:{category:'category',q1:'q1',median:'median',q3:'q3'},histogram:{value:'value'},stat:{value:'value'},gauge:{value:'value'},table:{},heatmap:{x:'category',y:'label',value:'value'},area:{x:'x',y:'value'},pie:{category:'category',value:'value'},donut:{category:'category',value:'value'},scatter:{x:'x',y:'y'},text:{},status:{value:'value'},progress:{value:'value'},timeline:{start:'start',label:'label'}};
  for(const [kind,mapping] of Object.entries(kinds)) {const html=render(data,panel(kind,mapping));assert.ok(html.length>0,kind);assert.ok(!html.includes('role="alert"'),kind);}
  const html=render(graph([{id:'a',label:'Alpha',group:'Person'},{id:'b',label:'Beta',group:'Team'}],[{source:'a',target:'b',type:'owns'}]),panel('network'));
  for(const label of ['Search nodes','Node type filter','Edge type filter','Community filter','Fit','Zoom in','Alpha','Node color legend']) assert.ok(html.includes(label),label);
});

test('renderer SSR reports incompatible data, invalid progress and safe markdown', () => {
  assert.match(render(table([]),panel('network')),/requires a graph dataset/);
  assert.match(render(graph([]),panel('heatmap')),/requires a tabular dataset/);
  assert.match(render(table([]),panel('progress',{}, {min:1,max:1})),/role="alert"/);
  const html=render(table([]),panel('text',{}, {text:'# Title\n**Bold** <script>alert(1)</script>\n[unsafe](javascript:alert)\n[safe](https://example.org)'}));
  assert.ok(html.includes('<h1')); assert.ok(html.includes('<strong>Bold</strong>')); assert.ok(!html.includes('<script>'));assert.ok(!html.includes('href="javascript:'));assert.ok(html.includes('href="https://example.org"'));
});


test('graph regions use generic mapped fields and connected components without changing data', async () => {
  const { groupGraph } = await import('../src/platform/graphModel.ts');
  const source = graph([{key:'c',cluster:'West',team:'Ops'}, {key:'a',cluster:'East',team:'Ops'}, {key:'b',team:'Tools'}], [{from:'a',to:'b'}]);
  const original = JSON.stringify(source);
  const model = buildGraphModel(source,{nodeId:'key',nodeCommunity:'cluster',nodeGroup:'team',edgeSource:'from',edgeTarget:'to'});
  assert.equal(groupGraph(model).source,'community');
  assert.deepEqual(groupGraph(model).groups.map(g=>g.label),['East','Unassigned','West']);
  assert.deepEqual(groupGraph(model,'group').groups.map(g=>g.label),['Ops','Tools']);
  const components=groupGraph(model,'components');
  assert.equal(components.membership.get('a'),components.membership.get('b'));
  assert.notEqual(components.membership.get('a'),components.membership.get('c'));
  assert.equal(groupGraph(buildGraphModel(graph([{id:'a',group:'Team'}]))).source,'group');
  assert.equal(groupGraph(buildGraphModel(graph([{id:'a'}]))).source,'components');
  assert.equal(JSON.stringify(source),original);
});

test('region geometry safely handles empty, single, paired, collinear and dragged outliers', async () => {
  const { groupGraph, graphBoundaries } = await import('../src/platform/graphModel.ts');
  assert.deepEqual(forceLayout(buildGraphModel(graph([]))),new Map());
  for(const count of [1,2,3,8]) {
    const model=buildGraphModel(graph(Array.from({length:count},(_,i)=>({id:String(i),community:'Same'}))));
    const grouping=groupGraph(model), positions=forceLayout(model);
    assert.equal(positions.size,count);
    const ids=new Set(model.nodes.map(n=>n.id));
    const [boundary]=graphBoundaries(grouping,ids,id=>positions.get(id));
    assert.equal(boundary.count,count); assert.ok(!/NaN|Infinity/.test(boundary.path));
    for(const p of positions.values()) assert.ok(p.x>boundary.bounds.x0 && p.x<boundary.bounds.x1 && p.y>boundary.bounds.y0 && p.y<boundary.bounds.y1);
    positions.set('0',{x:1500,y:-600});
    const [moved]=graphBoundaries(grouping,ids,id=>positions.get(id));
    assert.notEqual(moved.path,boundary.path); assert.ok(moved.bounds.x1>1500 && moved.bounds.y0 < -600);
    const hidden=graphBoundaries(grouping,new Set(),id=>positions.get(id));assert.deepEqual(hidden,[]);
  }
  const model=buildGraphModel(graph([{id:'a',group:'A'},{id:'b',group:'A'},{id:'c',group:'A'}]));
  const collinear=new Map([['a',{x:0,y:0}],['b',{x:50,y:0}],['c',{x:100,y:0}]]);
  assert.ok(!/NaN|Infinity/.test(graphBoundaries(groupGraph(model),new Set(collinear.keys()),id=>collinear.get(id))[0].path));
});

test('cluster layout separates fixture groups and is stable across input order', async () => {
  const { groupGraph, graphBoundaries, graphNodeRadius }=await import('../src/platform/graphModel.ts');
  const {readFile}=await import('node:fs/promises');
  const data=JSON.parse(await readFile('../applications/rs_knowledge/data/graph.json','utf8'));
  const model=buildGraphModel({...data,kind:'graph'}), positions=forceLayout(model), grouping=groupGraph(model);
  assert.deepEqual(forceLayout({...model,nodes:[...model.nodes].reverse(),edges:[...model.edges].reverse()}),positions);
  const boundaries=graphBoundaries(grouping,new Set(model.nodes.map(n=>n.id)),id=>positions.get(id));
  assert.equal(boundaries.length,5);
  for(let i=0;i<boundaries.length;i++) for(let j=i+1;j<boundaries.length;j++) {
    const a=boundaries[i].bounds,b=boundaries[j].bounds;
    assert.ok(a.x1 < b.x0 || b.x1 < a.x0 || a.y1 < b.y0 || b.y1 < a.y0,'initial region envelopes do not overlap');
  }
  const max=Math.max(...model.nodes.map(n=>n.size));
  assert.ok(model.nodes.every(n=>graphNodeRadius(n,max)<=4));
  for(let i=0;i<model.nodes.length;i++) for(let j=i+1;j<model.nodes.length;j++) {
    const a=model.nodes[i],b=model.nodes[j],pa=positions.get(a.id),pb=positions.get(b.id);
    assert.ok(Math.hypot(pa.x-pb.x,pa.y-pb.y)>=graphNodeRadius(a,max)+graphNodeRadius(b,max),'node dots do not overlap');
  }
});

// Size controls must not merge fixture regions back into the original hairball.
test('graph size settings keep region envelopes separate at supported extremes', async()=> {
  const {groupGraph,graphBoundaries}=await import('../src/platform/graphModel.ts');
  const {readFile}=await import('node:fs/promises');
  const input=JSON.parse(await readFile('../applications/rs_knowledge/data/graph.json','utf8'));
  const model=buildGraphModel({...input,kind:'graph'}),groups=groupGraph(model),ids=new Set(model.nodes.map(n=>n.id));
  for(const size of [.5,1.5,2]) {
    const points=forceLayout(model,720,440,'auto',size),bounds=graphBoundaries(groups,ids,id=>points.get(id),17+6*size).map(b=>b.bounds);
    for(let i=0;i<bounds.length;i++)for(let j=i+1;j<bounds.length;j++){const a=bounds[i],b=bounds[j];assert.ok(a.x1<b.x0||b.x1<a.x0||a.y1<b.y0||b.y1<a.y0);}
  }
});
