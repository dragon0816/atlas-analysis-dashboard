/** Durable scalar replay for the opt-in Atlas host acquisition journal. */
import {SimulationState,simulationStatistics} from "./simulation.ts";
import type {DatasetObserver,SourceProvider} from "../sources";
import type {Row,SourceDefinition,TabularDataset} from "../types";

const record=(v:unknown):v is Row=>!!v&&typeof v==="object"&&!Array.isArray(v);
const idPattern=/^[0-9a-f]{32}$/;
const stable=(value:unknown)=>JSON.stringify(value,(_key,v)=>record(v)?Object.fromEntries(Object.keys(v).sort().map(key=>[key,v[key]])):v);
export class DurableSimulationState {
  private scalar=new SimulationState(1);
  runId:string|null=null;
  private applied=0;
  private fingerprints=new Map<number,string>();
  private pending=new Map<number,Row>();
  private retired=new Set<string>();
  private warnings=new Set<string>();
  private state="waiting";
  private recovering=false;
  opened(){if(!this.runId)this.scalar.opened();else this.scalar.connected();this.recovering=true;}
  disconnected(){this.scalar.disconnected();}
  warn(message:string){if(this.warnings.size<10)this.warnings.add(message.slice(0,240));}
  gap(){return this.pending.size>0;}
  sequence(){return this.applied;}
  accept(raw:unknown){
    if(!record(raw)||raw.runner!==1||!["start","result","end"].includes(String(raw.event)))return;
    if(typeof raw.data!=="string")throw new Error("Invalid acquisition envelope");
    const data:unknown=JSON.parse(raw.data);
    if(!record(data))throw new Error("Invalid acquisition payload");
    if(data.acquisition_contract!=="atlas.acquisition.v1"){
      if(data.persistence_error){this.state="error";this.warn(`Execution incomplete: persistence failed: ${String(data.persistence_error)}`);return;}
      if(this.runId){this.warn("Unidentified legacy event ignored during a durable execution");return;}
      this.recovering=false;this.scalar.accept(raw);return;
    }
    if(typeof data.run_id!=="string"||!idPattern.test(data.run_id)||!Number.isSafeInteger(data.event_sequence)||Number(data.event_sequence)<1||Number(data.event_sequence)>5002)throw new Error("Invalid durable acquisition identity/sequence (PoC limit 5000 results)");
    const id=data.run_id,sequence=Number(data.event_sequence);
    if(this.retired.has(id)){this.warn("Late event from a previous execution ignored");return;}
    if(this.runId!==id){
      if(this.runId&&raw.event!=="start"){this.warn("Unannounced execution ignored until start/recovery");return;}
      if(this.runId)this.retired.add(this.runId);
      while(this.retired.size>16)this.retired.delete(this.retired.values().next().value!);
      this.runId=id;this.applied=0;this.pending.clear();this.fingerprints.clear();this.warnings.clear();
      this.scalar=new SimulationState(1);this.scalar.opened();this.state="running";
    }
    const fingerprint=stable({event:raw.event,data});
    const previous=this.fingerprints.get(sequence);
    if(previous){if(previous!==fingerprint)this.warn(`Conflicting durable event ${sequence}; first record retained`);this.recovering=false;return;}
    this.fingerprints.set(sequence,fingerprint);this.pending.set(sequence,raw);
    while(this.pending.has(this.applied+1)){
      const event=this.pending.get(this.applied+1)!;
      if(this.applied===0&&event.event!=="start")throw new Error("Durable replay must start with start");
      this.scalar.accept(event);
      this.pending.delete(++this.applied);
      if(event.event==="end"){
        const end=JSON.parse(String(event.data));this.state=String(end.state??"interrupted");
        if(end.complete!==true||this.state!=="completed")this.warn(`Execution incomplete: ${this.state}`);
      }
    }
    this.recovering=false;
  }
  restored(metadata:Row){
    if(metadata.run_id!==this.runId)return;
    if(Array.isArray(metadata.warnings))for(const warning of metadata.warnings)if(typeof warning==="string")this.warn(warning);
    this.state=String(metadata.state??"interrupted");this.recovering=false;
    if(metadata.complete!==true&&this.state!=="running")this.warn(`Execution incomplete: saved ${metadata.received}/${metadata.expected} (${this.state})`);
  }
  snapshot():TabularDataset {
    const data=this.scalar.snapshot();
    const sourceWarnings=this.runId?data.meta.warnings.map(w=>w.replace("execution identity is session-local","durable execution identity")):data.meta.warnings;
    const warnings=[...(this.runId?[`Durable run ${this.runId} · ${this.state} · event ${this.applied}`]:[]),
      ...(this.gap()?[`Missing event ${this.applied+1}; displayed prefix is incomplete, recovery requested`]:[]),
      ...this.warnings,...sourceWarnings];
    if(this.recovering)warnings.unshift("Reconnecting: awaiting durable replay/recovery");
    return {...data,fields:[...data.fields,{name:"run_id",type:"string"}],rows:data.rows.map(row=>({...row,run_id:this.runId})),meta:{...data.meta,warnings,revision:`${this.runId}:${this.applied}:${this.state}:${this.gap()}`}};
  }
}

type Stream=Pick<EventSource,"addEventListener"|"close">&{onopen:((e:Event)=>unknown)|null;onerror:((e:Event)=>unknown)|null};
interface Dependencies {fetch?:typeof fetch;eventSource?:(url:string)=>Stream;timeoutMs?:number}
export class DurableAtlasSimulationProvider implements SourceProvider {
  private state=new DurableSimulationState();
  private observers=new Set<DatasetObserver>();
  private stream:Stream|null=null;
  private controller=new AbortController();
  private initial:Promise<void>|null=null;
  private recovery:Promise<void>|null=null;
  private lastRecovery=0;
  private recoveryRunId:string|null=null;
  private recoveryAttempts=0;
  private recoveryTimer:ReturnType<typeof setTimeout>|undefined;
  private timer:ReturnType<typeof setTimeout>|undefined;
  private closeTimer:ReturnType<typeof setTimeout>|undefined;
  private disposed=false;
  private deps:Dependencies;
  constructor(deps:Dependencies={}){this.deps=deps;}
  private validate(definition:SourceDefinition,query:Row){
    if(this.disposed)throw new Error("Acquisition provider disposed");
    if(definition.url!=="/atlas-api/instances/events"||query.runner!==1||(query.view!==undefined&&query.view!=="statistics"))throw new Error("Acquisition PoC uses only fixed local runner 1");
  }
  private async get(path:string):Promise<Row>{
    const timeout=new AbortController(),timer=setTimeout(()=>timeout.abort(new Error("Acquisition request timed out")),this.deps.timeoutMs??5000);
    const signal=AbortSignal.any([this.controller.signal,timeout.signal]);
    try{
      const response=await (this.deps.fetch??globalThis.fetch)(`/atlas-api${path}`,{signal,credentials:"same-origin",redirect:"error",cache:"no-store"});
      if(!response.ok)throw new Error(`Acquisition HTTP ${response.status}`);
      if(Number(response.headers.get("content-length"))>8*1024*1024)throw new Error("Acquisition response exceeds 8 MiB");
      let text="",bytes=0;
      if(response.body){const reader=response.body.getReader(),decoder=new TextDecoder();try{while(true){const next=await reader.read();if(next.done)break;bytes+=next.value.byteLength;if(bytes>8*1024*1024)throw new Error("Acquisition response exceeds 8 MiB");text+=decoder.decode(next.value,{stream:true});}text+=decoder.decode();}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}}
      else{text=await response.text();if(new TextEncoder().encode(text).length>8*1024*1024)throw new Error("Acquisition response exceeds 8 MiB");}
      signal.throwIfAborted();const value:unknown=JSON.parse(text);if(!record(value))throw new Error("Invalid acquisition response");return value;
    }finally{clearTimeout(timer);}
  }
  private async restore(id:string,adopt=false){
    if(!idPattern.test(id))throw new Error("Invalid saved acquisition id");
    let after=0;
    for(let page=0;page<6;page++){
      const data=await this.get(`/acquisitions/${id}?after=${after}&limit=1000`);
      if(this.disposed||(!adopt&&this.state.runId!==id))return;
      if(data.run_id!==id||data.schemaVersion!==1||data.runner!==1||!Array.isArray(data.events)||data.events.length>1000)throw new Error("Invalid acquisition page identity");
      // Do not let a slow initial restore replace a newer live execution.
      if(adopt&&this.state.runId&&this.state.runId!==id)return;
      for(const event of data.events)this.state.accept(event);
      if(data.next_after===null){this.state.restored(data);this.emit();return;}
      if(!Number.isSafeInteger(data.next_after)||Number(data.next_after)<=after)throw new Error("Non-advancing acquisition page");
      after=Number(data.next_after);
    }
    throw new Error("Saved acquisition exceeds the 5000-result PoC replay limit");
  }
  private initialize(){
    if(!this.initial)this.initial=(async()=>{try{const listing=await this.get("/acquisitions?runner=1&limit=1");if(!Array.isArray(listing.files))throw new Error("Invalid acquisition list");const latest=listing.files[0];if(record(latest)&&typeof latest.run_id==="string")await this.restore(latest.run_id,true);}catch(ex){if(!this.disposed)this.state.warn(`Saved acquisition unavailable: ${String(ex)}`);}})();
    return this.initial;
  }
  private recover(){
    const id=this.state.runId;
    if(!id||this.disposed||!this.stream||!this.observers.size||this.recovery)return;
    if(this.recoveryRunId!==id){this.recoveryRunId=id;this.recoveryAttempts=0;this.lastRecovery=0;}
    if(this.recoveryAttempts>=3){this.state.warn("Recovery retry limit reached; snapshot may be incomplete. Reconnect to retry.");this.emit();return;}
    const delay=Math.max(0,1000-(Date.now()-this.lastRecovery));
    if(delay){if(this.recoveryTimer===undefined)this.recoveryTimer=setTimeout(()=>{this.recoveryTimer=undefined;this.recover();},delay);return;}
    clearTimeout(this.recoveryTimer);this.recoveryTimer=undefined;
    this.lastRecovery=Date.now();this.recoveryAttempts++;let failed=false;
    this.recovery=this.restore(id).catch(ex=>{failed=true;if(!this.disposed)this.state.warn(`Recovery failed: ${String(ex)}`);}).finally(()=>{
      this.recovery=null;this.emit();
      if(this.state.runId!==id){if(this.state.gap())this.recover();return;}
      if(failed||this.state.gap())this.recover();else this.recoveryAttempts=0;
    });
  }
  private dataset(data:TabularDataset,query:Row):TabularDataset{
    if(query.view!=="statistics")return data;
    const stats=simulationStatistics(data);return {kind:"table",fields:Object.keys(stats).map(name=>({name,type:name==="coverage"?"string":"number"})),rows:[stats],meta:data.meta};
  }
  describe=async()=>({live:true,fields:this.state.snapshot().fields});
  query=async(definition:SourceDefinition,query:Row,signal:AbortSignal)=>{this.validate(definition,query);signal.throwIfAborted();await this.initialize();signal.throwIfAborted();this.controller.signal.throwIfAborted();return this.dataset(this.state.snapshot(),query);};
  private emit(){if(this.disposed||this.timer!==undefined)return;this.timer=setTimeout(()=>{this.timer=undefined;const data=this.state.snapshot();for(const observer of this.observers)observer.next(data);},100);}
  subscribe=(definition:SourceDefinition,query:Row,observer:DatasetObserver,signal:AbortSignal)=>{
    this.validate(definition,query);signal.throwIfAborted();clearTimeout(this.closeTimer);
    const sink:DatasetObserver={...observer,next:data=>observer.next(this.dataset(data as TabularDataset,query))};this.observers.add(sink);
    if(!this.stream){
      let stream:Stream;
      try{stream=(this.deps.eventSource??(url=>new EventSource(url)))(definition.url!);this.stream=stream;}
      catch(ex){this.observers.delete(sink);throw ex;}
      stream.onopen=()=>{if(this.stream!==stream)return;this.state.opened();this.recoveryAttempts=0;this.recover();this.emit();};
      stream.onerror=()=>{if(this.stream!==stream)return;this.state.disconnected();this.emit();};
      stream.addEventListener("mux",event=>{if(this.disposed||this.stream!==stream)return;try{const text=(event as MessageEvent).data;if(typeof text!=="string"||new TextEncoder().encode(text).length>64*1024)throw new Error("Acquisition event exceeds 64 KB");this.state.accept(JSON.parse(text));if(this.state.gap())this.recover();}catch(ex){this.state.warn(`Invalid acquisition: ${String(ex)}`);}this.emit();});
    }
    sink.next(this.state.snapshot());let stopped=false;
    const stop=()=>{if(stopped)return;stopped=true;signal.removeEventListener("abort",stop);this.observers.delete(sink);if(!this.observers.size)this.closeTimer=setTimeout(()=>this.close(),120);};
    signal.addEventListener("abort",stop,{once:true});if(signal.aborted)stop();return stop;
  };
  private close(){this.stream?.close();this.stream=null;clearTimeout(this.timer);this.timer=undefined;clearTimeout(this.recoveryTimer);this.recoveryTimer=undefined;}
  dispose(){if(this.disposed)return;this.disposed=true;this.controller.abort();clearTimeout(this.closeTimer);this.close();this.observers.clear();}
}
