import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { GoogleAuth } from 'google-auth-library';

export class DriveStore {
  constructor({ env = process.env, fetcher = fetch } = {}) { this.env = env; this.fetcher = fetcher; }
  credentialFile() { const path=this.env.DRIVE_CREDENTIALS_FILE||this.env.GOOGLE_APPLICATION_CREDENTIALS;return path&&existsSync(path)?path:null; }
  oauthConfigured() { return ['DRIVE_OAUTH_CLIENT_ID','DRIVE_OAUTH_CLIENT_SECRET','DRIVE_OAUTH_REFRESH_TOKEN'].every(k=>this.env[k]); }
  configured() { return this.oauthConfigured()||!!this.credentialFile(); }
  async request(url, options = {}) {
    const response = await this.fetcher(url, { ...options, signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`Google Drive 请求失败（HTTP ${response.status}）；请检查授权、目录权限和网络。`);
    return response;
  }
  async token() {
    if (!this.configured()) throw new Error('请先配置 Google Drive OAuth 授权。');
    if(!this.oauthConfigured()&&this.credentialFile()){
      this.auth ||= new GoogleAuth({keyFilename:this.credentialFile(),scopes:['https://www.googleapis.com/auth/drive']});
      try{const token=await this.auth.getAccessToken();if(!token)throw new Error();return token;}
      catch{throw new Error('Google 凭据未能取得 Drive 访问令牌，请检查授权范围和网络。');}
    }
    if (this.accessToken && Date.now() < this.expiresAt) return this.accessToken;
    const response = await this.request('https://oauth2.googleapis.com/token', {
      method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'},
      body:new URLSearchParams({client_id:this.env.DRIVE_OAUTH_CLIENT_ID,client_secret:this.env.DRIVE_OAUTH_CLIENT_SECRET,refresh_token:this.env.DRIVE_OAUTH_REFRESH_TOKEN,grant_type:'refresh_token'}),
    });
    const result=await response.json();
    if (!result.access_token) throw new Error('Google Drive 授权未返回访问令牌。');
    this.accessToken=result.access_token;this.expiresAt=Date.now()+Math.max(0,(Number(result.expires_in)||3600)-60)*1000;
    return this.accessToken;
  }
  async api(path, options = {}) {
    return this.request('https://www.googleapis.com'+path,{...options,headers:{...options.headers,Authorization:'Bearer '+await this.token()}});
  }
  async checkFolder(id) {
    const r=await this.api('/drive/v3/files/'+encodeURIComponent(id)+'?fields=id,mimeType,capabilities(canAddChildren)&supportsAllDrives=true');
    const folder=await r.json();
    if(folder.mimeType!=='application/vnd.google-apps.folder'||!folder.capabilities?.canAddChildren)throw new Error('该网盘目录不存在或没有写入权限。');
  }
  async get(file) {
    if (!file || typeof file.id !== 'string' || !file.id || !/^[a-f0-9]{64}$/.test(file.sha256 || ''))
      throw new Error('网盘文件引用或校验值无效。');
    const response = await this.api('/drive/v3/files/'+encodeURIComponent(file.id)+'?alt=media&supportsAllDrives=true');
    const chunks=[];let size=0;
    for await (const chunk of response.body) {
      size+=chunk.length;
      if(size>2097152){await response.body.cancel().catch(()=>{});throw new Error('网盘交接文件超过 2 MiB，停止读取。');}
      chunks.push(Buffer.from(chunk));
    }
    const content=Buffer.concat(chunks);
    if(createHash('sha256').update(content).digest('hex')!==file.sha256)
      throw new Error('网盘文件内容已变化或下载不完整，请核对交接版本。');
    try{return JSON.parse(content.toString('utf8'));}
    catch{throw new Error('网盘文件不是有效的 JSON 交接资料。');}
  }
  async put(folder, key, content) {
    await this.checkFolder(folder);
    const hash=createHash('sha256').update(content).digest('hex');
    const q=`'${folder}' in parents and trashed = false and appProperties has { key='muse_pool_key' and value='${key}' }`;
    const list=await this.api('/drive/v3/files?'+new URLSearchParams({q,fields:'files(id)',spaces:'drive',supportsAllDrives:'true',includeItemsFromAllDrives:'true'}));
    const files=(await list.json()).files||[];
    if(files.length>1)throw new Error('网盘中存在重复的交接文件，请先处理重复项。');
    let id=files[0]?.id;
    if(!id){
      const created=await this.api('/drive/v3/files?supportsAllDrives=true',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:key+'.json',parents:[folder],mimeType:'application/json',appProperties:{muse_pool_key:key}})});
      id=(await created.json()).id;
    }
    if(!id)throw new Error('网盘未返回文件 ID。');
    await this.api('/upload/drive/v3/files/'+encodeURIComponent(id)+'?uploadType=media&supportsAllDrives=true',{method:'PATCH',headers:{'Content-Type':'application/json; charset=utf-8'},body:content});
    const downloaded=await this.api('/drive/v3/files/'+encodeURIComponent(id)+'?alt=media&supportsAllDrives=true');
    const actual=createHash('sha256').update(Buffer.from(await downloaded.arrayBuffer())).digest('hex');
    if(actual!==hash)throw new Error('交接文件上传后校验失败，账号尚未切换。');
    return {id,sha256:hash,url:'https://drive.google.com/file/d/'+id+'/view'};
  }
}
