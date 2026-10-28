import http from 'node:http';
import {randomBytes,createHash,scryptSync,timingSafeEqual} from 'node:crypto';
import {readFile,mkdir,writeFile,rename} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {WebSocketServer,WebSocket} from 'ws';
import {createGzip,gzip} from 'node:zlib';

const gzipAsync=buffer=>new Promise((resolve,reject)=>gzip(buffer,(error,out)=>error?reject(error):resolve(out)));

const here=dirname(fileURLToPath(import.meta.url));
const hash=x=>createHash('sha256').update(x).digest('hex');
const random=()=>randomBytes(32).toString('base64url');
const safeEqual=(a,b)=>{const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y);};
const DEVICE_LABEL=/^[a-f0-9]{24}$/;
const TIMING=process.env.CENTER_TIMING==='1';
const MUX_STATS=process.env.CENTER_MUX_STATS==='1';
export async function createCenter({password,publicUrl,dataDir,secure=true,allowWeakPassword=false,heartbeatMs=25000,deviceDomain,deviceOrigins=true}={}) {
  const minimum=allowWeakPassword?6:16;
  if (!password || password.length<minimum) throw Error(`Set a password of at least ${minimum} characters`);
  const publicBase=new URL(publicUrl);
  const origin=publicBase.origin;
  // Every device gets its own origin (<id>.<base domain>) so browser code that
  // builds root-absolute URLs keeps working without any per-plugin adaptation.
  const baseDomain=String(deviceDomain||publicBase.hostname).replace(/^\.+/,'').replace(/\.+$/,'').toLowerCase();
  const portSuffix=publicBase.port?':'+publicBase.port:'';
  const portalFor=id=>deviceOrigins?`${publicBase.protocol}//${id}.${baseDomain}${portSuffix}/`:undefined;
  // The login cookie must reach the device origins as well.
  const cookieDomain=secure&&baseDomain.includes('.')&&!/^[\d.]+$/.test(baseDomain)?`; Domain=${baseDomain}`:'';
  const hostnameOf=value=>String(value||'').toLowerCase().replace(/:\d+$/,'');
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
  const codes=new Map(),hosts=new Map(),pending=new Map(),attempts=new Map(),links=new Map();
  const linkState=id=>({online:hosts.get(id)?.readyState===WebSocket.OPEN,connection:hosts.get(id)?.readyState===WebSocket.OPEN?"connected":"reconnecting",...(links.get(id)||{})});
  let authSaves=Promise.resolve();
  const saveSessions=()=>{const data=JSON.stringify({salt:authSalt,verifier:authVerifier,sessions:[...sessions]});authSaves=authSaves.catch(()=>{}).then(async()=>{await writeFile(authStore+'.tmp',data,{mode:0o600});await rename(authStore+'.tmp',authStore);});return authSaves;};
  await saveSessions();

  const json=(res,status,data)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(data));};
  const sessionKey=req=>{
    const value=req.headers.cookie?.split(';').map(x=>x.trim()).find(x=>x.startsWith('center_session='))?.slice(15);
    return value?hash(value):'';
  };
  const session=req=>sessions.get(sessionKey(req))>Date.now();
  // Same origin means: the configured public origin, or the exact host that was
  // requested (device subdomains). Anything else is a cross-site request.
  const sameOrigin=req=>{
    const value=req.headers.origin;
    if(!value)return true;
    try{
      const u=new URL(value);
      if(u.origin===origin)return true;
      return u.host===req.headers.host&&(u.protocol==='https:'||u.protocol==='http:');
    }catch{return false;}
  };
  const read=async req=>{let text='';for await(const b of req){text+=b;if(Buffer.byteLength(text)>8192)throw Error('Body too large');}return JSON.parse(text||'{}');};
  function send(ws,m){if(ws?.readyState!==WebSocket.OPEN)return false;if(ws.bufferedAmount>16*1024*1024){ws.terminate();return false;}ws.send(JSON.stringify(m));return true;}
  function finish(id,error=false){const p=pending.get(id);if(!p)return;pending.delete(id);clearTimeout(p.timeout);if(p.buffering){buffering--;p.buffering=false;}if(TIMING)console.info(`[timing] ${error?'ERR':'OK'} ${p.path} ${p.bytes||0}B ${Date.now()-p.started}ms`);if(error){p.output?.destroy();if(p.res){if(!p.res.headersSent)json(p.res,502,{error:'设备连接中断，请重新连接'});else p.res.destroy();}else p.ws?.close(1011,'Device disconnected');}}
  function authorizePath(req){const u=new URL(req.url,origin);const match=/^\/d\/([a-f0-9]{24})(\/.*)$/.exec(u.pathname);return match&&{device:match[1],path:match[2]+u.search};}
  // Resolve the device a request belongs to from its Host header.
  // null: the center itself (apex). 'unknown': a device origin with no such device.
  const deviceFromHost=host=>{
    const h=hostnameOf(host);
    if(h===baseDomain||h===hostnameOf(publicBase.host))return null;
    const suffix='.'+baseDomain;
    if(!h.endsWith(suffix))return null;
    const label=h.slice(0,-suffix.length);
    return DEVICE_LABEL.test(label)&&devices[label]?label:'unknown';
  };
  const deviceList=list=>Object.values(list).map(({id,name,remark,tokenHash,...rest})=>({id,name:remark||name,originalName:name,remark:remark||'',portal:portalFor(id),...linkState(id),...rest}));
  const app=await readFile(join(here,'web/index.html'));
  const js=await readFile(join(here,'web/app.js'));
  // ---- static asset cache -------------------------------------------------
  // DSH serves content-hashed JS/CSS once per version; the same bytes are then
  // requested by every browser and every reload. Keeping them in this process
  // skips the tunnel (and the PC's uplink) completely on a hit, and lets the
  // browser cache them for a year.
  const assetCache=new Map();let assetCacheBytes=0;
  const assetCacheLimit=Math.max(0,Number(process.env.CENTER_ASSET_CACHE_MB??192))*1024*1024;
  const CACHEABLE_PATH=/^\/(?:assets|plugins|dsh-client-modules)\//;
  const CACHEABLE_TYPE=/^(?:text\/css|text\/javascript|application\/javascript|application\/json|image\/svg\+xml|font\/|application\/font|image\/)/i;
  const REVVED_PATH=/[?&]rev=[a-f0-9]+(?:&|$)/;
  const assetKey=(device,path)=>device+' '+path;
  const cacheGet=key=>{const entry=assetCache.get(key);if(!entry)return null;assetCache.delete(key);assetCache.set(key,entry);return entry;};
  const cachePut=(key,entry)=>{
    const size=entry.raw.length+(entry.gzip?entry.gzip.length:0);
    if(assetCacheLimit<=0||size>assetCacheLimit/4)return;
    const old=assetCache.get(key);if(old){assetCache.delete(key);assetCacheBytes-=old.raw.length+(old.gzip?old.gzip.length:0);}
    assetCache.set(key,entry);assetCacheBytes+=size;
    while(assetCacheBytes>assetCacheLimit&&assetCache.size>1){const [k,v]=assetCache.entries().next().value;assetCache.delete(k);assetCacheBytes-=v.raw.length+(v.gzip?v.gzip.length:0);}
  };
  const revved=path=>REVVED_PATH.test(path)||/^\/assets\/[^?]+-[\w-]+\.(?:js|css)(?:\?|$)/.test(path);
  const cacheControlFor=path=>revved(path)?'private, max-age=31536000, immutable':'private, max-age=300';
  // Ask Caddy for the on-demand certificate as soon as a device is known, so the
  // first browser visit does not pay for ACME issuance.
  const warmed=new Set();
  // Optional observability: how much the browser <-> host multiplexed socket moves.
  const muxStats=new Map();
  const muxStat=id=>{let s=muxStats.get(id);if(!s){s={inFrames:0,inBytes:0,outFrames:0,outBytes:0};muxStats.set(id,s);}return s;};
  const warmCertificate=id=>{
    const portal=portalFor(id);if(!portal||warmed.has(id))return;
    warmed.add(id);
    fetch(new URL('/health',portal).href,{signal:AbortSignal.timeout(25000)}).then(r=>r.arrayBuffer()).catch(()=>{});
  };
  let buffering=0;const MAX_BUFFERS=24,MAX_BUFFERED_ASSET=12*1024*1024;
  const serveCached=(device,path,req,res)=>{
    if(assetCacheLimit<=0||req.method!=='GET')return false;
    const pathname=path.split('?')[0];
    if(!CACHEABLE_PATH.test(pathname))return false;
    const entry=cacheGet(assetKey(device,path));if(!entry)return false;
    const inm=req.headers['if-none-match'];
    if(inm&&entry.headers.etag&&inm.split(',').map(x=>x.trim()).includes(entry.headers.etag)){
      res.writeHead(304,{'cache-control':entry.cacheControl,vary:'Accept-Encoding'});res.end();return true;
    }
    const accepts=/\bgzip\b/.test(req.headers['accept-encoding']||'');
    const gz=accepts&&entry.gzip?entry.gzip:null;
    const body=gz||entry.raw;
    const headers={...entry.headers,'cache-control':entry.cacheControl,vary:'Accept-Encoding','content-length':String(body.length)};
    if(gz)headers['content-encoding']='gzip';
    res.writeHead(200,headers);res.end(body);return true;
  };
  // Assets still stream to the browser untouched (no extra TTFB); their raw bytes
  // are captured on the way so the next request never touches the tunnel. gzip is
  // prepared in the background for the next visitor.
  const captureAsset=p=>{
    const parts=p.parts;p.parts=null;if(p.buffering){buffering--;p.buffering=false;}
    const gzParts=p.gzParts||null;p.gzParts=null;
    if(!p.cacheKey||!parts||!parts.length)return;
    const raw=Buffer.concat(parts);if(raw.length>MAX_BUFFERED_ASSET)return;
    const entry={raw,gzip:gzParts?Buffer.concat(gzParts):null,headers:{...p.meta.headers},cacheControl:p.cacheControl};
    cachePut(p.cacheKey,entry);
    if(!entry.gzip)gzipAsync(raw).then(gz=>{entry.gzip=gz;}).catch(()=>{});
  };
  const forward=(device,path,req,res)=>{
    // Cached assets stay available even while the PC is offline.
    if(serveCached(device,path,req,res))return;
    const host=hosts.get(device);if(!host){json(res,503,{error:'设备尚未连接中心，正在等待重连；电脑可能仍在运行'});return;}
    if(pending.size>=512){json(res,503,{error:'连接过多，请稍后重试'});return;}
    const id=random();
    const p={id,device,session:sessionKey(req),res,path,acceptEncoding:req.headers['accept-encoding']||'',cacheKey:'',bytes:0,started:Date.now(),timeout:setTimeout(()=>{send(host,{t:'cancel',id});finish(id,true);},45000)};
    if(req.method==='GET'&&assetCacheLimit>0&&CACHEABLE_PATH.test(path.split('?')[0]))p.cacheKey=assetKey(device,path);
    pending.set(id,p);
    send(host,{t:'request',id,path,method:req.method,headers:req.headers});
    let bytes=0;req.on('data',b=>{bytes+=b.length;if(bytes>32*1024*1024){send(host,{t:'cancel',id});finish(id,true);req.destroy();return;}send(host,{t:'data',id,data:b.toString('base64')});});
    req.on('end',()=>send(host,{t:'end',id}));
    req.on('error',()=>{send(host,{t:'cancel',id});finish(id,true);});
    res.on('close',()=>{if(pending.has(id)){send(host,{t:'cancel',id});finish(id);}});
  };
  const server=http.createServer(async(req,res)=>{
    res.setHeader('x-content-type-options','nosniff');res.setHeader('referrer-policy','no-referrer');res.setHeader('cache-control','no-store');
    try{
      const url=new URL(req.url,origin);
      const path=url.pathname;
      const deviceHost=deviceFromHost(req.headers.host);
      if(deviceHost==='unknown'){json(res,404,{error:'Not found'});return;}
      if(path==='/health'){json(res,200,{ok:true});return;}
      // Caddy's on-demand TLS permission check; only real device origins may get a certificate.
      if(path==='/center/tls-ask'&&req.method==='GET'){
        const asked=hostnameOf(url.searchParams.get('domain')||'');
        const id=asked!==''?deviceFromHost(asked):null;
        if(id&&id!=='unknown'){res.writeHead(200,{'content-type':'text/plain'});res.end('ok');}
        else{res.writeHead(403,{'content-type':'text/plain'});res.end('no');}
        return;
      }
      // A device origin is the DSH app itself: every path belongs to that device.
      if(deviceHost){
        if(!session(req)){json(res,401,{error:'请登录设备中心'});return;}
        if(!['GET','HEAD'].includes(req.method)&&!sameOrigin(req)){json(res,403,{error:'Origin rejected'});return;}
        forward(deviceHost,path+url.search,req,res);return;
      }
      if(path==='/center/host-devices'&&req.method==='GET'){
        const token=req.headers.authorization?.replace(/^Bearer /,'');
        if(!token||!Object.values(devices).some(d=>safeEqual(d.tokenHash,hash(token)))){json(res,401,{error:'Device authentication required'});return;}
        json(res,200,{devices:deviceList(devices)});return;
      }
      if(path==='/center/login'&&req.method==='POST'){
        if(!sameOrigin(req)){json(res,403,{error:'Origin rejected'});return;}
        const key=req.socket.remoteAddress;const a=attempts.get(key)||{n:0,until:Date.now()+60000};if(a.until<Date.now()){a.n=0;a.until=Date.now()+60000;}attempts.set(key,a);
        if(++a.n>10){json(res,429,{error:'请稍后重试'});return;}
        const body=await read(req);const result=scryptSync(String(body.password||''),salt,32);
        if(!timingSafeEqual(result,passwordHash)){json(res,401,{error:'密码不正确'});return;}
        const token=random();sessions.set(hash(token),Date.now()+30*86400000);await saveSessions();
        // center_scope is the JS-readable twin of the session cookie: the center page
        // uses it to detect a session that predates device origins (host-only cookie)
        // and to migrate that browser to a domain-scoped login.
        res.setHeader('set-cookie',[`center_session=${token}; HttpOnly; SameSite=Strict; Path=/${cookieDomain}; Max-Age=2592000${secure?'; Secure':''}`,`center_scope=1; SameSite=Strict; Path=/${cookieDomain}; Max-Age=2592000${secure?'; Secure':''}`]);json(res,200,{ok:true});return;
      }
      if(path==='/center/pair'&&req.method==='POST'){
        const b=await read(req),key=hash(String(b.code||'')),code=codes.get(key);
        if(!code||code.expires<Date.now()){json(res,401,{error:'配对码无效或过期'});return;}
        codes.delete(key);const id=randomBytes(12).toString('hex'),token=random();
        devices[id]={id,name:String(b.name||'我的电脑').slice(0,60),tokenHash:hash(token),createdAt:new Date().toISOString()};await save();if(deviceOrigins)warmCertificate(id);json(res,200,{id,token,server:origin,portal:portalFor(id)});return;
      }
      if(path==='/'||path==='/center/app.js'){
        res.setHeader('content-type',path==='/'?'text/html; charset=utf-8':'text/javascript; charset=utf-8');res.end(path==='/'?app:js);return;
      }
      if(!session(req)){json(res,401,{error:'请登录设备中心'});return;}
      if(!['GET','HEAD'].includes(req.method)&&!sameOrigin(req)){json(res,403,{error:'Origin rejected'});return;}
      if(path==='/center/relogin'&&req.method==='POST'){
        // Silent migration for browsers whose session cookie predates device origins:
        // rotate the token and re-issue it with Domain=<base domain>.
        if(!session(req)){json(res,401,{error:'请登录设备中心'});return;}
        if(!sameOrigin(req)){json(res,403,{error:'Origin rejected'});return;}
        const old=sessionKey(req),token=random();
        sessions.delete(old);sessions.set(hash(token),Date.now()+30*86400000);await saveSessions();
        res.setHeader('set-cookie',[
          `center_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure?'; Secure':''}`,
          `center_session=${token}; HttpOnly; SameSite=Strict; Path=/${cookieDomain}; Max-Age=2592000${secure?'; Secure':''}`,
          `center_scope=1; SameSite=Strict; Path=/${cookieDomain}; Max-Age=2592000${secure?'; Secure':''}`,
        ]);
        json(res,200,{ok:true});return;
      }
      if(path==='/center/devices'&&req.method==='GET'){json(res,200,{devices:deviceList(devices)});return;}
      if(path==='/center/logout'&&req.method==='POST'){
        const value=req.headers.cookie?.split(';').map(x=>x.trim()).find(x=>x.startsWith('center_session='))?.slice(15);if(value)sessions.delete(hash(value));await saveSessions();
        for(const[id,p]of pending)if(p.session===sessionKey(req)){send(hosts.get(p.device),{t:'cancel',id});finish(id,true);}
        res.setHeader('set-cookie',[`center_session=; Path=/${cookieDomain}; HttpOnly; SameSite=Strict; Max-Age=0${secure?'; Secure':''}`,`center_scope=; Path=/${cookieDomain}; SameSite=Strict; Max-Age=0${secure?'; Secure':''}`]);json(res,200,{ok:true});return;
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
      // Legacy path prefix: kept so existing links and older plugin builds keep working.
      const route=authorizePath(req);
      if(!route||!devices[route.device]){json(res,404,{error:'Not found'});return;}
      forward(route.device,route.path,req,res);
    }catch{if(!res.headersSent)json(res,400,{error:'请求失败'});else res.destroy();}
  });
  // A 16 MiB DSH response expands beyond 21 MiB in the base64 tunnel envelope.
  const wss=new WebSocketServer({noServer:true,maxPayload:24*1024*1024,perMessageDeflate:{threshold:1024,serverNoContextTakeover:true,clientNoContextTakeover:true,concurrencyLimit:2,zlibDeflateOptions:{level:3}}});
  // Session switches push megabytes of JSON down this socket; compress it. Browsers
  // always offer permessage-deflate, and frames are text so the ratio is high.
  const browserWss=new WebSocketServer({noServer:true,maxPayload:1024*1024,perMessageDeflate:{threshold:1024,concurrencyLimit:2,zlibDeflateOptions:{level:3}}});
  server.on('upgrade',(req,socket,head)=>{
    const url=new URL(req.url,origin);
    const path=url.pathname;
    const reject=()=>{socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');};
    const deviceHost=deviceFromHost(req.headers.host);
    if(deviceHost==='unknown'){reject();return;}
    if(!deviceHost&&path==='/center/host'){
      const token=req.headers.authorization?.replace(/^Bearer /,'');const d=token&&Object.values(devices).find(d=>safeEqual(d.tokenHash,hash(token)));if(!d){reject();return;}
      wss.handleUpgrade(req,socket,head,ws=>{
        const old=hosts.get(d.id);
        if(old){for(const[id,p]of pending)if(p.device===d.id){send(old,{t:'cancel',id});finish(id,true);}old.close(1012,'Replaced');}
        hosts.set(d.id,ws);ws.alive=true;links.set(d.id,{connectedAt:Date.now(),lastSeen:Date.now()});
        if(deviceOrigins)warmCertificate(d.id);
        console.info('Host connected',d.id,old?'replaced':'new');
        ws.on('pong',()=>{ws.alive=true;if(hosts.get(d.id)===ws)links.set(d.id,{...links.get(d.id),lastSeen:Date.now()});});
        ws.on('error',e=>console.warn('Host tunnel error',d.id,e.code||'unknown'));
        ws.on('close',code=>{console.info('Host disconnected',d.id,code);if(hosts.get(d.id)===ws){hosts.delete(d.id);links.set(d.id,{...links.get(d.id),disconnectedAt:Date.now(),closeCode:code});for(const[id,p]of pending)if(p.device===d.id)finish(id,true);}});
        ws.on('message',raw=>{try{
          const m=JSON.parse(raw),p=pending.get(m.id);if(!p||p.device!==d.id||hosts.get(d.id)!==ws)return;
          if(m.t==='headers'&&p.res){
            clearTimeout(p.timeout);if(!Number.isInteger(m.status)||m.status<100||m.status>599)throw Error();
            const headers={...m.headers};
            const type=String(headers['content-type']||'');
            // Start capturing cacheable assets while they stream to the browser.
            if(p.cacheKey&&m.status===200&&buffering<MAX_BUFFERS&&CACHEABLE_TYPE.test(type)){
              p.buffering=true;buffering++;p.parts=[];p.size=0;p.meta={status:m.status,headers:{...headers}};p.cacheControl=cacheControlFor(p.path);
            }
            else p.cacheKey='';
            const compressible=m.status===200&&/\bgzip\b/.test(p.acceptEncoding)&&!headers['content-encoding']&&/text\/html|text\/css|javascript|application\/json|image\/svg\+xml/i.test(type);
            if(compressible){headers.vary='Accept-Encoding';headers['content-encoding']='gzip';delete headers['content-length'];p.gzParts=p.cacheKey?[]:null;p.output=createGzip();p.output.on('data',chunk=>{if(p.gzParts)p.gzParts.push(chunk);});p.output.on('error',()=>finish(m.id,true));p.output.pipe(p.res);}
            if(m.status===200&&CACHEABLE_PATH.test(p.path.split('?')[0])&&CACHEABLE_TYPE.test(type))headers['cache-control']=cacheControlFor(p.path);
            p.res.writeHead(m.status,headers);
          }
          else if(m.t==='chunk'&&p.res){
            const b=Buffer.from(m.data,'base64');p.bytes+=b.length;
            if(p.parts){p.size+=b.length;if(p.size<=MAX_BUFFERED_ASSET)p.parts.push(b);else{p.cacheKey='';p.parts=null;p.gzParts=null;if(p.buffering){buffering--;p.buffering=false;}}}
            const output=p.output||p.res;if(output.writableLength>16*1024*1024||p.res.writableLength>16*1024*1024){send(ws,{t:'cancel',id:m.id});finish(m.id,true);return;}output.write(b);
          }
          else if(m.t==='end'&&p.res){
            if(p.output){
              // The gzip stream ends after its last chunk is written; capture only
              // then, otherwise the cached copy would be a truncated prefix.
              p.output.once('end',()=>{captureAsset(p);finish(m.id);});
              p.output.end();
            } else {p.res.end();captureAsset(p);finish(m.id);}
          }
          else if(m.t==='error')finish(m.id,true);
          else if(m.t==='ws-data'&&p.ws?.readyState===WebSocket.OPEN){if(p.ws.bufferedAmount>16*1024*1024)finish(m.id,true);else{p.ws.send(Buffer.from(m.data,'base64'),{binary:m.binary});if(p.stats){p.stats.outFrames++;p.stats.outBytes+=m.data.length*0.75;}}}
          else if(m.t==='ws-open'){clearTimeout(p.timeout);p.ready=true;for(const b of p.queue||[])send(ws,b);p.queue=[];}
          else if(m.t==='ws-close'){p.ws?.close(1012,'Upstream reconnecting');finish(m.id);}
        }catch{ws.close(1008,'Invalid tunnel message');}});
      });return;
    }
    // A device origin carries the whole app, so its upgrade path is used verbatim.
    const route=deviceHost?{device:deviceHost,path:req.url}:authorizePath(req);
    if(!route||!session(req)||!sameOrigin(req)||!hosts.has(route.device)||pending.size>=512){reject();return;}
    browserWss.handleUpgrade(req,socket,head,ws=>{
      ws.alive=true;ws.on('pong',()=>ws.alive=true);
      const stats=MUX_STATS?muxStat(route.device):null;if(stats)console.info('[mux] open',route.device);
      ws._device=route.device;
      const id=random(),host=hosts.get(route.device);const p={device:route.device,session:sessionKey(req),ws,queue:[],ready:false,stats,timeout:setTimeout(()=>finish(id,true),30000)};pending.set(id,p);
      send(host,{t:'ws-open',id,path:route.path,protocols:ws.protocol?[ws.protocol]:[]});
      ws.on('message',(b,binary)=>{if(stats){stats.inFrames++;stats.inBytes+=b.length;}const m={t:'ws-data',id,data:b.toString('base64'),binary};if(p.ready)send(host,m);else if(p.queue.length<64)p.queue.push(m);else ws.close(1009);});
      ws.on('close',()=>{if(stats)console.info('[mux] close',route.device);send(host,{t:'cancel',id});finish(id);});ws.on('error',()=>{});
    });
  });
  const heartbeat=setInterval(()=>{
    for(const ws of [...hosts.values(),...browserWss.clients]){if(!ws.alive)ws.terminate();else{ws.alive=false;ws.ping();}}
    if(MUX_STATS)for(const[id,s]of muxStats){if(s.inFrames||s.outFrames){console.info('[mux]',id,'in',s.inFrames,'frames',Math.round(s.inBytes),'B out',s.outFrames,'frames',Math.round(s.outBytes),'B');s.inFrames=s.inBytes=s.outFrames=s.outBytes=0;}}
    if(MUX_STATS)for(const client of browserWss.clients){const socket=client._socket;if(!socket)continue;const written=socket.bytesWritten,read=socket.bytesRead;if(!client._wire){client._wire={written,read};continue;}const dw=written-client._wire.written,dr=read-client._wire.read;if(dw||dr){const ext=client.extensions||'none';console.info('[mux-wire]',client._device||'?',ext,'in',dr,'B out',dw,'B');client._wire={written,read};}}
    const now=Date.now();for(const[k,t]of sessions)if(t<now)sessions.delete(k);for(const[k,c]of codes)if(c.expires<now)codes.delete(k);for(const[k,a]of attempts)if(a.until<now)attempts.delete(k);
    for(const[id,p]of pending)if(!sessions.has(p.session)){send(hosts.get(p.device),{t:'cancel',id});finish(id,true);}
  },heartbeatMs);heartbeat.unref();
  return {server,close:async()=>{clearInterval(heartbeat);for(const ws of [...wss.clients,...browserWss.clients])ws.terminate();for(const id of pending.keys())finish(id,true);await new Promise(r=>server.close(r));await saves;await authSaves;}};
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
  const password=process.env.CENTER_PASSWORD_FILE? (await readFile(process.env.CENTER_PASSWORD_FILE,'utf8')).trim():process.env.CENTER_PASSWORD;
  const {server}=await createCenter({password,publicUrl:process.env.CENTER_PUBLIC_URL,dataDir:process.env.CENTER_DATA||'./data',allowWeakPassword:process.env.CENTER_ALLOW_WEAK_PASSWORD==='true',deviceDomain:process.env.CENTER_DEVICE_DOMAIN,deviceOrigins:process.env.CENTER_DEVICE_ORIGINS!=='0'});
  server.listen(Number(process.env.PORT||4320),process.env.LISTEN_HOST||'127.0.0.1',()=>console.log('DSH Center listening'));
}
