import {build} from 'esbuild';
import {mkdir,writeFile} from 'node:fs/promises';
async function main(){
  const result=await build({entryPoints:['src/ui/demo-entry.tsx'],bundle:true,minify:true,write:false,outdir:'demo',format:'iife',platform:'browser',target:['chrome110','safari16'],define:{'process.env.NODE_ENV':'"production"'},legalComments:'none'});
  const js=result.outputFiles.find(f=>f.path.endsWith('.js'))!.text.replace(/<\/script/gi,'<\\/script');
  const css=result.outputFiles.find(f=>f.path.endsWith('.css'))!.text;
  const worker=await build({entryPoints:['src/ui/planner.worker.ts'],bundle:true,minify:true,write:false,format:'iife',platform:'browser',target:['chrome110','safari16']});
  const workerSource=JSON.stringify(worker.outputFiles[0].text).replace(/<\/script/gi,'<\\/script');
  await mkdir('demo',{recursive:true});
  await writeFile('demo/production-planner.html',`<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Поток — демонстрация</title><style>${css}</style></head><body><div id="root"></div><script>window.plannerWorkerSource=${workerSource};${js}</script></body></html>`);
  console.log('Created demo/production-planner.html');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
