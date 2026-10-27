import http from 'node:http';
import {randomBytes,createHash,scryptSync,timingSafeEqual} from 'node:crypto';
import {readFile,mkdir,writeFile,rename} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {WebSocketServer,WebSocket} from 'ws';
import {createGzip} from 'node:zlib';

const here=dirname(fileURLToPath(import.meta.url));
const hash=x=>createHash('sha256').update(x).digest('hex');
const random=()=>randomBytes(32).toString('base64url');
const safeEqual=(a,b)=>{const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y);};
export async function createCenter({password,publicUrl,dataDir,secure=true,allowWeakPassword=false}) {
  const minimum=allowWeakPassword?6:16;
  if (!password || password.length<minimum) throw Error(`Set a password of at least ${minimum} characters`);
  const origin=new URL(publicUrl).origin;
  const salt=randomBytes(16), passwordHash=scryptSync(password,salt,32);
  const store=join(dataDir,'devices.json'); await mkdir(dataDir,{recursive:true});
  let devices={};try{devices=JSON.parse(await readFile(store,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
  let saves=Promise.resolve();
  const save=()=>{const data=JSON.stringify(devices);saves=saves.then(async()=>{await writeFile(store+'.tmp',data,{mode:0o600});await rename(store+'.tmp',store);});return saves;};
  const authStore=join(dataDir,'sessions.json');
  let savedAuth;try{savedAuth=JSON.parse(await readFile(authStore,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
  const authSalt=savedAuth?.salt||randomBytes(16).toString('hex');
  const authVerifier=scryptSync(password,authSalt,32).toString('hex');
  const sessions=new Map(savedAuth?.verifier===authVerifier ? (savedAuth.sessions||[]).filter(([key,expires])=>typeof key==='string'&&Number.isFinite(expires)&&expires>Date.now()) : []);
  const codes=new Map(),hosts=new Map(),pending=new Map(),attempts=new Map();
  let authSaves=Promise.resolve();
  const saveSessions=()=>{const data=JSON.stringify({salt:authSalt,verifier:authVerifier,sessions:[...sessions]});authSaves=authSaves.catch(()=>{}).then(async()=>{await writeFile(authStore+'.tmp',data,{mode:0o600});await rename(authStore+'.tmp',authStore);});return authSaves;};
  await saveSessions();

  const json=(res,status,data)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(data));};
  const sessionKey=req=>{
    const value=req.headers.cookie?.split(';').map(x=>x.trim()).find(x=>x.startsWith('center_session='))?.slice(15);
    return value?hash(value):'';
  };
  const session=req=>sessions.get(sessionKey(req))>Date.now();
  const sameOrigin=req=>req.headers.origin===origin;
  const read=async req=>{let text='';for await(const b of req){text+=b;if(Buffer.byteLength(text)>8192)throw Error('Body too large');}return JSON.parse(text||'{}');};
  function send(ws,m){if(ws?.readyState!==WebSocket.OPEN)return false;if(ws.bufferedAmount>16*1024*1024){ws.terminate();return false;}ws.send(JSON.stringify(m));return true;}
  function finish(id,error=false){const p=pending.get(id);if(!p)return;pending.delete(id);clearTimeout(p.timeout);if(error){p.output?.destroy();if(p.res){if(!p.res.headersSent)json(p.res,502,{error:'设备连接中断，请重新连接'});else p.res.destroy();}else p.ws?.close(1011,'Device disconnected');}}
  function authorizePath(req){const u=new URL(req.url,origin);const match=/^\/d\/([a-f0-9]{24})(\/.*)$/.exec(u.pathname);return match&&{device:match[1],path:match[2]+u.search};}
  const app=await readFile(join(here,'web/index.html'));
  const js=await readFile(join(here,'web/app.js'));
  const server=http.createServer(async(req,res)=>{
    res.setHeader('x-content-type-options','nosniff');res.setHeader('referrer-policy','no-referrer');res.setHeader('cache-control','no-store');
    try{
      const path=new URL(req.url,origin).pathname;
      if(path==='/health'){json(res,200,{ok:true});return;}
      if(path==='/center/host-devices'&&req.method==='GET'){
        const token=req.headers.authorization?.replace(/^Bearer /,'');
        if(!token||!Object.values(devices).some(d=>safeEqual(d.tokenHash,hash(token)))){json(res,401,{error:'Device authentication required'});return;}
        json(res,200,{devices:Object.values(devices).map(({id,name,remark})=>({id,name:remark||name,originalName:name,remark:remark||'',online:hosts.has(id)}))});return;
      }
      if(path==='/center/login'&&req.method==='POST'){
        if(!sameOrigin(req)){json(res,403,{error:'Origin rejected'});return;}
        const key=req.socket.remoteAddress;const a=attempts.get(key)||{n:0,until:Date.now()+60000};if(a.until<Date.now()){a.n=0;a.until=Date.now()+60000;}attempts.set(key,a);
        if(++a.n>10){json(res,429,{error:'请稍后重试'});return;}
        const body=await read(req);const result=scryptSync(String(body.password||''),salt,32);
        if(!timingSafeEqual(result,passwordHash)){json(res,401,{error:'密码不正确'});return;}
        const token=random();sessions.set(hash(token),Date.now()+30*86400000);await saveSessions();
        res.setHeader('set-cookie',`center_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000${secure?'; Secure':''}`);json(res,200,{ok:true});return;
      }
      if(path==='/center/pair'&&req.method==='POST'){
        const b=await read(req),key=hash(String(b.code||'')),code=codes.get(key);
        if(!code||code.expires<Date.now()){json(res,401,{error:'配对码无效或过期'});return;}
        codes.delete(key);const id=randomBytes(12).toString('hex'),token=random();
        devices[id]={id,name:String(b.name||'我的电脑').slice(0,60),tokenHash:hash(token),createdAt:new Date().toISOString()};await save();json(res,200,{id,token,server:origin});return;
      }
      if(path==='/'||path==='/center/app.js'){
        res.setHeader('content-type',path==='/'?'text/html; charset=utf-8':'text/javascript; charset=utf-8');res.end(path==='/'?app:js);return;
      }
      if(!session(req)){json(res,401,{error:'请登录设备中心'});return;}
      if(!['GET','HEAD'].includes(req.method)&&!sameOrigin(req)){json(res,403,{error:'Origin rejected'});return;}
      if(path==='/center/devices'&&req.method==='GET'){json(res,200,{devices:Object.values(devices).map(({tokenHash,...d})=>({...d,name:d.remark||d.name,originalName:d.name,remark:d.remark||'',online:hosts.has(d.id)}))});return;}
      if(path==='/center/logout'&&req.method==='POST'){
        const value=req.headers.cookie?.split(';').map(x=>x.trim()).find(x=>x.startsWith('center_session='))?.slice(15);if(value)sessions.delete(hash(value));await saveSessions();
        for(const[id,p]of pending)if(p.session===sessionKey(req)){send(hosts.get(p.device),{t:'cancel',id});finish(id,true);}
        res.setHeader('set-cookie',`center_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure?'; Secure':''}`);json(res,200,{ok:true});return;
      }
      if(path==='/center/codes'&&req.method==='POST'){const code=randomBytes(16).toString('hex');codes.set(hash(code),{expires:Date.now()+600000});json(res,200,{code,expiresIn:600});return;}
      const remarkRoute=/^\/center\/devices\/([a-f0-9]{24})\/remark$/.exec(path);
      if(remarkRoute&&req.method==='PUT'){
        const device=devices[remarkRoute[1]];if(!device){json(res,404,{error:'设备不存在'});return;}
        const body=await read(req);
        if(typeof body.remark!=='string'||body.remark.trim().length>60){json(res,400,{error:'备注名最多 60 个字符'});return;}
        device.remark=body.remark.trim();await save();json(res,200,{ok:true});return;
      }
      if(path.startsWith('/center/devices/')&&req.method==='DELETE'){
        const id=path.split('/').pop();hosts.get(id)?.close(1008,'Revoked');hosts.delete(id);delete devices[id];await save();json(res,200,{ok:true});return;
      }
      const route=authorizePath(req);
      if(!route||!devices[route.device]){json(res,404,{error:'Not found'});return;}
      const host=hosts.get(route.device);if(!host){json(res,503,{error:'设备离线；不会自动切换到其他电脑'});return;}
      if(pending.size>=512){json(res,503,{error:'连接过多，请稍后重试'});return;}
      const id=random();const p={device:route.device,session:sessionKey(req),res,path:route.path,acceptEncoding:req.headers['accept-encoding']||'',timeout:setTimeout(()=>{send(host,{t:'cancel',id});finish(id,true);},45000)};pending.set(id,p);
      send(host,{t:'request',id,path:route.path,method:req.method,headers:req.headers});
      let bytes=0;req.on('data',b=>{bytes+=b.length;if(bytes>32*1024*1024){send(host,{t:'cancel',id});finish(id,true);req.destroy();return;}send(host,{t:'data',id,data:b.toString('base64')});});
      req.on('end',()=>send(host,{t:'end',id}));
      req.on('error',()=>{send(host,{t:'cancel',id});finish(id,true);});
      res.on('close',()=>{if(pending.has(id)){send(host,{t:'cancel',id});finish(id);}});
    }catch{if(!res.headersSent)json(res,400,{error:'请求失败'});else res.destroy();}
  });
  // A 16 MiB DSH response expands beyond 21 MiB in the base64 tunnel envelope.
  const wss=new WebSocketServer({noServer:true,maxPayload:24*1024*1024});
  const browserWss=new WebSocketServer({noServer:true,maxPayload:1024*1024});
  server.on('upgrade',(req,socket,head)=>{
    const path=new URL(req.url,origin).pathname;
    const reject=()=>{socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');};
    if(path==='/center/host'){
      const token=req.headers.authorization?.replace(/^Bearer /,'');const d=token&&Object.values(devices).find(d=>safeEqual(d.tokenHash,hash(token)));if(!d){reject();return;}
      wss.handleUpgrade(req,socket,head,ws=>{
        hosts.get(d.id)?.close(1012,'Reconnected');hosts.set(d.id,ws);ws.alive=true;
        ws.on('pong',()=>ws.alive=true);
        ws.on('error',e=>console.warn('Host tunnel error',d.id,e.code||'unknown'));
        ws.on('close',()=>{if(hosts.get(d.id)===ws){hosts.delete(d.id);for(const[id,p]of pending)if(p.device===d.id)finish(id,true);}});
        ws.on('message',raw=>{try{
          const m=JSON.parse(raw),p=pending.get(m.id);if(!p||p.device!==d.id||hosts.get(d.id)!==ws)return;
          if(m.t==='headers'&&p.res){
            clearTimeout(p.timeout);if(!Number.isInteger(m.status)||m.status<100||m.status>599)throw Error();
            const headers={...m.headers};
            const staticAsset=m.status===200 && /^\/(?:assets|plugins)\//.test(p.path) && /javascript|text\/css|image\/svg\+xml/.test(headers['content-type']||'');
            if(staticAsset){
              headers.vary='Accept-Encoding';
              if(/[?&]rev=[a-f0-9]+(?:&|$)/.test(p.path)||/^\/assets\/[^?]+-[\w-]+\.(?:js|css)(?:\?|$)/.test(p.path))headers['cache-control']='private, max-age=3600';
              if(/\bgzip\b/.test(p.acceptEncoding)&&!headers['content-encoding']){headers['content-encoding']='gzip';delete headers['content-length'];p.output=createGzip();p.output.on('error',()=>finish(m.id,true));p.output.pipe(p.res);}
            }
            p.res.writeHead(m.status,headers);
          }
          else if(m.t==='chunk'&&p.res){const output=p.output||p.res;if(output.writableLength>16*1024*1024||p.res.writableLength>16*1024*1024){send(ws,{t:'cancel',id:m.id});finish(m.id,true);return;}output.write(Buffer.from(m.data,'base64'));}
          else if(m.t==='end'&&p.res){(p.output||p.res).end();finish(m.id);}
          else if(m.t==='error')finish(m.id,true);
          else if(m.t==='ws-data'&&p.ws?.readyState===WebSocket.OPEN){if(p.ws.bufferedAmount>16*1024*1024)finish(m.id,true);else p.ws.send(Buffer.from(m.data,'base64'),{binary:m.binary});}
          else if(m.t==='ws-open'){clearTimeout(p.timeout);p.ready=true;for(const b of p.queue||[])send(ws,b);p.queue=[];}
          else if(m.t==='ws-close'){p.ws?.close();finish(m.id);}
        }catch{ws.close(1008,'Invalid tunnel message');}});
      });return;
    }
    const route=authorizePath(req);if(!session(req)||!sameOrigin(req)||!route||!hosts.has(route.device)||pending.size>=512){reject();return;}
    browserWss.handleUpgrade(req,socket,head,ws=>{
      const id=random(),host=hosts.get(route.device);const p={device:route.device,session:sessionKey(req),ws,queue:[],ready:false,timeout:setTimeout(()=>finish(id,true),30000)};pending.set(id,p);
      send(host,{t:'ws-open',id,path:route.path,protocols:ws.protocol?[ws.protocol]:[]});
      ws.on('message',(b,binary)=>{const m={t:'ws-data',id,data:b.toString('base64'),binary};if(p.ready)send(host,m);else if(p.queue.length<64)p.queue.push(m);else ws.close(1009);});
      ws.on('close',()=>{send(host,{t:'cancel',id});finish(id);});ws.on('error',()=>{});
    });
  });
  const heartbeat=setInterval(()=>{
    for(const ws of hosts.values()){if(!ws.alive)ws.terminate();else{ws.alive=false;ws.ping();}}
    const now=Date.now();for(const[k,t]of sessions)if(t<now)sessions.delete(k);for(const[k,c]of codes)if(c.expires<now)codes.delete(k);for(const[k,a]of attempts)if(a.until<now)attempts.delete(k);
    for(const[id,p]of pending)if(!sessions.has(p.session)){send(hosts.get(p.device),{t:'cancel',id});finish(id,true);}
  },25000);heartbeat.unref();
  return {server,close:async()=>{clearInterval(heartbeat);for(const ws of [...wss.clients,...browserWss.clients])ws.terminate();for(const id of pending.keys())finish(id,true);await new Promise(r=>server.close(r));await saves;await authSaves;}};
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
  const password=process.env.CENTER_PASSWORD_FILE? (await readFile(process.env.CENTER_PASSWORD_FILE,'utf8')).trim():process.env.CENTER_PASSWORD;
  const {server}=await createCenter({password,publicUrl:process.env.CENTER_PUBLIC_URL,dataDir:process.env.CENTER_DATA||'./data',allowWeakPassword:process.env.CENTER_ALLOW_WEAK_PASSWORD==='true'});
  server.listen(Number(process.env.PORT||4320),process.env.LISTEN_HOST||'127.0.0.1',()=>console.log('DSH Center listening'));
}
