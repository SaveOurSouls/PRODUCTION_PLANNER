import {canonicalJson} from '../domain/serialization';
import type {Prisma} from '@prisma/client';
import {db} from './db';
import type {Workspace,Project,Assignment,Actual,Movement,Employee,Machine,Operation} from '../domain/types';
type Client=Prisma.TransactionClient;
export const json=(v:unknown)=>JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue;
export async function readWorkspace(tx:Client=db):Promise<Workspace>{
  if(tx===db)return db.$transaction(inner=>readWorkspace(inner),{isolationLevel:'RepeatableRead'});
  const [projects,catalog]=await Promise.all([tx.project.findMany({include:{assignments:true,actuals:true,movements:true},orderBy:{id:'asc'}}),tx.catalog.findMany({orderBy:{id:'asc'}})]);
  return {schemaVersion:1,projects:projects.map(p=>({...p.payload as unknown as Project,assignments:p.assignments.map(a=>a.payload as unknown as Assignment).sort((a,b)=>a.id.localeCompare(b.id)),actuals:p.actuals.map(a=>a.payload as unknown as Actual).sort((a,b)=>a.id.localeCompare(b.id)),movements:p.movements.map(a=>a.payload as unknown as Movement).sort((a,b)=>a.id.localeCompare(b.id))})),employees:catalog.filter(c=>c.kind==='employee').map(c=>c.payload as unknown as Employee),machines:catalog.filter(c=>c.kind==='machine').map(c=>c.payload as unknown as Machine),operations:catalog.filter(c=>c.kind==='operation').map(c=>c.payload as unknown as Operation)};
}
async function writeWorkspace(tx:Client,w:Workspace,old:Workspace){
  for(const key of ['assignments','actuals','movements'] as const){const seen=new Set<string>();for(const p of w.projects)for(const item of p[key]){if(seen.has(item.id))throw new Error(`Повторный идентификатор ${key}: ${item.id}`);seen.add(item.id);}}
  for(const p of w.projects){if(p.assignments.some(a=>a.projectId!==p.id)||p.actuals.some(f=>!p.assignments.some(a=>a.id===f.assignmentId)))throw new Error('Нарушены связи проекта, заданий и факта');}
  for(const p of w.projects){
    if(canonicalJson(old.projects.find(x=>x.id===p.id))===canonicalJson(p))continue;
    const {assignments,actuals,movements,...payload}=p;
    await tx.project.upsert({where:{id:p.id},create:{id:p.id,revision:p.revision,status:p.status,payload:json(payload)},update:{revision:p.revision,status:p.status,payload:json(payload)}});
    await tx.assignment.deleteMany({where:{projectId:p.id,id:{notIn:assignments.map(x=>x.id)}}});
    for(const a of assignments)await tx.assignment.upsert({where:{id:a.id},create:{id:a.id,projectId:p.id,start:new Date(a.start),end:new Date(a.end),payload:json(a)},update:{start:new Date(a.start),end:new Date(a.end),payload:json(a)}});
    for(const f of actuals)await tx.actual.upsert({where:{id:f.id},create:{id:f.id,projectId:p.id,assignmentId:f.assignmentId,payload:json(f)},update:{payload:json(f)}});
    for(const m of movements)await tx.movement.upsert({where:{id:m.id},create:{id:m.id,projectId:p.id,at:new Date(m.at),payload:json(m)},update:{at:new Date(m.at),payload:json(m)}});
    await tx.projectVersion.upsert({where:{projectId_revision:{projectId:p.id,revision:p.revision}},create:{projectId:p.id,revision:p.revision,payload:json(p)},update:{}});
  }
  for(const [kind,list] of [['employee',w.employees],['machine',w.machines],['operation',w.operations]] as const)for(const item of list)await tx.catalog.upsert({where:{id:kind+':'+item.id},create:{id:kind+':'+item.id,kind,payload:json(item)},update:{payload:json(item)}});
}
export async function mutate(action:string,change:(w:Workspace,tx:Client)=>Workspace|Promise<Workspace>){
  return db.$transaction(async tx=>{await tx.$executeRaw`SELECT pg_advisory_xact_lock(7349281)`;const old=await readWorkspace(tx);const next=await change(structuredClone(old),tx);await writeWorkspace(tx,next,old);await tx.audit.create({data:{action,detail:json({projectIds:next.projects.map(p=>p.id)})}});return readWorkspace(tx);},{maxWait:10000,timeout:120000});
}
