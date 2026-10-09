import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
import { createService } from './server.mjs';
import { parseStep } from './executor.mjs';
import { createMuseAdapter } from './muse.mjs';
import { launchAccount } from './probe.mjs';
import { DriveStore } from './drive.mjs';

const answer=(nonce,extra={})=>JSON.stringify({nonce,done:false,summary:'第一步完成',next_steps:'继续第二步，不要重复第一步',artifacts:[{name:'first.md',content:'第一步成果'}],...extra});
function memoryDrive() {
  const files=new Map(),keys=new Map(),downloads=[];let corrupt=null,sequence=0;
  const json=value=>new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}});
  const store=new DriveStore({env:{DRIVE_OAUTH_CLIENT_ID:'fixture',DRIVE_OAUTH_CLIENT_SECRET:'fixture',DRIVE_OAUTH_REFRESH_TOKEN:'fixture'},fetcher:async (url,o={})=>{
    const u=new URL(url);
    if(u.hostname==='oauth2.googleapis.com')return json({access_token:'fixture',expires_in:3600});
    const id=u.pathname.split('/').at(-1);
    if(o.method==='PATCH'){files.set(id,String(o.body));return json({id});}
    if(o.method==='POST'){
      const body=JSON.parse(o.body),file='fixture-file-'+(++sequence);
      keys.set(body.parents[0]+'/'+body.appProperties.muse_pool_key,file);return json({id:file});
    }
    if(u.searchParams.has('q')){
      const q=u.searchParams.get('q'),folder=q.match(/^'([^']+)'/)[1],key=q.match(/value='([^']+)'/)[1];
      const file=keys.get(folder+'/'+key);return json({files:file?[{id:file}]:[]});
    }
    if(u.searchParams.get('alt')==='media'){
      downloads.push(id);return new Response(corrupt===id?'corrupt fixture':files.get(id));
    }
    return json({id,mimeType:'application/vnd.google-apps.folder',capabilities:{canAddChildren:true}});
  }});
  return {store,files,keys,downloads,corrupt:id=>{corrupt=id;}};
}
async function serviceFixture(t,{adapter,number=2,executorMaxSteps=20}={}) {
  const dataDir=await mkdtemp(join(tmpdir(),'muse-executor-'));const drive=memoryDrive();
  let service=await createService({dataDir,seed:false,scheduler:false,drive:drive.store,adapter,executorMaxSteps,prober:async()=>({weekly_used_pct:10})});
  t.after(async()=>{await service.stop();await rm(dataDir,{recursive:true,force:true});});
  await new Promise(r=>service.server.listen(0,'127.0.0.1',r));
  const api=async(path,data,method=data===undefined?'GET':'POST')=>{
    const r=await fetch('http://127.0.0.1:'+service.server.address().port+'/api/'+path,{method,headers:{'Content-Type':'application/json'},body:data===undefined?undefined:JSON.stringify(data)});
    return {status:r.status,data:await r.json()};
  };
  const ids=[];
  for(let i=0;i<number;i++){const a=(await api('accounts',{label:'账号'+(i+1)})).data;ids.push(a.id);await api('pool/accounts/'+a.id+'/folder',{folder_id:'folder-'+i});}
  await api('probe-all',{});
  for(let i=0;i<100;i++){if((await api('status')).data.accounts.every(a=>!a.job))break;await new Promise(r=>setTimeout(r,5));}
  await api('pool/documents',{title:'每日资料',content:'要同步给全部账号的资料'});
  const task=(await api('pool/tasks',{prompt:'分两步完成报告，把第一步成果保留，第二步续做。'})).data;
  await api('pool/tick',{});
  return {dataDir,drive,api,ids,task,get service(){return service;},async restart(){await service.stop();service=await createService({dataDir,seed:false,scheduler:false,drive:drive.store,adapter,executorMaxSteps});await new Promise(r=>service.server.listen(0,'127.0.0.1',r));}};
}
function adapterFixture({turn,quota=()=>10,close=async()=>{}}={}) {
  const sends=[],opens=[];let active=0;
  return {sends,opens,get active(){return active;},async open(account,path){opens.push({id:account.id,path});active++;return {
    quota:async()=>({weekly_used_pct:await quota(account.id)}),
    turn:async(prompt,callbacks)=>{
      if(!callbacks.canSubmit())return null;
      await callbacks.onSubmit({thread_url:'https://muse.ai/thread/fixture'});sends.push({id:account.id,prompt});
      const nonce=prompt.match(/"nonce":"([^"]+)"/)[1];
      const reply=turn?await turn(nonce,account.id,prompt):answer(nonce,{done:true,next_steps:'',summary:'完成'});
      await callbacks.onReply({reply,thread_url:'https://muse.ai/thread/fixture'});return reply;
    },close:async()=>{await close();active--;},
  };}};
}
const run=async f=>{f.service.executor.start();await f.service.executor.tick();};

test('真实临时浏览器驱动：读取网盘、1 号完成一步后达到阈值、2 号读取进度续做并上传成果',async t=>{
  const turns=[],events=[];let firstId;
  const adapter=createMuseAdapter({quietMs:40,pollMs:10,timeoutMs:3000,launch:async(account,path,headless)=>{
    const context=await launchAccount(account,path,headless);events.push('open:'+account.id);
    context.on('close',()=>events.push('close:'+account.id));
    await context.exposeFunction('fixtureTurn',async prompt=>{
      turns.push({id:account.id,prompt});const nonce=prompt.match(/"nonce":"([^"]+)"/)[1];
      return account.id===firstId?answer(nonce):answer(nonce,{done:true,summary:'两步完成',next_steps:'',artifacts:[{name:'second.md',content:'第二步成果'}]});
    });
    await context.route('**/*',route=>{
      const used=account.id===firstId&&turns.some(s=>s.id===firstId)?95:10;
      return route.fulfill({contentType:'text/html',body:`<!doctype html><button aria-label="Settings" onclick="document.querySelector('[role=dialog]').hidden=false">Settings</button><div role="dialog" hidden>Free plan\nWeekly usage\n${used}% used</div><div id="messages"></div><div data-hatch-composer-root><textarea></textarea><button data-testid="hatch-composer-stop-button" style="display:none">Stop</button></div><script>
      document.querySelector('textarea').onkeydown=async e=>{if(e.key!=='Enter'||e.shiftKey)return;e.preventDefault();const input=e.target,prompt=input.value;input.value='';const user=document.createElement('div');user.setAttribute('data-message-item','');user.setAttribute('data-message-role','user');user.textContent=prompt;document.querySelector('#messages').append(user);const stop=document.querySelector('button[data-testid]');stop.style.display='block';const reply=await window.fixtureTurn(prompt);const a=document.createElement('div');a.setAttribute('data-message-item','');a.setAttribute('data-message-role','assistant');a.textContent=reply;document.querySelector('#messages').append(a);stop.style.display='none';};</script>`});
    });
    return context;
  }});
  const f=await serviceFixture(t,{adapter});firstId=f.ids[0];
  assert.equal((await f.api('executor')).data.enabled,false);
  await run(f);let task=f.service.pool.view().tasks[0];
  assert.equal(task.status,'ready');assert.equal(task.account_id,f.ids[1]);assert.equal(task.revision,2);
  assert.equal(turns.length,1);assert.match(turns[0].prompt,/要同步给全部账号的资料/);
  const secondFile=task.file.id;await f.service.executor.tick();task=f.service.pool.view().tasks[0];
  assert.equal(task.status,'completed');assert.equal(turns.length,2);
  assert.match(turns[1].prompt,/继续第二步，不要重复第一步/);assert.match(turns[1].prompt,/第一步成果/);
  assert.deepEqual(task.checkpoint.artifacts.map(a=>a.name),['first.md','second.md']);
  assert.ok(f.drive.downloads.includes(secondFile));assert.ok(events.indexOf('close:'+firstId)<events.indexOf('open:'+f.ids[1]));
  assert.ok(f.drive.keys.has('folder-1/result-'+task.id));
  assert.equal((await f.api('pool/tasks/'+task.id+'/quota',{account_id:firstId,revision:1,weekly_used_pct:0})).status,409);
  assert.equal((await f.api('pool')).data.executor.status,'idle');
});

test('网盘交接校验失败时不打开 Muse、不发送请求',async t=>{
  const adapter=adapterFixture();const f=await serviceFixture(t,{adapter});
  f.drive.corrupt(f.service.pool.view().tasks[0].file.id);await run(f);
  assert.equal(adapter.opens.length,0);assert.equal(f.service.pool.view().tasks[0].status,'needs_attention');assert.equal(f.service.pool.view().tasks[0].uncertain,false);
});

test('无效回复暂停并保留原文，调度和重新启动都不重复发送',async t=>{
  const adapter=adapterFixture({turn:async()=>'<script>bad reply</script>'});const f=await serviceFixture(t,{adapter});await run(f);
  let task=f.service.pool.view().tasks[0];assert.equal(task.status,'needs_attention');assert.equal(task.uncertain,true);
  assert.equal((await f.api('pool/tasks/'+task.id+'/cancel',{})).status,409);
  await f.service.pool.tick();await f.service.executor.tick();await f.restart();await run(f);
  assert.equal(adapter.sends.length,1);assert.equal((await f.api('executor/tasks/'+task.id)).data.reply,'<script>bad reply</script>');
  assert.equal((await f.api('pool/tasks/'+task.id+'/resume',{summary:'已完成一步',next_steps:'下一步'})).status,409);
  f.service.executor.pause();
  const resumed=await f.api('pool/tasks/'+task.id+'/resume',{paused:true,summary:'已确认第一步完成',next_steps:'不要重做第一步，继续第二步',artifacts:[]});
  assert.equal(resumed.status,200);assert.equal(resumed.data.revision,2);assert.equal(resumed.data.account_id,f.ids[1]);
});

test('发送后超时不自动切号，账号保留给人工检查',async t=>{
  const adapter=adapterFixture({turn:async()=>{throw Object.assign(new Error('未能确认 Muse 已完整回复'),{code:'REPLY_TIMEOUT'});}});const f=await serviceFixture(t,{adapter});await run(f);
  const task=f.service.pool.view().tasks[0];assert.equal(task.status,'needs_attention');assert.equal(task.account_id,f.ids[0]);assert.equal(task.revision,1);assert.equal(adapter.active,0);
  await f.service.executor.tick();assert.equal(adapter.sends.length,1);
});

test('停止操作等待当前步骤并保存进度，不发送第二步',async t=>{
  let release,started;const began=new Promise(r=>{started=r;});const blocked=new Promise(r=>{release=r;});
  const adapter=adapterFixture({turn:async nonce=>{started();await blocked;return answer(nonce);}});const f=await serviceFixture(t,{adapter});
  f.service.executor.start();await began;
  assert.equal((await f.api('accounts/'+f.ids[0]+'/probe',{})).data.queued,false);
  assert.equal((await f.api('accounts/'+f.ids[0],{label:'不允许并发编辑'},'PATCH')).status,409);
  const paused=await f.api('executor/pause',{});assert.equal(paused.data.status,'stopping');
  assert.equal((await f.api('executor/start',{})).status,409);release();await f.service.executor.tick();
  assert.equal(adapter.sends.length,1);assert.equal(adapter.active,0);assert.equal(f.service.pool.view().tasks[0].status,'ready');assert.equal(f.service.executor.view().enabled,false);
});

test('步骤上限保存完整快照并等待检查，不能无限消耗额度',async t=>{
  const adapter=adapterFixture({turn:async nonce=>answer(nonce)});const f=await serviceFixture(t,{adapter,executorMaxSteps:1});await run(f);
  const task=f.service.pool.view().tasks[0];assert.equal(task.status,'needs_attention');assert.equal(task.uncertain,false);assert.equal(task.checkpoint.artifacts[0].content,'第一步成果');assert.equal(adapter.sends.length,1);
});

test('额度读取失败时不发送，未知额度不视为零',async t=>{
  const adapter=adapterFixture({quota:()=>NaN});const f=await serviceFixture(t,{adapter});await run(f);
  assert.equal(adapter.sends.length,0);assert.equal(f.service.pool.view().tasks[0].status,'needs_attention');
});

test('驱动发送前写入日志失败时不发送，并能显示存储错误',async t=>{
  let blocked;const adapter=adapterFixture({quota:async()=>{await mkdir(blocked);return 10;}});const f=await serviceFixture(t,{adapter});
  blocked=join(f.dataDir,'executor',f.task.id+'-1.json.tmp');await run(f);
  assert.equal(adapter.sends.length,0);assert.equal(f.service.pool.view().tasks[0].uncertain,false);await rmdir(blocked);
});

for(const phase of ['submitting','received','checkpointed'])test('重启恢复 '+phase+'，不重发旧步骤',async t=>{
  const adapter=adapterFixture();const f=await serviceFixture(t,{adapter});const task=f.service.pool.view().tasks[0];
  await f.service.pool.claim(task.id,{account_id:task.account_id,revision:1,executor:'builtin'});
  await writeFile(join(f.dataDir,'executor',task.id+'-1.json'),JSON.stringify({phase,checkpoint:{summary:'第一步完成',next_steps:'第二步',artifacts:[{name:'first.md',content:'已有成果'}]},step:1,completed:false,reply:'恢复测试回复'}));
  await f.restart();await run(f);const result=f.service.pool.view().tasks[0];
  if(phase==='checkpointed'){assert.equal(result.status,'completed');assert.equal(adapter.sends.length,1);assert.equal(result.revision,2);assert.match(adapter.sends[0].prompt,/已有成果/);}
  else{assert.equal(result.status,'needs_attention');assert.equal(result.uncertain,true);assert.equal(adapter.sends.length,0);}
});

test('回复协议拒绝旧标识、错误完成类型、超限成果；保留之前的成果',()=>{
  assert.throws(()=>parseStep(answer('old'),'new'));
  assert.throws(()=>parseStep(answer('n',{done:'true'}),'n'));
  assert.throws(()=>parseStep(answer('n',{artifacts:[{name:'big',content:'x'.repeat(20001)}]}),'n'));
  assert.throws(()=>parseStep(answer('n',{artifacts:[{name:'a',content:'x'},{name:'a',content:'y'}]}),'n'));
  const result=parseStep('```json\n'+answer('n',{done:true,artifacts:[]})+'\n```','n',{artifacts:[{name:'saved',content:'旧成果'}]});assert.equal(result.completed,true);assert.equal(result.artifacts[0].content,'旧成果');
});

test('下载校验拒绝变更内容、无效 JSON 和过大文件',async()=>{
  const value='{"a":1}',file={id:'fixture',sha256:createHash('sha256').update(value).digest('hex')};
  const drive=new DriveStore({env:{},fetcher:async()=>new Response(value)});drive.api=async()=>new Response(value);
  assert.deepEqual(await drive.get(file),{a:1});drive.api=async()=>new Response('{}');await assert.rejects(drive.get(file),/内容已变化/);
  const invalid='bad';drive.api=async()=>new Response(invalid);await assert.rejects(drive.get({...file,sha256:createHash('sha256').update(invalid).digest('hex')}),/不是有效的 JSON/);
  drive.api=async()=>new Response('x'.repeat(2097153));await assert.rejects(drive.get(file),/超过 2 MiB/);
});

test('恢复界面显示原文而不执行 HTML，并提交完整进度恢复',async t=>{
  const adapter=adapterFixture({turn:async()=>'<img src=x onerror="window.injected=true">'});const f=await serviceFixture(t,{adapter});await run(f);f.service.executor.pause();
  const browser=await chromium.launch({headless:true,channel:process.env.BROWSER_CHANNEL||(process.platform==='win32'?'chrome':undefined)});t.after(()=>browser.close());const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://127.0.0.1:'+f.service.server.address().port);await page.getByRole('button',{name:'检查并恢复',exact:true}).click();
  await page.locator('#recover-dialog').waitFor({state:'visible'});assert.match(await page.locator('#recover-reply').textContent(),/onerror/);assert.equal(await page.evaluate(()=>window.injected),undefined);
  await page.getByLabel('完整进度摘要',{exact:true}).fill('已完成第一步，准备继续');await page.getByLabel('续做指令',{exact:true}).fill('继续第二步');await page.locator('#recover-paused').check();
  await page.getByRole('button',{name:'保存并恢复',exact:true}).click();await page.locator('#recover-dialog').waitFor({state:'hidden'});
  assert.equal(f.service.pool.view().tasks[0].revision,2);assert.equal(f.service.pool.view().tasks[0].checkpoint.summary,'已完成第一步，准备继续');
  await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assert.deepEqual(errors,[]);
});

async function domSession(t,html,{timeoutMs=150,...options}={}) {
  const directory=await mkdtemp(join(tmpdir(),'muse-dom-'));let context;
  t.after(async()=>{await context?.close().catch(()=>{});await rm(directory,{recursive:true,force:true});});
  const adapter=createMuseAdapter({timeoutMs,readyMs:500,quietMs:20,pollMs:10,...options,launch:async(account,path,headless)=>{
    context=await launchAccount(account,path,headless);
    await context.route('**/*',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><meta charset="utf-8">'+html}));return context;
  }});
  return {session:await adapter.open({id:'fixture'},directory),get page(){return context.pages()[0];}};
}

test('网页有未发草稿或已有执行时，拒绝覆盖和发送',async t=>{
  const draft=await domSession(t,'<div data-hatch-composer-root><textarea>手工草稿</textarea></div>');
  let submissions=0;await assert.rejects(draft.session.turn('任务',{onSubmit:()=>{submissions++;}}),/未发送的草稿/);
  assert.equal(submissions,0);assert.equal(await draft.page.locator('textarea').inputValue(),'手工草稿');await draft.session.close();
  const busy=await domSession(t,'<div data-hatch-composer-root><textarea></textarea><button data-testid="hatch-composer-stop-button">Stop</button></div>');
  await assert.rejects(busy.session.turn('任务',{onSubmit:()=>{submissions++;}}),/其他任务/);assert.equal(submissions,0);
});

test('输入框 Enter 没有提交成功，只尝试一次且不能把旧回复当成新回复',async t=>{
  const f=await domSession(t,'<div data-message-item data-message-role="assistant">旧回复</div><div data-hatch-composer-root><textarea></textarea></div><script>window.presses=0;document.querySelector("textarea").onkeydown=e=>{if(e.key==="Enter"){e.preventDefault();window.presses++;}};</script>');
  let submissions=0;await assert.rejects(f.session.turn('任务',{onSubmit:async()=>{submissions++;}}),/完整回复/);
  assert.equal(submissions,1);assert.equal(await f.page.evaluate(()=>window.presses),1);
});

test('确认窗口、重复可见输入框均停止自动发送',async t=>{
  const approval=await domSession(t,'<div data-hatch-composer-root><textarea></textarea></div><div data-hatch-composer-approval-stack>请确认</div>');
  let submissions=0;await assert.rejects(approval.session.turn('任务',{onSubmit:()=>{submissions++;}}),/人工确认/);assert.equal(submissions,0);await approval.session.close();
  const duplicate=await domSession(t,'<div data-hatch-composer-root><textarea></textarea><div contenteditable="true"></div></div>');
  await assert.rejects(duplicate.session.turn('任务',{onSubmit:()=>{submissions++;}}),/唯一/);assert.equal(submissions,0);
});

test('一个隐藏旧输入框不会阻塞可见编辑器，已停止时不会按 Enter',async t=>{
  const f=await domSession(t,'<div data-hatch-composer-root><textarea hidden></textarea><div contenteditable="true"></div></div>');
  let submitted=0;assert.equal(await f.session.turn('任务',{canSubmit:()=>false,onSubmit:()=>{submitted++;}}),null);assert.equal(submitted,0);
});

test('发送日志保存期间收到暂停请求，不能按 Enter，并清理自己填写的草稿',async t=>{
  const f=await domSession(t,'<div data-hatch-composer-root><textarea></textarea></div><script>window.presses=0;document.querySelector("textarea").onkeydown=e=>{if(e.key==="Enter")window.presses++;};</script>');
  let allowed=true;const result=await f.session.turn('任务',{canSubmit:()=>allowed,onSubmit:async()=>{allowed=false;}});
  assert.equal(result,null);assert.equal(await f.page.evaluate(()=>window.presses),0);assert.equal(await f.page.locator('textarea').inputValue(),'');
});
