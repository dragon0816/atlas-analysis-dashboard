import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildPortableBundle,canonicalBundleJson,parseHostProfile,suggestLogicalSources} from '../src/platform/portableBundle.ts';
const source={type:'json',fields:[{name:'sample',type:'number'},{name:'value',type:'number',unit:'dBm'}],data:[{sample:1,value:-60}],url:'http://private.invalid',query:{access_token:'must-not-travel'}};
const app={id:'portable',name:'Portable',sources:{samples:source},transforms:{ordered:[{op:'sort',by:'sample'}],unused:[{op:'unknown'}]},dashboards:[]};
const panel=(id,type)=>({id,title:id,type,datasource:{id:'samples'},transform:[{op:'ref',id:'ordered'}],mapping:type==='line'?{x:'sample',y:'value'}:type==='stat'?{value:'value'}:{},display:{},layout:{x:0,y:0,w:6,h:4}});
const board={schemaVersion:2,id:'portable-review',title:'Portable review',applicationId:app.id,variables:[],values:{},panels:[panel('curve','line'),panel('last','stat'),panel('rows','table')]};
const profile={format:'atlas.dashboard-host-capabilities',schemaVersion:1,bundleVersion:1,dashboardSchemaVersion:2,renderer:{version:'0.1.0',artifactSha256:'a'.repeat(64)},capabilities:Object.fromEntries(['panel.line','panel.stat','panel.table','transform.ref','transform.sort','dataset.table'].map(k=>[k,'verified'])),hostSources:['results.measurements'],maxBundleBytes:8*1024*1024};

test('portable export preserves settings, closes transform dependencies and excludes source transport/data',async()=>{
 const logical=suggestLogicalSources(board,app),before=structuredClone(board);
 const {bundle,text,warnings}=await buildPortableBundle(board,app,logical,profile,'test-revision');
 assert.deepEqual(board,before);assert.deepEqual(bundle.content.dashboard,board);assert.deepEqual(Object.keys(bundle.content.application.transforms),['ordered']);
 assert.equal(bundle.content.sourceBindings[0].requiredFields[1].unit,'dBm');assert.equal(bundle.manifest.requiredCapabilities.length,6);
 assert.doesNotMatch(text,/private.invalid|must-not-travel/);assert.match(warnings[0],/AEP SQL\/Python/);
 const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(canonicalBundleJson(bundle.content)));
 assert.equal(bundle.manifest.contentSha256,Buffer.from(digest).toString('hex'));
});
test('unknown renderer, unsupported or disabled capability and target capacity refuse export',async()=>{
 const logical=suggestLogicalSources(board,app);
 assert.throws(()=>parseHostProfile({...profile,renderer:{...profile.renderer,version:'1.0.0'}}),/renderer 0.1/);
 await assert.rejects(buildPortableBundle(board,app,logical,{...profile,capabilities:{}},'r'),/Target does not support/);
 await assert.rejects(buildPortableBundle(board,app,logical,{...profile,maxBundleBytes:1},'r'),/size limit/);
 const changed=structuredClone(board);changed.panels[0].interaction={on_click:{action:'open_link',url:'https://example.org'}};
 await assert.rejects(buildPortableBundle(changed,app,logical,{...profile,capabilities:{...profile.capabilities,'action.open_link':'disabled'}},'r'),/action.open_link/);
});
test('logical sources cannot smuggle credentials or data and every required field is explicit',async()=>{
 const logical=suggestLogicalSources(board,app);
 for(const extra of [{url:'https://example.org'},{provider:'custom'},{data:[]},{headers:{}}])await assert.rejects(buildPortableBundle(board,app,[{...logical[0],...extra}],profile,'r'),/cannot carry/);
 await assert.rejects(buildPortableBundle(board,app,[{...logical[0],requiredFields:[]}],profile,'r'),/Declare required fields/);
 const changed=structuredClone(board);changed.panels[0].query={access_token:'private'};
 await assert.rejects(buildPortableBundle(changed,app,logical,profile,'r'),/Credential-like/);
});
test('join dependencies must be declared; missing and cyclic refs fail before output',async()=>{
 const joined=structuredClone(board);joined.panels[0].transform=[{op:'join',source:'other',on:{left:'sample',right:'sample'}}];
 const otherApp={...app,sources:{...app.sources,other:source}},logical=suggestLogicalSources(joined,otherApp);
 assert.equal(logical.length,2);await assert.rejects(buildPortableBundle(joined,otherApp,[logical[0]],profile,'r'),/each used source/);
 const cyclic={...app,transforms:{ordered:[{op:'ref',id:'ordered'}]}};
 assert.throws(()=>suggestLogicalSources(board,cyclic),/cycle/);
 assert.throws(()=>suggestLogicalSources(board,{...app,transforms:{}}),/Missing transform/);
});
