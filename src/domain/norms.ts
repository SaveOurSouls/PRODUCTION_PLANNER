import type { Norm, Actual } from './types';
export function calculateNorm(n: Norm, coefficient = 1) {
  for (const [key,value] of Object.entries(n)) if (typeof value==='number' && (!Number.isFinite(value)||value<0)) throw new Error(`Некорректный параметр нормы: ${key}`);
  if (!(coefficient>0) || !Number.isFinite(coefficient) || n.repeats<=0) throw new Error('Коэффициент и повторения должны быть больше нуля');
  const machine = n.machineId ? ((n.type==='linear' ? n.length*n.secondsPerMeter : 0)+n.toolSeconds*n.toolCount+n.extra)*n.repeats : 0;
  const manual = (n.take+n.work+n.put+n.extra)*n.repeats;
  const calculated = Math.max(manual/coefficient,machine);
  const cycle = Math.max(n.override ?? calculated,machine);
  if (!Number.isFinite(cycle)||cycle<=0) throw new Error('Норма времени должна быть больше нуля');
  return {machine,manual,calculated,cycle,setup:n.setup,hourly:3600/cycle};
}
export function actualMetrics(rows: Actual[]) {
  const seconds=rows.reduce((s,a)=>s+(Date.parse(a.end)-Date.parse(a.start))/1000-a.pauseSeconds,0);
  const processed=rows.reduce((s,a)=>s+a.processed,0), scrap=rows.reduce((s,a)=>s+a.scrap,0), good=processed-scrap;
  const laborSeconds=rows.reduce((s,a)=>s+((Date.parse(a.end)-Date.parse(a.start))/1000-a.pauseSeconds)*a.employeeIds.length,0);
  return {seconds,processed,scrap,good,average:processed?seconds/processed:null,perGood:good?laborSeconds/good:null};
}
