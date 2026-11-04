/** Portable bundle writer. Target capabilities and logical data must be explicit. */
import {validateDashboardDocument} from "./documents.ts";
import type {ApplicationDefinition,DashboardDocument,DatasetField,TransformStep} from "./types";

export interface LogicalSource {logicalId:string;datasetKind:"table"|"graph";requiredFields:DatasetField[];variableBindings?:Record<string,string>}
export interface HostProfile {format:"atlas.dashboard-host-capabilities";schemaVersion:1;bundleVersion:1;dashboardSchemaVersion:2;renderer:{version:string;artifactSha256:string};capabilities:Record<string,string>;maxBundleBytes:number;hostSources:string[]}
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==="object"&&!Array.isArray(v);
const forbidden=new Set(["__proto__","prototype","constructor"]);
const ops=new Set(["filter","normalize","join","group","aggregate","calculate","derive","sort","limit","ref"]);
function scan(value:unknown){
 const pending:[unknown,number][]=[[value,0]];let count=0;
 while(pending.length){const [item,depth]=pending.pop()!;if(depth>64||++count>200000)throw new Error("Bundle exceeds depth/value limit");
  if(typeof item==="number"&&!Number.isFinite(item))throw new Error("Bundle numbers must be finite");
  if(Array.isArray(item))for(const v of item)pending.push([v,depth+1]);
  else if(object(item))for(const [key,v] of Object.entries(item)){if(forbidden.has(key))throw new Error(`Forbidden key: ${key}`);if(/^(authorization|password|passwd|api[_-]?key|access[_-]?token|client[_-]?secret)$/i.test(key))throw new Error(`Credential-like field cannot be exported: ${key}`);pending.push([v,depth+1]);}
 }
}
export function canonicalBundleJson(value:unknown):string {
 if(value===null||typeof value==="string"||typeof value==="boolean")return JSON.stringify(value);
 if(typeof value==="number"){if(!Number.isFinite(value))throw new Error("Finite numbers required");return Object.is(value,-0)?"0":String(value);}
 if(Array.isArray(value))return `[${value.map(canonicalBundleJson).join(",")}]`;
 if(object(value))return `{${Object.keys(value).sort().map(k=>`${JSON.stringify(k)}:${canonicalBundleJson(value[k])}`).join(",")}}`;
 throw new Error("Expected JSON value");
}
export function parseHostProfile(value:unknown):HostProfile {
 if(!object(value)||value.format!=="atlas.dashboard-host-capabilities"||value.schemaVersion!==1||value.bundleVersion!==1||value.dashboardSchemaVersion!==2)throw new Error("Choose a compatible Atlas host profile (bundleVersion 1, dashboard schema 2)");
 if(!object(value.renderer)||typeof value.renderer.version!=="string"||!/^0\.1\.\d+$/.test(value.renderer.version)||typeof value.renderer.artifactSha256!=="string"||!/^[0-9a-f]{64}$/.test(value.renderer.artifactSha256))throw new Error("This exporter supports renderer 0.1.x only; use the target host's exported profile");
 if(!object(value.capabilities)||typeof value.maxBundleBytes!=="number"||value.maxBundleBytes<1||!Array.isArray(value.hostSources))throw new Error("Incomplete host profile");
 scan(value);return value as unknown as HostProfile;
}
function dependencies(board:DashboardDocument,app:ApplicationDefinition){
 const sourceIds=new Set<string>(),transforms:Record<string,TransformStep[]>={},capabilities=new Set<string>();
 function steps(items:TransformStep[],path:string[]=[]){
  if(!Array.isArray(items)||items.length>64)throw new Error("At most 64 transform steps allowed");
  for(const step of items){
   if(!ops.has(step.op))throw new Error(`Unsupported transform: ${step.op}`);capabilities.add(`transform.${step.op}`);
   if(step.op==="join"){if(typeof step.source!=="string")throw new Error("Join source id required");sourceIds.add(step.source);}
   if(step.op==="ref"){
    const id=String(step.id??"");if(path.includes(id)||path.length>=8)throw new Error("Transform cycle or depth over 8");
    if(!Object.hasOwn(app.transforms,id))throw new Error(`Missing transform: ${id}`);
    transforms[id]=app.transforms[id];steps(transforms[id],[...path,id]);
   }
  }
 }
 for(const panel of board.panels){sourceIds.add(panel.datasource.id);capabilities.add(`panel.${panel.type}`);steps(panel.transform);
  for(const action of [panel.interaction?.on_click].flat().filter(Boolean))capabilities.add(`action.${action!.action}`);
  if(panel.type==="network"&&panel.display.graphDimension==="3d")capabilities.add("display.network.3d");
 }
 for(const variable of board.variables)capabilities.add(`variable.${variable.type??"string"}`);
 for(const id of sourceIds)if(!Object.hasOwn(app.sources,id))throw new Error(`Application source not found: ${id}`);
 return {sourceIds,transforms,capabilities};
}
export function suggestLogicalSources(board:DashboardDocument,app:ApplicationDefinition):LogicalSource[] {
 return [...dependencies(board,app).sourceIds].map(id=>({logicalId:id,datasetKind:app.sources[id].format==="graph"?"graph":"table",requiredFields:(app.sources[id].fields??[]).map(f=>({name:f.name,type:f.type,...(f.unit?{unit:f.unit}:{})})),...(app.sources[id].bindings?{variableBindings:app.sources[id].bindings}:{})}));
}
export async function buildPortableBundle(board:DashboardDocument,app:ApplicationDefinition,bindings:unknown,profileValue:unknown,authoringCommit:string){
 validateDashboardDocument(board);scan(board);const profile=parseHostProfile(profileValue),deps=dependencies(board,app);
 if(board.applicationId!==app.id)throw new Error("Dashboard/application identity mismatch");
 if(!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(board.id))throw new Error("Portable id must be 1..128 safe characters");
 if(!authoringCommit||authoringCommit.length>256)throw new Error("Authoring revision is required");
 if(!Array.isArray(bindings)||bindings.length!==deps.sourceIds.size||bindings.length>64)throw new Error("Declare each used source exactly once");
 const sources:LogicalSource[]=[],seen=new Set<string>();
 for(const raw of bindings){
  if(!object(raw)||Object.keys(raw).some(k=>!["logicalId","datasetKind","requiredFields","variableBindings"].includes(k)))throw new Error("Logical sources cannot carry URLs, paths, providers, headers, data or code");
  const {logicalId,datasetKind,requiredFields,variableBindings}=raw;
  if(typeof logicalId!=="string"||!deps.sourceIds.has(logicalId)||seen.has(logicalId))throw new Error("Unknown or duplicate logical source");seen.add(logicalId);
  if(datasetKind!=="table"&&datasetKind!=="graph")throw new Error("Declare table or graph dataset kind");
  if(!Array.isArray(requiredFields)||!requiredFields.length||requiredFields.length>256)throw new Error(`Declare required fields for ${logicalId}; they cannot be inferred from a screenshot`);
  const names=new Set<string>();
  for(const field of requiredFields){
   if(!object(field)||Object.keys(field).some(k=>!["name","type","unit"].includes(k))||typeof field.name!=="string"||!field.name||field.name.length>256||names.has(field.name)||!["number","string","boolean","time","other"].includes(String(field.type))||(field.unit!==undefined&&typeof field.unit!=="string"))throw new Error("Invalid/duplicate required field");names.add(field.name);
  }
  if(variableBindings!==undefined&&(!object(variableBindings)||Object.entries(variableBindings).some(([field,id])=>!names.has(field)||!board.variables.some(v=>v.id===id))))throw new Error("Variable binding references an undeclared field or variable");
  deps.capabilities.add(`dataset.${datasetKind}`);sources.push(structuredClone(raw) as unknown as LogicalSource);
 }
 for(const capability of deps.capabilities)if(!["verified","available"].includes(profile.capabilities[capability]))throw new Error(`Target does not support ${capability}`);
 const content={dashboard:structuredClone(board),application:{id:app.id,name:app.name,transforms:structuredClone(deps.transforms)},sourceBindings:sources};
 scan(content);
 const digest=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(canonicalBundleJson(content)));
 const bundle={format:"atlas-analysis-dashboard-bundle",bundleVersion:1,manifest:{id:board.id,createdAt:new Date().toISOString(),authoringCommit,renderer:profile.renderer,dashboardSchemaVersion:2,requiredCapabilities:[...deps.capabilities].sort(),optionalCapabilities:[],contentSha256:[...new Uint8Array(digest)].map(v=>v.toString(16).padStart(2,"0")).join("")},content};
 const text=JSON.stringify(bundle,null,2)+"\n";
 if(new TextEncoder().encode(text).length>Math.min(8*1024*1024,profile.maxBundleBytes))throw new Error("Bundle exceeds the target size limit");
 return {bundle,text,warnings:["Data, source credentials and AEP SQL/Python operations are not exported. Bind equivalent computed data on the destination.",...([...deps.capabilities].some(c=>profile.capabilities[c]==="available")?["Some capabilities are available but not verified on the target; inspect the preview."]:[])]};
}
