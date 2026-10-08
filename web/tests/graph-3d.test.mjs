import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildGraphModel, groupGraph, filterGraph } from '../src/platform/graphModel.ts';
import { layoutGraph3D, envelopes3D, cameraFit3D } from '../src/platform/graph3DModel.ts';
import { build } from 'esbuild';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';
const dataset = { kind: 'graph', nodes: Array.from({length: 25}, (_,i) => ({id:`n${i}`, label:`Node ${i}`, community:`g${i%5}`, group:`type${i%3}`, size: i%4})), edges: Array.from({length:20}, (_,i) => ({id:`e${i}`,source:`n${i}`,target:`n${i+5}`,type:'link'})) };
const model = buildGraphModel(dataset), grouping = groupGraph(model);
test('3D layout is deterministic, finite, genuinely non-planar and leaves graph data untouched', () => {
 const before = JSON.stringify(model), points = layoutGraph3D(grouping);
 assert.deepEqual(points, layoutGraph3D(grouping)); assert.equal(points.size,25);
 assert.ok(new Set([...points.values()].map(p=>p.z)).size>4);
 assert.ok([...points.values()].every(p=>Object.values(p).every(Number.isFinite)));
 assert.equal(JSON.stringify(model), before);
 assert.equal(layoutGraph3D(groupGraph({nodes:[],edges:[],warnings:[]})).size,0);
});
test('3D envelopes contain every visible member, obey data grouping and exclude filtered IDs', () => {
 for (const scale of [0.5,1,2]) {
  const points=layoutGraph3D(grouping,scale), visible=new Set(filterGraph(model,{nodeType:'type1'}).nodes.map(n=>n.id));
  const volumes=envelopes3D(grouping,visible,points,14+4*scale);
  assert.deepEqual(new Set(volumes.flatMap(v=>v.members)),visible);
  for (const volume of volumes) for (const id of volume.members) {
   assert.equal(grouping.membership.get(id),volume.id); const p=points.get(id);
   assert.ok(Math.hypot(p.x-volume.center.x,p.y-volume.center.y,p.z-volume.center.z)<volume.radius);
  }
  assert.equal(envelopes3D(grouping,new Set(),points).length,0);
  assert.equal(envelopes3D(grouping,new Set(['n0']),points)[0].members.length,1);
 }
});
test('camera fit handles empty, single, deep and narrow views with finite enclosing distances',()=>{
 assert.ok(cameraFit3D([]).distance>0);
 const points=[{x:-40,y:12,z:-200},{x:90,y:-70,z:600}];
 for(const aspect of [0.1,1,4]) {const fit=cameraFit3D(points,aspect);assert.ok(fit.distance>fit.radius);for(const p of points)assert.ok(Math.hypot(p.x-fit.center.x,p.y-fit.center.y,p.z-fit.center.z)<fit.radius);}
 assert.ok(cameraFit3D(points,0.1).distance>cameraFit3D(points,1).distance);
});
const directory=await mkdtemp(join(tmpdir(),'atlas-3d-test-')); after(()=>rm(directory,{recursive:true,force:true}));
const realThree=resolve('node_modules/three/build/three.module.js');
await build({entryPoints:['src/components/panels/graph3DRenderer.ts'],bundle:true,platform:'node',format:'esm',outfile:join(directory,'renderer.mjs'),plugins:[{name:'mock-webgl-only',setup(build){build.onResolve({filter:/^three$/},()=>({path:'mock-three',namespace:'mock'}));build.onLoad({filter:/.*/,namespace:'mock'},()=>({contents:`export * from ${JSON.stringify(realThree)};
export class WebGLRenderer { constructor(){this.domElement=document.createElement('canvas');this.state=globalThis.__webgl={renders:0,resources:new Set(),disposed:new Set()};} setPixelRatio(){} setClearColor(){} setSize(){} render(scene,camera){scene.updateMatrixWorld(true);camera.updateMatrixWorld(true);this.state.scene=scene;this.state.camera=camera;this.state.renders++;scene.traverse(o=>{for(const r of [o.geometry,...(Array.isArray(o.material)?o.material:[o.material])].filter(Boolean)){if(!this.state.resources.has(r)){this.state.resources.add(r);r.addEventListener('dispose',()=>this.state.disposed.add(r));}}});} dispose(){this.state.rendererDisposed=true;} forceContextLoss(){this.state.contextReleased=true;} }`,loader:'js',resolveDir:process.cwd()}));}}]});
const {createGraph3D}=await import(pathToFileURL(join(directory,'renderer.mjs')).href);
test('3D controller uses real scene/camera geometry with mocked GPU: rotate, pan, zoom, select, update, cleanup',()=>{
 const dom=new JSDOM('<div id="host"></div>',{pretendToBeVisual:true});const originals=new Map();
 for(const [key,value] of Object.entries({window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement})) {originals.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});}
 const frames=new Map();let seq=0; globalThis.requestAnimationFrame=fn=>{frames.set(++seq,fn);return seq;};globalThis.cancelAnimationFrame=id=>frames.delete(id);
 const flush=()=>{const work=[...frames];frames.clear();for(const[,fn]of work)fn();};
 const host=document.getElementById('host');Object.defineProperties(host,{clientWidth:{value:720},clientHeight:{value:440}});
 const selected=[],edges=[];
 const options={model,visible:model,grouping,selected:null,neighborhood:true,neighbors:new Set(),matches:new Set(),pathNodes:new Set(),pathEdges:new Set(),labelMode:'all',labelSize:12,nodeScale:1,showRegions:true,directed:true,colorOf:()=> '#38bdf8',edgeColor:()=> '#a78bfa',regionColor:()=> '#a78bfa',onSelectNode:n=>selected.push(n.id),onSelectEdge:e=>edges.push(e.id),onHover:()=>{}};
 let failed=0;const api=createGraph3D(host,options,()=>failed++);flush();
 const state=globalThis.__webgl,canvas=host.querySelector('canvas');canvas.setPointerCapture=()=>{};canvas.releasePointerCapture=()=>{};canvas.hasPointerCapture=()=>false;canvas.getBoundingClientRect=()=>({left:0,top:0,width:720,height:440});
 assert.ok(state.renders>0); assert.equal(state.camera.isPerspectiveCamera,true);
 assert.equal(state.scene.children[0].children.filter(o=>o.userData.node).length,25);
 const region=state.scene.children[0].children.find(o=>o.userData.members);assert.ok(region.userData.members.length>0);assert.ok(region.material.opacity<0.15);
 const start=state.camera.position.clone();canvas.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'ArrowRight'}));flush();assert.notDeepEqual(state.camera.position.toArray(),start.toArray());
 const rotated=state.camera.position.clone();canvas.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'ArrowUp',shiftKey:true}));flush();assert.notDeepEqual(state.camera.position.toArray(),rotated.toArray());
 api.fit();flush();const beforeZoom=state.camera.position.length();api.zoom(1.3);flush();assert.notEqual(state.camera.position.length(),beforeZoom);
 api.fit();flush();
 const node=state.scene.children[0].children.find(o=>o.userData.node);const projected=node.position.clone().project(state.camera);const pointer={bubbles:true,clientX:(projected.x*.5+.5)*720,clientY:(-.5*projected.y+.5)*440,button:0};
 canvas.dispatchEvent(new dom.window.MouseEvent('pointerdown',pointer));canvas.dispatchEvent(new dom.window.MouseEvent('pointerup',pointer));assert.equal(selected[0],node.userData.node.id);
 api.update({...options,selected:'n0',matches:new Set(['n0'])});flush();assert.match(host.textContent,/Node 0/);assert.equal(failed,0);
 const filtered=filterGraph(model,{community:'g1'});api.update({...options,visible:filtered});flush();assert.equal(state.scene.children[0].children.filter(o=>o.userData.node).length,5);
 canvas.dispatchEvent(new dom.window.Event('webglcontextlost',{cancelable:true}));assert.equal(failed,1);
 api.zoom(1.1);assert.ok(frames.size);api.dispose();assert.equal(frames.size,0);assert.equal(host.children.length,0);assert.ok(state.rendererDisposed&&state.contextReleased);assert.equal(state.disposed.size,state.resources.size);
 const renderCount=state.renders;canvas.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'+'}));flush();assert.equal(state.renders,renderCount);api.dispose();
 dom.window.close();delete globalThis.requestAnimationFrame;delete globalThis.cancelAnimationFrame;delete globalThis.__webgl;for(const[key,value]of originals)value?Object.defineProperty(globalThis,key,value):delete globalThis[key];
});
test('Three and its controls are exclusively in lazy renderer, with a separate vendor chunk',async()=>{
 const panel=await readFile('src/components/panels/Graph3DView.tsx','utf8'),config=await readFile('vite.config.ts','utf8');
 assert.match(panel,/import\('\.\/graph3DRenderer'\)/);assert.match(panel,/cancelled = true/);assert.match(panel,/controller\.current\?\.dispose/);assert.match(config,/three-runtime/);
});

