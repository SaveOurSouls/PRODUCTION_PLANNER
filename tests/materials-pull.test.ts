import {describe,it,expect} from 'vitest';
import {seedWorkspace} from '../src/domain/seed';
import {plan,assignmentConflicts,applyScenario} from '../src/domain/scheduler';
import {dailyInventory,inventoryErrors,materialReport} from '../src/domain/inventory';
import {addMovement} from '../src/domain/actions';
import type {Movement} from '../src/domain/types';

const now='2026-09-23T00:00:00.000Z';
function twoStages(machineCount=2){
  const w=seedWorkspace(),p=w.projects[0];
  p.quantity=12;p.deadline='2026-09-25';p.stages=p.stages.slice(0,2);p.stages[1].final=true;
  p.edges=p.edges.slice(0,1);p.edges[0].transferBatch=1;
  w.employees=w.employees.slice(0,2);p.employeeIds=w.employees.map(e=>e.id);
  w.machines[0].count=machineCount;
  for(const [i,s] of p.stages.entries()){
    s.operations[0].workers=2;
    Object.assign(s.operations[0].norm,{work:i?120:60,toolSeconds:i?0:60,setup:0});
  }
  return {w,p};
}

describe('Вытягивающее распределение',()=>{
  it('не переводит универсальных исполнителей дальше, пока можно загрузить предыдущий этап',()=>{
    const {w,p}=twoStages();
    const [s]=plan(w,p.id,'pull',now);
    const upstream=s.assignments.filter(a=>a.stageId===p.stages[0].id);
    const downstream=s.assignments.filter(a=>a.stageId===p.stages[1].id);
    expect(s.mode).toBe('pull');
    expect(downstream.length).toBeGreaterThan(0);
    const lastUpstreamStart=Math.max(...upstream.map(a=>Date.parse(a.start)));
    expect(downstream.every(a=>Date.parse(a.start)>=lastUpstreamStart)).toBe(true);
    expect(inventoryErrors({},s.movements)).toEqual([]);
    for(const a of s.assignments)expect(assignmentConflicts(w,p,a,s.assignments)).toEqual([]);
  });
  it('использует свободные руки дальше, когда предыдущая машина занята и есть годный запас',()=>{
    const {w,p}=twoStages(1),[s]=plan(w,p.id,'pull',now);
    const upstream=s.assignments.filter(a=>a.stageId===p.stages[0].id);
    const downstream=s.assignments.filter(a=>a.stageId===p.stages[1].id);
    const firstDown=downstream.reduce((first,a)=>a.start<first.start?a:first);
    const lastUp=upstream.reduce((last,a)=>a.end>last.end?a:last);
    expect(firstDown.start<lastUp.end).toBe(true);
    expect(upstream.some(a=>a.start<=firstDown.start&&a.end>firstDown.start)).toBe(true);
    expect(upstream.some(a=>a.end<=firstDown.start)).toBe(true);
    expect(inventoryErrors({},s.movements)).toEqual([]);
  });
  it('сохраняет закрепления, исходный план и чужие назначения при применении',()=>{
    const {w,p}=twoStages(1);const initial=plan(w,p.id,'pull',now)[0];
    const next=applyScenario(w,initial);next.projects[0].assignments[0].locked=true;
    const fixed=structuredClone(next.projects[0].assignments[0]),baseline=structuredClone(next.projects[0].baseline);
    const foreign=structuredClone(p);foreign.id='other';foreign.assignments=[];next.projects.push(foreign);
    const [s]=plan(next,p.id,'pull',now);const applied=applyScenario(next,s);
    expect(applied.projects[0].assignments.find(a=>a.id===fixed.id)).toEqual(fixed);
    expect(applied.projects[0].baseline).toEqual(baseline);
    expect(applied.projects[1]).toEqual(foreign);
  });
});

describe('Общая таблица материалов',()=>{
  it('сводит по дням все полуфабрикаты, переносит остатки и отделяет выпуск от склада',()=>{
    const {p}=twoStages();p.opening={'stage-1':3,'stage-2':2};
    const move=(id:string,stageId:string,quantity:number,kind:Movement['kind'],at='2026-09-23T02:00:00Z'):Movement=>({id,stageId,quantity,kind,at});
    p.movements=[move('a','stage-1',10,'output'),move('b','stage-1',-4,'consume'),move('c','stage-2',4,'output'),move('d','stage-2',-3,'shipment'),move('e','stage-1',5,'output','2026-09-24T02:00:00Z')];
    const r=materialReport(p),first=r.days[0],second=r.days[1];
    expect(first.stages.map(s=>s.stageId)).toEqual(p.stages.map(s=>s.id));
    expect(first.stages[0].fact).toMatchObject({opening:3,output:10,consume:4,closing:9,cumulative:10});
    expect(second.stages[0].fact).toMatchObject({opening:9,output:5,closing:14,cumulative:15});
    expect(first.stages[1].fact).toMatchObject({opening:2,output:4,shipped:3,closing:3,cumulative:4});
    expect(first.stages[1].plan).toMatchObject({closing:2,shipped:0,output:0});
  });
  it('включает отгрузки после дедлайна и учитывает местный день предприятия',()=>{
    const {w,p}=twoStages();p.opening={'stage-2':10};
    const next=addMovement(w,p.id,{id:'late',stageId:'stage-2',at:'2026-09-25T18:00:00Z',quantity:-4,kind:'shipment'});
    const report=materialReport(next.projects[0]);
    expect(report.to).toBe('2026-09-26');
    expect(report.days.at(-1)!.stages[1].fact).toMatchObject({opening:10,closing:6,shipped:4});
    expect(report.days.at(-1)!.stages[1].plan.closing).toBe(10);
    expect(()=>addMovement(next,p.id,{id:'too-much',stageId:'stage-2',at:'2026-09-26T02:00:00Z',quantity:-7,kind:'shipment'})).toThrow('Дефицит');
  });
  it('сводка и подробный журнал используют один и тот же расчёт',()=>{
    const {w,p}=twoStages();p.assignments=plan(w,p.id,'pull',now)[0].assignments;
    const report=materialReport(p);
    const full=dailyInventory(p,p.movements,report.from,report.to);
    const active=full.filter(row=>report.days.some(day=>day.date===row.date));
    expect(report.days.flatMap(d=>d.stages.map(s=>s.fact))).toEqual(active);
    expect(report.days.every(day=>day.stages.some(s=>s.plan.events.length||s.fact.events.length||s.plan.output||s.fact.output))).toBe(true);
    expect(report.days.at(-1)!.stages[1].plan.closing).toBe(p.quantity);
  });
});
