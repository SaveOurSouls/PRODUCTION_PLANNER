import {describe,expect,it} from 'vitest';
import {groupWork,stageNorm} from '../src/domain/reporting';
import {seedWorkspace} from '../src/domain/seed';
import type {Assignment,Actual} from '../src/domain/types';

const start='2026-09-23T01:00:00Z',end='2026-09-23T02:00:00Z';
const from=Date.parse('2026-09-22T16:00:00Z'),to=from+86400000; // Enterprise day in UTC+8.
function fixture(){
  const p=seedWorkspace().projects[0];p.assignments=[];p.actuals=[];
  const a=(id:string,patch:Partial<Assignment>={}):Assignment=>({id,batchId:id,projectId:p.id,stageId:p.stages[0].id,operationId:p.stages[0].operations[0].id,employeeIds:['person'],quantity:5,start,end,segments:[{start,end}],setupSeconds:0,locked:false,...patch});
  const f=(id:string,assignmentId:string,patch:Partial<Actual>={}):Actual=>({id,assignmentId,start,end,pauseSeconds:0,processed:5,scrap:0,employeeIds:['person'],...patch});
  return {p,a,f};
}
describe('Групповой план/факт',()=>{
  it('сворачивает партии одной работы; переключение полуфабриката создаёт другую строку',()=>{
    const {p,a}=fixture();p.assignments=[a('1'),a('2',{quantity:7}),a('3',{stageId:p.stages[1].id,operationId:p.stages[1].operations[0].id,quantity:3})];
    const groups=groupWork([p],'person',from,to);
    expect(groups).toHaveLength(2);expect(groups.map(g=>g.plannedOutput)).toEqual([12,3]);expect(groups[0].assignments).toHaveLength(2);
  });
  it('не считает промежуточные операции повторным выпуском полуфабриката',()=>{
    const {p,a,f}=fixture();p.stages[0].operations.push({...p.stages[0].operations[0],id:'last'});
    p.assignments=[a('first'),a('last',{operationId:'last'})];
    p.actuals=[f('f1','first'),f('f2','last',{processed:3,scrap:1}),f('f3','last',{processed:2})];
    const [g]=groupWork([p],'person',from,to);expect(g.plannedOutput).toBe(5);expect(g.actualOutput).toBe(4);expect(g.scrap).toBe(1);
  });
  it('показывает многодневную работу, но выпуск относит только к дню завершения',()=>{
    const {p,a,f}=fixture(),tomorrow='2026-09-24T02:00:00Z';
    p.assignments=[a('long',{end:tomorrow,segments:[{start,end},{start:'2026-09-24T01:00:00Z',end:tomorrow}]})];
    p.actuals=[f('f','long',{end:tomorrow})];
    expect(groupWork([p],'person',from,to)[0]).toMatchObject({plannedOutput:0,actualOutput:0});
    expect(groupWork([p],'person',to,to+86400000)[0]).toMatchObject({plannedOutput:5,actualOutput:5});
  });
  it('завершение на границе дня учитывается ровно один раз, даже без сегмента следующего дня',()=>{
    const {p,a}=fixture(),midnight=new Date(to).toISOString();p.assignments=[a('night',{end:midnight,segments:[{start,end:midnight}]})];
    expect(groupWork([p],'person',from,to)[0].plannedOutput).toBe(0);
    expect(groupWork([p],'person',to,to+86400000)[0].plannedOutput).toBe(5);
  });
  it('бригада видит общий выпуск; подмена исполнителя факта не теряет факт',()=>{
    const {p,a,f}=fixture();p.assignments=[a('crew',{employeeIds:['person','second']})];p.actuals=[f('f','crew',{employeeIds:['person','replacement']})];
    for(const id of ['person','second'])expect(groupWork([p],id,from,to)[0]).toMatchObject({plannedOutput:5,crew:true});
    expect(groupWork([p],'replacement',from,to)[0]).toMatchObject({plannedOutput:0,actualOutput:5,crew:true});
  });
  it('не смешивает разные проекты и сохраняет нулевой факт',()=>{
    const {p,a,f}=fixture();p.assignments=[a('1')];p.actuals=[f('zero','1',{processed:0})];
    const other=structuredClone(p);other.id='other';other.assignments[0].projectId=other.id;
    const groups=groupWork([p,other],'person',from,to);expect(groups).toHaveLength(2);expect(groups[0].actuals).toHaveLength(1);expect(groups[0].actualOutput).toBe(0);
  });
});
describe('Норматив полуфабриката',()=>{
  it('суммирует последовательные циклы, подготовку и трудозатраты бригады',()=>{
    const {p}=fixture(),stage=p.stages[0],base=stage.operations[0];
    stage.operations=[{...base,norm:{...base.norm,machineId:undefined,work:10,setup:30}}, {...base,id:'crew',mode:'crew',workers:2,norm:{...base.norm,machineId:undefined,work:20,setup:60,override:25}}];
    expect(stageNorm(stage,100)).toMatchObject({cycle:35,calculated:30,setup:90,overridden:true});
    expect(stageNorm(stage,100)?.laborHours).toBeCloseTo((1030+2560*2)/3600);
  });
  it('не подменяет отсутствующие или неверные нормы нулями',()=>{
    const {p}=fixture(),stage=p.stages[0];expect(stageNorm(stage)?.laborHours).toBeNull();
    stage.operations[0].norm.work=NaN;expect(stageNorm(stage,100)).toBeNull();
    stage.operations=[];expect(stageNorm(stage,100)).toBeNull();
  });
});
