import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, rename, access } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvFile } from 'node:process';
import { probeAccount, launchAccount, proxyOptions, publicError, closeAllBrowsers } from './probe.mjs';
import { createPool } from './pool.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
try { await access(join(ROOT, '.env')); loadEnvFile(join(ROOT, '.env')); } catch (e) {
  if (e.code !== 'ENOENT') throw e;
}
const ID = /^[a-f0-9]{12}$/;
const publicAccount = a => ({
  id: a.id, label: a.label, notes: a.notes || '', enabled: a.enabled,
  proxy_server: a.proxy_server || '', proxy_username_env: a.proxy_username_env || '',
  proxy_password_env: a.proxy_password_env || '',
});
export function quotaView(account, snapshot, { now = Date.now(), intervalMinutes = 30, threshold = 90, busy = false } = {}) {
  const quota = snapshot?.quota || null;
  const lastSuccess = snapshot?.last_success_at || null;
  const stale = !lastSuccess || !Number.isFinite(Date.parse(lastSuccess)) || now - Date.parse(lastSuccess) > intervalMinutes * 120000 || snapshot?.status !== 'success';
  let reason = null;
  if (!account.enabled) reason = '账号已停用';
  else if (busy) reason = '账号正在登录或检测';
  else if (!quota || !Number.isFinite(quota.weekly_used_pct) || quota.weekly_used_pct < 0 || quota.weekly_used_pct > 100 || stale) reason = '额度未知、读取失败或结果已过期';
  else if (quota.weekly_used_pct >= threshold) reason = '周用量已达到暂停阈值';
  return {
    account_id: account.id, quota, stale,
    status: snapshot?.status || 'never_checked',
    checked_at: snapshot?.checked_at || null, last_success_at: lastSuccess,
    error: snapshot?.error || null, eligible_for_new_requests: reason === null, reason,
  };
}
export async function createService(options = {}) {
  const dataDir = resolve(options.dataDir || process.env.DATA_DIR || join(ROOT, 'data'));
  const intervalMinutes = Number(options.intervalMinutes ?? process.env.PROBE_INTERVAL_MINUTES ?? 30);
  const threshold = Number(options.threshold ?? process.env.PAUSE_AT_PERCENT ?? 90);
  if (!Number.isFinite(intervalMinutes) || intervalMinutes < 1 || intervalMinutes > 1440 ||
      !Number.isFinite(threshold) || threshold < 0 || threshold > 100)
    throw new Error('刷新间隔应为 1–1440 分钟，阈值应为 0–100。');
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const statePath = join(dataDir, 'state.json');
  let state;
  try { state = JSON.parse(await readFile(statePath, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') state = { accounts: [], snapshots: {} }; else throw new Error('账号数据文件损坏，请检查备份。'); }
  if (!Array.isArray(state.accounts) || !state.snapshots || state.accounts.some(a => !ID.test(a.id)))
    throw new Error('账号数据格式无效。');
  let saving = Promise.resolve();
  function save(change = () => () => {}) {
    saving = saving.catch(() => {}).then(async () => {
      const rollback = change();
      try {
        const temp = statePath + '.tmp';
        await writeFile(temp, JSON.stringify(state, null, 2), { mode: 0o600 });
        await rename(temp, statePath);
      } catch (error) { rollback(); throw error; }
    });
    return saving;
  }
  if (!state.accounts.length && options.seed !== false) {
    state.accounts.push({ id: randomBytes(6).toString('hex'), label: 'Muse 账号1', enabled: true });
    await save();
  }
  const prober = options.prober || probeAccount;
  const jobs = new Map(), logins = new Map();
  let tail = Promise.resolve(), stopped = false;
  const profile = a => join(dataDir, 'profiles', a.id);
  const pool = await createPool({
    dataDir, drive: options.drive,
    syncHour: Number(process.env.DAILY_SYNC_HOUR ?? 8),
    accounts: () => state.accounts.map(a => {
      const view = quotaView(a, state.snapshots[a.id], { intervalMinutes, threshold, busy: jobs.has(a.id) || logins.has(a.id) });
      return { ...publicAccount(a), ...view, pause_at_percent: threshold, quota_usable: a.enabled && !view.stale };
    }),
  });
  const poolTimer = options.scheduler === false ? null : setInterval(() => {
    void pool.tick().catch(() => console.error('账号池状态保存失败，请检查数据目录。'));
  }, 15000);
  poolTimer?.unref();
  function findAccount(id) {
    if (!ID.test(id)) throw Object.assign(new Error('账号 ID 无效。'), { status: 400 });
    const a = state.accounts.find(x => x.id === id);
    if (!a) throw Object.assign(new Error('账号不存在。'), { status: 404 });
    return a;
  }
  function enqueue(a) {
    if (!a.enabled || jobs.has(a.id) || logins.has(a.id) || stopped || pool.usingProfile(a.id)) return false;
    jobs.set(a.id, 'queued');
    tail = tail.catch(() => {}).then(async () => {
      if (stopped || !a.enabled) { jobs.delete(a.id); return; }
      jobs.set(a.id, 'running');
      let snapshot;
      try {
        const quota = await prober(a, profile(a));
        const checkedAt = new Date().toISOString();
        snapshot = { quota, status: 'success', checked_at: checkedAt, last_success_at: checkedAt, error: null };
      } catch (error) {
        snapshot = {
          ...state.snapshots[a.id], status: 'error', checked_at: new Date().toISOString(), error: publicError(error),
        };
      } finally {
        try {
          if (!stopped) await save(() => {
            const previous = state.snapshots[a.id];
            state.snapshots[a.id] = snapshot;
            return () => { if (previous) state.snapshots[a.id] = previous; else delete state.snapshots[a.id]; };
          });
        }
        catch (error) {
          state.snapshots[a.id] = {
            ...state.snapshots[a.id], status: 'error',
            error: { code: 'STORAGE_ERROR', message: '检测结果未能保存，请检查数据目录权限。' },
          };
          console.error('检测结果保存失败：' + (error.code || 'UNKNOWN'));
        } finally { jobs.delete(a.id); }
      }
    });
    void tail.catch(() => { console.error('无法保存检测结果，请检查数据目录权限。'); });
    return true;
  }
  const timer = options.scheduler === false ? null : setInterval(() => {
    for (const a of state.accounts) enqueue(a);
  }, intervalMinutes * 60000);
  timer?.unref();
  function respond(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(data));
  }
  async function body(req, limit = 16384) {
    if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || ''))
      throw Object.assign(new Error('请发送 JSON 请求。'), { status: 415 });
    const chunks = []; let size = 0;
    for await (const part of req.iterator({ destroyOnReturn: false })) {
      size += part.length;
      if (size > limit) { req.resume(); throw Object.assign(new Error('请求过大。'), { status: 413 }); }
      chunks.push(part);
    }
    const text = Buffer.concat(chunks).toString('utf8');
    try { const value = text ? JSON.parse(text) : {}; if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('bad body'); return value; }
    catch { throw Object.assign(new Error('JSON 无效。'), { status: 400 }); }
  }
  const server = createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(await readFile(join(ROOT, 'public', 'index.html'))); return;
      }
      if (req.method === 'GET' && url.pathname === '/healthz') {
        respond(res, 200, { service: 'muse-quota-probe', status: stopped ? 'stopping' : 'ready' }); return;
      }
      if (!url.pathname.startsWith('/api/')) { respond(res, 404, { error: '路径不存在。' }); return; }
      if (url.pathname.startsWith('/api/pool')) {
        if (req.method === 'GET' && url.pathname === '/api/pool') { respond(res, 200, pool.view()); return; }
        if (req.method !== 'POST') { respond(res, 405, { error: '请求方法不支持。' }); return; }
        const data = await body(req, 262144);
        if (url.pathname === '/api/pool/documents') { respond(res, 201, await pool.addDocument(data)); return; }
        if (url.pathname === '/api/pool/tasks') { respond(res, 201, await pool.addTask(data)); return; }
        if (url.pathname === '/api/pool/sync') { respond(res, 200, await pool.sync()); return; }
        if (url.pathname === '/api/pool/tick') { await pool.tick(); respond(res, 200, pool.view()); return; }
        const folder = url.pathname.match(/^\/api\/pool\/accounts\/([a-f0-9]{12})\/folder$/);
        if (folder) { respond(res, 200, await pool.bind(folder[1], data.folder_id)); return; }
        const operation = url.pathname.match(/^\/api\/pool\/tasks\/([a-f0-9]{12})\/(claim|checkpoint|quota|cancel)$/);
        if (operation) {
          const [, id, action] = operation;
          if (action === 'quota') {
            pool.validateWorker(id, data);
            if (typeof data.weekly_used_pct !== 'number' || !Number.isFinite(data.weekly_used_pct) || data.weekly_used_pct < 0 || data.weekly_used_pct > 100)
              throw Object.assign(new Error('周用量必须是 0–100 的数字。'), { status: 400 });
            await pool.recordQuota(id, data, () => save(() => {
              const previous = state.snapshots[data.account_id], checkedAt = new Date().toISOString();
              state.snapshots[data.account_id] = { quota: { ...(previous?.quota || {}), weekly_used_pct: data.weekly_used_pct, weekly_remaining_pct: Math.round((100-data.weekly_used_pct)*100)/100 }, status: 'success', checked_at: checkedAt, last_success_at: checkedAt, error: null };
              return () => { if (previous) state.snapshots[data.account_id] = previous; else delete state.snapshots[data.account_id]; };
            }));
            respond(res, 200, pool.view()); return;
          }
          respond(res, 200, await pool[action](id, data)); return;
        }
        respond(res, 404, { error: '账号池操作不存在。' }); return;
      }
      if (req.method === 'GET' && ['/api/status', '/api/quotas'].includes(url.pathname)) {
        respond(res, 200, {
          interval_minutes: intervalMinutes, pause_at_percent: threshold,
          login_available: process.env.ALLOW_LOGIN !== '0',
          accounts: state.accounts.map(a => ({
            ...publicAccount(a),
            pool_busy: pool.usingProfile(a.id),
            login_open: logins.has(a.id), job: jobs.get(a.id) || null,
            ...quotaView(a, state.snapshots[a.id], { intervalMinutes, threshold, busy: logins.has(a.id) || jobs.has(a.id) || pool.usingProfile(a.id) }),
          })),
        }); return;
      }
      if (req.method === 'POST' && url.pathname === '/api/accounts') {
        const data = await body(req);
        if (typeof data.label !== 'string' || !data.label.trim() || data.label.length > 80)
          throw Object.assign(new Error('账号名称需要 1–80 个字符。'), { status: 400 });
        if (data.notes !== undefined && (typeof data.notes !== 'string' || data.notes.length > 1000))
          throw Object.assign(new Error('备注最多 1000 个字符。'), { status: 400 });
        const a = { id: randomBytes(6).toString('hex'), label: data.label.trim(), notes: data.notes?.trim() || '', enabled: true };
        for (const key of ['proxy_server', 'proxy_username_env', 'proxy_password_env']) {
          if (data[key] !== undefined && (typeof data[key] !== 'string' || data[key].length > 256))
            throw Object.assign(new Error('代理配置格式无效。'), { status: 400 });
          a[key] = data[key]?.trim() || '';
        }
        try { proxyOptions(a); } catch (e) { throw Object.assign(e, { status: 400 }); }
        await save(() => {
          state.accounts.push(a);
          return () => { state.accounts.splice(state.accounts.indexOf(a), 1); };
        });
        respond(res, 201, publicAccount(a)); return;
      }
      if (req.method === 'POST' && url.pathname === '/api/probe-all') {
        await body(req);
        respond(res, 202, { queued: state.accounts.filter(a => enqueue(a)).length }); return;
      }
      const match = url.pathname.match(/^\/api\/accounts\/([^/]+)(?:\/(probe|login|finish-login))?$/);
      if (!match) { respond(res, 404, { error: '路径不存在。' }); return; }
      const a = findAccount(match[1]), action = match[2];
      if (req.method === 'PATCH' && !action) {
        const data = await body(req);
        if (jobs.has(a.id) || logins.has(a.id) || pool.usingProfile(a.id)) throw Object.assign(new Error('账号正在操作，请稍后修改。'), { status: 409 });
        const keys = Object.keys(data);
        if (!keys.length || keys.some(key => !['enabled', 'label', 'notes'].includes(key)))
          throw Object.assign(new Error('仅支持修改名称、备注和启用状态。'), { status: 400 });
        if ('enabled' in data && typeof data.enabled !== 'boolean')
          throw Object.assign(new Error('enabled 需要布尔值。'), { status: 400 });
        if ('label' in data && (typeof data.label !== 'string' || !data.label.trim() || data.label.length > 80))
          throw Object.assign(new Error('账号名称需要 1–80 个字符。'), { status: 400 });
        if ('notes' in data && (typeof data.notes !== 'string' || data.notes.length > 1000))
          throw Object.assign(new Error('备注最多 1000 个字符。'), { status: 400 });
        await save(() => {
          if (jobs.has(a.id) || logins.has(a.id) || pool.usingProfile(a.id)) throw Object.assign(new Error('账号正在操作，请稍后修改。'), { status: 409 });
          const previous = { ...a };
          if ('enabled' in data) a.enabled = data.enabled;
          if ('label' in data) a.label = data.label.trim();
          if ('notes' in data) a.notes = data.notes.trim();
          return () => {
            for (const key of keys) { if (key in previous) a[key] = previous[key]; else delete a[key]; }
          };
        });
        respond(res, 200, publicAccount(a)); return;
      }
      if (req.method !== 'POST') { respond(res, 405, { error: '请求方法不支持。' }); return; }
      await body(req);
      if (action === 'probe') {
        if (logins.has(a.id)) throw Object.assign(new Error('请先完成登录并关闭登录窗口。'), { status: 409 });
        respond(res, 202, { queued: enqueue(a) }); return;
      }
      if (action === 'login') {
        if (process.env.ALLOW_LOGIN === '0')
          throw Object.assign(new Error('云端请先通过服务器图形会话执行登录命令，详见 README。'), { status: 409 });
        if (!a.enabled || jobs.has(a.id) || logins.has(a.id) || pool.usingProfile(a.id))
          throw Object.assign(new Error('账号已停用或正在操作。'), { status: 409 });
        logins.set(a.id, null);
        try {
          const context = await launchAccount(a, profile(a), false);
          if (stopped) { await context.close(); throw new Error('service stopped'); }
          logins.set(a.id, context);
          context.on('close', () => { logins.delete(a.id); });
          const page = context.pages()[0] || await context.newPage();
          await page.goto('https://muse.ai/', { waitUntil: 'domcontentloaded', timeout: 45000 });
          respond(res, 200, { opened: true }); return;
        } catch (e) {
          await logins.get(a.id)?.close().catch(() => {});
          logins.delete(a.id); respond(res, 400, { error: publicError(e).message }); return;
        }
      }
      if (action === 'finish-login') {
        if (logins.has(a.id) && !logins.get(a.id))
          throw Object.assign(new Error('登录窗口正在启动，请稍后。'), { status: 409 });
        await logins.get(a.id)?.close();
        logins.delete(a.id);
        respond(res, 202, { queued: enqueue(a) }); return;
      }
      respond(res, 404, { error: '操作不存在。' });
    } catch (error) {
      const message = error.status ? error.message : '操作未完成，请检查本机文件权限和服务状态。';
      if (!res.headersSent) respond(res, error.status || 500, { error: message });
      else res.end();
    }
  });
  return {
    server, dataDir, pool,
    async stop() {
      stopped = true; if (timer) clearInterval(timer);
      if (poolTimer) clearInterval(poolTimer);
      await pool.stop();
      await closeAllBrowsers();
      await tail.catch(() => {}); await saving.catch(() => {});
      if (server.listening) await new Promise(resolve => server.close(resolve));
    },
  };
}
async function main() {
  const service = await createService();
  if (process.argv[2] === 'info') {
    const port = Number(process.env.PORT || 8788);
    const host = process.env.HOST || '127.0.0.1';
    const displayHost = host === '0.0.0.0' ? '127.0.0.1' : host;
    console.log(JSON.stringify({url:'http://' + displayHost + ':' + port,data_dir:service.dataDir}));
    await service.stop(); return;
  }
  if (process.argv[2] === 'login') {
    const state = JSON.parse(await readFile(join(service.dataDir, 'state.json'), 'utf8'));
    const a = state.accounts.find(a => a.id === process.argv[3]);
    if (!a) throw new Error('请输入已有的账号 ID。');
    const context = await launchAccount(a, join(service.dataDir, 'profiles', a.id), false);
    const page = context.pages()[0] || await context.newPage();
    await page.goto('https://muse.ai/', { waitUntil: 'domcontentloaded' });
    console.log('请在服务器浏览器中登录。完成后按 Enter 保存并退出。');
    process.stdin.once('data', async () => { await context.close(); await service.stop(); process.exit(0); });
    process.once('SIGINT', async () => { await service.stop(); process.exit(0); });
    return;
  }
  const host = process.env.HOST || '127.0.0.1', port = Number(process.env.PORT || 8788);
  service.server.on('error', async () => { console.error('服务无法启动，请检查端口和监听地址。'); await service.stop(); process.exitCode = 1; });
  service.server.listen(port, host, () => {
    console.log('Muse 额度探针已启动，端口 ' + port + '。');
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await service.stop(); process.exit(0); });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(() => { console.error('启动失败，请检查配置文件、数据目录和浏览器安装。'); process.exitCode = 1; });
