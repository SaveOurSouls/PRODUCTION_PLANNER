import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const env=JSON.parse(await readFile('test-results/test-env.json','utf8'));const base=env.APP_URL;let cookie='';
async function request(path,body,expected=200){const r=await fetch(base+'/api/v1/'+path,{method:body===undefined?'GET':'POST',headers:{Origin:base,...(cookie?{Cookie:cookie}:{}),...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)});if(r.headers.has('set-cookie'))cookie=r.headers.get('set-cookie').split(';')[0];const data=await r.json();assert.equal(r.status,expected,JSON.stringify(data));return data;}
await request('workspace',undefined,401);
await request('auth/login',{login:env.PLANNER_LOGIN,password:env.PLANNER_PASSWORD});
let w=await request('workspace');assert.ok(w.projects.length);
const original=w.projects.find(p=>p.id==='project-demo');assert.ok(original);
const p={...structuredClone(original),id:'integration-'+Date.now(),code:'TEST-'+Date.now(),name:'Integration test',quantity:30,assignments:[],baseline:[],actuals:[],movements:[],opening:{},supplies:[]};p.edges.forEach(e=>e.transferBatch=5);
if(w.projects.some(x=>x.id===p.id)){console.log('Integration fixture already exists; run against a fresh database.');process.exit(1);}
w=await request('projects',p);assert.ok(w.projects.length>=2);
let job=await request('projects/'+p.id+'/plan',{mode:'first'},202);assert.equal(job.status,'queued');
const begin=Date.now();while(Date.now()-begin<60000){await new Promise(r=>setTimeout(r,500));job=await request('jobs/'+job.id);if(job.status==='done'||job.status==='error')break;}
assert.equal(job.status,'done',job.error);assert.ok(job.scenarios.length>1);
w=await request(`jobs/${job.id}/apply`,{scenarioId:job.scenarios[0].id});const applied=w.projects.find(x=>x.id===p.id);assert.ok(applied.assignments.length);
assert.deepEqual(w.projects.find(x=>x.id===original.id),original);
await request(`jobs/${job.id}/apply`,{scenarioId:job.scenarios[0].id},400);
const versionBefore=applied.normVersion;w=await request('projects',{...applied,name:'Integration renamed'});assert.equal(w.projects.find(x=>x.id===p.id).normVersion,versionBefore);
const a=applied.assignments.find(x=>x.stageId==='stage-1');
w=await request(`projects/${p.id}/actuals`,{id:'integration-actual-'+Date.now(),assignmentId:a.id,employeeIds:a.employeeIds,start:a.start,end:a.end,pauseSeconds:0,processed:a.quantity,scrap:1});
assert.equal(w.projects.find(x=>x.id===p.id).movements.find(x=>x.kind==='output').quantity,a.quantity-1);
const exported=await request(`projects/${p.id}/export`);assert.equal(exported.schemaVersion,1);assert.equal(exported.project.actuals.length,1);
const importedId='import-'+p.id;const importedProject={...exported.project,id:importedId,assignments:[],baseline:[],actuals:[],movements:[],revision:1};
w=await request('projects/import',{...exported,project:importedProject});assert.ok(w.projects.find(x=>x.id===importedId));
w=await request(`projects/${p.id}/clone`,{template:true});const template=w.projects.find(x=>x.template);assert.ok(template);assert.equal(template.actuals.length,0);assert.equal(template.assignments.length,0);
w=await request(`projects/${p.id}/delete`,{confirm:p.code});assert.equal(w.projects.find(x=>x.id===p.id).status,'deleted');
w=await request(`projects/${p.id}/restore`,{});assert.equal(w.projects.find(x=>x.id===p.id).status,'open');
const badOrigin=await fetch(base+'/api/v1/projects',{method:'POST',headers:{Cookie:cookie,Origin:'https://untrusted.invalid','Content-Type':'application/json'},body:JSON.stringify(p)});assert.equal(badOrigin.status,400);
console.log('PASS: auth, migration, persisted workspace, worker queue, scheduling, apply/stale checks, actuals, JSON export, templates, delete/restore, CSRF origin.');
