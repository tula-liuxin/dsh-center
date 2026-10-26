import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import { join, dirname } from 'node:path';
import { watchFile, unwatchFile } from 'node:fs';
import { connectHost } from './tunnel.js';
export const name = 'dsh-center-host';
export const inject = ['webServer', 'connection'];
export function apply(ctx) {
  let stop = () => {}, disposed = false, generation = 0;
  const file = process.env.DSH_CENTER_CONFIG || join(homedir(), '.dsh-center', 'host.json');
  ctx.on('dispose', () => { disposed = true; generation++; stop(); unwatchFile(file, onChange); });
  // Do not change Desktop's listener, authentication, storage, or other plugins.
  const start = async () => {
    const current = ++generation;
    stop();
    let config;
    try { config = JSON.parse(await readFile(file, 'utf8')); }
    catch (e) { if (e.code === 'ENOENT') return; throw e; }
    if (disposed || current !== generation) return;
    stop = connectHost(config, async () => {
      const origin = ctx.webServer.getOrigin();
      const r = await fetch(ctx.connection.authenticatedUrl(origin + '/'), {redirect: 'manual'});
      const cookies = r.headers.getSetCookie().map(x => x.split(';')[0]).join('; ');
      if (!cookies) throw new Error('DSH local authentication unavailable');
      return {origin, cookie: cookies};
    }, {onStatus: status => { writeFile(file+'.status',status,{mode:0o600}).catch(()=>{}); }});
  };
  const onChange = () => start().catch(e => console.error('[dsh-center]', e.message));
  ctx.effect(() => ctx.webServer.register({kind:'exact',path:'/center-host/setup',handler:async(req,res)=>{
    if(!ctx.connection.authorizeIndex(req,res))return;
    const reply=(status,b)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(b));};
    if(req.method==='GET'){
      let c={},status='未配对';try{c=JSON.parse(await readFile(file,'utf8'));status=await readFile(file+'.status','utf8');}catch{}
      let devices=[];
      if(c.token&&c.server)try{const r=await fetch(new URL('/center/host-devices',c.server),{headers:{authorization:`Bearer ${c.token}`},redirect:'error',signal:AbortSignal.timeout(5000)});if(r.ok)devices=(await r.json()).devices||[];}catch{}
      reply(200,{server:c.server||'https://dsh.agencyarche.com',name:c.name||hostname(),id:c.id,status,devices});return;
    }
    if(req.method!=='POST'){reply(405,{error:'Method not allowed'});return;}
    // Only authenticated same-origin local surfaces can pair this Host.
    const origin=req.headers.origin;
    if(origin && origin!==ctx.webServer.getOrigin()){reply(403,{error:'Origin rejected'});return;}
    try{
      let text='';for await(const chunk of req){text+=chunk;if(Buffer.byteLength(text)>8192)throw Error('请求过大');}
      const b=JSON.parse(text),server=new URL(b.server);if(server.protocol!=='https:'||server.username||server.password)throw Error('中心地址必须使用 HTTPS');
      const r=await fetch(new URL('/center/pair',server),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code:b.code,name:b.name}),redirect:'error',signal:AbortSignal.timeout(15000)});
      const c=await r.json();if(!r.ok)throw Error(c.error||'配对失败');
      if(typeof c.token!=='string'||!c.token||typeof c.id!=='string')throw Error('中心返回无效凭据');
      await mkdir(dirname(file),{recursive:true});await writeFile(file,JSON.stringify({...c,server:server.origin,name:String(b.name||hostname()).slice(0,60)}),{mode:0o600});
      await start();reply(200,{ok:true});
    }catch(e){reply(400,{error:e.message});}
  }}));
  watchFile(file, {interval:3000,persistent:false}, onChange);
  start().catch(e => console.error('[dsh-center]', e.message));
}
