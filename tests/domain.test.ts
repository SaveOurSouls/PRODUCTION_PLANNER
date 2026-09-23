import {describe,it,expect} from 'vitest';
import {calculateNorm,actualMetrics} from '../src/domain/norms';
import {seedWorkspace} from '../src/domain/seed';
import {validateRoute,demand} from '../src/domain/graph';
import {fitWork,seconds} from '../src/domain/calendar';
import {plan,applyScenario,assignmentConflicts,fingerprint} from '../src/domain/scheduler';
import {inventoryErrors,dailyInventory} from '../src/domain/inventory';
import {recordActual,cloneProject,saveProject,addMovement} from '../src/domain/actions';
import {previewImport,applyImport,parseNumber} from '../src/domain/importer';
import type {Workspace,Actual} from '../src/domain/types';
function fixture(){const w=seedWorkspace();const p=w.projects[0];p.quantity=30;for(const e of p.edges)e.transferBatch=5;return w;}
const now='2026-09-23T00:00:00.000Z';
describe('Нормы',()=>{
  it('погонная норма использует секунды на метр и действия инструмента',()=>{const n={...seedWorkspace().operations[0].norm,type:'linear' as const,length:2,secondsPerMeter:3,toolSeconds:.5,toolCount:2,extra:1,work:0};expect(calculateNorm(n).cycle).toBe(8);});
  it.each(['static','variable'] as const)('%s: ручная сумма и нижняя машинная граница',type=>{const n={...seedWorkspace().operations[0].norm,type,take:3,work:4,put:2,extra:1,toolSeconds:12,toolCount:1};expect(calculateNorm(n,2).cycle).toBe(13);expect(calculateNorm({...n,override:2}).cycle).toBe(13);});
  it('ручная операция не резервирует машинное время',()=>{const n={...seedWorkspace().operations[1].norm,toolSeconds:200,toolCount:5};expect(calculateNorm(n).machine).toBe(0);expect(()=>calculateNorm(n,0)).toThrow();});
  it('нулевой выпуск и среднее взвешенное по количеству',()=>{expect(actualMetrics([]).average).toBeNull();const base={id:'f',assignmentId:'a',start:now,end:'2026-09-23T00:02:00Z',pauseSeconds:0,processed:4,scrap:1,employeeIds:['a','b']};expect(actualMetrics([base]).average).toBe(30);expect(actualMetrics([base]).perGood).toBe(80);});
});
describe('Граф и календарь',()=>{
  it('отвергает циклы и два Final',()=>{const p=fixture().projects[0];p.edges.push({id:'loop',source:'stage-4',target:'stage-1',quantity:1,transferBatch:1});expect(()=>validateRoute(p)).toThrow('цикл');p.edges.pop();p.stages[0].final=true;expect(()=>validateRoute(p)).toThrow('Final');});
  it('сборка 2A + 1B требует все компоненты',()=>{const p=fixture().projects[0];p.stages=p.stages.slice(0,3);p.stages[2].final=true;p.edges=[{id:'a-c',source:'stage-1',target:'stage-3',quantity:2,transferBatch:1},{id:'b-c',source:'stage-2',target:'stage-3',quantity:1,transferBatch:1}];expect(demand(p)).toEqual({'stage-3':30,'stage-2':30,'stage-1':60});});
  it('учитывает перерыв, 6,5 часов и выходные',()=>{const c=seedWorkspace().employees[0].calendar;const spans=fitWork([c],[],seconds('2026-09-25T09:00:00+08:00'),8*3600)!;expect(spans).toHaveLength(3);expect(spans[0].end).toBe('2026-09-25T05:00:00.000Z');expect(spans[2].start).toBe('2026-09-28T01:00:00.000Z');expect(spans.reduce((s,a)=>s+seconds(a.end)-seconds(a.start),0)).toBe(28800);});
});
describe('Автопланирование',()=>{
  it('снимок PostgreSQL с другим порядком полей остаётся тем же вариантом',()=>{
    const w=fixture(),s=plan(w,w.projects[0].id,'throughput',now)[0];
    const reorder=(value:unknown):unknown=>Array.isArray(value)?value.map(reorder):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).reverse().filter(([,v])=>v!==undefined).map(([k,v])=>[k,reorder(v)])):value;
    const restored=reorder(JSON.parse(JSON.stringify(w))) as Workspace;
    expect(fingerprint(restored)).toBe(fingerprint(w));expect(applyScenario(restored,s).projects[0].assignments.length).toBeGreaterThan(0);
    restored.employees[0].calendar.effectiveHours=5;expect(()=>applyScenario(restored,s)).toThrow('изменились');
  });
  it('подготовка начисляется при запуске ресурса, а не каждой передаче',()=>{
    const w=fixture(),p=w.projects[0];p.stages[0].operations[0].norm.setup=60;
    const s=plan(w,p.id,'first',now)[0],tasks=s.assignments.filter(a=>a.stageId==='stage-1');
    const resources=new Set(tasks.map(a=>a.employeeIds.join(',')+a.machineUnit));
    expect(tasks.length).toBeGreaterThan(resources.size);expect(tasks.reduce((sum,a)=>sum+a.setupSeconds,0)).toBe(resources.size*60);
  });
  it('один общий запас используется двумя потребителями без двойного резерва',()=>{
    const w=fixture(),p=w.projects[0];p.edges=[{id:'ab',source:'stage-1',target:'stage-2',quantity:2,transferBatch:5},{id:'ac',source:'stage-1',target:'stage-3',quantity:1,transferBatch:5},{id:'bd',source:'stage-2',target:'stage-4',quantity:1,transferBatch:5},{id:'cd',source:'stage-3',target:'stage-4',quantity:1,transferBatch:5}];
    const s=plan(w,p.id,'throughput',now)[0];expect(inventoryErrors({},s.movements)).toEqual([]);expect(s.movements.filter(m=>m.stageId==='stage-1'&&m.kind==='consume').reduce((sum,m)=>sum+m.quantity,0)).toBe(-90);
  });
  it('срок максимальной производительности не хуже вариантов первой отгрузки',()=>{
    const w=fixture(),p=w.projects[0],first=plan(w,p.id,'first',now),fast=plan(w,p.id,'throughput',now)[0];
    expect(first.length).toBeGreaterThan(1);expect(first.every(s=>fast.finishAt<=s.finishAt)).toBe(true);
  });
  it('сохраняет материальный баланс и исключает пересечения людей и машин',()=>{const w=fixture(),s=plan(w,w.projects[0].id,'throughput',now)[0];expect(s.assignments.length).toBeGreaterThan(0);expect(inventoryErrors(w.projects[0].opening,s.movements)).toEqual([]);for(const a of s.assignments)expect(assignmentConflicts(w,w.projects[0],a,s.assignments)).toEqual([]);const final=s.movements.filter(m=>m.stageId==='stage-4'&&m.kind==='output').reduce((a,m)=>a+m.quantity,0);expect(final).toBe(30);});
  it('предлагает разные размеры первой партии и корректно применяет версию',()=>{const w=fixture(),options=plan(w,w.projects[0].id,'first',now);expect(options.length).toBeGreaterThan(1);expect(options.length).toBeLessThanOrEqual(5);const next=applyScenario(w,options[0]);expect(next.projects[0].baseline.length).toBeGreaterThan(0);expect(()=>applyScenario(next,options[0])).toThrow('изменились');});
  it('учитывает обязательную бригаду без деления нормы',()=>{const w=fixture(),p=w.projects[0];p.stages=p.stages.slice(0,1);p.stages[0].final=true;p.edges=[];p.stages[0].operations[0].mode='crew';p.stages[0].operations[0].workers=2;p.quantity=1;const s=plan(w,p.id,'throughput',now)[0];expect(s.assignments[0].employeeIds).toHaveLength(2);expect(seconds(s.assignments[0].end)-seconds(s.assignments[0].start)).toBeCloseTo(28.8);});
  it('выдаёт причину отсутствия допуска',()=>{const w=fixture();for(const e of w.employees)e.skills={};expect(()=>plan(w,w.projects[0].id,'first',now)).toThrow('допущенных');});
  it('не использует поставку до даты поступления',()=>{const w=fixture(),p=w.projects[0];p.quantity=10;p.opening={};p.supplies=[{id:'s',stageId:'stage-1',quantity:10,at:'2026-09-25T02:00:00.000Z'}];const s=plan(w,p.id,'throughput',now)[0];expect(s.assignments.some(a=>a.stageId==='stage-1')).toBe(false);expect(s.assignments.filter(a=>a.stageId==='stage-2').every(a=>a.start>=p.supplies[0].at)).toBe(true);});
  it('готовая продукция поставки завершает заказ только после поступления',()=>{const w=fixture(),p=w.projects[0];p.supplies=[{id:'ready',stageId:'stage-4',quantity:30,at:'2026-09-25T02:00:00.000Z'}];const s=plan(w,p.id,'throughput',now)[0];expect(s.assignments).toEqual([]);expect(s.finishAt).toBe(p.supplies[0].at);});
  it('сборка из двух потоков не расходует один запас дважды',()=>{const w=fixture(),p=w.projects[0];p.stages=p.stages.slice(0,3);p.stages[2].final=true;p.edges=[{id:'1',source:'stage-1',target:'stage-3',quantity:2,transferBatch:5},{id:'2',source:'stage-2',target:'stage-3',quantity:1,transferBatch:5}];const s=plan(w,p.id,'throughput',now)[0];expect(inventoryErrors({},s.movements)).toEqual([]);expect(s.movements.filter(m=>m.kind==='consume'&&m.stageId==='stage-1').reduce((n,m)=>n+m.quantity,0)).toBe(-60);});
  it('сохраняет чужой проект и закреплённые задания при пересчёте',()=>{const w=fixture(),p=w.projects[0];const s=plan(w,p.id,'throughput',now)[0];let next=applyScenario(w,s);next.projects[0].assignments[0].locked=true;const locked=structuredClone(next.projects[0].assignments[0]);const foreign=cloneProject(p);foreign.id='foreign';foreign.assignments=[{...s.assignments[0],id:'foreign-task',projectId:foreign.id}];next.projects.push(foreign);const result=plan(next,p.id,'throughput',now)[0];expect(result.assignments.find(a=>a.id===locked.id)).toEqual(locked);expect(next.projects[1]).toEqual(foreign);});
});
describe('Факт и импорт',()=>{
  it('импорт требует единицы, не скрывает пропуски и не затрагивает проектные нормы',()=>{
    const w=fixture(),snapshot=structuredClone(w.projects[0]);
    const sheet={spreadsheet:'s',sheet:'БД.ОП',at:now,values:[['Номер','Название операции','Тип операции','Время ручных работ для взятия полуфабриката','Время ручных работ','Время ручных работ для снятия полуфабриката','Время доп.операции'],['1','Сборка','Статичный','1','4','1','0']]};
    expect(previewImport([sheet],w).diagnostics.some(d=>d.blocking&&d.message.includes('единицы'))).toBe(true);
    const preview=previewImport([sheet],w,{timeUnit:'seconds'});expect(preview.diagnostics.some(d=>d.blocking)).toBe(false);const next=applyImport(w,preview);expect(next.projects[0]).toEqual(snapshot);
    sheet.values[1][4]='';expect(previewImport([sheet],w,{timeUnit:'seconds'}).diagnostics.some(d=>d.blocking&&d.message.includes('Не задано'))).toBe(true);
  });
  it('импорт ЗАГРУЗ не принимает смещённые строки сотрудников за проекты',()=>{
    const w=fixture(),sheet={spreadsheet:'s',sheet:'ЗАГРУЗ',at:now,values:[['№ проекта','Наименование организации','Дедлайн'],['1','Клиент','01.10.2026'],[],[],['EMPLOYEE','Оператор']]};
    const preview=previewImport([sheet],w,{employeesStartRow:5});expect(preview.projects.map(p=>p.code)).toEqual(['1']);
  });
  it('частичный и нулевой выпуск суммируются, брак не попадает в годный запас',()=>{
    let w=fixture();const options=plan(w,w.projects[0].id,'first',now);w=applyScenario(w,options[options.length-1]);const p=w.projects[0],a=p.assignments.find(a=>a.stageId==='stage-1')!;
    const at=(i:number)=>new Date(Date.parse(a.start)+i*1000).toISOString();
    for(const [i,processed,scrap] of [[0,0,0],[1,1,1],[2,1,0]])w=recordActual(w,p.id,{id:'partial-'+i,assignmentId:a.id,start:at(i*10),end:at(i*10+10),pauseSeconds:0,employeeIds:a.employeeIds,processed,scrap});
    const final=w.projects[0];expect(actualMetrics(final.actuals).average).toBe(15);expect(final.movements.filter(m=>m.kind==='output').reduce((sum,m)=>sum+m.quantity,0)).toBe(1);
    const changed=structuredClone(final);changed.opening={'stage-1':999};expect(()=>saveProject(w,changed)).toThrow('корректировку');
  });
  it('движения сравниваются по времени с учётом часового пояса',()=>{
    expect(inventoryErrors({},[{id:'in',at:'2026-09-23T09:00:00+08:00',stageId:'a',quantity:2,kind:'receipt'},{id:'out',at:'2026-09-23T02:00:00Z',stageId:'a',quantity:-2,kind:'consume'}])).toEqual([]);
  });
  it('факт первого этапа создаёт только годный запас',()=>{let w=fixture();const options=plan(w,w.projects[0].id,'first',now);w=applyScenario(w,options[options.length-1]);const p=w.projects[0],a=p.assignments.find(a=>a.stageId==='stage-1')!;const f:Actual={id:'f',assignmentId:a.id,start:a.start,end:a.end,pauseSeconds:0,processed:a.quantity,scrap:1,employeeIds:a.employeeIds};w=recordActual(w,p.id,f);expect(w.projects[0].movements.find(m=>m.kind==='output')!.quantity).toBe(a.quantity-1);expect(()=>recordActual(w,p.id,f)).toThrow('существует');});
  it('не разрешает факт последующего этапа без материала',()=>{let w=fixture();w=applyScenario(w,plan(w,w.projects[0].id,'throughput',now)[0]);const p=w.projects[0],a=p.assignments.find(a=>a.stageId==='stage-2')!;expect(()=>recordActual(w,p.id,{id:'f',assignmentId:a.id,start:a.start,end:a.end,pauseSeconds:0,processed:1,scrap:0,employeeIds:a.employeeIds})).toThrow('Дефицит');});
  it('не разрешает отгрузить отсутствующую продукцию',()=>{const w=fixture();expect(()=>addMovement(w,w.projects[0].id,{id:'m',stageId:'stage-4',at:now,quantity:-1,kind:'shipment'})).toThrow('Дефицит');});
  it('сохраняет только маршрут при создании шаблона',()=>{const p=fixture().projects[0];p.opening={'stage-1':10};const copy=cloneProject(p,true);expect(copy.template).toBe(true);expect(copy.assignments).toEqual([]);expect(copy.opening).toEqual({});expect(copy.stages).toEqual(p.stages);});
  it('русские числа и формульные ошибки не превращаются в ноль',()=>{expect(parseNumber('1 200,5')).toBe(1200.5);expect(parseNumber('#REF!')).toBeNull();expect(parseNumber('')).toBeNull();});
  it('повторный импорт не создаёт дубликатов и сохраняет допуски',()=>{const w=fixture(),sheets=[{spreadsheet:'s',sheet:'БД. СОТ',values:[['Линейный сотрудник'],['Тестовый оператор']],at:now}];const preview=previewImport(sheets,w);const once=applyImport(w,preview);once.employees.at(-1)!.skills={special:{allowed:true,stars:5,coefficient:1.2}};const twice=applyImport(once,previewImport(sheets,once));expect(twice.employees.length).toBe(once.employees.length);expect(twice.employees.at(-1)!.skills.special.coefficient).toBe(1.2);});
});
