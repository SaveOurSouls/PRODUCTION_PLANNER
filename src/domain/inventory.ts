import {DateTime} from 'luxon';
import type {Project,Assignment,Movement,Actual} from './types';
import {uid} from './types';
export function assignmentMovements(p:Project,assignments:Assignment[]):Movement[] {
  const result:Movement[]=[];
  for(const a of assignments){const stage=p.stages.find(s=>s.id===a.stageId);if(!stage)continue;
    if(stage.operations[0]?.id===a.operationId) for(const e of p.edges.filter(e=>e.target===stage.id))result.push({id:`${a.id}-${e.id}`,at:a.start,stageId:e.source,quantity:-a.quantity*e.quantity,kind:'consume',assignmentId:a.id});
    if(stage.operations.at(-1)?.id===a.operationId)result.push({id:`${a.id}-out`,at:a.end,stageId:stage.id,quantity:a.quantity,kind:'output',assignmentId:a.id});
  }
  return result;
}
export function actualMovements(p:Project,a:Assignment,f:Actual):Movement[]{
  const stage=p.stages.find(s=>s.id===a.stageId)!;const result:Movement[]=[];
  if(stage.operations[0].id===a.operationId)for(const e of p.edges.filter(e=>e.target===stage.id))result.push({id:uid(),at:f.start,stageId:e.source,quantity:-f.processed*e.quantity,kind:'consume',assignmentId:a.id,note:f.id});
  if(stage.operations.at(-1)!.id===a.operationId)result.push({id:uid(),at:f.end,stageId:stage.id,quantity:f.processed-f.scrap,kind:'output',assignmentId:a.id,note:f.id});
  if(f.scrap)result.push({id:uid(),at:f.end,stageId:stage.id,quantity:0,kind:'scrap',assignmentId:a.id,note:`${f.id}: ${f.scrap} шт.`});
  return result;
}
export function inventoryErrors(opening:Record<string,number>,moves:Movement[]){
  const balance={...opening}, errors:string[]=Object.entries(opening).filter(([,q])=>q<0).map(([id])=>`Отрицательный начальный остаток ${id}`);
  for(const m of [...moves].sort((a,b)=>Date.parse(a.at)-Date.parse(b.at)||b.quantity-a.quantity)){balance[m.stageId]=(balance[m.stageId]||0)+m.quantity;if(balance[m.stageId]<-1e-6)errors.push(`Дефицит ${m.stageId}: ${-balance[m.stageId]} на ${m.at}`);}
  return errors;
}
export interface DailyStock {date:string;stageId:string;opening:number;receipt:number;consume:number;output:number;shipped:number;scrap:number;closing:number;cumulative:number;events:Movement[]}
export function materialReport(p:Project){
  const plannedMoves:Movement[]=[...p.supplies.map(s=>({...s,kind:'receipt' as const})),...assignmentMovements(p,p.assignments)];
  const dates=[p.startDate,p.deadline,...p.assignments.map(a=>a.end),...p.actuals.flatMap(f=>[f.start,f.end]),...plannedMoves.map(m=>m.at),...p.movements.map(m=>m.at)]
    .map(at=>DateTime.fromISO(at,{zone:p.zone}).toISODate()!).sort();
  const from=dates[0],to=dates.at(-1)!;
  const planned=dailyInventory(p,plannedMoves,from,to),actual=dailyInventory(p,p.movements,from,to);
  const actualByDay=new Map(actual.map(r=>[JSON.stringify([r.date,r.stageId]),r]));
  const days=new Map<string,{stageId:string;plan:DailyStock;fact:DailyStock}[]>();
  const activeDates=new Set<string>();
  const markRange=(start:string,end:string)=>{
    let day=DateTime.fromISO(start,{zone:p.zone}).startOf('day');
    const last=DateTime.fromISO(end,{zone:p.zone}).startOf('day');
    for(let i=0;day<=last&&i<3660;i++,day=day.plus({days:1}))activeDates.add(day.toISODate()!);
  };
  for(const a of p.assignments)for(const s of a.segments)markRange(s.start,s.end);
  for(const f of p.actuals)markRange(f.start,f.end);
  for(const m of [...plannedMoves,...p.movements])activeDates.add(DateTime.fromISO(m.at,{zone:p.zone}).toISODate()!);
  for(const plan of planned){
    if(!activeDates.has(plan.date))continue;
    const entries=days.get(plan.date)||[];
    entries.push({stageId:plan.stageId,plan,fact:actualByDay.get(JSON.stringify([plan.date,plan.stageId]))!});
    days.set(plan.date,entries);
  }
  return {from,to,days:[...days].map(([date,stages])=>({date,stages}))};
}
export function dailyInventory(p:Project,movements:Movement[],from=p.startDate,to=p.deadline):DailyStock[]{
  const result:DailyStock[]=[],balance={...p.opening},cumulative:Record<string,number>={};
  const sorted=[...movements].sort((a,b)=>Date.parse(a.at)-Date.parse(b.at));
  for(const m of sorted)if(DateTime.fromISO(m.at,{zone:p.zone}).toISODate()!<from){balance[m.stageId]=(balance[m.stageId]||0)+m.quantity;if(m.kind==='output')cumulative[m.stageId]=(cumulative[m.stageId]||0)+m.quantity;}
  const end=DateTime.fromISO(to,{zone:p.zone});let day=DateTime.fromISO(from,{zone:p.zone});
  for(let i=0;day<=end&&i<3660;i++,day=day.plus({days:1}))for(const s of p.stages){
    const events=sorted.filter(m=>m.stageId===s.id&&DateTime.fromISO(m.at,{zone:p.zone}).toISODate()===day.toISODate());
    const sum=(kind:Movement['kind'])=>events.filter(e=>e.kind===kind).reduce((v,e)=>v+e.quantity,0);
    const opening=balance[s.id]||0,output=sum('output');balance[s.id]=opening+events.reduce((v,e)=>v+e.quantity,0);cumulative[s.id]=(cumulative[s.id]||0)+output;
    const scrap=events.filter(e=>e.kind==='scrap').reduce((total,e)=>total+(p.actuals.find(a=>a.id===e.note?.split(':')[0])?.scrap||0),0);
    result.push({date:day.toISODate()!,stageId:s.id,opening,receipt:sum('receipt')+sum('adjustment')+sum('opening'),consume:-sum('consume')||0,output,shipped:-sum('shipment')||0,scrap,closing:balance[s.id],cumulative:cumulative[s.id],events});
  }
  return result;
}
