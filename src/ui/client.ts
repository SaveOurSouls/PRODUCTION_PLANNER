import {canonicalJson} from '../domain/serialization';
import type {Workspace,Job,Scenario,Project,Actual,Assignment,Movement,Employee,Machine,Operation} from '../domain/types';
import {seedWorkspace} from '../domain/seed';
import {saveProject,cloneProject,recordActual,addMovement,saveAssignment} from '../domain/actions';
import {plan,applyScenario} from '../domain/scheduler';
import {projectSchema,employeeSchema,machineSchema,operationSchema,workspaceSchema} from '../domain/schema';
const KEY='potok-workspace-v1';
export class Client {
  local?:Workspace;scenarios:Scenario[]=[];
  constructor(public demo:boolean){if(demo){try{this.local=workspaceSchema.parse(JSON.parse(localStorage.getItem(KEY)||'null'));}catch{this.local=seedWorkspace();}}}
  async request(path:string,body?:unknown){const r=await fetch('/api/v1/'+path,{method:body===undefined?'GET':'POST',headers:body===undefined?{}:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const data=await r.json();if(!r.ok)throw new Error(data.error||'Ошибка сервера');return data;}
  private persist(w:Workspace){this.local=w;localStorage.setItem(KEY,JSON.stringify(w));return structuredClone(w);}
  async load():Promise<Workspace>{return this.demo?structuredClone(this.local!):this.request('workspace');}
  async save(p:Project):Promise<Workspace>{return this.demo?this.persist(saveProject(this.local!,p)):this.request('projects',p);}
  async action(id:string,action:string,input:unknown={}):Promise<Workspace>{
    if(!this.demo)return this.request(`projects/${id}/${action}`,input);
    const w=structuredClone(this.local!),p=w.projects.find(p=>p.id===id)!;
    if(action==='clone')return this.persist(saveProject(w,cloneProject(p,!!(input as {template?:boolean}).template)));
    if(action==='actuals')return this.persist(recordActual(w,id,input as Actual));
    if(action==='assignments')return this.persist(saveAssignment(w,id,input as Assignment));
    if(action==='movements')return this.persist(addMovement(w,id,input as Movement));
    if(action==='delete'){if((input as {confirm:string}).confirm!==p.code)throw new Error('Введите номер проекта');p.previousStatus=p.status==='closed'?'closed':'open';p.status='deleted';}
    if(action==='restore')p.status=p.previousStatus||'open';if(action==='close')p.status='closed';if(action==='reopen')p.status='open';p.revision++;return this.persist(w);
  }
  async catalog(kind:'employees'|'machines'|'operations',item:Employee|Machine|Operation):Promise<Workspace>{
    if(!this.demo)return this.request('catalog/'+kind,item);const w=structuredClone(this.local!);
    if(kind==='employees'){const value=employeeSchema.parse(item);w.employees=w.employees.filter(e=>e.id!==value.id);w.employees.push(value);}
    if(kind==='machines'){const value=machineSchema.parse(item);w.machines=w.machines.filter(e=>e.id!==value.id);w.machines.push(value);}
    if(kind==='operations'){const value=operationSchema.parse(item);w.operations=w.operations.filter(e=>e.id!==value.id);w.operations.push(value);}
    return this.persist(w);
  }
  async calculate(projectId:string,mode:'first'|'throughput',onStatus:(s:string)=>void):Promise<Job>{
    if(this.demo){onStatus('Рассчитываем варианты…');const p=this.local!.projects.find(p=>p.id===projectId)!;const code=(window as unknown as {plannerWorkerSource:string}).plannerWorkerSource;const url=URL.createObjectURL(new Blob([code],{type:'text/javascript'}));
      this.scenarios=await new Promise<Scenario[]>((resolve,reject)=>{const worker=new Worker(url);const timer=setTimeout(()=>{worker.terminate();URL.revokeObjectURL(url);reject(new Error('Расчёт превысил 5 минут. Увеличьте передаточные партии.'));},300000);const finish=()=>{clearTimeout(timer);worker.terminate();URL.revokeObjectURL(url);};worker.onmessage=e=>{finish();e.data.error?reject(new Error(e.data.error)):resolve(e.data.scenarios);};worker.onerror=e=>{finish();reject(new Error(e.message));};worker.postMessage({workspace:this.local,projectId,mode,now:p.startDate+'T00:00:00+08:00'});});return {id:'local',status:'done',scenarios:this.scenarios};}
    let job:Job=await this.request(`projects/${projectId}/plan`,{mode});
    for(let attempt=0;attempt<600;attempt++){onStatus(job.status==='queued'?'В очереди расчётов…':'Рассчитываем варианты…');await new Promise(r=>setTimeout(r,1500));job=await this.request('jobs/'+job.id);if(job.status==='error')throw new Error(job.error);if(job.status==='done')return job;}
    throw new Error('Расчёт продолжается на сервере. Проверьте работу worker.');
  }
  async apply(jobId:string,scenario:Scenario):Promise<Workspace>{return this.demo?this.persist(applyScenario(this.local!,scenario)):this.request(`jobs/${jobId}/apply`,{scenarioId:scenario.id});}
  async exportProject(id:string){if(!this.demo)return this.request(`projects/${id}/export`);const w=this.local!;return {schemaVersion:1,project:w.projects.find(p=>p.id===id),employees:w.employees,machines:w.machines,operations:w.operations};}
  async importProject(data:{schemaVersion:number;project:Project;employees:Employee[];machines:Machine[];operations:Operation[]}):Promise<Workspace>{
    if(!this.demo)return this.request('projects/import',data);if(data.schemaVersion!==1)throw new Error('Неподдерживаемая версия');const p=projectSchema.parse(data.project);const w=structuredClone(this.local!);if(w.projects.some(x=>x.id===p.id))throw new Error('Такой проект уже существует');
    for(const [key,schema] of [['employees',employeeSchema],['machines',machineSchema],['operations',operationSchema]] as const)for(const v of data[key]){const item=schema.parse(v);const existing=w[key].find(x=>x.id===item.id);if(existing&&canonicalJson(existing)!==canonicalJson(item))throw new Error('Конфликт справочника '+item.name);if(!existing)(w[key] as {id:string}[]).push(item);}
    w.projects.push(p);return this.persist(w);
  }
}
export function download(name:string,value:unknown){const url=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
