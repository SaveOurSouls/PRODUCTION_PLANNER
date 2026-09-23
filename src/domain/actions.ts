import type {Workspace,Project,Actual,Assignment,Movement} from './types';
import {uid} from './types';
import {projectSchema,actualSchema,assignmentSchema,movementSchema} from './schema';
import {topological} from './graph';
import {actualMovements,assignmentMovements,inventoryErrors} from './inventory';
import {assignmentConflicts} from './scheduler';
import {canonicalJson} from './serialization';
export function saveProject(w:Workspace,input:Project){
  const p=projectSchema.parse(input);topological(p);
  if(new Set(p.stages.map(s=>s.index)).size!==p.stages.length)throw new Error('Индекс полуфабриката должен быть уникальным');
  const next=structuredClone(w),index=next.projects.findIndex(x=>x.id===p.id),old=next.projects[index];
  if(old){
    if(old.revision!==p.revision)throw new Error('Проект изменён в другой вкладке. Обновите страницу.');
    const routeChanged=canonicalJson([old.stages,old.edges])!==canonicalJson([p.stages,p.edges]);
    if(old.assignments.length&&routeChanged){const structural=(x:Project)=>canonicalJson([x.stages.map(s=>({id:s.id,final:s.final,operations:s.operations.map(o=>o.id)})),x.edges]);if(structural(old)!==structural(p))throw new Error('Для изменения структуры используйте копию проекта: уже есть задания');}
    if((old.actuals.length||old.movements.length)&&canonicalJson(old.opening)!==canonicalJson(p.opening))throw new Error('Начальный остаток уже участвует в учёте. Добавьте корректировку в журнал движений.');
    if(old.assignments.some(a=>a.employeeIds.some(id=>!p.employeeIds.includes(id))))throw new Error('У сотрудника есть задания. Сначала переназначьте их.');
    p.assignments=old.assignments;p.baseline=old.baseline;p.actuals=old.actuals;p.movements=old.movements;p.revision++;if(routeChanged)p.normVersion++;
    if(p.employeeIds.some(id=>!w.employees.some(e=>e.id===id)))throw new Error('Сотрудник не найден');
    next.projects[index]=p;
  }else {if(p.assignments.length||p.actuals.length||p.movements.length||p.baseline.length)throw new Error('Новый проект создаётся без фактических записей');next.projects.push(p);}
  return next;
}
export function cloneProject(p:Project,asTemplate=false):Project{
  return {...structuredClone(p),id:uid(),revision:1,normVersion:1,name:p.name+(asTemplate?' · шаблон':' · копия'),code:p.code+'-К',template:asTemplate,status:'open',previousStatus:undefined,assignments:[],baseline:[],actuals:[],movements:[],opening:{},supplies:[],demo:false};
}
export function recordActual(w:Workspace,projectId:string,input:Actual){
  const f=actualSchema.parse(input),next=structuredClone(w),p=next.projects.find(p=>p.id===projectId);
  if(!p||p.status!=='open'||p.template)throw new Error('Проект недоступен для ввода факта');
  if(p.actuals.some(a=>a.id===f.id))throw new Error('Такая запись факта уже существует');
  const a=p.assignments.find(a=>a.id===f.assignmentId);if(!a)throw new Error('Задание не найдено');
  if(new Set(f.employeeIds).size!==f.employeeIds.length||f.employeeIds.length!==a.employeeIds.length||f.employeeIds.some(id=>!a.employeeIds.includes(id)))throw new Error('Исполнители факта должны соответствовать заданию');
  if(p.actuals.filter(x=>x.assignmentId===a.id).reduce((s,x)=>s+x.processed,0)+f.processed>a.quantity)throw new Error('Суммарный факт превышает количество задания');
  const stage=p.stages.find(s=>s.id===a.stageId)!,index=stage.operations.findIndex(o=>o.id===a.operationId);
  if(index>0){const previous=p.assignments.filter(x=>x.batchId===a.batchId&&x.operationId===stage.operations[index-1].id);const good=p.actuals.filter(x=>previous.some(t=>t.id===x.assignmentId)&&x.end<=f.start).reduce((s,x)=>s+x.processed-x.scrap,0);const processed=p.actuals.filter(x=>x.assignmentId===a.id).reduce((s,x)=>s+x.processed,0)+f.processed;if(processed>good)throw new Error('Недостаточно подтверждённого выпуска предыдущей операции');}
  for(const project of w.projects)for(const other of project.actuals)if(other.employeeIds.some(id=>f.employeeIds.includes(id))&&f.start<other.end&&other.start<f.end)throw new Error('Факт пересекается с другой работой сотрудника');
  const movements=actualMovements(p,a,f);const errors=inventoryErrors(p.opening,[...p.movements,...movements]);if(errors.length)throw new Error(errors[0]);
  p.actuals.push(f);p.movements.push(...movements);a.locked=true;p.revision++;
  return next;
}
export function addMovement(w:Workspace,projectId:string,input:Movement){
  const m=movementSchema.parse(input);if(!['receipt','shipment','adjustment','opening'].includes(m.kind))throw new Error('Выпуск и расход регистрируются через факт');
  const next=structuredClone(w),p=next.projects.find(p=>p.id===projectId);if(!p||!p.stages.some(s=>s.id===m.stageId))throw new Error('Полуфабрикат не найден');
  if(p.status!=='open'||p.template)throw new Error('Откройте рабочий проект');
  if(p.movements.some(x=>x.id===m.id))throw new Error('Запись уже существует');
  if(m.kind==='shipment'&&(m.quantity>=0||!p.stages.find(s=>s.id===m.stageId)?.final))throw new Error('Отгрузка списывает готовую продукцию');
  if(['opening','receipt'].includes(m.kind)&&m.quantity<=0)throw new Error('Поступление должно быть положительным');
  const errors=inventoryErrors(p.opening,[...p.movements,m]);if(errors.length)throw new Error(errors[0]);p.movements.push(m);p.revision++;return next;
}
export function saveAssignment(w:Workspace,projectId:string,input:Assignment){
  const a=assignmentSchema.parse(input),next=structuredClone(w),p=next.projects.find(p=>p.id===projectId);if(!p||a.projectId!==p.id)throw new Error('Проект не найден');
  if(p.status!=='open'||p.template)throw new Error('Откройте рабочий проект');
  const old=p.assignments.find(x=>x.id===a.id);if(old&&p.actuals.some(f=>f.assignmentId===a.id))throw new Error('Задание с фактом нельзя менять');
  const existing=next.projects.filter(x=>x.status!=='deleted'&&!x.template).flatMap(x=>x.assignments);
  const errors=assignmentConflicts(next,p,a,existing);if(errors.length)throw new Error(errors.join('; '));
  const stage=p.stages.find(s=>s.id===a.stageId)!,opIndex=stage.operations.findIndex(o=>o.id===a.operationId);
  if(opIndex>0){const predecessor=p.assignments.find(x=>x.batchId===a.batchId&&x.operationId===stage.operations[opIndex-1].id);if(!predecessor||predecessor.end>a.start||predecessor.quantity<a.quantity)throw new Error('Предыдущая операция партии должна завершиться до начала');}
  const successors=p.assignments.filter(x=>x.batchId===a.batchId&&stage.operations.findIndex(o=>o.id===x.operationId)>opIndex);if(successors.some(x=>x.start<a.end))throw new Error('Следующая операция начинается до завершения этой');
  p.assignments=p.assignments.filter(x=>x.id!==a.id);p.assignments.push(a);
  const stockErrors=inventoryErrors(p.opening,[...p.supplies.map(s=>({id:s.id,at:s.at,stageId:s.stageId,quantity:s.quantity,kind:'receipt' as const})),...assignmentMovements(p,p.assignments)]);if(stockErrors.length)throw new Error(stockErrors[0]);
  p.revision++;return next;
}
