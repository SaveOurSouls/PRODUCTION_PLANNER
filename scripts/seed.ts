import {mutate} from '../src/server/repository';
import {db} from '../src/server/db';
import {seedWorkspace} from '../src/domain/seed';
async function main(){await mutate('seed',w=>{if(w.projects.length)throw new Error('База уже содержит проекты');return seedWorkspace();});await db.$disconnect();}
main().catch(e=>{console.error(e);process.exitCode=1;});
