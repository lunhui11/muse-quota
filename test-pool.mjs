import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createService } from './server.mjs';
import { createPool } from './pool.mjs';
import { DriveStore } from './drive.mjs';
import { chromium } from 'playwright';

const temporary=await mkdtemp('/tmp/muse-pool-test-');
const uploads=new Map();let failFolder=null;let writes=0;
const drive={configured:()=>true,checkFolder:async()=>{},put:async(folder,key,content)=>{
  if(folder===failFolder)throw new Error('模拟网盘上传失败');
  writes++;uploads.set(folder+'/'+key,content);return {id:folder+'-'+key,sha256:'fixture',url:'https://drive.google.com/file/d/fixture/view'};
}};
let service,browser;
try {
  service=await createService({dataDir:temporary,seed:false,scheduler:false,drive,prober:async()=>({weekly_used_pct:10,weekly_remaining_pct:90})});
  await new Promise(r=>service.server.listen(0,'127.0.0.1',r));
  let base='http://127.0.0.1:'+service.server.address().port;
  async function api(path,data,method=data===undefined?'GET':'POST'){
    const r=await fetch(base+'/api/'+path,{method,headers:{'Content-Type':'application/json'},body:data===undefined?undefined:JSON.stringify(data)});return {status:r.status,data:await r.json()};
  }
  const ids=[];
  for(const label of ['账号1','账号2','账号3'])ids.push((await api('accounts',{label})).data.id);
  for(const [i,id] of ids.entries())assert.equal((await api('pool/accounts/'+id+'/folder',{folder_id:'folder'+(i+1)})).status,200);
  assert.equal((await api('pool/accounts/'+ids[0]+'/folder',{folder_id:"bad'id"})).status,400);
  await api('probe-all',{});
  for(let n=0;n<100;n++){const s=(await api('status')).data;if(s.accounts.every(a=>!a.job))break;await new Promise(r=>setTimeout(r,10));}
  assert.ok((await api('status')).data.accounts.every(a=>a.eligible_for_new_requests));
  assert.equal((await api('pool/documents',{title:'今日资料',content:'今天新增的信息🙂'})).status,201);
  assert.equal((await api('pool/sync',{})).status,200);
  assert.equal(uploads.size,3);
  let t=(await api('pool/tasks',{prompt:'分析资料并生成报告'})).data;
  await api('pool/tick',{});t=(await api('pool')).data.tasks[0];
  assert.equal(t.status,'ready');assert.equal(t.account_id,ids[0]);assert.equal(t.bundle.documents.length,1);
  const worker={account_id:ids[0],revision:t.revision};
  assert.equal((await api('pool/tasks/'+t.id+'/claim',worker)).status,200);
  assert.equal((await api('pool/tasks/'+t.id+'/claim',worker)).status,409);
  assert.equal((await api('accounts/'+ids[0]+'/probe',{})).data.queued,false);
  assert.equal((await api('pool/tasks/'+t.id+'/cancel',{})).status,409);
  assert.equal((await api('pool/tasks/'+t.id+'/quota',{...worker,weekly_used_pct:101})).status,400);
  await api('pool/tasks/'+t.id+'/quota',{...worker,weekly_used_pct:92});
  t=(await api('pool')).data.tasks[0];assert.equal(t.status,'pause_requested');assert.equal(t.account_id,ids[0]);
  assert.equal((await api('pool/tasks/'+t.id+'/checkpoint',{...worker,summary:'完成第一章',next_steps:'继续第二章'})).status,400);
  failFolder='folder2';
  t=(await api('pool/tasks/'+t.id+'/checkpoint',{...worker,paused:true,summary:'第一章已完成，文件已保存',next_steps:'继续第二章，不要重做第一章',artifacts:[{name:'chapter-1.md',content:'第一章正文'}]})).data;
  assert.equal(t.status,'upload_failed');assert.equal(t.account_id,ids[0]);assert.equal(t.revision,1);
  assert.equal((await api('pool/tasks/'+t.id+'/claim',{account_id:ids[1],revision:2})).status,409);
  failFolder=null;await api('pool/tick',{});t=(await api('pool')).data.tasks[0];
  assert.equal(t.status,'ready');assert.equal(t.account_id,ids[1]);assert.equal(t.revision,2);
  const handoff=JSON.parse(uploads.get('folder2/handoff-'+t.id+'-2'));
  assert.equal(handoff.checkpoint.artifacts[0].content,'第一章正文');assert.equal(handoff.checkpoint.summary,'第一章已完成，文件已保存');assert.match(handoff.checkpoint.next_steps,/不要重做/);
  assert.equal(uploads.get('folder1/handoff-'+t.id+'-2'),uploads.get('folder2/handoff-'+t.id+'-2'));
  assert.equal((await api('pool/tasks/'+t.id+'/checkpoint',{...worker,paused:true,summary:'迟到的旧状态',next_steps:'错误的续做'})).status,409);
  assert.equal((await api('pool/tasks/'+t.id+'/quota',{...worker,weekly_used_pct:0})).status,409);
  const worker2={account_id:ids[1],revision:2};
  assert.equal((await api('pool/tasks/'+t.id+'/claim',worker2)).status,200);
  await service.stop();
  service=await createService({dataDir:temporary,seed:false,scheduler:false,drive});
  await new Promise(r=>service.server.listen(0,'127.0.0.1',r));base='http://127.0.0.1:'+service.server.address().port;
  t=(await api('pool')).data.tasks[0];assert.equal(t.status,'pause_requested');assert.equal(t.account_id,ids[1]);
  assert.equal((await api('pool/tasks/'+t.id+'/claim',worker2)).status,409);
  t=(await api('pool/tasks/'+t.id+'/checkpoint',{...worker2,paused:true,summary:'第二章完成',next_steps:'继续第三章'})).data;
  assert.equal(t.account_id,ids[2]);assert.equal(t.revision,3);
  const worker3={account_id:ids[2],revision:3};await api('pool/tasks/'+t.id+'/claim',worker3);
  t=(await api('pool/tasks/'+t.id+'/checkpoint',{...worker3,completed:true,summary:'全部完成'})).data;
  assert.equal(t.status,'completed');
  assert.ok(uploads.has('folder3/result-'+t.id));
  assert.equal(JSON.parse(await readFile(join(temporary,'pool-state.json'),'utf8')).tasks[0].status,'completed');
  assert.equal((await api('status')).data.accounts.find(a=>a.id===ids[2]).pool_busy,false);
  browser=await chromium.launch({headless:true});
  const page=await browser.newPage();const pageErrors=[];page.on('pageerror',e=>pageErrors.push(e.message));
  await page.goto(base);
  await page.getByRole('heading',{name:'任务账号池',exact:true}).waitFor();
  await page.waitForFunction(()=>!!poolState);
  const third=page.locator('.card').filter({has:page.getByRole('heading',{name:'账号3',exact:true})});
  await third.getByRole('button',{name:'编辑',exact:true}).click();
  await page.getByLabel('Google Drive 目录 ID 或链接').fill('https://drive.google.com/drive/folders/folder-ui');
  await page.getByRole('button',{name:'保存',exact:true}).click();
  await page.waitForFunction(()=>poolState.folders[accounts[2].id]==='folder-ui');
  await page.getByText('添加每日同步资料',{exact:true}).click();
  await page.getByLabel('资料标题',{exact:true}).fill('面板资料');
  await page.getByLabel('资料内容',{exact:true}).fill('面板添加的每日资料');
  await page.getByRole('button',{name:'保存资料',exact:true}).click();
  await page.waitForFunction(()=>poolState.documents.length===2);
  await page.getByText('添加任务',{exact:true}).click();
  await page.getByLabel('任务说明',{exact:true}).fill('面板添加的任务');
  await page.getByRole('button',{name:'加入账号池',exact:true}).click();
  await page.waitForFunction(()=>poolState.tasks.length===2&&poolState.tasks[1].status==='ready');
  await page.getByRole('button',{name:'取消任务',exact:true}).click();
  await page.waitForFunction(()=>poolState.tasks[1].status==='cancelled');
  await page.setViewportSize({width:390,height:844});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  assert.deepEqual(pageErrors,[]);await browser.close();browser=null;
  console.log('PASS 账号池面板：目录绑定、资料保存、任务创建和取消、手机布局');
  console.log('PASS 账号1→账号2→账号3交接、资料复制、阈值暂停、上传失败不切号、旧版本拒绝、重启恢复及任务完成');
  await service.stop();service=null;

  const dailyDir=await mkdtemp(join(temporary,'daily-'));
  let clock=new Date('2026-10-09T00:00:00Z');
  const a={id:'aaaaaaaaaaaa',enabled:true,eligible_for_new_requests:true,quota_usable:true,quota:{weekly_used_pct:10},pause_at_percent:90};
  const pool=await createPool({dataDir:dailyDir,accounts:()=>[{...a}],drive,now:()=>clock});
  await pool.bind(a.id,'daily-folder');await pool.addDocument({title:'日报',content:'新内容'});
  const before=writes;await pool.tick();const once=writes;assert.ok(once>before);await pool.tick();assert.equal(writes,once);
  clock=new Date('2026-10-10T00:00:00Z');await pool.tick();assert.ok(writes>once);assert.equal(pool.view().last_sync_date,'2026-10-10');
  a.quota_usable=false;a.eligible_for_new_requests=false;
  const waiting=await pool.addTask({prompt:'等待账号'});await pool.tick();assert.equal(pool.view().tasks.find(t=>t.id===waiting.id).status,'waiting_account');
  console.log('PASS 北京时间每日同步、同日不重复、过期额度不分配');
  const missingDir=await mkdtemp(join(temporary,'missing-'));
  a.quota_usable=true;a.eligible_for_new_requests=true;
  const missing=await createPool({dataDir:missingDir,accounts:()=>[{...a}],drive:new DriveStore({env:{}})});
  await missing.bind(a.id,'folder-missing');await missing.addTask({prompt:'等待授权'});await missing.tick();
  assert.equal(missing.view().tasks[0].status,'waiting_drive');
  await missing.addDocument({title:'资料',content:'内容'});await assert.rejects(missing.sync(),/OAuth/);
  console.log('PASS 缺少网盘授权时等待并显示错误，不伪造上传或执行成功');

  // Exercise the actual Google Drive transport with intercepted HTTP responses.
  const stored=new Map();let tokenCalls=0,corrupt=false;
  const transport=new DriveStore({env:{DRIVE_OAUTH_CLIENT_ID:'test-client',DRIVE_OAUTH_CLIENT_SECRET:'test-secret',DRIVE_OAUTH_REFRESH_TOKEN:'test-refresh'},fetcher:async(url,options)=>{
    const u=new URL(url);const json=x=>new Response(JSON.stringify(x),{headers:{'Content-Type':'application/json'}});
    if(u.hostname==='oauth2.googleapis.com'){tokenCalls++;return json({access_token:'test-access',expires_in:3600});}
    assert.equal(options.headers.Authorization,'Bearer test-access');
    if(u.pathname==='/drive/v3/files/folder123')return json({mimeType:'application/vnd.google-apps.folder',capabilities:{canAddChildren:true}});
    if(u.pathname==='/drive/v3/files'&&options.method==='POST'){stored.set('file123','');return json({id:'file123'});}
    if(u.pathname==='/drive/v3/files')return json({files:stored.has('file123')?[{id:'file123'}]:[]});
    if(u.pathname==='/upload/drive/v3/files/file123'){stored.set('file123',options.body);return json({id:'file123'});}
    if(u.searchParams.get('alt')==='media')return new Response(corrupt?'corrupted':stored.get('file123'));
    throw new Error('Unexpected fixture request');
  }});
  const file=await transport.put('folder123','handoff-test','{"summary":"进度"}');assert.ok(file.sha256);assert.equal(tokenCalls,1);
  await transport.put('folder123','handoff-test','{"summary":"下一步"}');assert.equal(stored.size,1);assert.equal(tokenCalls,1);
  corrupt=true;await assert.rejects(transport.put('folder123','handoff-test','{}'),/校验失败/);
  console.log('PASS Google Drive 令牌刷新、幂等文件更新、上传后下载校验（模拟 Google HTTP）');
} finally {if(browser)await browser.close();if(service)await service.stop();await rm(temporary,{recursive:true,force:true});}
