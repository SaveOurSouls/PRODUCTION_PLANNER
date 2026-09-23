import {createHmac,timingSafeEqual,randomBytes,createCipheriv,createDecipheriv,scryptSync} from 'node:crypto';
import type {NextRequest} from 'next/server';
const secret=()=>{const value=process.env.SESSION_SECRET;if(!value||value.length<32)throw new Error('Настройте SESSION_SECRET (минимум 32 символа)');return value;};
function signature(s:string){return createHmac('sha256',secret()).update(s).digest('base64url');}
export function signed(payload:object){const body=Buffer.from(JSON.stringify(payload)).toString('base64url');return body+'.'+signature(body);}
export function verified(token:string):Record<string,unknown>|null{try{const [body,sig]=token.split('.');if(!body||!sig)return null;const expected=signature(body);if(sig.length!==expected.length||!timingSafeEqual(Buffer.from(sig),Buffer.from(expected)))return null;const p=JSON.parse(Buffer.from(body,'base64url').toString());return typeof p.exp==='number'&&p.exp>Date.now()?p:null;}catch{return null;}}
export function authenticated(req:NextRequest){return verified(req.cookies.get('planner-session')?.value||'')?.kind==='session';}
export function checkPassword(login:string,password:string){const expected=process.env.PLANNER_PASSWORD;if(!expected||expected.length<12)throw new Error('Задайте пароль планировщика не короче 12 символов');const hash=(s:string)=>scryptSync(s,secret(),32);return timingSafeEqual(hash(password),hash(expected))&&login===(process.env.PLANNER_LOGIN||'planner');}
export function session(){return signed({kind:'session',exp:Date.now()+12*3600000});}
export function enforceOrigin(req:NextRequest){if(['GET','HEAD','OPTIONS'].includes(req.method))return;const origin=req.headers.get('origin');const expected=new URL(process.env.APP_URL||req.url).origin;if(origin!==expected)throw new Error('Недопустимый источник запроса');}
const encryptionKey=()=>{const s=process.env.TOKEN_ENCRYPTION_KEY;if(!s||!/^[a-f\d]{64}$/i.test(s))throw new Error('Настройте TOKEN_ENCRYPTION_KEY: 32 случайных байта в hex');return Buffer.from(s,'hex');};
export function encrypt(value:unknown){const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',encryptionKey(),iv);const data=Buffer.concat([cipher.update(JSON.stringify(value)),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),data]).toString('base64');}
export function decrypt<T>(value:string):T{const b=Buffer.from(value,'base64'),d=createDecipheriv('aes-256-gcm',encryptionKey(),b.subarray(0,12));d.setAuthTag(b.subarray(12,28));return JSON.parse(Buffer.concat([d.update(b.subarray(28)),d.final()]).toString());}
