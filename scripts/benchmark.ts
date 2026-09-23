import {seedWorkspace} from '../src/domain/seed';
import {plan} from '../src/domain/scheduler';
const w=seedWorkspace();const start=performance.now();const result=plan(w,w.projects[0].id,'first','2026-09-23T00:00:00.000Z');console.log(JSON.stringify({milliseconds:Math.round(performance.now()-start),options:result.map(s=>({batch:s.batch,first:s.firstQuantity,finish:s.finishAt,tasks:s.assignments.length}))},null,2));
