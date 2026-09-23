import {spawnSync} from 'node:child_process';
import {mkdirSync,openSync,closeSync,existsSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
const destination=resolve(process.argv[2]||`backups/planner-${new Date().toISOString().replace(/[:.]/g,'-')}.dump`);
if(existsSync(destination))throw new Error('Backup destination exists');
mkdirSync(dirname(destination),{recursive:true});const fd=openSync(destination,'wx');
const result=spawnSync('docker',['compose','exec','-T','db','pg_dump','-U','planner','-d','planner','-Fc'],{stdio:['ignore',fd,'inherit'],shell:false});closeSync(fd);if(result.status!==0)throw new Error('Backup failed');console.log(destination);
