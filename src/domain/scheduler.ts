import { DateTime } from 'luxon';
import { calculateNorm } from './norms';
import { validateRoute } from './graph';
import { fitWork, seconds, iso, type Span, overlaps, daySpans } from './calendar';
import { assignmentMovements, inventoryErrors } from './inventory';
import type { Workspace,Project,Assignment,Scenario,PlanningMode,Movement,RouteOperation,Employee } from './types';
import {uid} from './types';
import {canonicalJson} from './serialization';
import {idlePeriods} from './idle';

export function fingerprint(w:Workspace){
  // Stable FNV fingerprint for stale scenario detection; not a security signature.
  const s=canonicalJson(w);let h=2166136261;for(let i=0;i<s.length;i++){h^=s.charCodeAt(i);h=Math.imul(h,16777619);}return (h>>>0).toString(16);
}
export function preservedAssignments(p:Project,now:string){
  const batches=new Set(p.assignments.filter(a=>a.locked||seconds(a.start)<seconds(now)||p.actuals.some(f=>f.assignmentId===a.id)).map(a=>a.batchId));
  return p.assignments.filter(a=>batches.has(a.batchId));
}
function combinations<T>(items:T[],n:number,limit=100):T[][]{const out:T[][]=[];const visit=(at:number,chosen:T[])=>{if(out.length>=limit)return;if(chosen.length===n){out.push(chosen);return;}for(let i=at;i<items.length;i++)visit(i+1,[...chosen,items[i]]);};visit(0,[]);return out;}
function resources(w:Workspace,p:Project,op:RouteOperation){
  const people=w.employees.filter(e=>p.employeeIds.includes(e.id)&&e.skills[op.operationId]?.allowed);
  const groups=op.mode==='crew'?combinations(people,op.workers):people.map(e=>[e]);
  const machine=op.norm.machineId?w.machines.find(m=>m.id===op.norm.machineId):undefined;
  if(op.norm.machineId&&!machine)throw new Error(`Не найдено оборудование: ${op.name}`);
  return groups.flatMap(group=>(machine?Array.from({length:machine.count},(_,i)=>i):[undefined]).map(unit=>({group,machine,unit})));
}
export function assignmentConflicts(w:Workspace,p:Project,a:Assignment,existing:Assignment[]):string[]{
  const op=p.stages.find(s=>s.id===a.stageId)?.operations.find(o=>o.id===a.operationId);if(!op)return ['Не найдена операция'];
  const errors:string[]=[];const people=a.employeeIds.map(id=>w.employees.find(e=>e.id===id));
  if(people.some(e=>!e||!p.employeeIds.includes(e.id)||!e.skills[op.operationId]?.allowed))errors.push('Исполнитель отсутствует в команде или не допущен');
  if(op.mode==='crew'?a.employeeIds.length!==op.workers:a.employeeIds.length!==1)errors.push('Неверный состав исполнителей');
  if(a.machineId!==op.norm.machineId)errors.push('Неверное оборудование');
  const machine=w.machines.find(m=>m.id===a.machineId);
  if(new Set(a.employeeIds).size!==a.employeeIds.length)errors.push('Исполнитель указан повторно');
  if(a.machineId&&(!machine||a.machineUnit===undefined||!Number.isInteger(a.machineUnit)||a.machineUnit<0||a.machineUnit>=machine.count))errors.push('Нет доступной единицы оборудования');
  if(!a.segments.length||a.start!==a.segments[0].start||a.end!==a.segments.at(-1)!.end)errors.push('Некорректные интервалы задания');
  const calendars=[...people.filter((e):e is Employee=>!!e).map(e=>e.calendar),...(machine?[machine.calendar]:[])];
  for(const [index,seg] of a.segments.entries()){const s={start:seconds(seg.start),end:seconds(seg.end)};
    if(index>0&&seconds(a.segments[index-1].end)>s.start)errors.push('Интервалы задания пересекаются или нарушен их порядок');
    if(s.end<=s.start)errors.push('Конец задания должен быть позже начала');
    for(const c of calendars){const date=DateTime.fromISO(seg.start,{zone:c.zone}).toISODate()!;if(!daySpans(c,date).some(d=>d.start<=s.start&&d.end>=s.end))errors.push('Задание выходит за рабочее время');}
    for(const b of existing.filter(b=>b.id!==a.id))if(b.employeeIds.some(id=>a.employeeIds.includes(id))||(a.machineId&&b.machineId===a.machineId&&b.machineUnit===a.machineUnit))if(b.segments.some(t=>overlaps(s,{start:seconds(t.start),end:seconds(t.end)})))errors.push(`Пересечение с заданием ${b.id}`);
  }
  if(people.every(Boolean)){const k=Math.min(...people.map(e=>e!.skills[op.operationId]?.coefficient||1));const n=calculateNorm(op.norm,k);const duration=a.segments.reduce((s,x)=>s+seconds(x.end)-seconds(x.start),0);if(duration+0.01<n.cycle*a.quantity+a.setupSeconds)errors.push('Недостаточная длительность задания');}
  return [...new Set(errors)];
}
type Batch={id:string;stageId:string;quantity:number;op:number;ready:number};
type Event={at:number;kind:'move'|'complete';move?:Movement;batch?:Batch;assignment?:Assignment};
function fixedProjection(p:Project,fixed:Assignment[],now:number):Movement[]{
  const projected=assignmentMovements(p,fixed);
  return projected.map(m=>{
    const booked=p.movements.filter(x=>x.assignmentId===m.assignmentId&&x.stageId===m.stageId&&x.kind===m.kind).reduce((s,x)=>s+x.quantity,0);
    let quantity=m.quantity-booked;
    if(m.kind==='output') {const a=fixed.find(a=>a.id===m.assignmentId)!;const ids=new Set(fixed.filter(x=>x.batchId===a.batchId).map(x=>x.id));quantity-=p.actuals.filter(f=>ids.has(f.assignmentId)).reduce((s,f)=>s+f.scrap,0);}
    return {...m,at:iso(Math.max(seconds(m.at),now+(m.kind==='output'?1:0))),quantity:m.kind==='output'?Math.max(0,quantity):Math.min(0,quantity)};
  }).filter(m=>Math.abs(m.quantity)>1e-8);
}
function build(w:Workspace,p:Project,mode:PlanningMode,batchSize:number,now:string,priority:'downstream'|'buffer'):Scenario {
  const order=validateRoute(p),start=Math.max(seconds(now),DateTime.fromISO(p.startDate,{zone:p.zone}).startOf('day').toSeconds());
  // Pull dispatch: exhaust feasible upstream work at this event before assigning
  // spare resources downstream. Material and resource constraints still apply.
  const depth=new Map<string,number>();
  for(const id of order)depth.set(id,Math.max(0,...p.edges.filter(e=>e.target===id).map(e=>depth.get(e.source)!+1)));
  const fixed=preservedAssignments(p,now);const foreign=w.projects.filter(x=>x.id!==p.id&&x.status!=='deleted'&&!x.template).flatMap(x=>x.assignments);
  const assignments:Assignment[]=[...fixed],reservations=[...foreign,...fixed],stock={...p.opening};
  const baseMoves=[...p.movements,...p.supplies.map(s=>({id:s.id,stageId:s.stageId,quantity:s.quantity,at:s.at,kind:'receipt' as const})),...fixedProjection(p,fixed,start)];
  const net={...stock};for(const m of baseMoves)net[m.stageId]=(net[m.stageId]||0)+m.quantity;
  const shipped=p.movements.filter(m=>m.kind==='shipment').reduce((sum,m)=>sum-m.quantity,0);
  const required:Record<string,number>={};for(const id of [...order].reverse()){const s=p.stages.find(s=>s.id===id)!;const gross=s.final?Math.max(0,p.quantity-shipped):p.edges.filter(e=>e.source===id).reduce((sum,e)=>sum+required[e.target]*e.quantity,0);required[id]=Math.max(0,Math.ceil(gross-(net[id]||0)));}
  const remaining={...required},waiting:Batch[]=[];const events:Event[]=[],moves:Movement[]=[...baseMoves];
  for(const m of baseMoves)if(seconds(m.at)<start)stock[m.stageId]=(stock[m.stageId]||0)+m.quantity;else events.push({at:seconds(m.at),kind:'move',move:m});
  if(Object.values(stock).some(q=>q< -1e-6))throw new Error('Фактический остаток отрицательный. Исправьте журнал движений перед расчётом.');
  let t=start,iterations=0,peakWip=0;const setups=new Set<string>();let blockReasons=new Set<string>();
  for(const a of fixed)setups.add([a.stageId,a.operationId,[...a.employeeIds].sort().join(','),a.machineId,a.machineUnit].join('|'));
  const setupKey=(stage:string,op:RouteOperation,group:Employee[],machine?:string,unit?:number)=>[stage,op.id,group.map(e=>e.id).sort().join(','),machine,unit].join('|');
  const targets=new Map(p.stages.map(stage=>[stage.id,p.edges.filter(e=>e.source===stage.id).reduce((total,edge)=>{
    const consumer=p.stages.find(s=>s.id===edge.target)!.operations[0];
    const eligible=w.employees.filter(e=>p.employeeIds.includes(e.id)&&e.skills[consumer.operationId]?.allowed);
    const n=calculateNorm(consumer.norm,eligible.length?Math.min(...eligible.map(e=>e.skills[consumer.operationId].coefficient)):1);
    const machines=consumer.norm.machineId?w.machines.find(m=>m.id===consumer.norm.machineId)?.count||0:Infinity;
    const capacity=consumer.mode==='crew'?Math.min(1,Math.floor(eligible.length/consumer.workers),machines):Math.min(eligible.length,consumer.workers,machines);
    return total+p.bufferHours*3600/n.cycle*capacity*edge.quantity;
  },0)]));
  while((Object.values(remaining).some(v=>v>0)||waiting.length||events.length)&&iterations++<80000){
    events.sort((a,b)=>a.at-b.at||(b.move?.quantity||0)-(a.move?.quantity||0));
    while(events.length&&events[0].at<=t+1e-7){const e=events.shift()!;
      if(e.kind==='move'){stock[e.move!.stageId]=(stock[e.move!.stageId]||0)+e.move!.quantity;if(stock[e.move!.stageId]<-1e-5)throw new Error(`Закреплённый план создаёт дефицит ${e.move!.stageId}. Исправьте закреплённое задание.`);}
      else {const b=e.batch!,stage=p.stages.find(s=>s.id===b.stageId)!;if(b.op+1<stage.operations.length)waiting.push({...b,op:b.op+1,ready:e.at});else{const m:Movement={id:uid(),at:iso(e.at),stageId:b.stageId,quantity:b.quantity,kind:'output',assignmentId:e.assignment!.id};stock[b.stageId]=(stock[b.stageId]||0)+b.quantity;moves.push(m);}}
    }
    peakWip=Math.max(peakWip,p.stages.filter(s=>!s.final).reduce((sum,s)=>sum+(stock[s.id]||0),0));
    const candidates=[...waiting];
    for(const id of order)if(remaining[id]>0){const incoming=p.edges.filter(e=>e.target===id);const available=incoming.length?Math.min(...incoming.map(e=>Math.floor((stock[e.source]||0)/e.quantity+1e-8))):remaining[id];
      const transferMinimum=incoming.length?Math.max(...incoming.map(e=>Math.ceil(e.transferBatch/e.quantity))):1;
      const q=Math.min(remaining[id],Math.max(batchSize,transferMinimum));
      if(available>=q)candidates.push({id:'new',stageId:id,quantity:q,op:0,ready:t});else blockReasons.add(`${p.stages.find(s=>s.id===id)!.name}: ожидание материала`);
    }
    type Choice={batch:Batch;op:RouteOperation;group:Employee[];machineId?:string;unit?:number;segments:NonNullable<ReturnType<typeof fitWork>>;setup:number;key:string;rank:number};
    let best:Choice|undefined;
    for(const b of candidates){const stage=p.stages.find(s=>s.id===b.stageId)!,op=stage.operations[b.op];const options=resources(w,p,op);
      if(!options.length){blockReasons.add(`${stage.name}: нет допущенных исполнителей или оборудования`);continue;}
      const parallel=op.mode==='independent'?assignments.filter(a=>a.stageId===stage.id&&a.operationId===op.id&&seconds(a.end)>t&&seconds(a.start)<=t):[];
      if(parallel.length>=op.workers)continue;
      for(const r of options){const k=Math.min(...r.group.map(e=>e.skills[op.operationId].coefficient));const norm=calculateNorm(op.norm,k),key=setupKey(stage.id,op,r.group,r.machine?.id,r.unit);const setup=setups.has(key)?0:norm.setup;
        const busy:Span[]=reservations.filter(a=>a.employeeIds.some(id=>r.group.some(e=>e.id===id))||(r.machine&&a.machineId===r.machine.id&&a.machineUnit===r.unit)).flatMap(a=>a.segments.map(s=>({start:seconds(s.start),end:seconds(s.end)})));
        const segments=fitWork([...r.group.map(e=>e.calendar),...(r.machine?[r.machine.calendar]:[])],busy,Math.max(t,b.ready),b.quantity*norm.cycle+setup);
        if(!segments)continue;
        const downstream=order.indexOf(stage.id);const buffer=targets.get(stage.id)||0;const deficit=buffer-(stock[stage.id]||0);
        const rank=mode==='pull'?depth.get(stage.id)!*2+(b.op>0?0:1):priority==='downstream'?-downstream:-(deficit/Math.max(1,buffer)*100+downstream);
        const choice:Choice={batch:b,op,group:r.group,machineId:r.machine?.id,unit:r.unit,segments,setup,key,rank};
        const from=segments[0].start,to=segments.at(-1)!.end;
        if(!best||from<best.segments[0].start||(from===best.segments[0].start&&(rank<best.rank||(rank===best.rank&&to<best.segments.at(-1)!.end))))best=choice;
      }
    }
    const nextEvent=events[0]?.at??Infinity;
    if(!best){if(nextEvent<Infinity){t=nextEvent;continue;}if(Object.values(remaining).some(q=>q>0)||waiting.length)throw new Error([...blockReasons].join('; ')||'Невозможно разместить работы в календаре');break;}
    const begin=seconds(best.segments[0].start);
    if(nextEvent<=begin){t=nextEvent;continue;}
    t=begin;const b=best.batch;const batchId=b.id==='new'?uid():b.id;
    if(b.id==='new')remaining[b.stageId]-=b.quantity;else waiting.splice(waiting.findIndex(x=>x.id===b.id&&x.op===b.op),1);
    const a:Assignment={id:uid(),batchId,projectId:p.id,stageId:b.stageId,operationId:best.op.id,employeeIds:best.group.map(e=>e.id),machineId:best.machineId,machineUnit:best.unit,quantity:b.quantity,start:best.segments[0].start,end:best.segments.at(-1)!.end,segments:best.segments,setupSeconds:best.setup,locked:false};
    if(b.op===0)for(const e of p.edges.filter(e=>e.target===b.stageId)){const q=b.quantity*e.quantity;stock[e.source]=(stock[e.source]||0)-q;if(stock[e.source]<-1e-6)throw new Error('Повторное резервирование материала');moves.push({id:uid(),at:a.start,stageId:e.source,quantity:-q,kind:'consume',assignmentId:a.id});}
    assignments.push(a);reservations.push(a);setups.add(best.key);events.push({at:seconds(a.end),kind:'complete',batch:{...b,id:batchId},assignment:a});
  }
  if(iterations>=80000)throw new Error('Слишком подробный расчёт: увеличьте передаточную партию или сократите объём');
  const errors=inventoryErrors(p.opening,moves);if(errors.length)throw new Error(errors[0]);
  const final=p.stages.find(s=>s.final)!,outputs=moves.filter(m=>m.stageId===final.id&&m.quantity>0).sort((a,b)=>seconds(a.at)-seconds(b.at));
  const futureOutputs=outputs.filter(m=>seconds(m.at)>=start);const first=futureOutputs[0];
  const finishAt=iso(Math.max(start,...assignments.map(a=>seconds(a.end)),...futureOutputs.map(m=>seconds(m.at))));
  const readyNow=Math.max(0,(p.opening[final.id]||0)+moves.filter(m=>m.stageId===final.id&&seconds(m.at)<start).reduce((sum,m)=>sum+m.quantity,0));
  const firstAt=readyNow>0?iso(start):first?.at??iso(start),firstQuantity=readyNow>0?Math.min(p.quantity,readyNow):first?.quantity??0;
  let availableSeconds=0;for(const e of w.employees.filter(e=>p.employeeIds.includes(e.id))){let d=DateTime.fromSeconds(start,{zone:e.calendar.zone}).startOf('day');const last=DateTime.fromISO(finishAt);for(let i=0;d<=last&&i<730;i++,d=d.plus({days:1}))for(const s of daySpans(e.calendar,d.toISODate()!)){const low=Math.max(s.start,start),high=Math.min(s.end,seconds(finishAt));if(high>low)availableSeconds+=high-low;}}
  const usedSeconds=reservations.reduce((sum,a)=>sum+a.employeeIds.filter(id=>p.employeeIds.includes(id)).length*a.segments.reduce((s,seg)=>s+Math.max(0,Math.min(seconds(seg.end),seconds(finishAt))-Math.max(seconds(seg.start),start)),0),0);
  const idleHours=Math.max(0,(availableSeconds-usedSeconds)/3600),warnings:string[]=[];
  if(DateTime.fromISO(finishAt,{zone:p.zone}).toISODate()!>p.deadline)warnings.push('Завершение позже дедлайна');
  if(idleHours>0.01)warnings.push(`Свободное рабочее время: ${idleHours.toFixed(1)} ч. Причины: ожидание материала, готовности предыдущей операции или свободной машины.`);
  if(fixed.some(a=>seconds(a.end)<seconds(now)&&!p.actuals.some(f=>f.assignmentId===a.id)))warnings.push('Есть прошедшие задания без факта. Их оставшийся выпуск учитывается только как прогноз.');
  if(mode==='pull'&&fixed.length)warnings.push('Закреплённые и начатые партии сохранены. Приоритет предыдущих этапов действует для новых назначений.');
  return {id:uid(),projectId:p.id,revision:p.revision,mode,batch:batchSize,firstQuantity,firstAt,finishAt,assignments,movements:moves,idleHours,peakWip,warnings,score:seconds(finishAt),createdAt:now,fingerprint:fingerprint(w)};
}
export function plan(w:Workspace,projectId:string,mode:PlanningMode,now=new Date().toISOString()):Scenario[]{
  const p=w.projects.find(p=>p.id===projectId);if(!p||p.status!=='open'||p.template)throw new Error('Откройте рабочий проект для планирования');
  validateRoute(p);if(!p.employeeIds.length)throw new Error('Добавьте сотрудников в команду');
  // Bound work for interactive use: always include a small early-flow batch.
  const minimum=Math.max(1,Math.ceil(p.quantity/200));
  const batches=[...new Set([minimum,...[.01,.05,.1,.25,1].map(r=>Math.max(minimum,Math.ceil(p.quantity*r)))])];
  const results:Scenario[]=[],failures:string[]=[];
  const strategies=mode==='pull'?['downstream'] as const:['downstream','buffer'] as const;
  for(const b of batches)for(const strategy of strategies)try{results.push(build(w,p,mode,b,now,strategy));}catch(e){failures.push((e as Error).message);}
  if(!results.length)throw new Error(failures[0]||'Нет допустимого плана');
  results.sort((a,b)=>a.finishAt.localeCompare(b.finishAt)||a.idleHours-b.idleHours||a.peakWip-b.peakWip);
  const explain=(selected:Scenario[])=>selected.map(s=>({...s,idlePeriods:idlePeriods(w,p,s)}));
  if(mode==='throughput'||mode==='pull')return explain(results.slice(0,1));
  const unique=results.filter((r,i)=>results.findIndex(x=>x.firstQuantity===r.firstQuantity&&x.firstAt===r.firstAt)===i);
  const frontier=unique.filter(r=>!unique.some(x=>x!==r&&x.firstQuantity>=r.firstQuantity&&x.firstAt<=r.firstAt&&(x.firstQuantity>r.firstQuantity||x.firstAt<r.firstAt))).sort((a,b)=>a.firstAt.localeCompare(b.firstAt));
  if(frontier.length<=5)return explain(frontier);
  return explain([0,1,2,3,4].map(i=>frontier[Math.round(i*(frontier.length-1)/4)]));
}
export function applyScenario(w:Workspace,scenario:Scenario,now=scenario.createdAt):Workspace{
  if(scenario.fingerprint!==fingerprint(w))throw new Error('Данные изменились после расчёта. Рассчитайте варианты заново.');
  const next=structuredClone(w),p=next.projects.find(p=>p.id===scenario.projectId)!;
  if(!p||p.revision!==scenario.revision)throw new Error('Версия проекта изменилась');
  for(const fixed of preservedAssignments(p,now))if(canonicalJson(scenario.assignments.find(a=>a.id===fixed.id))!==canonicalJson(fixed))throw new Error('Часть заданий уже началась после расчёта. Рассчитайте варианты заново.');
  if(!p.baseline.length)p.baseline=structuredClone(scenario.assignments);
  p.assignments=structuredClone(scenario.assignments);p.revision++;
  return next;
}
