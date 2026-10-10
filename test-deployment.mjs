import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { inspectDeployment, RUNTIME_FILES } from './deployment.mjs';
import { createService } from './server.mjs';

const run=promisify(execFile);
async function fixture(t){
  const root=await mkdtemp(join(tmpdir(),'muse-deployment-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const hashes={};
  for(const name of RUNTIME_FILES){
    await mkdir(dirname(join(root,name)),{recursive:true});
    const content='fixture '+name+'\n';
    await writeFile(join(root,name),content);
    hashes[name]=createHash('sha256').update(content).digest('hex');
  }
  return {root,hashes};
}

test('复制部署无 Git 时报告未知版本；私有文件不参与指纹或输出',async t=>{
  const {root}=await fixture(t);
  await writeFile(join(root,'.env'),'fixture-secret-before');
  const first=await inspectDeployment(root);
  await writeFile(join(root,'.env'),'fixture-secret-after');
  const second=await inspectDeployment(root);
  assert.equal(first.source_kind,'unversioned_copy');assert.equal(first.source_commit,null);
  assert.match(first.runtime_sha256,/^[a-f0-9]{64}$/);
  assert.equal(first.runtime_sha256,second.runtime_sha256);
  assert.doesNotMatch(JSON.stringify(second),/fixture-secret/);
});

test('源码包清单校验通过才采用声明版本；修改代码后不误报旧版本',async t=>{
  const {root,hashes}=await fixture(t),commit='a'.repeat(40);
  await writeFile(join(root,'HANDOFF-MANIFEST.json'),JSON.stringify({format:1,contains:'source_only',source_commit:commit,source_modified:false,files:{...hashes,'../private-key':'ignored'}}));
  const original=await inspectDeployment(root);
  assert.equal(original.source_kind,'source_bundle');assert.equal(original.source_commit,commit);
  assert.equal(original.manifest_runtime_verified,true);assert.equal(original.runtime_modified,false);
  await writeFile(join(root,'server.mjs'),'changed runtime');
  const changed=await inspectDeployment(root);
  assert.equal(changed.source_kind,'unversioned_copy');assert.equal(changed.source_commit,null);
  assert.equal(changed.bundle_declared_commit,commit);assert.equal(changed.manifest_runtime_verified,false);
  assert.notEqual(changed.runtime_sha256,original.runtime_sha256);
});

test('父目录有 Git 不把子目录中的复制部署当作 Git 检出',async t=>{
  const {root}=await fixture(t);await run('git',['init',root]);
  const child=join(root,'copied-service');await mkdir(child);
  for(const name of RUNTIME_FILES){await mkdir(dirname(join(child,name)),{recursive:true});await writeFile(join(child,name),await readFile(join(root,name)));}
  assert.equal((await inspectDeployment(child)).source_kind,'unversioned_copy');
});

test('真正的 Git 部署报告提交与运行源码修改状态',async t=>{
  const {root}=await fixture(t);await run('git',['init',root]);await run('git',['-C',root,'add','.']);
  await run('git',['-C',root,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','fixture']);
  const original=await inspectDeployment(root);
  assert.equal(original.source_kind,'git_checkout');assert.match(original.source_commit,/^[a-f0-9]{40,64}$/);
  assert.equal(original.runtime_modified,false);
  await writeFile(join(root,'pool.mjs'),'modified pool');
  assert.equal((await inspectDeployment(root)).runtime_modified,true);
});

test('符号链接源码或损坏清单不作为已验证版本',async t=>{
  const {root}=await fixture(t);
  await rm(join(root,'server.mjs'));await symlink(join(root,'.env'),join(root,'server.mjs'));
  await writeFile(join(root,'.env'),'fixture-private-file');
  await writeFile(join(root,'HANDOFF-MANIFEST.json'),'{broken');
  const report=await inspectDeployment(root);
  assert.equal(report.runtime_files_complete,false);assert.equal(report.runtime_sha256,null);
  assert.equal(report.manifest_runtime_verified,null);assert.equal(report.source_commit,null);
});

test('运行实例版本 API 返回真实根目录，并保持执行器关闭',async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'muse-deployment-api-'));
  const service=await createService({dataDir,seed:false,scheduler:false,drive:{configured:()=>false}});
  t.after(async()=>{await service.stop();await rm(dataDir,{recursive:true,force:true});});
  await new Promise(r=>service.server.listen(0,'127.0.0.1',r));
  const base='http://127.0.0.1:'+service.server.address().port;
  const info=await(await fetch(base+'/api/deployment')).json();
  assert.equal(info.service_root,resolve(dirname(fileURLToPath(import.meta.url))));
  assert.equal(info.process_id,process.pid);assert.equal(info.executor_enabled,false);
  assert.match(info.runtime_sha256,/^[a-f0-9]{64}$/);
  const repeated=await(await fetch(base+'/api/deployment')).json();assert.deepEqual(repeated,info);
  assert.deepEqual((await(await fetch(base+'/api/pool')).json()).tasks,[]);
});
