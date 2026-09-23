import {canonicalJson} from './serialization';
import {defaultCalendar, type Workspace,type Operation,type Employee,type Project, type Machine} from './types';
import {emptyProject} from './seed';
import {calculateNorm} from './norms';
export interface SheetData {spreadsheet:string;sheet:string;values:string[][];at:string}
export interface ImportOptions { timeUnit?: 'seconds'; employeesStartRow?: number }
export interface ImportPreview {operations:Operation[];employees:Employee[];projects:Project[];machines:Machine[];diagnostics:{sheet:string;row:number;message:string;blocking:boolean}[];sheets:SheetData[];changes:{kind:string;name:string;action:'new'|'update'|'unchanged'}[]}
const normalized=(s:string)=>String(s||'').trim().toLowerCase().replace(/\s+/g,' ');
export function parseNumber(raw:unknown):number|null{if(raw===null||raw===undefined||String(raw).trim()===''||String(raw).startsWith('#'))return null;const value=Number(String(raw).replace(/[\s\u00a0]/g,'').replace(',','.'));return Number.isFinite(value)?value:null;}
const key=(s:string)=>{let h=0;for(const c of s)h=Math.imul(h,31)+c.charCodeAt(0)|0;return (h>>>0).toString(36);};
const sourceId=(s:SheetData,id:string)=>`gs-${key(s.spreadsheet+':'+s.sheet+':'+id)}`;
export function previewImport(sheets:SheetData[],w:Workspace,options:ImportOptions={}):ImportPreview{
  const out:ImportPreview={operations:[],employees:[],projects:[],machines:[],diagnostics:[],sheets,changes:[]};
  const diagnostic=(sheet:string,row:number,message:string,blocking=true)=>out.diagnostics.push({sheet,row,message,blocking});
  for(const s of sheets){
    for(let i=0;i<s.values.length;i++)if(s.values[i].some(x=>/^#(REF!|VALUE!|N\/A|DIV\/0!|NAME\?|NUM!|ERROR!)/.test(String(x))))diagnostic(s.sheet,i+1,'Ошибка формулы источника: строка не используется как числовая норма',s.sheet==='БД.ОП');
    const provenance=(row:number)=>({spreadsheet:s.spreadsheet,sheet:s.sheet,row,importedAt:s.at});
    if(s.sheet==='БД.ОП'){
      const header=s.values.findIndex(r=>r.some(x=>normalized(x)==='номер')&&r.some(x=>normalized(x)==='тип операции'));if(header<0){diagnostic(s.sheet,1,'Не найдены заголовки Номер и Тип операции');continue;}
      const headers=s.values[header].map(normalized);const col=(name:string)=>{const key=normalized(name);return headers.findIndex(h=>h===key||h===key+', сек'||h===key+', с');};
      for(let i=header+1;i<s.values.length;i++){const row=s.values[i],get=(name:string)=>String(row[col(name)]??'').trim(),code=get('Номер');if(!code)continue;
        const number=(name:string,required=true)=>{const raw=get(name);const n=parseNumber(raw);if(!required&&raw==='')return 0;if(n===null)throw new Error(`Не задано число: ${name}. Ноль должен быть указан явно.`);return n;};
        try{const kind=get('Тип операции');const type=({'Погонный':'linear','Переменный':'variable','Статичный':'static'} as const)[kind as 'Погонный'];if(!type)throw new Error(`Неизвестный тип ${kind}`);
          const machineName=get('Машина'),machineId=machineName?'machine-'+key(machineName):undefined;
          if(machineId&&!w.machines.some(m=>m.id===machineId)&&!out.machines.some(m=>m.id===machineId)){out.machines.push({id:machineId,name:machineName,count:1,calendar:defaultCalendar()});diagnostic(s.sheet,i+1,`Оборудование «${machineName}»: принято 1 место, проверьте количество`,false);}
          const timeFields=['Время ручных работ для взятия полуфабриката','Время ручных работ','Время ручных работ для снятия полуфабриката','Время доп.операции',...(machineId?['Скорость работы инструмента']:[])];
          if(options.timeUnit!=='seconds'&&timeFields.some(name=>!/(,\s*(сек|с))$/.test(headers[col(name)]||'')))throw new Error('Не указаны единицы времени. Подтвердите секунды в настройках импорта или укажите «, сек» в заголовках.');
          const n={type,length:1,secondsPerMeter:type==='linear'&&machineId?number('Скорость проката, сек/м'):0,toolSeconds:machineId?number('Скорость работы инструмента'):0,toolCount:machineId?number('Кол-во операций инструмента'):0,take:number('Время ручных работ для взятия полуфабриката'),work:number('Время ручных работ'),put:number('Время ручных работ для снятия полуфабриката'),extra:number('Время доп.операции'),repeats:1,setup:number('Время подготовки, сек',false),machineId};
          if(!get('Время подготовки, сек'))diagnostic(s.sheet,i+1,'Подготовка не указана: принята отдельно как 0 с; проверьте перед планированием.',false);
          if(type==='linear'&&machineId&&n.secondsPerMeter<=0)throw new Error('Нет времени проката в сек/м');calculateNorm(n);
          const op:Operation={id:sourceId(s,code),code,name:get('Название')||get('Название операции'),norm:n,source:provenance(i+1)};
          if(out.operations.some(o=>o.id===op.id))throw new Error(`Повторный номер операции: ${code}`);out.operations.push(op);
        }catch(e){diagnostic(s.sheet,i+1,(e as Error).message);}
      }
    }else if(s.sheet==='БД. СОТ'){
      const h=s.values.findIndex(r=>r.some(x=>normalized(x)==='линейный сотрудник'));if(h<0){diagnostic(s.sheet,1,'Не найден список сотрудников');continue;}
      const index=s.values[h].findIndex(x=>normalized(x)==='линейный сотрудник');for(let i=h+1;i<s.values.length;i++){const name=String(s.values[i][index]||'').trim();if(!name)continue;const id=sourceId(s,name);if(out.employees.some(e=>e.id===id)){diagnostic(s.sheet,i+1,`Повторное ФИО «${name}»: требуется уникальный идентификатор`);continue;}out.employees.push({id,name,calendar:defaultCalendar(),skills:{},source:provenance(i+1)});}
    }else if(s.sheet==='ЗАГРУЗ'){
      const h=s.values.findIndex(r=>r.some(x=>normalized(x)==='№ проекта'));if(h<0){diagnostic(s.sheet,1,'Не найдены заголовки проекта');continue;}const headers=s.values[h].map(normalized);const column=(name:string)=>headers.indexOf(normalized(name));
      const boundary=options.employeesStartRow??55;
      diagnostic(s.sheet,1,`Календарь начинается с Q. Блок сотрудников начинается со строки ${boundary}; строки этого блока не импортируются как проекты.`,false);
      const seen=new Set<string>();for(let i=h+1;i<Math.min(s.values.length,boundary-1);i++){const row=s.values[i];const code=String(row[column('№ Проекта')]||'').trim();if(!code)continue;if(seen.has(code)){diagnostic(s.sheet,i+1,`Повторный проект ${code}`);continue;}seen.add(code);
        const p=emptyProject(sourceId(s,code),String(row[column('Наименование организции')]||row[column('Наименование организации')]||code));p.source=provenance(i+1);p.code=code;p.comment=String(row[column('Комментарий')]||'');p.quantity=1;
        const raw=String(row[column('Дедлайн')]||'');const match=raw.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);if(match){p.deadline=`${match[3]}-${match[2]}-${match[1]}`;if(p.deadline<p.startDate)p.startDate=p.deadline;}else diagnostic(s.sheet,i+1,`Проект ${code}: дедлайн требует уточнения`,false);
        p.readiness={'Материалы':row[column('КОМПЛ ЕСТЬ')]==='TRUE','Техкарта':row[column('ТЕХ.КАР')]==='TRUE','Комплектация':row[column('КОМПЛ НАБР')]==='TRUE'};
        p.comment+=`\nИсточник: ${s.spreadsheet} / ${s.sheet}, строка ${i+1}; снимок ${s.at}. Статус: ${row[column('Статус')]||'—'}. Уточните объём заказа и поставки.`;out.projects.push(p);
      }
    }else if(s.sheet==='Нормы'){
      // The source contains conflicting cached rates: retain the reference and report it explicitly.
      const h=s.values.findIndex(r=>r.some(x=>normalized(x)==='время, ч'));if(h>=0){const headers=s.values[h].map(normalized),hours=headers.indexOf('время, ч'),quantity=headers.indexOf('кол-во'),rate=headers.indexOf('шт, в час');for(let i=h+1;i<s.values.length;i++){const r=s.values[i],a=parseNumber(r[hours]),b=parseNumber(r[quantity]),c=parseNumber(r[rate]);if(a&&b&&c&&Math.abs(b/a-c)>0.01)diagnostic(s.sheet,i+1,`Несогласованная норма: ${b}/${a} = ${(b/a).toFixed(2)}, указано ${c}. Требуется ручное решение.`,false);}}
    }else if(s.sheet==='Лист14'){
      for(let i=0;i<s.values.length;i++)if(s.values[i].some(x=>(parseNumber(x)??0)<0))diagnostic(s.sheet,i+1,'Отрицательный остаток в референсе. Не переносится в рабочий учёт.',false);
    }
  }
  for(const [kind,items,existing] of [['operation',out.operations,w.operations],['employee',out.employees,w.employees],['project',out.projects,w.projects]] as const)for(const item of items){const old=existing.find(x=>x.id===item.id);out.changes.push({kind,name:item.name,action:old?(kind==='operation'&&canonicalJson((old as Operation).norm)!==canonicalJson((item as Operation).norm)?'update':'unchanged'):'new'});}
  return out;
}
export function applyImport(w:Workspace,p:ImportPreview):Workspace{
  if(p.diagnostics.some(x=>x.blocking))throw new Error('Исправьте ошибки импорта и обновите снимок');
  const next=structuredClone(w);
  for(const op of p.operations){const at=next.operations.findIndex(o=>o.id===op.id);if(at<0)next.operations.push(op);else next.operations[at]=op;}
  for(const person of p.employees){const old=next.employees.find(e=>e.id===person.id);if(old){old.name=person.name;old.source=person.source;}else next.employees.push(person);}
  for(const machine of p.machines)if(!next.machines.some(m=>m.id===machine.id))next.machines.push(machine);
  for(const project of p.projects)if(!next.projects.some(p=>p.id===project.id))next.projects.push(project);
  return next;
}
