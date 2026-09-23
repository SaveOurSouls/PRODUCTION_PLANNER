import type { Project } from './types';
export function topological(project: Pick<Project,'stages'|'edges'>) {
  const ids = new Set(project.stages.map(s=>s.id));
  if(ids.size!==project.stages.length) throw new Error('Идентификаторы блоков должны быть уникальными');
  const indegree=new Map([...ids].map(id=>[id,0]));
  const pairs=new Set<string>();
  for(const e of project.edges) {
    if(!ids.has(e.source)||!ids.has(e.target)||e.quantity<=0||e.transferBatch<=0) throw new Error('Некорректная связь блоков');
    const key=e.source+':'+e.target; if(pairs.has(key)) throw new Error('Повторная связь блоков'); pairs.add(key);
    indegree.set(e.target,indegree.get(e.target)!+1);
  }
  const ready=[...ids].filter(id=>indegree.get(id)===0).sort(), result:string[]=[];
  while(ready.length){const id=ready.shift()!;result.push(id);for(const e of project.edges.filter(e=>e.source===id)){indegree.set(e.target,indegree.get(e.target)!-1);if(!indegree.get(e.target))ready.push(e.target);}}
  if(result.length!==ids.size) throw new Error('В схеме обнаружен цикл');
  return result;
}
export function validateRoute(p:Project) {
  const order=topological(p), finals=p.stages.filter(s=>s.final);
  if(finals.length!==1) throw new Error('Укажите ровно один блок Final');
  if(p.edges.some(e=>e.source===finals[0].id)) throw new Error('Блок Final должен завершать маршрут');
  const reaches=new Set([finals[0].id]);
  for(const id of [...order].reverse()) if(p.edges.some(e=>e.source===id&&reaches.has(e.target))) reaches.add(id);
  if(reaches.size!==p.stages.length) throw new Error('Все блоки должны вести к Final');
  if(p.stages.some(s=>!s.operations.length)) throw new Error('Добавьте операции во все блоки');
  return order;
}
export function demand(p:Project) {
  const order=validateRoute(p), required:Record<string,number>={};
  for(const id of [...order].reverse()) {
    const s=p.stages.find(s=>s.id===id)!;
    const gross=s.final?p.quantity:p.edges.filter(e=>e.source===id).reduce((sum,e)=>sum+(required[e.target]||0)*e.quantity,0);
    required[id]=Math.max(0,Math.ceil(gross-(p.opening[id]||0)-p.supplies.filter(x=>x.stageId===id).reduce((s,x)=>s+x.quantity,0)));
  }
  return required;
}
