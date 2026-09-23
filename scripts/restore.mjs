import {spawnSync} from 'node:child_process';
import {openSync,closeSync} from 'node:fs';
const path=process.argv[2];if(!path||process.argv[3]!=='--replace-database')throw new Error('Usage: node scripts/restore.mjs backup.dump --replace-database. Stops app and worker and replaces planner data.');
let r=spawnSync('docker',['compose','stop','app','worker'],{stdio:'inherit',shell:false});if(r.status!==0)throw new Error('Could not stop application');
const fd=openSync(path,'r');r=spawnSync('docker',['compose','exec','-T','db','pg_restore','-U','planner','-d','planner','--clean','--if-exists','--no-owner','--exit-on-error'],{stdio:[fd,'inherit','inherit'],shell:false});closeSync(fd);if(r.status!==0)throw new Error('Restore failed: application remains stopped');
r=spawnSync('docker',['compose','up','-d','app','worker'],{stdio:'inherit',shell:false});if(r.status!==0)throw new Error('Database restored, but application restart failed');
