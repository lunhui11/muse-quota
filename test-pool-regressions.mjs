import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, rmdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPool } from './pool.mjs';
import { DriveStore } from './drive.mjs';

async function fixture(t,number=2){
  const dataDir=await mkdtemp(join(tmpdir(),'muse-pool-regression-'));
  t.after(()=>rm(dataDir,{recursive:true,force:true}));
  const accounts=Array.from({length:number},(_,i)=>({id:String(i+1).padStart(12,'0'),enabled:true,eligible_for_new_requests:true,quota_usable:true,quota:{weekly_used_pct:10},pause_at_percent:90}));
  const files=new Map();let beforePut=async()=>{};
  const drive={configured:()=>true,checkFolder:async()=>{},put:async(folder,key,content)=>{await beforePut(folder,key);files.set(folder+'/'+key,content);return {id:key,url:'https://drive.google.com/file/d/'+key+'/view',sha256:'fixture'};}};
  const pool=await createPool({dataDir,accounts:()=>structuredClone(accounts),drive,now:()=>new Date('2026-10-09T00:00:00Z')});
  for(const [i,a] of accounts.entries())await pool.bind(a.id,'folder-'+i);
  return {pool,accounts,files,dataDir,intercept:fn=>{beforePut=fn;}};
}
async function start(f){const t=await f.pool.addTask({prompt:'续做任务'});await f.pool.tick();const ready=f.pool.view().tasks.find(item=>item.id===t.id);await f.pool.claim(t.id,{account_id:ready.account_id,revision:ready.revision});return ready;}

test('交接的磁盘保存失败，不能在内存中发布新账号',async t=>{
  const f=await fixture(t);const task=await start(f);const blocked=join(f.dataDir,'pool-state.json.tmp');
  f.intercept(async(folder,key)=>{if(folder==='folder-1'&&key.startsWith('handoff-'))await mkdir(blocked);});
  await assert.rejects(f.pool.checkpoint(task.id,{account_id:task.account_id,revision:1,paused:true,summary:'已完成第一步',next_steps:'第二步'}));
  const current=f.pool.view().tasks[0];
  assert.notEqual(current.status,'ready');assert.equal(current.account_id,task.account_id);assert.equal(current.revision,1);
  await rmdir(blocked);f.intercept(async()=>{});
  await assert.rejects(f.pool.claim(task.id,{account_id:f.accounts[1].id,revision:2}),e=>e.status===409);
  await f.pool.tick();assert.equal(f.pool.view().tasks[0].revision,2);
});

test('没有备用账号，也先把暂停进度备份到源网盘',async t=>{
  const f=await fixture(t,1);const task=await start(f);
  f.accounts[0].quota.weekly_used_pct=95;f.accounts[0].eligible_for_new_requests=false;
  await f.pool.tick();
  const paused=await f.pool.checkpoint(task.id,{account_id:task.account_id,revision:1,paused:true,summary:'关键进度',next_steps:'继续第二步'});
  assert.equal(paused.status,'waiting_account');
  assert.ok([...f.files.entries()].some(([key,content])=>key.startsWith('folder-0/checkpoint-')&&JSON.parse(content).checkpoint?.summary==='关键进度'));
});

test('原账号额度恢复后，无备用账号的任务可以继续',async t=>{
  const f=await fixture(t,1);const task=await start(f);
  f.accounts[0].quota.weekly_used_pct=95;f.accounts[0].eligible_for_new_requests=false;
  await f.pool.tick();await f.pool.checkpoint(task.id,{account_id:task.account_id,revision:1,paused:true,summary:'进度',next_steps:'续做'});
  f.accounts[0].quota.weekly_used_pct=0;f.accounts[0].eligible_for_new_requests=true;
  await f.pool.tick();const resumed=f.pool.view().tasks[0];assert.equal(resumed.status,'ready');assert.equal(resumed.account_id,task.account_id);assert.equal(resumed.revision,2);
});

test('新增目录后，同一天补同步已有资料',async t=>{
  const f=await fixture(t,1);await f.pool.addDocument({title:'资料',content:'今天的资料'});await f.pool.tick();
  await f.pool.bind(f.accounts[0].id,'new-folder');await f.pool.tick();
  assert.ok([...f.files.keys()].some(key=>key.startsWith('new-folder/info-')));
});

test('已完成的任务不能被取消改写',async t=>{
  const f=await fixture(t);const task=await start(f);
  await f.pool.checkpoint(task.id,{account_id:task.account_id,revision:1,completed:true,summary:'完成'});
  await assert.rejects(f.pool.cancel(task.id),e=>e.status===409);
  assert.equal(f.pool.view().tasks[0].status,'completed');
});

test('OAuth 变量不完整时仍可使用已有凭据文件',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'muse-drive-regression-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const path=join(dir,'fixture.json');await writeFile(path,'{}');
  const drive=new DriveStore({env:{DRIVE_CREDENTIALS_FILE:path,DRIVE_OAUTH_REFRESH_TOKEN:'partial-fixture'},fetcher:async()=>{throw new Error('不应该调用不完整的 OAuth 配置');}});
  drive.auth={getAccessToken:async()=>'fixture-access'};
  assert.equal(await drive.token(),'fixture-access');
});

test('源网盘备份失败时不切号，修复后可重试交接',async t=>{
  const f=await fixture(t);const task=await start(f);
  f.intercept(async(folder,key)=>{if(key.startsWith('checkpoint-'))throw new Error('模拟源目录不可写');});
  const paused=await f.pool.checkpoint(task.id,{account_id:task.account_id,revision:1,paused:true,summary:'进度',next_steps:'下一步'});
  assert.equal(paused.status,'checkpoint_upload_failed');assert.equal(paused.account_id,task.account_id);assert.equal(paused.revision,1);
  assert.ok(![...f.files.keys()].some(key=>key.startsWith('folder-1/handoff-')));
  f.intercept(async()=>{});await f.pool.tick();assert.equal(f.pool.view().tasks[0].account_id,f.accounts[1].id);assert.equal(f.pool.view().tasks[0].revision,2);
});

test('最终结果的磁盘保存失败时不宣布完成',async t=>{
  const f=await fixture(t);const task=await start(f);const blocked=join(f.dataDir,'pool-state.json.tmp');
  f.intercept(async(folder,key)=>{if(key.startsWith('result-'))await mkdir(blocked);});
  await assert.rejects(f.pool.checkpoint(task.id,{account_id:task.account_id,revision:1,completed:true,summary:'全部完成'}));
  assert.equal(f.pool.view().tasks[0].status,'finalizing');
  await rmdir(blocked);f.intercept(async()=>{});await f.pool.tick();assert.equal(f.pool.view().tasks[0].status,'completed');
});

test('并发领取只授予一个执行程序',async t=>{
  const f=await fixture(t);const task=await f.pool.addTask({prompt:'仅执行一次'});await f.pool.tick();const ready=f.pool.view().tasks[0];
  const claims=await Promise.allSettled([f.pool.claim(task.id,{account_id:ready.account_id,revision:1}),f.pool.claim(task.id,{account_id:ready.account_id,revision:1})]);
  assert.equal(claims.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(claims.find(r=>r.status==='rejected').reason.status,409);
});

test('任务幂等键在并发、状态变化和重启后仍返回原任务',async t=>{
  const f=await fixture(t);const data={prompt:'微信只创建一次的任务',request_id:'wechat:fixture-1'};
  const results=await Promise.all([f.pool.addTask(data),f.pool.addTask(data)]);
  assert.equal(results[0].id,results[1].id);assert.equal(f.pool.view().tasks.length,1);
  await f.pool.tick();await f.pool.cancel(results[0].id);
  const repeated=await f.pool.addTask(data);assert.equal(repeated.status,'cancelled');
  const reloaded=await createPool({dataDir:f.dataDir,accounts:()=>f.accounts,drive:{configured:()=>false}});
  assert.equal((await reloaded.addTask(data)).id,repeated.id);assert.equal(reloaded.view().tasks.length,1);
  await assert.rejects(reloaded.addTask({...data,prompt:'同键不同任务'}),e=>e.status===409);
});

test('拒绝非法幂等键，保存失败不会留下未确认的键或任务',async t=>{
  const f=await fixture(t);await assert.rejects(f.pool.addTask({prompt:'任务',request_id:'bad key'}),e=>e.status===400);
  const blocked=join(f.dataDir,'pool-state.json.tmp');await mkdir(blocked);
  await assert.rejects(f.pool.addTask({prompt:'任务',request_id:'wechat:retry'}));assert.equal(f.pool.view().tasks.length,0);
  await rmdir(blocked);const retry=await f.pool.addTask({prompt:'任务',request_id:'wechat:retry'});assert.equal(f.pool.getTask(retry.id).request_id,'wechat:retry');
  assert.throws(()=>f.pool.getTask('000000000000'),e=>e.status===404);
});
