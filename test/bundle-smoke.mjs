import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtempSync,writeFileSync,existsSync } from 'node:fs';
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
let visible = true;
let appConnections=0;
const pipe=join(dir,'app.sock');
const app=net.createServer(s=>{appConnections++;let data=Buffer.alloc(0);s.on('data',c=>{data=Buffer.concat([data,c]);if(data.length<4||data.length<data.readUInt32LE(0)+4)return;const q=JSON.parse(data.subarray(4));
const payload=q.params?.tool==='list_threads'?{threads:visible ? [{id:'chat-full-id',kind:'codex',hostId:'local',projectId}] : []}:{projects:[{projectId:'p',hostId:'local',label:'Project'}]};
const result=q.method==='tools/list'?{tools:['list_threads','list_projects'].map(name=>({name,namespace:'codex_app'}))}:{success:true,contentItems:[{type:'inputText',text:JSON.stringify(payload)}]};
const b=Buffer.from(JSON.stringify({jsonrpc:'2.0',id:q.id,result}));const h=Buffer.alloc(4);h.writeUInt32LE(b.length);s.end(Buffer.concat([h,b]));});});
await new Promise(r=>app.listen(pipe,r));
writeFileSync(join(dir,'config.json'),JSON.stringify({apiKey:'test',peerName:'alex',workspace:'test',endpoint:{baseUrl:`http://127.0.0.1:${api.address().port}`},hosts:{codex:{scopeStrategy:'desktop-project',sessionStrategy:'chat-instance'}}}));
const rollout = join(dir, "rollout.jsonl");
async function hook(verb = "recall", options = { transcript_path: rollout }){return new Promise((resolve,reject)=>{const p=spawn(process.execPath,[fileURLToPath(new URL('../dist/codex-honcho.mjs', import.meta.url)),verb],{env:{...process.env,CODEX_HOME:dir,HONCHO_CONFIG_DIR:dir,HONCHO_API_KEY:'test',CODEX_APP_TOOLS_PIPE_PATH:pipe,CODEX_APP_TOOLS_CALLER_HOST_ID:'local'}});let out='',err='';p.stdout.on('data',c=>out+=c);p.stderr.on('data',c=>err+=c);p.on('close',code=>code?reject(Error(err)):resolve(out));p.stdin.end(JSON.stringify({...options,tool_name:'apply_patch',session_id:'chat-full-id',cwd:'/repo/worktree',prompt:'Explain project auth'}));});}
try{
 for (const options of [{}, { transcript_path: null }, { transcript_path: rollout }]) {
   const headers = options.transcript_path
     ? [{ thread_source: "guardian_review" }, { source: { subagent: { other: "guardian" } } }]
     : [null];
   for (const header of headers) {
     if (header) {
       writeFileSync(rollout, JSON.stringify({ type: "session_meta", payload: header }) + "\n" +
         JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "internal review" } }) + "\n");
     }
     for (const verb of ["recall", "prompt", "observe", "writeback"]) {
       assert.equal(await hook(verb, options), "");
     }
     assert.equal(appConnections, 0);
     assert.equal(seen.length, 0);
     assert.equal(existsSync(join(dir, "codex")), false, "excluded hooks wrote local state");
   }
 }
 writeFileSync(rollout, JSON.stringify({type:"session_meta",payload:{thread_source:"user"}}) + "\n");
 const first=await hook();assert.doesNotMatch(first,/Project-only memory/); const task=await hook("prompt");assert.match(task,/Project-only memory/);assert.doesNotMatch(first,/Global card/);assert(seen.some(x=>x.path.endsWith('/scopes')&&x.body.metadata.projectName==='Project'));assert(seen.some(x=>x.path.includes('/scopes/')&&x.body.session_ids?.[0]==='chat-full-id'));
 projectId=null;const second=await hook("prompt");assert.match(second,/Global task fact/);assert(seen.some(x=>x.method==='DELETE'&&x.path.endsWith('/sessions/chat-full-id')));
 const sqlite = await import('node:sqlite').catch(() => null);
 if (sqlite) {
   visible = false;
   const db = new sqlite.DatabaseSync(join(dir, '.codex-global-state.sqlite'));
   try {
     db.exec('CREATE TABLE settings (scope TEXT, key TEXT PRIMARY KEY, value TEXT)');
     const put = db.prepare("INSERT OR REPLACE INTO settings VALUES ('global', ?, ?)");
     const id = 'chat-full-id';
     put.run('thread-project-membership-host-ids', JSON.stringify({[id]: 'local'}));
     put.run('thread-project-assignments', JSON.stringify({[id]: {projectKind: 'local', projectId: 'p'}}));
     put.run('projectless-thread-ids', '[]');
     assert.match(await hook('prompt'), /Project-only memory/);
     put.run('projectless-thread-ids', JSON.stringify([id]));
     assert.match(await hook('prompt'), /lookup unavailable/);
     put.run('thread-project-assignments', '{}');
     assert.match(await hook('prompt'), /Global task fact/);
     put.run('thread-project-membership-host-ids', JSON.stringify({[id]: 'remote'}));
     assert.match(await hook('prompt'), /lookup unavailable/);
     put.run('projectless-thread-ids', '[]');
     assert.match(await hook('prompt'), /lookup unavailable/);
   } finally {
     db.close();
   }
 }
 console.log(JSON.stringify({pass:true,scopeMembership:true,fullSessionId:true,scopedRecall:true,projectlessRemoval:true,requests:seen.length}));
}finally{app.close();api.close();}
