import {useEffect,useRef,useState,createContext,useContext,type ReactNode} from 'react';
import {X, CircleHelp} from 'lucide-react';
export const FormErrorContext=createContext('');
export function Modal({title,children,onClose,wide=false}:{title:string;children:ReactNode;onClose:()=>void;wide?:boolean}){
  const error=useContext(FormErrorContext);
  const ref=useRef<HTMLDialogElement>(null);useEffect(()=>{const d=ref.current;d?.showModal();return ()=>d?.close();},[]);
  return <dialog ref={ref} className={'modal '+(wide?'wide':'')} onCancel={e=>{e.preventDefault();onClose();}}><header><h2>{title}</h2><button className="icon-button" onClick={onClose} aria-label="Закрыть"><X size={18}/></button></header>{error&&<p className="negative" role="alert">{error}</p>}{children}</dialog>;
}
export function Hint({text}:{text:string}){
  const [position,setPosition]=useState({left:12,top:12});
  const locate=(el:HTMLElement)=>{const r=el.getBoundingClientRect();setPosition({left:Math.max(12,Math.min(r.left,window.innerWidth-332)),top:Math.max(12,Math.min(r.bottom+8,window.innerHeight-230))});};
  return <span className="hint" tabIndex={0} role="note" aria-label={text} onMouseEnter={e=>locate(e.currentTarget)} onFocus={e=>locate(e.currentTarget)}><CircleHelp size={14}/><span className="hint-popup" role="tooltip" style={position}>{text}</span></span>;
}
export function Field({label,children,hint}:{label:string;children:ReactNode;hint?:string}){return <label className="field"><span>{label} {hint&&<Hint text={hint}/>}</span>{children}</label>;}
export const num=(n:number|null|undefined,digits=0)=>n==null||!Number.isFinite(n)?'—':(Object.is(n,-0)?0:n).toLocaleString('ru-RU',{maximumFractionDigits:digits});
export const dateLabel=(s:string)=>new Intl.DateTimeFormat('ru-RU',{day:'numeric',month:'short'}).format(new Date(s.includes('T')?s:s+'T12:00:00'));
export const timeLabel=(s:string,zone='Asia/Shanghai')=>new Intl.DateTimeFormat('ru-RU',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit',timeZone:zone}).format(new Date(s));
export function Badge({children,tone='neutral'}:{children:ReactNode;tone?:string}){return <span className={'badge '+tone}>{children}</span>;}
