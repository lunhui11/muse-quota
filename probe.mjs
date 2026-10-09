import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';

export class ProbeError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function percentMatch(text, patterns) {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      const number = Number(match[1]);
      return Number.isFinite(number) && number >= 0 && number <= 100 ? number : null;
    }
  }
  return null;
}

export function parseQuota(text) {
  text = String(text).replace(/\r/g, '').replace(/\u00a0/g, ' ');
  const extraIndex = text.search(/Additional tokens|Extra tokens|额外(?:的)?(?:使用)?(?:额度|代币|令牌|词元|Token)|附加(?:额度|代币|令牌)/i);
  const weeklyText = extraIndex < 0 ? text : text.slice(0, extraIndex);
  const extraText = extraIndex < 0 ? '' : text.slice(extraIndex);
  if (!/weekly|每周|周额度|周用量|本周|周限制/i.test(weeklyText))
    throw new ProbeError('PAGE_CHANGED', '没有找到周额度区块，请对照 Muse 设置中的用量页面。');
  let used = percentMatch(weeklyText, [
    /(\d+(?:\.\d+)?)\s*%\s*(?:used|已使用|已用|已消耗)/i,
    /(?:已使用|已用|已消耗|使用了|Used)\s*[:：]?\s*(\d+(?:\.\d+)?)\s*%/i,
  ]);
  if (used === null) {
    const remaining = percentMatch(weeklyText, [
      /(\d+(?:\.\d+)?)\s*%\s*(?:remaining|left|剩余)/i,
      /(?:剩余|remaining)\s*[:：]?\s*(\d+(?:\.\d+)?)\s*%/i,
    ]);
    if (remaining !== null) used = Math.round((100 - remaining) * 100) / 100;
  }
  if (used === null)
    throw new ProbeError('PAGE_CHANGED', '没有读到有效的周用量百分比；本次结果为未知。');
  const plan = text.split('\n').map(x => x.trim()).find(x =>
    /^(?:.{1,35}\s+plan|免费(?:方案|套餐|版)|(?:Power|Maximum)\s*(?:方案|套餐|版)?)$/i.test(x)) || null;
  const reset = weeklyText.match(/Weekly limit resets?\s*(?:on|:)?\s*([^\n]+)/i)
    || weeklyText.match(/(?:每周额度|周额度|周限制)?\s*(?:重置日期|重置时间|重置于|重置日)\s*[:：]?\s*([^\n]+)/)
    || weeklyText.match(/(?:每周(?:限额|额度|限制)|周(?:限额|额度|限制))\s*(?:将在|将于|于)\s*([^\n]+?)\s*重置/);
  const extraUsed = percentMatch(extraText, [
    /(\d+(?:\.\d+)?)\s*%\s*(?:used|已使用|已用)/i,
    /(?:已使用|已用)\s*[:：]?\s*(\d+(?:\.\d+)?)\s*%/,
  ]);
  const extraLeft = extraText.match(/[（(]([^）)\n]*(?:tokens?\s+left|剩余)[^）)\n]*)[）)]/i)
    || extraText.match(/([^\n]{0,50}\btokens?\s+left)/i)
    || extraText.match(/((?:剩余|可用)[^\n]{1,60})/);
  return {
    plan, weekly_used_pct: used,
    weekly_remaining_pct: Math.round((100 - used) * 100) / 100,
    weekly_reset: reset ? reset[1].trim().slice(0, 120) : null,
    extra_used_pct: extraUsed,
    extra_left: extraLeft ? extraLeft[1].trim().slice(0, 120) : null,
    extra_expires: /Never expires|永不过期|从不过期|永久有效/i.test(extraText) ? 'never' : null,
  };
}

export function proxyOptions(account, env = process.env) {
  if (!account.proxy_server) return undefined;
  let url;
  try { url = new URL(account.proxy_server); } catch {
    throw new ProbeError('CONFIGURATION_ERROR', '代理地址格式无效。');
  }
  if (!['http:', 'https:', 'socks5:'].includes(url.protocol) || !url.hostname ||
      url.username || url.password || (url.pathname && url.pathname !== '/') || url.search || url.hash)
    throw new ProbeError('CONFIGURATION_ERROR', '代理需要 http/https/socks5 地址，认证信息请通过环境变量提供。');
  const result = { server: url.protocol + '//' + url.host };
  for (const [field, envField] of [['username', 'proxy_username_env'], ['password', 'proxy_password_env']]) {
    if (account[envField]) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(account[envField]) || !env[account[envField]])
        throw new ProbeError('CONFIGURATION_ERROR', '代理认证环境变量未设置。');
      result[field] = env[account[envField]];
    }
  }
  if (url.protocol === 'socks5:' && (result.username || result.password))
    throw new ProbeError('CONFIGURATION_ERROR', 'Chromium 不支持这里配置的 SOCKS5 认证，请使用 HTTP 认证代理。');
  return result;
}

const activeContexts = new Set();
export async function closeAllBrowsers() {
  await Promise.allSettled([...activeContexts].map(context => context.close()));
}

export async function launchAccount(account, profileDir, headless = true, browserType = chromium) {
  const proxy = proxyOptions(account); // Invalid/unavailable proxy never falls back to direct.
  await mkdir(profileDir, { recursive: true, mode: 0o700 });
  const context = await browserType.launchPersistentContext(profileDir, {
    headless, proxy, timeout: 45000,
    channel: process.env.BROWSER_CHANNEL || (process.platform === 'win32' ? 'chrome' : undefined),
  });
  activeContexts.add(context);
  context.on('close', () => activeContexts.delete(context));
  return context;
}

async function visible(locator) {
  for (const item of await locator.all()) if (await item.isVisible()) return item;
  return null;
}

export async function readQuotaPage(page) {
  await page.goto('https://muse.ai/', { waitUntil: 'domcontentloaded', timeout: 45000 });
  let settings;
  for (let attempt = 0; attempt < 30; attempt++) {
    settings = await visible(page.getByRole('button', { name: /^(Settings|设置)$/i }))
      || await visible(page.locator('button[aria-label*="Settings" i],button[aria-label*="设置"]'));
    if (settings) break;
    const body = await page.locator('body').innerText().catch(() => '');
    if (/accounts\.meta\.com|auth\.meta\.com/i.test(page.url()) ||
        /(?:Log in|Sign in|登录|登入)/i.test(body) && !/Weekly|每周|周额度/i.test(body))
      throw new ProbeError('LOGIN_REQUIRED', '此账号需要登录；请打开登录窗口。');
    await page.waitForTimeout(500);
  }
  if (!settings) throw new ProbeError('PAGE_CHANGED', '未找到设置按钮，登录可能未完成或页面结构已变化。');
  await settings.click();
  const dialogs = page.locator('[role="dialog"],[aria-modal="true"]');
  let dialog = await visible(dialogs);
  if (!dialog) {
    await page.waitForTimeout(400);
    const menuSettings = await visible(page.getByRole('menuitem', { name: /^(Settings|设置)$/i }))
      || await visible(page.getByText(/^(Settings|设置)$/i).last());
    if (!menuSettings) throw new ProbeError('PAGE_CHANGED', '未找到设置菜单。');
    await menuSettings.click();
    await dialogs.first().waitFor({ state: 'visible', timeout: 15000 });
    dialog = await visible(dialogs);
  }
  if (!dialog) throw new ProbeError('PAGE_CHANGED', '未找到设置面板。');
  const general = await visible(dialog.getByRole('tab', { name: /^(General|常规|通用)$/i }))
    || await visible(dialog.getByRole('button', { name: /^(General|常规|通用)$/i }));
  if (general && await general.getAttribute('data-active') !== 'true' && await general.getAttribute('aria-selected') !== 'true')
    await general.click({ timeout: 10000 });
  let lastError;
  for (let attempt = 0; attempt < 24; attempt++) {
    try { return parseQuota(await dialog.innerText()); } catch (error) { lastError = error; }
    if (attempt === 4) {
      const usage = await visible(dialog.getByRole('tab', { name: /^(Usage|用量|使用情况)$/i }))
        || await visible(dialog.getByRole('button', { name: /^(Usage|用量|使用情况)$/i }));
      if (usage) await usage.click();
    }
    await page.waitForTimeout(500);
  }
  throw lastError;
}

export function publicError(error) {
  if (error instanceof ProbeError) return { code: error.code, message: error.message };
  const message = String(error?.message || error);
  if (/proxy|ERR_TUNNEL|ERR_SOCKS|ERR_PROXY/i.test(message))
    return { code: 'PROXY_ERROR', message: '代理连接失败；没有回退直连。' };
  if (/user data directory|ProcessSingleton|profile.*use|SingletonLock/i.test(message))
    return { code: 'ACCOUNT_BUSY', message: '该账号的浏览器配置正在使用，请关闭其登录窗口后再查询。' };
  if (/Executable doesn't exist|browser.*not found/i.test(message))
    return { code: 'BROWSER_MISSING', message: '没有找到浏览器；请安装 Chromium 或设置 BROWSER_CHANNEL=chrome。' };
  if (/Timeout|ERR_|net::|Navigation/i.test(message))
    return { code: 'NETWORK_ERROR', message: '页面加载或网络访问失败，请检查网络和账号访问状态。' };
  return { code: 'PROBE_ERROR', message: '探测未完成；请检查浏览器安装和登录状态。' };
}

export async function probeAccount(account, profileDir, { setupContext } = {}) {
  let context;
  try {
    context = await launchAccount(account, profileDir);
    if (setupContext) await setupContext(context); // Test fixture, never configurable through the HTTP API.
    const page = context.pages()[0] || await context.newPage();
    return await readQuotaPage(page);
  } finally { if (context) await context.close().catch(() => {}); }
}
