import type {Actual, Assignment, Project, Stage} from './types';
import {calculateNorm} from './norms';

/** Norms describe sequential work on one item, not the calendar duration. */
export function stageNorm(stage: Stage, quantity?: number) {
  if (!stage.operations.length) return null;
  try {
    const rows = stage.operations.map(op => ({op, n: calculateNorm(op.norm)}));
    const cycle = rows.reduce((sum, {n}) => sum + n.cycle, 0);
    return {
      cycle,
      calculated: rows.reduce((sum, {n}) => sum + n.calculated, 0),
      setup: rows.reduce((sum, {n}) => sum + n.setup, 0),
      hourly: 3600 / cycle,
      laborHours: quantity === undefined ? null : rows.reduce((sum, {op, n}) =>
        sum + (n.cycle * quantity + n.setup) * (op.mode === 'crew' ? op.workers : 1), 0) / 3600,
      overridden: rows.some(({op}) => op.norm.override !== undefined),
    };
  } catch { return null; }
}

export const completesIn = (end: string, from: number, to: number) =>
  Date.parse(end) >= from && Date.parse(end) < to;

export function assignmentInPeriod(a: Assignment, from: number, to: number) {
  return completesIn(a.end, from, to) || a.segments.some(s => Date.parse(s.start) < to && Date.parse(s.end) > from);
}

export interface WorkGroup {
  key: string;
  project: Project;
  stage: Stage;
  assignments: Assignment[];
  actuals: Actual[];
  plannedOutput: number;
  actualOutput: number;
  scrap: number;
  crew: boolean;
  firstAt: number;
}

/** Per-person view: crew output is shared, never multiplied by crew size. */
export function groupWork(projects: Project[], person: string, from: number, to: number): WorkGroup[] {
  const groups: WorkGroup[] = [];
  for (const project of projects) {
    const byId = new Map(project.assignments.map(a => [a.id, a]));
    const planned = project.assignments.filter(a => a.employeeIds.includes(person) && assignmentInPeriod(a, from, to));
    const facts = project.actuals.filter(f => f.employeeIds.includes(person) &&
      (completesIn(f.end, from, to) || (Date.parse(f.start) < to && Date.parse(f.end) > from)));
    for (const stage of project.stages) {
      const assignments = planned.filter(a => a.stageId === stage.id).sort((a,b) => Date.parse(a.start)-Date.parse(b.start));
      const actuals = facts.filter(f => byId.get(f.assignmentId)?.stageId === stage.id);
      if (!assignments.length && !actuals.length) continue;
      const last = stage.operations.at(-1)?.id;
      const finishedFacts = actuals.filter(f => completesIn(f.end, from, to));
      groups.push({
        key: `${project.id}/${stage.id}`, project, stage, assignments, actuals,
        plannedOutput: assignments.filter(a => a.operationId === last && completesIn(a.end, from, to)).reduce((sum,a) => sum+a.quantity,0),
        actualOutput: finishedFacts.filter(f => byId.get(f.assignmentId)?.operationId === last).reduce((sum,f) => sum+f.processed-f.scrap,0),
        scrap: finishedFacts.reduce((sum,f) => sum+f.scrap,0),
        crew: assignments.some(a => a.employeeIds.length > 1) || actuals.some(f => f.employeeIds.length > 1),
        firstAt: Math.min(...assignments.map(a => Date.parse(a.start)), ...actuals.map(f => Date.parse(f.start))),
      });
    }
  }
  return groups.sort((a,b) => a.firstAt-b.firstAt);
}
