import {canonicalJson} from '../../../../domain/serialization';
import {NextRequest,NextResponse} from 'next/server';
import {z} from 'zod';
import {db} from '../../../../server/db';
import {readWorkspace,mutate,json} from '../../../../server/repository';
import {authenticated,enforceOrigin,checkPassword,session} from '../../../../server/auth';
import {authorization,exchange,fetchSnapshots} from '../../../../server/google';
import {previewImport,applyImport,type ImportPreview} from '../../../../domain/importer';
import {saveProject,cloneProject,recordActual,addMovement,saveAssignment} from '../../../../domain/actions';
import {applyScenario} from '../../../../domain/scheduler';
import {projectSchema,employeeSchema,machineSchema,operationSchema} from '../../../../domain/schema';
import {seedWorkspace} from '../../../../domain/seed';
import type {Scenario,Project} from '../../../../domain/types';
export const runtime='nodejs';export const dynamic='force-dynamic';
const loginAttempts=new Map<string,{count:number;until:number}>();
const response=(value:unknown,status=200)=>NextResponse.json(value,{status,headers:{'Cache-Control':'no-store'}});
async function handler(req:NextRequest,context:{params:Promise<{path:string[]}>}){
  try{
    const {path}=await context.params,route=path.join('/');enforceOrigin(req);
    if(route==='auth/login'&&req.method==='POST'){
      const key='planner';let attempt=loginAttempts.get(key);if(attempt&&attempt.until<Date.now()){loginAttempts.delete(key);attempt=undefined;}if(attempt&&attempt.count>=10)return response({error:'Слишком много попыток. Повторите через 15 минут.'},429);
      const {login,password}=z.object({login:z.string().max(200),password:z.string().max(1000)}).parse(await req.json());
      if(!checkPassword(login,password)){loginAttempts.set(key,{count:(attempt?.count||0)+1,until:Date.now()+15*60000});return response({error:'Неверный логин или пароль'},401);}loginAttempts.delete(key);
      const r=response({ok:true});r.cookies.set('planner-session',session(),{httpOnly:true,sameSite:'lax',secure:process.env.APP_URL?.startsWith('https:'),maxAge:12*3600,path:'/'});return r;
    }
    if(!authenticated(req))return response({error:'Войдите как планировщик'},401);
    if(route==='auth/logout'&&req.method==='POST'){const r=response({ok:true});r.cookies.delete('planner-session');return r;}
    if(route==='google/callback'&&req.method==='GET'){
      const state=req.nextUrl.searchParams.get('state'),code=req.nextUrl.searchParams.get('code');if(!state||!code||state!==req.cookies.get('google-state')?.value)throw new Error('Недопустимое подтверждение Google');await exchange(code,state);const r=NextResponse.redirect(new URL('/?google=connected',process.env.APP_URL));r.cookies.delete('google-state');return r;
    }
    if(route==='google/connect'&&req.method==='POST'){const {url,state}=authorization();const r=response({url});r.cookies.set('google-state',state,{httpOnly:true,sameSite:'lax',secure:process.env.APP_URL?.startsWith('https:'),maxAge:600,path:'/'});return r;}
    if(route==='google/status'&&req.method==='GET')return response({connected:!!await db.credential.findUnique({where:{id:'google'},select:{id:true}})});
    if(route==='workspace'&&req.method==='GET')return response(await readWorkspace());
    if(route==='demo/seed'&&req.method==='POST')return response(await mutate('demo.seed',w=>{if(w.projects.length)throw new Error('Демонстрационные данные можно загрузить только в пустую базу');return seedWorkspace();}));
    if(route==='projects'&&req.method==='POST'){const input=projectSchema.parse(await req.json());return response(await mutate('project.save',w=>saveProject(w,input)));}
    if(path[0]==='projects'&&path.length===3){const id=path[1],action=path[2];
      if(action==='export'&&req.method==='GET'){const w=await readWorkspace(),p=w.projects.find(p=>p.id===id);if(!p)throw new Error('Проект не найден');return response({schemaVersion:1,project:p,employees:w.employees.filter(e=>p.employeeIds.includes(e.id)),machines:w.machines,operations:w.operations});}
      if(req.method==='POST'){
        const input=await req.json();
        if(action==='clone')return response(await mutate('project.clone',w=>{const p=w.projects.find(p=>p.id===id);if(!p)throw new Error('Проект не найден');return saveProject(w,cloneProject(p,!!input.template));}));
        if(['close','reopen','delete','restore'].includes(action))return response(await mutate('project.'+action,w=>{const p=w.projects.find(p=>p.id===id);if(!p)throw new Error('Проект не найден');if(action==='delete'){if(input.confirm!==p.code)throw new Error('Введите номер проекта для подтверждения');p.previousStatus=p.status==='closed'?'closed':'open';p.status='deleted';}else if(action==='restore')p.status=p.previousStatus||'open';else p.status=action==='close'?'closed':'open';p.revision++;return w;}));
        if(action==='actuals')return response(await mutate('actual.create',w=>recordActual(w,id,input)));
        if(action==='movements')return response(await mutate('movement.create',w=>addMovement(w,id,input)));
        if(action==='assignments')return response(await mutate('assignment.save',w=>saveAssignment(w,id,input)));
        if(action==='plan'){const mode=z.enum(['first','throughput','pull']).parse(input.mode);const w=await readWorkspace();if(!w.projects.some(p=>p.id===id))throw new Error('Проект не найден');const job=await db.job.create({data:{projectId:id,mode,input:json(w)}});return response({id:job.id,status:job.status},202);}
      }
    }
    if(route==='projects/import'&&req.method==='POST'){
      const body=await req.json();if(body.schemaVersion!==1)throw new Error('Неподдерживаемая версия файла');const p=projectSchema.parse(body.project);
      const employees=z.array(employeeSchema).parse(body.employees||[]),machines=z.array(machineSchema).parse(body.machines||[]),operations=z.array(operationSchema).parse(body.operations||[]);
      return response(await mutate('project.import',w=>{if(w.projects.some(x=>x.id===p.id))throw new Error('Такой проект уже существует. Создайте копию перед импортом.');const join=<T extends {id:string}>(old:T[],incoming:T[])=>{for(const item of incoming){const found=old.find(x=>x.id===item.id);if(found&&canonicalJson(found)!==canonicalJson(item))throw new Error(`Конфликт справочника ${item.id}`);if(!found)old.push(item);}};join(w.employees,employees);join(w.machines,machines);join(w.operations,operations);w.projects.push(p as Project);return w;}));
    }
    if(path[0]==='catalog'&&path.length===2&&req.method==='POST'){
      const input=await req.json(),kind=path[1];return response(await mutate('catalog.'+kind,w=>{
        if(kind==='employees'){const item=employeeSchema.parse(input);w.employees=w.employees.filter(e=>e.id!==item.id);w.employees.push(item);}
        else if(kind==='machines'){const item=machineSchema.parse(input);w.machines=w.machines.filter(e=>e.id!==item.id);w.machines.push(item);}
        else if(kind==='operations'){const item=operationSchema.parse(input);w.operations=w.operations.filter(e=>e.id!==item.id);w.operations.push(item);}else throw new Error('Неизвестный справочник');return w;
      }));
    }
    if(route==='imports/preview'&&req.method==='POST'){const options=z.object({timeUnit:z.literal('seconds').optional(),employeesStartRow:z.number().int().min(5).max(5000).optional()}).parse(await req.json());const w=await readWorkspace(),sheets=await fetchSnapshots(),preview=previewImport(sheets,w,options);const snapshot=await db.importSnapshot.create({data:{payload:json(preview)}});return response({id:snapshot.id,...preview});}
    if(path[0]==='imports'&&path[2]==='apply'&&req.method==='POST')return response(await mutate('import.apply',async(w,tx)=>{const snapshot=await tx.importSnapshot.findUnique({where:{id:path[1]}});if(!snapshot)throw new Error('Снимок не найден');if(snapshot.appliedAt)throw new Error('Этот снимок уже применён');const result=applyImport(w,snapshot.payload as unknown as ImportPreview);await tx.importSnapshot.update({where:{id:path[1]},data:{appliedAt:new Date()}});return result;}));
    if(path[0]==='jobs'&&path.length===2&&req.method==='GET'){const job=await db.job.findUnique({where:{id:path[1]}});if(!job)return response({error:'Расчёт не найден'},404);return response({id:job.id,status:job.status,error:job.error,scenarios:job.result});}
    if(path[0]==='jobs'&&path[2]==='apply'&&req.method==='POST'){const input=await req.json();return response(await mutate('plan.apply',async(w,tx)=>{const job=await tx.job.findUnique({where:{id:path[1]}});if(!job||job.status!=='done')throw new Error('Расчёт ещё не готов');const s=(job.result as unknown as Scenario[]).find(s=>s.id===input.scenarioId);if(!s)throw new Error('Вариант не найден');return applyScenario(w,s,new Date().toISOString());}));}
    return response({error:'Неизвестный API маршрут'},404);
  }catch(e){const error=e as Error;return response({error:e instanceof z.ZodError?e.issues.map(i=>i.path.join('.')+': '+i.message).join('; '):error.message},400);}
}
export {handler as GET,handler as POST};
