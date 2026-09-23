import {DateTime} from 'luxon';
import {daySpans,subtract,seconds,iso} from './calendar';
import type {Workspace,Project,Scenario,Assignment} from './types';

export interface IdlePeriod {employeeId:string;start:string;end:string;hours:number;reason:string}
/** Explain observed gaps in the chosen schedule, without claiming an optimality proof. */
export function idlePeriods(w:Workspace,p:Project,s:Scenario):IdlePeriod[]{
  const from=Math.max(seconds(s.createdAt),DateTime.fromISO(p.startDate,{zone:p.zone}).toSeconds()),to=seconds(s.finishAt);
  const tasks=[...s.assignments,...w.projects.filter(x=>x.id!==p.id&&x.status!=='deleted'&&!x.template).flatMap(x=>x.assignments)];
  const stockAt=(stage:string,at:number)=>(p.opening[stage]||0)+s.movements.filter(m=>m.stageId===stage&&seconds(m.at)<=at).reduce((sum,m)=>sum+m.quantity,0);
  const active=(a:Assignment,at:number)=>a.segments.some(t=>seconds(t.start)<=at&&seconds(t.end)>at);
  const result:IdlePeriod[]=[];
  for(const employee of w.employees.filter(e=>p.employeeIds.includes(e.id))){
    const busy=tasks.filter(a=>a.employeeIds.includes(employee.id)).flatMap(a=>a.segments.map(t=>({start:seconds(t.start),end:seconds(t.end)})));
    const firstDay=DateTime.fromSeconds(from,{zone:employee.calendar.zone}).startOf('day');
    for(let d=firstDay;d.toSeconds()<to;d=d.plus({days:1})){
      const gaps=subtract(daySpans(employee.calendar,d.toISODate()!),busy).map(t=>({start:Math.max(t.start,from),end:Math.min(t.end,to)})).filter(t=>t.end>t.start);
      for(const gap of gaps){
        const points=[...new Set([gap.start,gap.end,...s.movements.map(m=>seconds(m.at)),...tasks.flatMap(a=>a.segments.flatMap(t=>[seconds(t.start),seconds(t.end)]))].filter(t=>t>=gap.start&&t<=gap.end))].sort((a,b)=>a-b);
        for(let i=0;i<points.length-1;i++){
          const at=points[i],end=points[i+1],reasons=new Set<string>();let pending=0,eligible=0;
          for(const stage of p.stages)for(const op of stage.operations){
            if(!s.assignments.some(a=>a.stageId===stage.id&&a.operationId===op.id&&seconds(a.end)>at))continue;
            pending++;if(!employee.skills[op.operationId]?.allowed)continue;eligible++;
            const task=s.assignments.filter(a=>a.stageId===stage.id&&a.operationId===op.id&&seconds(a.start)>=at).sort((a,b)=>seconds(a.start)-seconds(b.start))[0];
            if(!task){reasons.add('Оставшиеся работы уже выполняются');continue;}
            const incoming=p.edges.filter(e=>e.target===stage.id);
            if(stage.operations[0].id===op.id&&incoming.some(e=>stockAt(e.source,at)<task.quantity*e.quantity)){reasons.add('Ожидание компонентов / передаточной партии');continue;}
            const opIndex=stage.operations.indexOf(op);
            if(opIndex>0&&!s.assignments.some(a=>a.batchId===task.batchId&&a.operationId===stage.operations[opIndex-1].id&&seconds(a.end)<=at)){reasons.add('Ожидание предыдущей операции');continue;}
            const machine=w.machines.find(m=>m.id===op.norm.machineId);
            if(machine){const date=DateTime.fromSeconds(at,{zone:machine.calendar.zone}).toISODate()!;if(!daySpans(machine.calendar,date).some(t=>t.start<=at&&t.end>at)){reasons.add('Оборудование вне смены');continue;}if(new Set(tasks.filter(a=>a.machineId===machine.id&&active(a,at)).map(a=>a.machineUnit)).size>=machine.count){reasons.add('Оборудование занято');continue;}}
            reasons.add(op.mode==='crew'?'Ожидание состава бригады':'Резерв мощности выбранного распределения');
          }
          const reason=!pending?'Завершение производства':!eligible?'Нет допуска к оставшимся работам':[...reasons].join('; ');
          const last=result.at(-1);if(last?.employeeId===employee.id&&last.end===iso(at)&&last.reason===reason){last.end=iso(end);last.hours+=(end-at)/3600;}else result.push({employeeId:employee.id,start:iso(at),end:iso(end),hours:(end-at)/3600,reason});
        }
      }
    }
  }
  return result;
}
