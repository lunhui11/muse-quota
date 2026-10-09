// Real Node API and executor with deterministic Muse/Drive fixtures; never uses real profiles.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createService } from '../../../server.mjs';
const dataDir=await mkdtemp(join(tmpdir(),'wechat-pool-http-'));
const files=new Map(),sent=new Map();let firstId;
const drive={configured:()=>true,checkFolder:async()=>{},put:async(folder,key,content)=>{
  const id=folder+'-'+key;files.set(id,content);
  return {id,sha256:createHash('sha256').update(content).digest('hex'),url:'https://drive.google.com/file/d/'+id+'/view'};
},get:async file=>JSON.parse(files.get(file.id))};
const adapter={async open(account){return {
  quota:async()=>({weekly_used_pct:account.id===firstId&&sent.has(account.id)?95:10}),
  turn:async(prompt,cb)=>{
    await cb.onSubmit({thread_url:'https://muse.ai/thread/fixture'});
    sent.set(account.id,(sent.get(account.id)||0)+1);
    const nonce=prompt.match(/"nonce":"([^"]+)"/)[1],done=account.id!==firstId;
    const reply=JSON.stringify({nonce,done,summary:done?'报告最终完成':'第一部分完成',next_steps:done?'':'继续第二部分，不要重做第一部分',artifacts:[{name:done?'second.md':'first.md',content:done?'第二部分成果':'第一部分成果'}]});
    await cb.onReply({reply,thread_url:'https://muse.ai/thread/fixture'});return reply;
  },close:async()=>{},
};}};
const service=await createService({dataDir,seed:false,scheduler:false,drive,adapter,prober:async()=>({weekly_used_pct:10})});
await new Promise(r=>service.server.listen(0,'127.0.0.1',r));
const base='http://127.0.0.1:'+service.server.address().port;
async function api(path,data){const r=await fetch(base+'/api/'+path,{method:data===undefined?'GET':'POST',headers:{'Content-Type':'application/json'},body:data===undefined?undefined:JSON.stringify(data)});if(!r.ok)throw new Error('fixture HTTP failure');return r.json();}
for(let i=0;i<2;i++){
  const a=await api('accounts',{label:'测试账号'+i});firstId ||= a.id;await api('pool/accounts/'+a.id+'/folder',{folder_id:'fixture-folder-'+i});
}
await api('probe-all',{});
for(let i=0;i<100;i++){if((await api('status')).accounts.every(a=>!a.job))break;await new Promise(r=>setTimeout(r,5));}
const timer=setInterval(()=>{void service.executor.tick();},10);
console.log(JSON.stringify({base}));
for(const sig of ['SIGINT','SIGTERM'])process.once(sig,async()=>{
  clearInterval(timer);await service.stop();await rm(dataDir,{recursive:true,force:true});process.exit(0);
});
