import { readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { DriveStore } from './drive.mjs';

const error = (message,status=400)=>Object.assign(new Error(message),{status});
const text = (value,name,max=10000)=>{if(typeof value!=='string'||!value.trim()||value.length>max)throw error(`${name}需要 1–${max} 个字符。`);return value.trim();};
function snapshot(data,now) {
  const summary=text(data.summary,'进度摘要');
  const nextSteps=data.completed===true?'':text(data.next_steps,'续做指令');
  let artifacts=[];
  if(data.artifacts!==undefined){
    if(!Array.isArray(data.artifacts)||data.artifacts.length>10)throw error('工作成果最多包含 10 个文本文件。');
    artifacts=data.artifacts.map(file=>({name:text(file?.name,'成果文件名',120),content:text(file?.content,'成果内容',20000)}));
    if(new Set(artifacts.map(f=>f.name)).size!==artifacts.length)throw error('成果文件名不能重复。');
  }
  return {summary,next_steps:nextSteps,artifacts,updated_at:now().toISOString()};
}
export async function createPool({dataDir,accounts,drive=new DriveStore(),now=()=>new Date(),syncHour=8,importDrive=false}) {
  if(!Number.isInteger(syncHour)||syncHour<0||syncHour>23)throw error('DAILY_SYNC_HOUR 需要 0–23 的整数。');
  const path=join(dataDir,'pool-state.json');
  let state;
  try{state=JSON.parse(await readFile(path,'utf8'));}
  catch(e){if(e.code!=='ENOENT')throw new Error('账号池数据损坏，请检查备份。');state={folders:{},tasks:[],documents:[],last_sync_date:null,sync_error:null};}
  if(!state.folders||!Array.isArray(state.tasks)||!Array.isArray(state.documents))throw new Error('账号池数据格式无效。');
  state.drive_inputs ||= {};
  let tail=Promise.resolve(), pendingTick=null, committedState=structuredClone(state);
  const save=async()=>{
    const snapshot=structuredClone(state);
    try{
      await writeFile(path+'.tmp',JSON.stringify(snapshot,null,2),{mode:0o600});
      await rename(path+'.tmp',path);committedState=snapshot;
    }catch(e){state=structuredClone(committedState);throw e;}
  };
  function serial(fn){const result=tail.catch(()=>{}).then(fn);tail=result;return result;}
  async function change(fn){const before=structuredClone(state);let saving=false;try{const result=await fn();saving=true;await save();return structuredClone(result);}catch(e){if(!saving)state=before;throw e;}}
  function task(id){const t=state.tasks.find(t=>t.id===id);if(!t)throw error('任务不存在。',404);return t;}
  const active=t=>!['completed','cancelled'].includes(t.status);
  function available(exclude=null,taskId=null){return accounts().filter(a=>a.id!==exclude&&a.eligible_for_new_requests&&state.folders[a.id]&&!state.tasks.some(t=>t.id!==taskId&&active(t)&&t.account_id===a.id));}
  function view(){return structuredClone({drive_configured:!!drive.configured(),drive_import_enabled:importDrive,sync_hour:syncHour,...state});}
  const today=()=>now().toLocaleDateString('en-CA',{timeZone:'Asia/Shanghai'});
  async function importInputs(a,force=false) {
    if(!importDrive)return;
    if(!force&&state.drive_inputs[a.id]?.date===today())return;
    if(!drive.configured())throw error('请先配置 Google Drive OAuth 授权。',409);
    const documents=await drive.importTextFiles(state.folders[a.id]);
    state.drive_inputs[a.id]={date:today(),documents};
  }
  async function syncDocuments(targets=accounts().filter(a=>a.enabled&&state.folders[a.id])) {
    if(state.documents.length&&!drive.configured())throw error('请先配置 Google Drive OAuth 授权。',409);
    if(state.documents.length&&!targets.length)throw error('请先为至少一个启用的账号绑定网盘目录。',409);
    for(const a of targets)for(const d of state.documents){
      const content=JSON.stringify({schema_version:1,id:d.id,title:d.title,content:d.content,updated_at:d.updated_at});
      const file=await drive.put(state.folders[a.id],'info-'+d.id,content);
      d.files[a.id]=file;
    }
  }
  async function assign(t,exclude=null){
    const list=accounts(),start=list.findIndex(a=>a.id===exclude);
    const position=a=>list.findIndex(item=>item.id===a.id);
    const candidates=available(exclude,t.id).sort((a,b)=>((position(a)-start-1+list.length)%list.length)-((position(b)-start-1+list.length)%list.length));
    const next=candidates[0]||available(null,t.id).find(a=>a.id===exclude);
    if(!next){t.status='waiting_account';t.error='没有额度新鲜且已绑定网盘目录的空闲账号。';await save();return;}
    if(!drive.configured()){t.status='waiting_drive';t.error='请先配置 Google Drive OAuth 授权。';await save();return;}
    t.status='uploading';t.target_account_id=next.id;await save();
    try{
      await syncDocuments([next]);
      await importInputs(next);
      const bundle={schema_version:1,task_id:t.id,prompt:t.prompt,revision:t.revision+1,from_account_id:t.account_id,to_account_id:next.id,checkpoint:t.checkpoint||null,documents:[...state.documents.map(d=>({id:d.id,title:d.title,file:d.files[next.id]})),...(state.drive_inputs[next.id]?.documents||[])],created_at:now().toISOString()};
      const content=JSON.stringify(bundle);
      if(t.account_id&&state.folders[t.account_id])await drive.put(state.folders[t.account_id],'handoff-'+t.id+'-'+bundle.revision,content);
      const file=await drive.put(state.folders[next.id],'handoff-'+t.id+'-'+bundle.revision,content);
      // Commit the new owner only after both copies have been uploaded and verified.
      t.history.push({from:t.account_id,to:next.id,revision:bundle.revision,file,at:bundle.created_at});
      t.account_id=next.id;t.revision=bundle.revision;t.bundle=bundle;t.file=file;t.status='ready';t.error=null;delete t.target_account_id;
    }catch(e){t.status='upload_failed';t.error=e.message;}
    await save();
  }
  async function backupCheckpoint(t){
    try{
      if(!state.folders[t.account_id]||!drive.configured())throw new Error('暂停进度尚未上传，请检查源账号的网盘授权和目录。');
      t.checkpoint_file=await drive.put(state.folders[t.account_id],'checkpoint-'+t.id+'-'+t.revision,JSON.stringify({schema_version:1,task_id:t.id,prompt:t.prompt,revision:t.revision,account_id:t.account_id,checkpoint:t.checkpoint}));
      t.status='queued';t.error=null;
    }catch(e){t.status='checkpoint_upload_failed';t.error=e.message;}
    await save();
  }
  async function finalize(t){
    try{
      if(!state.folders[t.account_id]||!drive.configured())throw new Error('任务结果尚未上传，请检查网盘授权和目录。');
      t.file=await drive.put(state.folders[t.account_id],'result-'+t.id,JSON.stringify({schema_version:1,task_id:t.id,prompt:t.prompt,revision:t.revision,account_id:t.account_id,checkpoint:t.checkpoint,completed_at:now().toISOString()}));
      t.status='completed';t.error=null;
    }catch(e){t.status='completion_upload_failed';t.error=e.message;}
    await save();
  }
  async function cycle(){
    for(const t of state.tasks){
      if(['checkpoint_pending','checkpoint_upload_failed'].includes(t.status))await backupCheckpoint(t);
      if(['finalizing','completion_upload_failed'].includes(t.status))await finalize(t);
      if(t.status==='ready'){
        const a=accounts().find(a=>a.id===t.account_id);
        if(!a||!a.quota_usable||a.quota?.weekly_used_pct>=a.pause_at_percent)t.status='queued';
      }
      if(t.status==='running'){
        const a=accounts().find(a=>a.id===t.account_id);
        // Stale/unknown readings pause work too; they never authorize another request.
        if(!a||!a.quota_usable||a.quota?.weekly_used_pct>=a.pause_at_percent){t.status='pause_requested';t.error='请在当前步骤结束后暂停，并提交可续做的进度。';}
      }
      if(['queued','waiting_account','waiting_drive','upload_failed','uploading'].includes(t.status))await assign(t,t.account_id);
    }
    const date=today();
    const hour=Number(now().toLocaleTimeString('en-GB',{timeZone:'Asia/Shanghai',hour:'2-digit',hour12:false}));
    if(hour>=syncHour&&state.last_sync_date!==date&&(state.documents.length||importDrive)){
      try{await syncDocuments();for(const a of accounts().filter(a=>a.enabled&&state.folders[a.id]))await importInputs(a,true);state.last_sync_date=date;state.sync_error=null;}
      catch(e){state.sync_error=e.message;}
    }
    await save();
  }
  // A previously claimed worker must acknowledge a pause after a service restart.
  for(const t of state.tasks){if(t.status==='running'){t.status='pause_requested';t.error='服务已重启，请暂停并重新提交进度。';}}
  return {
    view,
    getTask:id=>structuredClone(task(id)),
    usingProfile: id=>state.tasks.some(t=>t.account_id===id&&['running','pause_requested'].includes(t.status)),
    validateWorker(id,data){const t=task(id);if(!['running','pause_requested'].includes(t.status)||t.account_id!==data.account_id||t.revision!==data.revision)throw error('旧账号或旧版本不能更新任务。',409);},
    async recordQuota(id,data,apply){return serial(async()=>{this.validateWorker(id,data);await apply();await cycle();});},
    async cancel(id){return serial(()=>change(()=>{const t=task(id);if(t.status==='completed')throw error('已完成的任务不能取消。',409);if(['running','pause_requested'].includes(t.status)||(t.status==='needs_attention'&&t.uncertain))throw error('请先确认 Muse 已停止，并通过恢复任务提交进度。',409);t.status='cancelled';t.error=null;return t;}));},
    async bind(id,folder){return serial(()=>change(async()=>{
      if(!accounts().some(a=>a.id===id))throw error('账号不存在。',404);
      if(state.tasks.some(t=>active(t)&&(t.account_id===id||t.target_account_id===id)))throw error('该账号有未结束的任务，暂时不能更改网盘目录。',409);
      let value=text(folder,'网盘目录',256);if(value.startsWith('https://')){let url;try{url=new URL(value);}catch{throw error('网盘目录链接无效。');}if(url.hostname!=='drive.google.com')throw error('请使用 Google Drive 目录链接。');value=url.pathname.match(/\/folders\/([A-Za-z0-9_-]+)/)?.[1]||'';}
      if(!/^[A-Za-z0-9_-]{5,200}$/.test(value))throw error('请输入网盘目录 ID 或目录链接。');
      if(drive.configured())try{await drive.checkFolder(value);}catch(e){throw error(e.message,409);}
      if(state.folders[id]!==value){state.last_sync_date=null;delete state.drive_inputs[id];}
      state.folders[id]=value;return {folder_id:value,verified:!!drive.configured()};
    }));},
    async addDocument(data){return serial(()=>change(()=>{const d={id:randomBytes(6).toString('hex'),title:text(data.title,'资料标题',120),content:text(data.content,'资料内容'),updated_at:now().toISOString(),files:{}};state.documents.push(d);state.last_sync_date=null;return d;}));},
    async addTask(data){return serial(async()=>{
      const prompt=text(data.prompt,'任务说明');
      const requestId=data.request_id;
      if(requestId!==undefined&&(typeof requestId!=='string'||!/^[A-Za-z0-9._:-]{1,128}$/.test(requestId)))throw error('request_id 需要 1–128 个字母、数字或 . _ : - 字符。');
      if(requestId!==undefined){
        const existing=state.tasks.find(t=>t.request_id===requestId);
        if(existing){if(existing.prompt!==prompt)throw error('同一个 request_id 不能用于不同任务。',409);return structuredClone(existing);}
      }
      return change(()=>{const t={id:randomBytes(6).toString('hex'),prompt,status:'queued',account_id:null,revision:0,checkpoint:null,history:[],created_at:now().toISOString(),error:null};
      if(requestId!==undefined)t.request_id=requestId;
      state.tasks.push(t);return t;});
    });},
    async claim(id,data){return serial(()=>change(()=>{
      const t=task(id);if(t.status!=='ready'||t.account_id!==data.account_id||t.revision!==data.revision)throw error('任务归属或版本已变化，请重新读取任务。',409);
      const a=accounts().find(a=>a.id===t.account_id);if(!a?.eligible_for_new_requests)throw error('账号额度不确定或正在操作，暂时不能执行任务。',409);
      t.status='running';if(data.executor==='builtin')t.executor='builtin';else delete t.executor;delete t.uncertain;return t;
    }));},
    async checkpoint(id,data){return serial(async()=>{
      const t=task(id);if(!['running','pause_requested'].includes(t.status)||t.account_id!==data.account_id||t.revision!==data.revision)throw error('旧账号或旧版本不能更新任务。',409);
      if(data.paused!==true&&data.completed!==true)throw error('提交进度前必须确认任务已暂停或已完成。');
      const checkpoint=snapshot(data,now);
      await change(()=>{t.checkpoint=checkpoint;t.status=data.completed===true?'finalizing':'checkpoint_pending';t.error=null;});
      if(t.status==='checkpoint_pending')await backupCheckpoint(t);
      if(t.status==='queued')await assign(t,t.account_id);else if(t.status==='finalizing')await finalize(t);
      return structuredClone(t);
    });},
    // These operations share the same ownership checks as external workers.
    async progress(id,data){return serial(()=>change(()=>{
      this.validateWorker(id,data);const t=task(id);t.checkpoint=snapshot(data,now);return t;
    }));},
    async hold(id,data){return serial(()=>change(()=>{
      this.validateWorker(id,data);const t=task(id);
      t.status='needs_attention';t.error=text(data.reason,'暂停原因',500);t.uncertain=data.uncertain!==false;return t;
    }));},
    async resume(id,data){return serial(async()=>{
      const t=task(id);if(t.status!=='needs_attention')throw error('只有等待人工检查的任务可以恢复。',409);
      if(data.paused!==true)throw error('请先在 Muse 中确认任务已经停止。',409);
      const checkpoint=snapshot({...data,artifacts:data.artifacts??t.checkpoint?.artifacts},now);
      await change(()=>{t.checkpoint=checkpoint;t.status=data.completed===true?'finalizing':'checkpoint_pending';t.error=null;delete t.uncertain;});
      if(t.status==='finalizing')await finalize(t);else{await backupCheckpoint(t);if(t.status==='queued')await assign(t,t.account_id);}
      return structuredClone(t);
    });},
    async sync(){return serial(async()=>{try{await syncDocuments();for(const a of accounts().filter(a=>a.enabled&&state.folders[a.id]))await importInputs(a,true);state.last_sync_date=today();state.sync_error=null;await save();return view();}catch(e){state.sync_error=e.message;await save();throw error(e.message,409);}});},
    tick:()=>pendingTick||(pendingTick=serial(cycle).finally(()=>{pendingTick=null;})),
    stop:()=>tail.catch(()=>{}),
  };
}
