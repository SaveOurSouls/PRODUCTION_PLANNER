import {Fragment,useMemo,useState} from 'react';
import {ArrowLeftRight,ArrowUpRight,ChevronDown,Plus} from 'lucide-react';
import {DateTime} from 'luxon';
import type {Project,Movement} from '../domain/types';
import {materialReport,type DailyStock} from '../domain/inventory';
import {dateLabel,Hint,num,timeLabel} from './components';

export type MovementOpen={kind?:'shipment';stageId?:string;date?:string};
const fields:{key:keyof Pick<DailyStock,'opening'|'receipt'|'consume'|'output'|'scrap'|'shipped'|'closing'|'cumulative'>;label:string;hint:string}[]=[
  {key:'opening',label:'Начало',hint:'Остаток предыдущего дня. Начальные остатки проекта общие для плана и факта.'},
  {key:'receipt',label:'Приход',hint:'Внешние поступления и корректировки. Собственный выпуск показан отдельно.'},
  {key:'consume',label:'Расход',hint:'Компоненты снимаются со свободного склада в момент начала следующего этапа по норме расхода.'},
  {key:'output',label:'Выпуск',hint:'Годные полуфабрикаты, завершённые за день. Выпуск доступен после последней операции блока.'},
  {key:'scrap',label:'Брак',hint:'Брак исключён из годного выпуска. Повторно из остатка он не вычитается.'},
  {key:'shipped',label:'Отгружено',hint:'Ручная фактическая отгрузка Final. Плановые отгрузки пока не задаются.'},
  {key:'closing',label:'Остаток',hint:'Начало + приход + годный выпуск − расход − отгрузки. Это свободный запас на конец дня.'},
  {key:'cumulative',label:'Накоплено',hint:'Годный выпуск с начала проекта. Отгрузки и расход не уменьшают этот показатель.'},
];
const movementLabels:Record<Movement['kind'],string>={opening:'Начальный остаток',receipt:'Приход',consume:'Расход',output:'Выпуск',scrap:'Брак',shipment:'Отгрузка',adjustment:'Корректировка'};

export function Materials({project,onNew,onSave}:{project:Project;onNew:(options?:MovementOpen)=>void;onSave?:(project:Project)=>void}){
  const [view,setView]=useState<'overview'|'stage'>('overview');
  const [metric,setMetric]=useState<'closing'|'output'>('closing');
  const [transposed,setTransposed]=useState(false);
  const [selected,setSelected]=useState(project.stages.find(s=>s.final)?.id||project.stages[0]?.id||'');
  const [stageView,setStageView]=useState<'detail'|'group'>('detail');
  const [expanded,setExpanded]=useState<string>(),[period,setPeriod]=useState(0);
  const [overtime,setOvertime]=useState<Record<string,number>>(project.overtime||{});
  const report=useMemo(()=>materialReport(project),[project]);
  const page=Math.min(period,Math.max(0,Math.ceil(report.days.length/14)-1));
  const visible=report.days.slice(page*14,(page+1)*14);
  const finalStage=project.stages.find(s=>s.final);
  const finalStock=report.days.at(-1)?.stages.find(s=>s.stageId===finalStage?.id);
  const shipped=project.movements.filter(m=>m.kind==='shipment').reduce((sum,m)=>sum-m.quantity,0);
  const currentDate=DateTime.now().setZone(project.zone).toISODate()!;
  const stageDaily=useMemo(()=>report.days.map(day=>{
    const entry=day.stages.find(s=>s.stageId===selected);if(!entry)return null;
    const actuals=project.actuals.filter(f=>{const a=project.assignments.find(x=>x.id===f.assignmentId);return a?.stageId===selected&&DateTime.fromISO(f.end,{zone:project.zone}).toISODate()===day.date;});
    const workSeconds=actuals.reduce((sum,f)=>sum+Math.max(0,(Date.parse(f.end)-Date.parse(f.start))/1000-f.pauseSeconds),0);
    const processed=actuals.reduce((sum,f)=>sum+f.processed,0),good=Math.max(0,processed-actuals.reduce((sum,f)=>sum+f.scrap,0));
    return {date:day.date,plan:entry.plan,fact:entry.fact,workSeconds,processed,good,average:processed?workSeconds/processed:null,perGood:good?workSeconds/good:null};
  }).filter((x):x is NonNullable<typeof x>=>!!x),[report.days,project.actuals,project.assignments,project.zone,selected]);
  const saveOvertime=(date:string,value:number)=>{const next={...overtime,[date]:Math.min(24,Math.max(0,value||0))};if(next[date]===0)delete next[date];setOvertime(next);onSave?.({...project,overtime:next});};
  const openDetails=(stageId:string,date?:string)=>{setSelected(stageId);setView('stage');setExpanded(date);};
  const headings=(key:string)=><Fragment key={key}><th className="plan-block-head" scope="col">План</th><th className="fact-block-head fact-start" scope="col">Факт</th></Fragment>;
  const stageName=(id:string)=>{const stage=project.stages.find(s=>s.id===id)!;return <>{stage.name}<small>{stage.index}{stage.final?' · склад готовые':''}</small></>;};
  const pair=(entry:(typeof report.days)[number]['stages'][number],date:string)=><Fragment key={entry.stageId+date}>
    {(['plan','fact'] as const).map(side=><td key={side} className={(side==='plan'?'plan-cell':'fact-cell fact-start')+(entry[side][metric]<0?' negative':'')}>
      <button className="material-value" aria-label={`${side==='plan'?'План':'Факт'}: ${project.stages.find(s=>s.id===entry.stageId)!.name}, ${date}, детали`} onClick={()=>openDetails(entry.stageId,date)}>{num(entry[side][metric],2)}</button>
    </td>)}
  </Fragment>;
  return <>
    <div className="section-toolbar">
      <h2>Движение материалов <Hint text="Каждая строка переносит остаток предыдущего дня и учитывает события текущего дня. План — назначения и ожидаемые поставки; факт — журнал выполнения и ручные движения. Нажмите число для подробностей. Отгрузку готовой продукции вводят вручную."/></h2>
      <div className="actions"><button onClick={()=>onNew({date:currentDate})} disabled={!project.stages.length}><Plus size={16}/>Движение</button><button className="primary" onClick={()=>onNew({kind:'shipment',stageId:finalStage!.id,date:currentDate})} disabled={!finalStage}><ArrowUpRight size={16}/>Отгрузка</button></div>
    </div>
    <div className="material-toolbar">
      <div className="segmented"><button aria-pressed={view==='overview'} className={view==='overview'?'selected':''} onClick={()=>setView('overview')}>Общий вид</button><button aria-pressed={view==='stage'} className={view==='stage'?'selected':''} onClick={()=>setView('stage')}>По полуфабрикату</button></div>
      {view==='overview'&&<div className="actions"><div className="segmented"><button aria-pressed={metric==='closing'} className={metric==='closing'?'selected':''} onClick={()=>setMetric('closing')}>Остатки</button><button aria-pressed={metric==='output'} className={metric==='output'?'selected':''} onClick={()=>setMetric('output')}>Дневной выпуск</button></div><button onClick={()=>setTransposed(!transposed)} aria-pressed={transposed}><ArrowLeftRight size={15}/>Повернуть оси</button></div>}
    </div>
    <div className="overtime-panel"><div><strong>Переработка по рабочим дням</strong><Hint text="Дополнительное время доступно планировщику только в указанную дату. Значение сохраняется в проекте и учитывается при расчёте заданий."/></div><div className="overtime-grid">{report.days.map(day=><label key={day.date}><span>{dateLabel(day.date)}</span><input type="number" min="0" max="24" step="0.5" value={overtime[day.date]||0} onChange={e=>setOvertime({...overtime,[day.date]:Math.min(24,Math.max(0,+e.target.value||0))})} onBlur={e=>saveOvertime(day.date,+e.target.value)}/><small>ч</small></label>)}</div></div>
    {view==='overview'?<>
      {finalStock&&<div className="report-summary material-summary">
        <div><span>План: склад готовые на {dateLabel(report.to)}</span><strong>{num(finalStock.plan.closing)} <small>шт.</small></strong></div>
        <div><span>Факт: склад готовые на {dateLabel(report.to)}</span><strong>{num(finalStock.fact.closing)} <small>шт.</small></strong></div>
        <div><span>Фактически отгружено</span><strong>{num(shipped)} <small>шт.</small></strong></div>
      </div>}
      <div className="table-wrap"><table className="materials-table material-overview">
        <caption className="sr-only">{metric==='closing'?'Остатки на конец дня':'Дневной выпуск'}, шт.</caption>
        <thead><tr><th rowSpan={2} scope="col">{transposed?'Полуфабрикат':'День'}</th>{transposed?visible.map(day=><th key={day.date} colSpan={2} scope="colgroup" className="material-stage-head">{dateLabel(day.date)}</th>):project.stages.map(s=><th key={s.id} colSpan={2} scope="colgroup" className={'material-stage-head '+(s.final?'final-stage-head':'')}>{stageName(s.id)}</th>)}</tr>
          <tr>{transposed?visible.map(d=>headings(d.date)):project.stages.map(s=>headings(s.id))}</tr>
        </thead>
        <tbody>{transposed?project.stages.map(stage=><tr key={stage.id}><th scope="row">{stageName(stage.id)}</th>{visible.map(day=>pair(day.stages.find(s=>s.stageId===stage.id)!,day.date))}</tr>):visible.map(day=><tr key={day.date}><th scope="row">{dateLabel(day.date)}</th>{day.stages.map(s=>pair(s,day.date))}</tr>)}</tbody>
      </table></div>
    </>:<>
      <div className="material-selector">{project.stages.map((s,i)=><button className={selected===s.id?'selected':''} aria-pressed={selected===s.id} key={s.id} onClick={()=>{setSelected(s.id);setExpanded(undefined);}}><i className={'legend-dot stage-'+i%5}/>{s.name}{s.final?' · склад готовые':''}</button>)}</div>
      <div className="material-toolbar stage-view-toolbar"><div className="segmented"><button aria-pressed={stageView==='detail'} className={stageView==='detail'?'selected':''} onClick={()=>setStageView('detail')}>Движения</button><button aria-pressed={stageView==='group'} className={stageView==='group'?'selected':''} onClick={()=>setStageView('group')}>Групповой список по дню</button></div></div>
      {stageView==='group'?<div className="table-wrap"><table className="materials-table materials-grouped"><thead><tr><th>День</th><th>Плановый выпуск</th><th>Фактический выпуск</th><th>Факт. время</th><th>Среднее на шт.</th><th>На годную</th><th>Плановый остаток</th><th>Фактический остаток</th></tr></thead><tbody>{stageDaily.map(row=><tr key={row.date}><th scope="row">{dateLabel(row.date)}</th><td>{num(row.plan.output,2)}</td><td>{num(row.fact.output,2)}</td><td>{num(row.workSeconds/3600,2)} ч</td><td>{row.average===null?'—':`${num(row.average/60,2)} мин`}</td><td>{row.perGood===null?'—':`${num(row.perGood/60,2)} мин`}</td><td>{num(row.plan.closing,2)}</td><td>{num(row.fact.closing,2)}</td></tr>)}</tbody></table></div>:<div className="table-wrap"><table className="materials-table materials-detail">
        <thead><tr><th rowSpan={2} scope="col">День</th><th colSpan={8} className="plan-block-head" scope="colgroup">План</th><th colSpan={8} className="fact-block-head fact-start" scope="colgroup">Факт</th></tr><tr>{['plan','fact'].flatMap(side=>fields.map((f,i)=><th scope="col" key={side+f.key} className={(side==='plan'?'plan-block-head':'fact-block-head')+(side==='fact'&&i===0?' fact-start':'')}>{f.label} <Hint text={f.hint}/></th>))}</tr></thead>
        <tbody>{visible.map(day=>{const entry=day.stages.find(s=>s.stageId===selected);if(!entry)return null;return <Fragment key={day.date}>
          <tr><th scope="row"><button className="material-value" aria-expanded={expanded===day.date} onClick={()=>setExpanded(expanded===day.date?undefined:day.date)}><ChevronDown size={12}/>{dateLabel(day.date)}</button></th>{(['plan','fact'] as const).flatMap(side=>fields.map((f,i)=><td key={side+f.key} className={(side==='plan'?'plan-cell':'fact-cell')+(side==='fact'&&i===0?' fact-start':'')+(entry[side][f.key]<0?' negative':'')}>{num(entry[side][f.key],2)}</td>))}</tr>
          {expanded===day.date&&<tr><td colSpan={17}><div className="material-events">{(['plan','fact'] as const).map(side=><div key={side} className={side==='plan'?'plan-cell':'fact-cell fact-start'}><h4>{side==='plan'?'План':'Факт'}</h4><div className="event-list">{entry[side].events.map(e=><span key={e.id}>{timeLabel(e.at,project.zone)} · {movementLabels[e.kind]} · {num(e.quantity,2)} шт. {e.note||''}</span>)}{!entry[side].events.length&&<span>Нет движений за день</span>}</div></div>)}</div></td></tr>}
        </Fragment>;})}</tbody>
      </table></div>}
    </>}
    <div className="table-footer"><span>{report.days.length} календарных дней · {dateLabel(visible[0]?.date||report.from)} – {dateLabel(visible.at(-1)?.date||report.to)}</span><div className="actions"><button disabled={page===0} onClick={()=>setPeriod(page-1)}>Ранее</button><button disabled={(page+1)*14>=report.days.length} onClick={()=>setPeriod(page+1)}>Далее</button></div></div>
  </>;
}
