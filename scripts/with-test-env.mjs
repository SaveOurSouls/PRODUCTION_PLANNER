import {readFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
const env=JSON.parse(await readFile('test-results/test-env.json','utf8'));
const args=process.argv.slice(2);if(!args.length)throw new Error('Pass node entrypoint and arguments');
const child=spawn(process.execPath,args,{env:{...process.env,...env,NEXT_TELEMETRY_DISABLED:'1'},stdio:'inherit',windowsHide:true});
child.on('exit',code=>process.exit(code??1));
for(const sig of ['SIGTERM','SIGINT'])process.on(sig,()=>child.kill());
