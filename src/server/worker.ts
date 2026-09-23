import {db} from './db';
import {json} from './repository';
import {plan} from '../domain/scheduler';
import type {Workspace,PlanningMode} from '../domain/types';
import {setTimeout as delay} from 'node:timers/promises';
let stop=false;process.on('SIGTERM',()=>{stop=true;});process.on('SIGINT',()=>{stop=true;});
async function run(){
  while(!stop){
    try{
      // A worker crash leaves a visible error instead of silently losing a running job.
      await db.job.updateMany({where:{status:'running',startedAt:{lt:new Date(Date.now()-30*60000)}},data:{status:'error',error:'Расчёт прерван. Запустите его повторно.',finishedAt:new Date()}});
      const job=await db.$transaction(async tx=>{
        const rows=await tx.$queryRaw<{id:string}[]>`SELECT id FROM "Job" WHERE status='queued' ORDER BY "createdAt" FOR UPDATE SKIP LOCKED LIMIT 1`;
        if(!rows[0])return null;return tx.job.update({where:{id:rows[0].id},data:{status:'running',startedAt:new Date()}});
      });
      if(!job){await delay(1500);continue;}
      try{const scenarios=plan(job.input as unknown as Workspace,job.projectId,job.mode as PlanningMode,job.createdAt.toISOString());await db.job.update({where:{id:job.id},data:{status:'done',result:json(scenarios),finishedAt:new Date()}});}catch(e){await db.job.update({where:{id:job.id},data:{status:'error',error:(e as Error).message,finishedAt:new Date()}});}
    }catch(e){console.error('Worker:',(e as Error).message);await delay(5000);}
  }
  await db.$disconnect();
}
run().catch(e=>{console.error(e);process.exitCode=1;});
