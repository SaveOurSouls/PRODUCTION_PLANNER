import { DateTime } from 'luxon';
import type { Calendar,WorkSegment } from './types';
export interface Span {start:number;end:number}
const calendarCache=new WeakMap<Calendar,Map<string,Span[]>>();
export const seconds = (iso:string) => Date.parse(iso)/1000;
export const iso = (s:number) => new Date(s*1000).toISOString();
export function daySpans(c:Calendar,date:string):Span[] {
  let cache=calendarCache.get(c);if(!cache){cache=new Map();calendarCache.set(c,cache);}const cached=cache.get(date);if(cached)return cached;
  const d=DateTime.fromISO(date,{zone:c.zone});
  if(!d.isValid||!c.weekdays.includes(d.weekday)||c.absences.includes(date)){cache.set(date,[]);return [];}
  const at=(t:string)=>DateTime.fromISO(`${date}T${t}`,{zone:c.zone}).toSeconds();
  let spans=[{start:at(c.start),end:at(c.end)}];
  for(const [a,b] of c.breaks)spans=subtract(spans,[{start:at(a),end:at(b)}]);
  let budget=c.effectiveHours*3600;
  const result=spans.map(s=>{const length=Math.max(0,Math.min(s.end-s.start,budget));budget-=length;return {...s,end:s.start+length};}).filter(s=>s.end>s.start);cache.set(date,result);return result;
}
export function daySpansWithOvertime(c:Calendar,date:string,overtimeHours=0):Span[] {
  const base=daySpans(c,date);if(overtimeHours<=0||!base.length)return base;
  const result=base.map(s=>({...s}));const last=result.at(-1)!;last.end+=overtimeHours*3600;return result;
}
export function subtract(spans:Span[], busy:Span[]):Span[] {
  let result=spans;
  for(const b of busy) result=result.flatMap(s=>b.end<=s.start||b.start>=s.end?[s]:[{start:s.start,end:Math.min(s.end,b.start)},{start:Math.max(s.start,b.end),end:s.end}].filter(x=>x.end>x.start));
  return result;
}
export function intersect(a:Span[],b:Span[]):Span[]{return a.flatMap(x=>b.map(y=>({start:Math.max(x.start,y.start),end:Math.min(x.end,y.end)})).filter(s=>s.end>s.start));}
export function fitWork(calendars:Calendar[],busy:Span[],earliest:number,duration:number,horizon=730,overtime:Record<string,number>={}):WorkSegment[]|null {
  if(!calendars.length||duration<=0)return null;
  let remaining=duration; const result:WorkSegment[]=[];
  const day=DateTime.fromSeconds(earliest,{zone:calendars[0].zone}).startOf('day');
  for(let i=0;i<horizon&&remaining>0.00001;i++) {
    const date=day.plus({days:i}).toISODate()!;
    let spans=daySpansWithOvertime(calendars[0],date,overtime[date]||0);
    for(const c of calendars.slice(1)) {
      // The same absolute day can overlap two local dates in another timezone.
      const first=day.plus({days:i}).setZone(c.zone).startOf('day');
      const last=day.plus({days:i+1}).minus({milliseconds:1}).setZone(c.zone).startOf('day');
      const resourceSpans=daySpansWithOvertime(c,first.toISODate()!,overtime[first.toISODate()!]||0);
      spans=intersect(spans,first.toISODate()===last.toISODate()?resourceSpans:[...resourceSpans,...daySpansWithOvertime(c,last.toISODate()!,overtime[last.toISODate()!]||0)]);
    }
    spans=subtract(spans,busy).map(s=>({...s,start:Math.max(s.start,earliest)})).filter(s=>s.end>s.start);
    for(const s of spans){const length=Math.min(remaining,s.end-s.start);result.push({start:iso(s.start),end:iso(s.start+length)});remaining-=length;if(remaining<0.00001)break;}
  }
  return remaining>0.00001?null:result;
}
export function overlaps(a:Span,b:Span){return a.start<b.end&&b.start<a.end;}
