import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtempSync,writeFileSync,readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
const dir=mkdtempSync(join(tmpdir(),'honcho-bundle-'));
const seen=[];
const api=http.createServer(async(req,res)=>{
 let text='';for await(const c of req)text+=c;
 const body=text?JSON.parse(text):{};seen.push({path:req.url,method:req.method,body});
 res.setHeader('content-type','application/json');res.end(JSON.stringify(req.url.includes('conclusions/query')?[{content:'Global task fact'}]:req.url.includes('representation')?{representation:'Project-only memory'}:{id:body.id||'test',metadata:{},configuration:{},representation:'Global memory',peer_card:['Global card']}));
});
await new Promise(r=>api.listen(0,'127.0.0.1',r));
let projectId='p';
const pipe=join(dir,'app.sock');
const app=net.createServer(s=>{let data=Buffer.alloc(0);s.on('data',c=>{data=Buffer.concat([data,c]);if(data.length<4||data.length<data.readUInt32LE(0)+4)return;const q=JSON.parse(data.subarray(4));
const payload=q.params?.tool==='list_threads'?{threads:[{id:'chat-full-id',kind:'codex',hostId:'local',projectId}]}:{projects:[{projectId:'p',hostId:'local',label:'Project'}]};
const result=q.method==='tools/list'?{tools:['list_threads','list_projects'].map(name=>({name,namespace:'codex_app'}))}:{success:true,contentItems:[{type:'inputText',text:JSON.stringify(payload)}]};
const b=Buffer.from(JSON.stringify({jsonrpc:'2.0',id:q.id,result}));const h=Buffer.alloc(4);h.writeUInt32LE(b.length);s.end(Buffer.concat([h,b]));});});
await new Promise(r=>app.listen(pipe,r));
writeFileSync(join(dir,'config.json'),JSON.stringify({apiKey:'test',peerName:'alex',workspace:'test',endpoint:{baseUrl:`http://127.0.0.1:${api.address().port}`},hosts:{codex:{scopeStrategy:'desktop-project',sessionStrategy:'chat-instance'}}}));
async function hook(verb = "recall"){return new Promise((resolve,reject)=>{const p=spawn(process.execPath,[fileURLToPath(new URL('../dist/codex-honcho.mjs', import.meta.url)),verb],{env:{...process.env,HONCHO_CONFIG_DIR:dir,HONCHO_API_KEY:'test',CODEX_APP_TOOLS_PIPE_PATH:pipe,CODEX_APP_TOOLS_CALLER_HOST_ID:'local'}});let out='',err='';p.stdout.on('data',c=>out+=c);p.stderr.on('data',c=>err+=c);p.on('close',code=>code?reject(Error(err)):resolve(out));p.stdin.end(JSON.stringify({session_id:'chat-full-id',cwd:'/repo/worktree',prompt:'Explain project auth'}));});}
try{
 const first=await hook();assert.doesNotMatch(first,/Project-only memory/); const task=await hook("prompt");assert.match(task,/Project-only memory/);assert.doesNotMatch(first,/Global card/);assert(seen.some(x=>x.path.endsWith('/scopes')&&x.body.metadata.projectName==='Project'));assert(seen.some(x=>x.path.includes('/scopes/')&&x.body.session_ids?.[0]==='chat-full-id'));
 projectId=null;const second=await hook("prompt");assert.match(second,/Global task fact/);assert(seen.some(x=>x.method==='DELETE'&&x.path.endsWith('/sessions/chat-full-id')));
 console.log(JSON.stringify({pass:true,scopeMembership:true,fullSessionId:true,scopedRecall:true,projectlessRemoval:true,requests:seen.length}));
}finally{app.close();api.close();}
