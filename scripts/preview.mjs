import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
createServer(async(req,res)=>{if(req.url!=='/'&&req.url!=='/production-planner.html'){res.writeHead(404);res.end();return;}try{const html=await readFile(new URL('../demo/production-planner.html',import.meta.url));res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});res.end(html);}catch{res.writeHead(500);res.end('Build demo first');}}).listen(4173,'127.0.0.1',()=>console.log('Demo: http://127.0.0.1:4173'));
