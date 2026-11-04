/** Adapter for Atlas's completed scalar simulation samples, not AEP telemetry. */
import type {DatasetObserver, SourceProvider} from "../sources";
import type {Row, SourceDefinition, TabularDataset} from "../types";

const record = (value: unknown): value is Row => !!value && typeof value === "object" && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const MAX_ROWS = 5000;
export class SimulationState {
  private rows = new Map<number, Row>();
  private warnings = new Set<string>();
  private total = 0;
  private ended = false;
  private overflow = false;
  private connection = "waiting";
  private generation = 0;
  readonly runner:number;
  constructor(runner = 1) {
    this.runner=runner;
    if (!Number.isInteger(runner) || runner < 1) throw new Error("Runner must be 1-based");
  }
  opened() {
    // Atlas replays the current start/result/end buffer on every connection.
    // Rebuild rather than merging an unidentified previous execution.
    this.rows.clear();this.warnings.clear();this.total=0;this.ended=false;this.overflow=false;
    this.connection="connected, awaiting replay";
  }
  disconnected() {this.connection="STALE: disconnected; automatic reconnect pending";}
  connected() {this.connection="connected";}
  invalid(message: string) {if(this.warnings.size<20)this.warnings.add(message.slice(0,240));else this.warnings.add("Additional diagnostics omitted");}
  accept(raw: unknown) {
    if (!record(raw) || raw.runner !== this.runner) return;
    if (typeof raw.event !== "string" || typeof raw.data !== "string") throw new Error("Malformed Atlas mux envelope");
    if (!["start","result","end"].includes(raw.event)) return;
    const data: unknown=JSON.parse(raw.data);
    if (!record(data)) throw new Error("Malformed Atlas event");
    if (raw.event === "start") {
      if (!Number.isInteger(data.testcases) || Number(data.testcases)<0) throw new Error("Invalid test count");
      this.generation++;this.rows.clear();this.warnings.clear();this.overflow=false;
      this.total=Number(data.testcases);this.ended=false;this.connection="connected";
      if(this.total>MAX_ROWS)this.invalid("Plan exceeds the 5000-row adapter limit");
      return;
    }
    if(raw.event === "end") {this.ended=true;this.connection="connected";return;}
    if(!Number.isInteger(data.index))throw new Error("Result index must be an integer");
    const index=Number(data.index);
    if(index<1)throw new Error("Result index must be positive");
    if(index>MAX_ROWS){this.overflow=true;this.invalid("Results truncated at 5000 rows");return;}
    const measurements=record(data.results)&&record(data.results.Simulation)?data.results.Simulation:null;
    const read=(key:string)=>{const tuple=measurements?.[key];return Array.isArray(tuple)&&[2,9].includes(tuple.length)?tuple[0]:undefined;};
    const stats=record(data.stats)?data.stats:{};
    let row: Row;
    if(typeof stats.error === "string" && data.name === "Simulated power sample") {
      row={index,sequence:null,acquired_at:null,power_dbm:null,setpoint_dbm:null,error_db:null,frequency_hz:null,verdict:"error",error:stats.error};
    } else {
      if(read("contract")!=="atlas.simulation.power.v1")return;
      const sequence=read("sequence"), time=read("acquired_at");
      if(!Number.isInteger(sequence)||Number(sequence)<1||typeof time!=="string"||!Number.isFinite(Date.parse(time))||read("timestamp_kind")!=="synthetic")throw new Error("Simulation sequence/time metadata is invalid");
      for(const key of ["power_dbm","setpoint_dbm","error_db","frequency_hz"])if(!finite(read(key)))throw new Error(`Non-numeric simulation ${key}`);
      for(const [key,unit]of [["power_dbm","dBm"],["setpoint_dbm","dBm"],["error_db","dB"],["frequency_hz","Hz"]]) {
        const tuple=measurements?.[key];if(!Array.isArray(tuple)||tuple[1]!==unit)throw new Error(`Invalid unit for ${key}`);
      }
      const delta=measurements?.error_db;
      // CheckedResult verdict is index 8. Never derive PASS from the whole test.
      const verdict=Array.isArray(delta)&&delta.length===9&&typeof delta[8]==="boolean"?(delta[8]?"pass":"fail"):"unchecked";
      row={index,sequence,acquired_at:time,timestamp_kind:"synthetic",power_dbm:read("power_dbm"),setpoint_dbm:read("setpoint_dbm"),error_db:read("error_db"),frequency_hz:read("frequency_hz"),verdict,
        lower_db:Array.isArray(delta)&&finite(delta[2])?delta[2]:null,upper_db:Array.isArray(delta)&&finite(delta[3])?delta[3]:null};
      if(sequence!==index)this.invalid("Acquisition sequence differs from testcase index; inspect plan order");
    }
    const existing=this.rows.get(index);
    if(existing){if(JSON.stringify(existing)!==JSON.stringify(row))this.invalid(`Conflicting replay at result ${index}`);return;}
    this.rows.set(index,row);this.connection="connected";
  }
  snapshot():TabularDataset {
    const rows=[...this.rows.values()].sort((a,b)=>Number(a.index)-Number(b.index));
    const diagnostics=[...this.warnings];
    if(rows.length && rows.some((row,i)=>row.index!==i+1))diagnostics.push("Missing result indices; snapshot is incomplete");
    if(this.ended&&rows.length!==this.total)diagnostics.push(`Execution ended with ${rows.length}/${this.total} simulation results (stopped, missing, or mixed plan)`);
    // Panel chrome shows two warnings: keep connection/integrity ahead of context.
    const warnings=[`Stream ${this.connection}; execution identity is session-local`,...diagnostics,"Synthetic acquisition timestamps; completed scalar samples only"];
    return {kind:"table",fields:[
      {name:"index",type:"number"},{name:"sequence",type:"number"},{name:"acquired_at",type:"time"},
      {name:"power_dbm",type:"number",unit:"dBm"},{name:"setpoint_dbm",type:"number",unit:"dBm"},
      {name:"error_db",type:"number",unit:"dB"},{name:"frequency_hz",type:"number",unit:"Hz"},
      {name:"verdict",type:"string"},{name:"error",type:"string"},{name:"lower_db",type:"number"},{name:"upper_db",type:"number"},
    ],rows,meta:{warnings,truncated:this.overflow,sourceRows:rows.length,revision:`${this.generation}:${rows.length}:${this.connection}`}};
  }
}

type EventStream = Pick<EventSource,"addEventListener"|"close"> & {onopen:((event:Event)=>unknown)|null;onerror:((event:Event)=>unknown)|null};
/** One shared connection per application runtime. Panels consume bounded snapshots. */
export class AtlasSimulationProvider implements SourceProvider {
  private state=new SimulationState(1);
  private observers=new Set<DatasetObserver>();
  private stream:EventStream|null=null;
  private flush:ReturnType<typeof setTimeout>|undefined;
  private disposeTimer:ReturnType<typeof setTimeout>|undefined;
  private disposed=false;
  private factory:(url:string)=>EventStream;
  constructor(factory:(url:string)=>EventStream=url=>new EventSource(url)){this.factory=factory;}
  private validate(definition:SourceDefinition,query:Row) {
    if(definition.url!=="/atlas-api/instances/events"||query.runner!==1)throw new Error("Simulation PoC supports only the fixed local Atlas stream and runner 1");
    if(query.view!==undefined&&query.view!=="statistics")throw new Error("Unknown simulation view");
  }
  private dataset(query:Row) {const data=this.state.snapshot();return query.view==="statistics"?statisticsDataset(data):data;}
  describe=async()=>({live:true,fields:this.state.snapshot().fields});
  query=async(definition:SourceDefinition,query:Row,signal:AbortSignal)=>{
    this.validate(definition,query);if(signal.aborted)throw signal.reason;
    if(this.disposed)throw new Error("Simulation provider disposed");return this.dataset(query);
  };
  private schedule() {
    if(this.flush!==undefined)return;
    this.flush=setTimeout(()=>{this.flush=undefined;const snapshot=this.state.snapshot();for(const o of this.observers)o.next(snapshot);},100);
  }
  subscribe=(definition:SourceDefinition,query:Row,observer:DatasetObserver,signal:AbortSignal)=>{
    this.validate(definition,query);if(signal.aborted)throw signal.reason;
    if(this.disposed)throw new Error("Simulation provider disposed");
    clearTimeout(this.disposeTimer);
    const sink:DatasetObserver={...observer,next:data=>observer.next(query.view==="statistics"?statisticsDataset(data as TabularDataset):data)};
    this.observers.add(sink);
    if(!this.stream){
      try {
        this.stream=this.factory(definition.url!);
        this.stream.onopen=()=>{this.state.opened();this.schedule();};
        this.stream.onerror=()=>{this.state.disconnected();this.schedule();};
        this.stream.addEventListener("mux",event=>{
          try {const text=(event as MessageEvent).data;if(typeof text!=="string"||text.length>64_000)throw new Error("Atlas event exceeds 64 KB");this.state.accept(JSON.parse(text));}
          catch(ex){this.state.invalid(`Invalid event: ${String(ex)}`);}this.schedule();
        });
      }catch(ex){this.observers.delete(sink);this.stream?.close();this.stream=null;throw ex;}
    }
    sink.next(this.state.snapshot());
    let stopped=false;
    const stop=()=>{if(stopped)return;stopped=true;signal.removeEventListener("abort",stop);this.observers.delete(sink);if(!this.observers.size)this.disposeTimer=setTimeout(()=>this.close(),120);};
    signal.addEventListener("abort",stop,{once:true});return stop;
  };
  private close(){this.stream?.close();this.stream=null;clearTimeout(this.flush);this.flush=undefined;}
  dispose(){if(this.disposed)return;this.disposed=true;clearTimeout(this.disposeTimer);this.close();this.observers.clear();}
}

/** Statistics count only checked error_db measurements; errors/unchecked stay separate. */
export function simulationStatistics(dataset:TabularDataset) {
  const pass=dataset.rows.filter(r=>r.verdict==="pass").length, fail=dataset.rows.filter(r=>r.verdict==="fail").length;
  const error=dataset.rows.filter(r=>r.verdict==="error").length, unchecked=dataset.rows.filter(r=>r.verdict==="unchecked").length;
  const numeric=dataset.rows.filter(r=>finite(r.error_db));
  const mean=numeric.length?numeric.reduce((sum,r)=>sum+Number(r.error_db),0)/numeric.length:null;
  const sigma=mean!==null&&numeric.length>1?Math.sqrt(numeric.reduce((sum,r)=>sum+(Number(r.error_db)-mean)**2,0)/(numeric.length-1)):null;
  const limits=numeric.map(r=>`${r.lower_db}:${r.upper_db}`), consistent=new Set(limits).size===1;
  const first=numeric[0];
  const cpk=consistent&&first&&finite(first.lower_db)&&finite(first.upper_db)&&first.lower_db<first.upper_db&&mean!==null&&sigma!==null&&sigma>0?Math.min((Number(first.upper_db)-mean)/(3*sigma),(mean-Number(first.lower_db))/(3*sigma)):null;
  return {samples:dataset.rows.length,pass,fail,error,unchecked,pass_rate:pass+fail?pass/(pass+fail):null,mean_error_db:mean,sample_sigma_db:sigma,cpk,
    coverage:dataset.meta.truncated?"truncated snapshot":dataset.meta.warnings.some(w=>/incomplete|Execution ended with|STALE/.test(w))?"incomplete or stale snapshot":"current execution snapshot"};
}

function statisticsDataset(data:TabularDataset):TabularDataset {
  const stats=simulationStatistics(data);
  return {kind:"table",fields:Object.keys(stats).map(name=>({name,type:name==="coverage"?"string":"number"})),rows:[stats],meta:data.meta};
}
