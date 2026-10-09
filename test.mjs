import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, rmdir } from 'node:fs/promises';
import { join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { parseQuota, proxyOptions, launchAccount, probeAccount, ProbeError } from './probe.mjs';
import { createService, quotaView } from './server.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const workDir = resolve(process.env.TEST_WORK_DIR || join(root, 'work'));
await mkdir(workDir, { recursive: true });
const temporary = await mkdtemp(join(workDir, 'muse-test-'));
let browser, service, releaseProbe;
const english = pct => 'Free plan\nWeekly limit resets on Oct 12\n' + pct + '% used\nAdditional tokens\n0% used (2B tokens left)\nNever expires';
const chinese = '免费方案\n每周额度\n重置日期：10月12日\n已使用 73.5%\n额外额度\n已使用 0%\n剩余 2B 代币\n永不过期';
try {
  for (const pct of [0, 1, 12.5, 90, 100]) {
    const q = parseQuota(english(pct));
    assert.equal(q.weekly_used_pct, pct);
    assert.equal(q.weekly_remaining_pct, 100-pct);
    assert.equal(q.weekly_reset, 'Oct 12');
    assert.equal(q.extra_left, '2B tokens left');
  }
  assert.equal(parseQuota(chinese).weekly_used_pct, 73.5);
  assert.equal(parseQuota(chinese).weekly_reset, '10月12日');
  const actualChinese='免费版\n每周限额将在 10月10日重置\n已使用 100%\n额外的使用额度\n从不过期\n已使用 0%（剩余 29\u00a0亿个词元）';
  const actualQuota=parseQuota(actualChinese);
  assert.equal(actualQuota.weekly_used_pct,100);
  assert.equal(actualQuota.weekly_reset,'10月10日');
  assert.equal(actualQuota.extra_left,'剩余 29 亿个词元');
  assert.equal(actualQuota.extra_used_pct,0);
  assert.equal(actualQuota.extra_expires,'never');
  assert.equal(parseQuota('每周限额将在 10月10日重置\n已使用 25%').extra_left,null);
  assert.equal(parseQuota('Weekly usage\n87.5% remaining').weekly_used_pct, 12.5);
  assert.equal(parseQuota('Storage\n80% used\n'+english(25)).weekly_used_pct,25);
  assert.equal(parseQuota('存储空间\n已使用 80%\n'+chinese).weekly_used_pct,73.5);
  assert.equal(parseQuota('Storage\n20% remaining\nWeekly usage\n75% remaining').weekly_used_pct,25);
  assert.equal(parseQuota('Weekly limit\n25% used\nStorage\n80% used').weekly_used_pct,25);
  assert.equal(parseQuota('每周额度\n已使用 25%\n每月额度\n已使用 80%').weekly_used_pct,25);
  assert.throws(()=>parseQuota('Storage\n80% used\nWeekly limit\n暂无数据'),e=>e.code==='PAGE_CHANGED');
  assert.throws(()=>parseQuota('Weekly limit\n暂无数据\nStorage\n80% used'),e=>e.code==='PAGE_CHANGED');
  assert.throws(()=>parseQuota('Weekly limit\n暂无数据\nDaily limit\n80% used'),e=>e.code==='PAGE_CHANGED');
  assert.throws(()=>parseQuota('Weekly limit\n暂无数据 Additional tokens 80% used'),e=>e.code==='PAGE_CHANGED');
  for (const text of ['Free plan\nAdditional tokens\n0% used', 'Weekly limit\n101% used', 'Monthly limit\n25% used', '每周额度\n暂无数据','Weekly limit\n-1% used','Weekly limit\n1,000% used','Weekly limit\n100.5% used'])
    assert.throws(() => parseQuota(text), e => e.code === 'PAGE_CHANGED');
  assert.equal(proxyOptions({proxy_server:'socks5://localhost:1080'}).server, 'socks5://localhost:1080');
  assert.throws(() => proxyOptions({proxy_server:'http://secret:secret@localhost:8080'}), e => e.code === 'CONFIGURATION_ERROR');
  assert.throws(() => proxyOptions({proxy_server:'http://localhost:8080',proxy_password_env:'ABSENT'}, {}), e => e.code === 'CONFIGURATION_ERROR');
  let launchCount=0;
  await assert.rejects(() => launchAccount({proxy_server:'http://127.0.0.1:1'},join(temporary,'proxy'),true,{
    async launchPersistentContext(_,options){launchCount++;assert.equal(options.proxy.server,'http://127.0.0.1:1');throw new Error('proxy failed');}
  }));
  assert.equal(launchCount,1);
  const a={id:'aaaaaaaaaaaa',enabled:true}, now=Date.now();
  const snap={status:'success',last_success_at:new Date(now).toISOString(),quota:parseQuota(english(12.5))};
  assert.equal(quotaView(a,snap,{now}).eligible_for_new_requests,true);
  assert.equal(quotaView(a,{...snap,status:'error'},{now}).eligible_for_new_requests,false);
  assert.equal(quotaView(a,snap,{now:now+61*60000}).stale,true);
  assert.equal(quotaView(a,{...snap,last_success_at:'invalid'},{now}).stale,true);
  assert.equal(quotaView(a,{...snap,quota:parseQuota(english(90))},{now}).eligible_for_new_requests,false);
  console.log('PASS 解析、过期状态、阈值和代理校验');

  // Two real persistent browser contexts, with a fully intercepted fixture.
  for (const [id,pct] of [['aaaaaaaaaaaa',12.5],['bbbbbbbbbbbb',73.5]]) {
    const profile = join(temporary,'profiles',id);
    const context=await launchAccount({id},profile);
    assert.equal((await context.cookies('https://muse.ai')).length,0);
    await context.addCookies([{name:'fixture_account',value:id,domain:'muse.ai',path:'/',expires:Math.floor(Date.now()/1000)+3600}]);
    await context.close();
    const result=await probeAccount({id},profile,{setupContext:async context=>{
      const cookies=await context.cookies('https://muse.ai');
      assert.equal(cookies.find(c=>c.name==='fixture_account')?.value,id);
      await context.route('**/*',route=>route.fulfill({contentType:'text/html',body:
        '<button aria-label="Settings" onclick="document.querySelector(\'[role=dialog]\').style.display=\'block\'">Settings</button>'+
        '<div role="dialog" style="display:none;white-space:pre-line">General\nUsage\n'+english(pct)+'</div>'
      }));
    }});
    assert.equal(result.weekly_used_pct,pct);
  }
  console.log('PASS 两个真实浏览器配置的 Cookie 隔离及页面探测（模拟用量页面）');

  let active=0,maxActive=0,fail=false,calls=0;
  const initialProbeGate=new Promise(resolve=>{releaseProbe=resolve;});
  service=await createService({dataDir:join(temporary,'service'),seed:false,scheduler:false,prober:async(account,profile)=>{
    active++;calls++;maxActive=Math.max(active,maxActive);
    await initialProbeGate;
    assert.equal(basename(profile),account.id);
    await new Promise(r=>setTimeout(r,80));
    active--;
    if(fail)throw new ProbeError('NETWORK_ERROR','测试网络失败');
    return parseQuota(english(account.label==='账号 A'?12.5:73.5));
  }});
  await new Promise(r=>service.server.listen(0,'127.0.0.1',r));
  const base='http://127.0.0.1:'+service.server.address().port;
  async function api(path,method='GET',body){
    const response=await fetch(base+'/api/'+path,{method,headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
    return {status:response.status,data:await response.json()};
  }
  assert.equal((await fetch(base+'/api/status')).status,200);
  assert.equal((await fetch(base+'/api/quotas')).status,200);
  await assert.rejects(readFile(join(service.dataDir,'admin-token.txt')),e=>e.code==='ENOENT');
  assert.equal((await api('accounts','POST',null)).status,400);
  assert.equal((await api('accounts','POST',{label:'坏代理',proxy_server:'http://u:p@host:9'})).status,400);
  const accountA=(await api('accounts','POST',{label:'账号 A'})).data;
  const accountB=(await api('accounts','POST',{label:'账号 B'})).data;
  assert.notEqual(accountA.id,accountB.id);
  // Force an actual filesystem write failure, then verify rollback and recovery.
  const blockedFile=join(service.dataDir,'state.json.tmp');
  await mkdir(blockedFile);
  assert.equal((await api('accounts','POST',{label:'不能保存的账号'})).status,500);
  assert.equal((await api('accounts/'+accountA.id,'PATCH',{label:'不能保存的名称',notes:'不能保存的备注'})).status,500);
  let unchanged=(await api('status')).data.accounts;
  assert.equal(unchanged.length,2);
  assert.equal(unchanged.find(a=>a.id===accountA.id).label,'账号 A');
  assert.equal(unchanged.find(a=>a.id===accountA.id).notes,'');
  await rmdir(blockedFile); // Exact temporary directory owned by this test.
  const splitNotes='分段中文🙂';
  const payload=Buffer.from(JSON.stringify({notes:splitNotes}));
  const splitAt=payload.indexOf(Buffer.from('分'))+1;
  const splitResult=await new Promise((resolve,reject)=>{
    const req=request(base+'/api/accounts/'+accountA.id,{method:'PATCH',headers:{'Content-Type':'application/json'}},res=>{
      const parts=[];res.on('data',part=>parts.push(part));res.on('end',()=>resolve({status:res.statusCode,data:JSON.parse(Buffer.concat(parts).toString())}));
    });
    req.on('error',reject);req.write(payload.subarray(0,splitAt));setTimeout(()=>req.end(payload.subarray(splitAt)),30);
  });
  assert.equal(splitResult.status,200);assert.equal(splitResult.data.notes,splitNotes);
  assert.equal((await api('accounts','POST',{label:'x',notes:'x'.repeat(17000)})).status,413);
  assert.equal((await api('probe-all','POST',{})).data.queued,2);
  assert.equal((await api('accounts/'+accountA.id+'/probe','POST',{})).data.queued,false);
  assert.equal((await api('accounts/'+accountA.id,'PATCH',{enabled:false})).status,409);
  assert.equal((await api('accounts/'+accountA.id+'/login','POST',{})).status,409);
  releaseProbe();
  async function waitComplete(){
    for(let i=0;i<60;i++){
      const list=(await api('status')).data.accounts;
      if(list.every(a=>!a.job))return list;
      await new Promise(r=>setTimeout(r,50));
    }
    throw new Error('queue did not complete');
  }
  let list=await waitComplete();
  assert.equal(maxActive,1);assert.equal(calls,2);
  assert.equal(list.find(a=>a.id===accountA.id).quota.weekly_used_pct,12.5);
  assert.equal(list.find(a=>a.id===accountB.id).quota.weekly_used_pct,73.5);
  assert.ok([400,404].includes((await api('accounts/%2e%2e/probe','POST',{})).status));

  browser=await chromium.launch({channel:process.env.BROWSER_CHANNEL || (process.platform==='win32'?'chrome':undefined),headless:true});
  const page=await browser.newPage({viewport:{width:1280,height:900}});
  const pageErrors=[];page.on('pageerror',e=>pageErrors.push(e.message));
  const apiAuthorizations=[];
  page.on('request',req=>{if(new URL(req.url()).pathname.startsWith('/api/'))apiAuthorizations.push(req.headers().authorization);});
  await page.goto(base);
  await page.getByRole('heading',{name:'账号 A',exact:true}).waitFor();
  assert.equal(await page.getByLabel('访问密钥').count(),0);
  assert.equal(await page.getByRole('button',{name:'退出面板',exact:true}).count(),0);
  const card=page.locator('.card').filter({has:page.getByRole('heading',{name:'账号 A',exact:true})});
  await card.getByRole('button',{name:'编辑',exact:true}).click();
  await page.getByLabel('账号名称',{exact:true}).last().fill('日常任务 A');
  await page.getByLabel('备注（可选）',{exact:true}).last().fill('已绑定网盘\n<script>window.injected=true</script>');
  await page.getByRole('button',{name:'保存',exact:true}).click();
  await page.getByRole('heading',{name:'日常任务 A',exact:true}).waitFor();
  assert.equal(await page.locator('.notes').first().textContent(),'已绑定网盘\n<script>window.injected=true</script>');
  assert.equal(await page.evaluate(()=>window.injected),undefined);
  const edited=(await api('status')).data.accounts.find(a=>a.id===accountA.id);
  assert.equal(edited.label,'日常任务 A');assert.equal(edited.enabled,true);assert.equal(edited.quota.weekly_used_pct,12.5);
  assert.equal((await api('accounts/'+accountA.id,'PATCH',{label:'不应保存',notes:'x'.repeat(1001)})).status,400);
  assert.equal((await api('accounts/'+accountA.id,'PATCH',{label:'   '})).status,400);
  assert.equal((await api('accounts/'+accountA.id,'PATCH',{proxy_server:'http://localhost:8'})).status,400);
  assert.equal((await api('status')).data.accounts.find(a=>a.id===accountA.id).label,'日常任务 A');
  await page.screenshot({path:join(workDir,'muse-dashboard-test.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:join(workDir,'muse-dashboard-mobile-test.png'),fullPage:true});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  assert.deepEqual(pageErrors,[]);
  // Hold an old response until a newer refresh has rendered; no timing assumptions.
  for (const oldStatus of [200,401,500]) {
    let releaseOld,oldSeen;
    const oldGate=new Promise(resolve=>{releaseOld=resolve;});
    const oldStarted=new Promise(resolve=>{oldSeen=resolve;});
    let statusRequests=0;
    await page.route('**/api/status',async route=>{
      const isOld=++statusRequests===1;
      const response=await route.fetch();
      const json=await response.json();
      if(isOld){oldSeen();await oldGate;}
      if(isOld&&oldStatus!==200){await route.fulfill({status:oldStatus,json:{error:'旧请求失败'}});return;}
      json.accounts.find(a=>a.id===accountA.id).label=isOld?'旧状态':'新状态';
      await route.fulfill({response,json});
    });
    const oldUpdate=page.evaluate(()=>update().catch(()=>{}));
    await oldStarted;
    try {
      await page.evaluate(()=>update());
      assert.equal(await page.locator('#cards h2').first().textContent(),'新状态');
    } finally {releaseOld();await oldUpdate;}
    assert.equal(await page.locator('#cards h2').first().textContent(),'新状态');
    assert.equal(await page.locator('#dashboard').isVisible(),true);
    assert.equal(await page.evaluate(()=>accounts[0].label),'新状态');
    await page.unroute('**/api/status');
  }
  await page.evaluate(()=>update());
  console.log('PASS 并发刷新乱序响应及旧请求失败不会覆盖新状态');
  await page.reload();
  await page.getByRole('heading',{name:'日常任务 A',exact:true}).waitFor();
  assert.equal(await page.locator('#dashboard').isVisible(),true);
  assert.ok(apiAuthorizations.length>0);
  assert.ok(apiAuthorizations.every(value=>value===undefined));
  assert.deepEqual(pageErrors,[]);
  await browser.close();browser=null;

  fail=true;
  await api('accounts/'+accountA.id+'/probe','POST',{});
  list=await waitComplete();
  const failed=list.find(a=>a.id===accountA.id);
  assert.equal(failed.quota.weekly_used_pct,12.5);
  assert.equal(failed.status,'error');assert.equal(failed.stale,true);
  assert.equal(failed.eligible_for_new_requests,false);
  assert.equal((await api('accounts/'+accountB.id,'PATCH',{enabled:false})).status,200);
  assert.equal((await api('probe-all','POST',{})).data.queued,1);
  await waitComplete();
  const disk=JSON.parse(await readFile(join(temporary,'service','state.json'),'utf8'));
  assert.equal(disk.snapshots[accountA.id].quota.weekly_used_pct,12.5);
  assert.equal(disk.accounts.find(a=>a.id===accountA.id).label,'日常任务 A');
  assert.equal(disk.accounts.find(a=>a.id===accountA.id).notes,'已绑定网盘\n<script>window.injected=true</script>');
  console.log('PASS HTTP 无密钥访问、保存失败回滚、分段中文请求、名称备注编辑与持久化、页面自动加载与重载、账号输入、登录检测互斥、串行队列、重复检测、失败缓存和桌面/手机页面');
  console.log('以上为本地模拟验证；未登录真实 Muse 账号，不代表真实账号或 Docker 已验证。');
} finally {
  releaseProbe?.();
  if(browser)await browser.close();
  if(service)await service.stop();
  if(dirname(temporary)===workDir && basename(temporary).startsWith('muse-test-'))
    await rm(temporary,{recursive:true,force:true});
}
