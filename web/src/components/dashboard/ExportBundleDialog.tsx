import {useState} from "react";
import {buildPortableBundle,suggestLogicalSources} from "../../platform/portableBundle";
import type {ApplicationDefinition,DashboardDocument} from "../../platform/types";

/** Export a frozen snapshot, with explicit target capabilities and data declarations. */
export function ExportBundleDialog({document,application,onClose}:{document:DashboardDocument;application:ApplicationDefinition;onClose:()=>void}){
 const [profile,setProfile]=useState(""),[bindings,setBindings]=useState(()=>JSON.stringify(suggestLogicalSources(document,application),null,2));
 const [revision,setRevision]=useState("uncommitted-working-tree"),[error,setError]=useState(""),[busy,setBusy]=useState(false);
 const [result,setResult]=useState<Awaited<ReturnType<typeof buildPortableBundle>>|null>(null);
 const preview=async()=>{setBusy(true);setError("");setResult(null);try{setResult(await buildPortableBundle(document,application,JSON.parse(bindings),JSON.parse(profile),revision));}catch(ex){setError(ex instanceof Error?ex.message:String(ex));}finally{setBusy(false);}};
 const download=()=>{if(!result)return;const url=URL.createObjectURL(new Blob([result.text],{type:"application/json"})),link=window.document.createElement("a");link.href=url;link.download=`${document.id}.atlas-bundle.json`;link.click();setTimeout(()=>URL.revokeObjectURL(url),0);};
 return <div className="atlas-modal-backdrop"><section className="atlas-modal" style={{maxWidth:900,maxHeight:"90vh",overflow:"auto"}} role="dialog" aria-modal="true" aria-label="Export for Atlas">
  <h2>Export for Atlas</h2><p>Snapshot: {document.title}. On the destination, open Imported dashboards and export its host profile first. Data and AEP SQL/Python are not included; bind equivalent computed rows after import.</p>
  <label className="block">Destination host profile<input type="file" accept=".json,application/json" onChange={async event=>{setResult(null);const file=event.target.files?.[0];if(!file)return;if(file.size>100000){setError("Host profile exceeds 100 KB");return;}setProfile(await file.text());setError("");}} /></label>
  <label className="block mt-3">Host profile JSON<textarea className="atlas-control w-full font-mono" rows={5} value={profile} onChange={e=>{setProfile(e.target.value);setResult(null);}} /></label>
  <label className="block mt-3">Logical sources and required fields<textarea className="atlas-control w-full font-mono" rows={8} value={bindings} onChange={e=>{setBindings(e.target.value);setResult(null);}} /></label>
  <label className="block mt-3">Authoring revision<input className="atlas-control w-full" value={revision} onChange={e=>{setRevision(e.target.value);setResult(null);}} /></label>
  {error&&<p role="alert" className="text-rose-300">{error}</p>}
  {result&&<><ul>{result.warnings.map(w=><li key={w}>{w}</li>)}</ul><label className="block mt-3">Portable bundle preview<textarea readOnly className="atlas-control w-full font-mono" rows={8} value={result.text}/></label></>}
  <div className="mt-4 flex justify-end gap-2"><button className="atlas-button" disabled={busy} onClick={onClose}>Close</button><button className="atlas-button" disabled={busy} onClick={()=>void preview()}>Validate portable export</button><button className="atlas-button primary" disabled={!result||busy} onClick={download}>Download Atlas bundle</button></div>
 </section></div>;
}
