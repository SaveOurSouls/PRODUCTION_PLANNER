export type OperationType = 'linear' | 'static' | 'variable';
export interface Norm {
  type: OperationType; length: number; secondsPerMeter: number; toolSeconds: number; toolCount: number;
  take: number; work: number; put: number; extra: number; repeats: number; setup: number;
  machineId?: string; override?: number;
}
export interface Operation { id: string; code: string; name: string; norm: Norm; source?: Provenance }
export interface Provenance { spreadsheet: string; sheet: string; row: number; importedAt: string }
export interface Skill { allowed: boolean; stars: number; coefficient: number }
export interface Calendar { zone: string; weekdays: number[]; start: string; end: string; breaks: [string,string][]; effectiveHours: number; absences: string[] }
export interface Employee { id: string; name: string; calendar: Calendar; skills: Record<string,Skill>; source?: Provenance }
export interface Machine { id: string; name: string; count: number; calendar: Calendar }
export interface RouteOperation { id: string; operationId: string; code: string; name: string; norm: Norm; workers: number; mode: 'independent' | 'crew' }
export interface Stage { id: string; name: string; index: string; final: boolean; x: number; y: number; operations: RouteOperation[] }
export interface Edge { id: string; source: string; target: string; quantity: number; transferBatch: number }
export interface WorkSegment { start: string; end: string }
export interface Assignment {
  id: string; batchId: string; projectId: string; stageId: string; operationId: string; employeeIds: string[]; machineId?: string; machineUnit?: number;
  quantity: number; start: string; end: string; segments: WorkSegment[]; setupSeconds: number; locked: boolean;
}
export interface Actual { id: string; assignmentId: string; start: string; end: string; pauseSeconds: number; processed: number; scrap: number; employeeIds: string[] }
export interface Movement { id: string; at: string; stageId: string; quantity: number; kind: 'opening' | 'receipt' | 'consume' | 'output' | 'scrap' | 'shipment' | 'adjustment'; assignmentId?: string; note?: string }
export interface Supply { id: string; stageId: string; at: string; quantity: number }
export interface Project {
  source?: Provenance;
  id: string; revision: number; normVersion: number; code: string; name: string; quantity: number; startDate: string; deadline: string; zone: string;
  status: 'open' | 'closed' | 'deleted'; previousStatus?: 'open' | 'closed'; template: boolean; comment: string;
  readiness: Record<string,boolean>; employeeIds: string[]; stages: Stage[]; edges: Edge[]; bufferHours: number;
  opening: Record<string,number>; supplies: Supply[]; assignments: Assignment[]; baseline: Assignment[]; actuals: Actual[]; movements: Movement[]; demo: boolean;
}
export interface Workspace { schemaVersion: 1; projects: Project[]; employees: Employee[]; machines: Machine[]; operations: Operation[] }
export type PlanningMode = 'first' | 'throughput' | 'pull';
export interface Scenario {
  idlePeriods?: import('./idle').IdlePeriod[];
  id: string; projectId: string; revision: number; mode: PlanningMode; batch: number; firstQuantity: number; firstAt: string; finishAt: string;
  assignments: Assignment[]; movements: Movement[]; idleHours: number; peakWip: number; warnings: string[]; score: number; createdAt: string; fingerprint: string;
}
export interface Job { id: string; status: 'queued' | 'running' | 'done' | 'error'; error?: string; scenarios?: Scenario[] }
export const uid = () => globalThis.crypto.randomUUID();
export const defaultCalendar = (): Calendar => ({ zone:'Asia/Shanghai', weekdays:[1,2,3,4,5], start:'09:00', end:'17:00', breaks:[['13:00','14:00']], effectiveHours:6.5, absences:[] });
