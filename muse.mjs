import { launchAccount, readQuotaPage, publicError } from './probe.mjs';

// Muse's rendered UI hooks, documented by https://github.com/fierzone/MUSE_MCP.
// No captured sessions or authentication data are used by this adapter.
export const MUSE_SELECTORS = {
  editor: '[data-hatch-composer-root] textarea,[data-hatch-composer-root] [contenteditable="true"],[data-hatch-composer-prehydration-input]',
  assistant: '[data-message-item][data-message-role="assistant"]',
  user: '[data-message-item][data-message-role="user"]',
  stop: '[data-testid="hatch-composer-stop-button"]',
  error: '[data-testid="assistant-response-error-notice"]',
  approval: '[data-hatch-composer-approval-stack]',
};
const failure=(code,message)=>Object.assign(new Error(message),{code});
async function visible(locator) {
  const result=[];
  for(const element of await locator.all())if(await element.isVisible())result.push(element);
  return result;
}

export function createMuseAdapter({launch=launchAccount,quotaReader=readQuotaPage,headless=true,timeoutMs=300000,readyMs=30000,quietMs=2500,pollMs=300}={}) {
  return {
    async open(account,profileDir) {
      let context;
      try {
        context=await launch(account,profileDir,headless);
        const page=context.pages()[0]||await context.newPage();
        await page.goto('https://muse.ai/',{waitUntil:'domcontentloaded',timeout:45000});
        await page.waitForFunction(selector=>[...document.querySelectorAll(selector)].some(el=>el.getClientRects().length&&getComputedStyle(el).visibility!=='hidden'),MUSE_SELECTORS.editor,{timeout:readyMs});
        if(new URL(page.url()).origin!=='https://muse.ai')throw failure('LOGIN_REQUIRED','此账号需要重新登录 Muse。');
        return {
          async quota() {
            // Use a separate tab; settings navigation must not destroy the conversation.
            const quotaPage=await context.newPage();
            try{return await quotaReader(quotaPage);}finally{await quotaPage.close();}
          },
          async turn(prompt,{onSubmit,onReply,canSubmit=()=>true}={}) {
            const editors=await visible(page.locator(MUSE_SELECTORS.editor));
            if(editors.length!==1)throw failure('PAGE_CHANGED','未找到唯一的 Muse 输入框，请检查网页结构。');
            if((await visible(page.locator(MUSE_SELECTORS.stop))).length)
              throw failure('MUSE_BUSY','Muse 正在执行其他任务，请先在官网确认停工。');
            if((await visible(page.locator(MUSE_SELECTORS.approval))).length)
              throw failure('APPROVAL_REQUIRED','Muse 正等待人工确认，请先在官网处理。');
            if((await visible(page.locator(MUSE_SELECTORS.error))).length)
              throw failure('MUSE_ERROR','Muse 页面显示执行错误，请先在官网检查。');
            const editor=editors[0];
            const draft=await editor.evaluate(el=>'value' in el?el.value:el.innerText);
            if(draft.trim())throw failure('COMPOSER_ERROR','Muse 输入框有未发送的草稿，请先在官网处理，避免覆盖。');
            const marker=prompt.match(/"nonce":"([^"]+)"/)?.[1]||prompt.trim().slice(0,80);
            await editor.fill(prompt,{timeout:10000});
            const filled=await editor.evaluate(el=>'value' in el?el.value:el.innerText);
            if(filled.replace(/\r\n/g,'\n')!==prompt)
              throw failure('COMPOSER_ERROR','Muse 输入框未完整接收任务内容，尚未提交。');
            const discardOwnDraft=async()=>{
              const current=await editor.evaluate(el=>'value' in el?el.value:el.innerText);
              if(current.replace(/\r\n/g,'\n')===prompt)await editor.fill('');
            };
            if(!canSubmit()){await discardOwnDraft();return null;}
            // Persist the possible-send boundary before pressing Enter. Never retry it blindly.
            await onSubmit?.({thread_url:page.url()});
            if(!canSubmit()){await discardOwnDraft();return null;}
            await editor.press('Enter',{timeout:10000});
            const deadline=Date.now()+timeoutMs;
            let last='',stableAt=Date.now();
            while(Date.now()<deadline) {
              if((await visible(page.locator(MUSE_SELECTORS.approval))).length)
                throw failure('APPROVAL_REQUIRED','Muse 等待人工确认；任务已暂停自动续做，请到官网检查。');
              if((await visible(page.locator(MUSE_SELECTORS.error))).length)
                throw failure('MUSE_ERROR','Muse 返回执行错误；请查看官网与最近回复。');
              const messages=await page.locator('[data-message-item]').evaluateAll(elements=>elements.map(el=>({role:el.getAttribute('data-message-role'),text:el.innerText})));
              const sentAt=messages.findLastIndex(item=>item.role==='user'&&item.text.includes(marker));
              const sent=sentAt>=0;
              const text=sent?messages.slice(sentAt+1).filter(item=>item.role==='assistant').map(item=>item.text.trim()).filter(Boolean).join('\n\n'):'';
              if(text.length>1048576)throw failure('MUSE_REPLY_TOO_LARGE','Muse 回复超过 1 MiB，请在官网整理成果后恢复。');
              if(text!==last){last=text;stableAt=Date.now();}
              const busy=(await visible(page.locator(MUSE_SELECTORS.stop))).length>0;
              if(sent&&text&&!busy&&Date.now()-stableAt>=quietMs) {
                await onReply?.({reply:text,thread_url:page.url()});
                return text;
              }
              await page.waitForTimeout(pollMs);
            }
            throw failure('REPLY_TIMEOUT','未能确认 Muse 已完整回复，任务不会自动重发，请检查官网。');
          },
          async close(){await context.close();},
        };
      } catch(e) {
        await context?.close().catch(()=>{});
        if(e.code)throw e;
        throw failure('MUSE_OPEN_FAILED','无法打开 Muse 会话：'+publicError(e).message);
      }
    },
  };
}
