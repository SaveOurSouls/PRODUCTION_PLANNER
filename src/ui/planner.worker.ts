import {plan} from '../domain/scheduler';
import type {Workspace,PlanningMode} from '../domain/types';
self.onmessage=(event:MessageEvent<{workspace:Workspace;projectId:string;mode:PlanningMode;now:string}>)=>{
  try{const {workspace,projectId,mode,now}=event.data;self.postMessage({scenarios:plan(workspace,projectId,mode,now)});}catch(e){self.postMessage({error:(e as Error).message});}
};
