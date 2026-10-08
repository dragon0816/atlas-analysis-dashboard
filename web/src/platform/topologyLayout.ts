import type { GraphModel } from './graphModel';
export type LayoutMode = 'topology' | 'grouped';
/** Deterministic spring layout: equal treatment across communities, no group anchors/clamps.
 * Weights change attraction, not coordinates-as-scores. All axes encode layout only. */
export function topologyLayout(model: GraphModel, dimensions: 2 | 3 = 2, nodeScale = 1) {
 const nodes=[...model.nodes].sort((a,b)=>a.id.localeCompare(b.id)), n=nodes.length;
 const points=nodes.map((_,i)=>{
  const angle=i*Math.PI*(3-Math.sqrt(5)), y=n===1?0:1-2*(i+0.5)/n;
  const radius=45+Math.sqrt(n)*9, ring=dimensions===3?Math.sqrt(1-y*y):Math.sqrt((i+0.5)/Math.max(1,n));
  return {x:radius*ring*Math.cos(angle),y:dimensions===3?radius*y:radius*ring*Math.sin(angle),z:dimensions===3?radius*ring*Math.sin(angle):0,vx:0,vy:0,vz:0};
 });
 const index=new Map(nodes.map((node,i)=>[node.id,i]));
 const links=[...model.edges].sort((a,b)=>a.id.localeCompare(b.id)).map(e=>({a:index.get(e.source)!,b:index.get(e.target)!,w:Math.min(2,Math.sqrt(e.weight))}));
 const steps=n>200?160:280, stride=Math.max(1,Math.ceil(n/220));
 for(let tick=0;tick<steps;tick++) {
  const alpha=1-tick/steps;
  for(let i=0;i<n;i++)for(let j=i+1+tick%stride;j<n;j+=stride){
   const a=points[i],b=points[j],dx=a.x-b.x||0.001,dy=a.y-b.y||0.001,dz=a.z-b.z;
   const d2=Math.max(25,dx*dx+dy*dy+dz*dz),d=Math.sqrt(d2),f=Math.min(8,1100*stride*nodeScale*alpha/d2);
   a.vx+=dx/d*f;a.vy+=dy/d*f;a.vz+=dz/d*f;b.vx-=dx/d*f;b.vy-=dy/d*f;b.vz-=dz/d*f;
  }
  for(const {a,b,w} of links){if(a===b)continue;const pa=points[a],pb=points[b],dx=pb.x-pa.x,dy=pb.y-pa.y,dz=pb.z-pa.z,d=Math.max(1,Math.hypot(dx,dy,dz));
   const f=(d-36*nodeScale)*0.024*w*alpha;
   pa.vx+=dx/d*f;pa.vy+=dy/d*f;pa.vz+=dz/d*f;pb.vx-=dx/d*f;pb.vy-=dy/d*f;pb.vz-=dz/d*f;
  }
  for(const p of points){p.vx=(p.vx-p.x*0.0015*alpha)*0.72;p.vy=(p.vy-p.y*0.0015*alpha)*0.72;p.vz=(p.vz-p.z*0.0015*alpha)*0.72;p.x+=p.vx;p.y+=p.vy;p.z+=p.vz;}
 }
 return new Map(nodes.map((node,i)=>[node.id,{x:points[i].x,y:points[i].y,z:points[i].z}]));
}
