import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {WebSocketServer,WebSocket} from 'ws';
import {createCenter} from '../server.js';
import {connectHost} from '../plugin/tunnel.js';
const listen=s=>new Promise(r=>s.listen(0,'127.0.0.1',()=>r(`http://127.0.0.1:${s.address().port}`)));
const wait=ms=>new Promise(r=>setTimeout(r,ms));
test('authentication, pairing, isolated devices, streaming, websocket, revocation and offline',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'dsh-center-test-'));
 const center=await createCenter({password:'a-long-test-password',publicUrl:'http://localhost',dataDir:dir,secure:false});
 const url=await listen(center.server);let stopA=()=>{},stopB=()=>{};
 const upstream=http.createServer((req,res)=>{
   assert.equal(req.headers.cookie,'local-secret');assert.equal(req.headers.authorization,undefined);
   if(req.url==='/'){res.setHeader('content-type','text/html');res.end('<html><head></head><body>DSH</body></html>');return;}
   if(req.url==='/assets/test-abcdef.js'){res.setHeader('content-type','text/javascript');res.end('/* representative script */\n'.repeat(100000));return;}
   if(req.url==='/stream'){res.writeHead(200,{'content-type':'text/event-stream'});res.write('data: first\n\n');setTimeout(()=>res.end('data: second\n\n'),80);return;}
   let b='';req.on('data',x=>b+=x);req.on('end',()=>res.end(req.url+':'+b));
 });
 const local=await listen(upstream);const echo=new WebSocketServer({server:upstream});echo.on('connection',ws=>{ws.on('error',()=>{});ws.on('message',(b,binary)=>ws.send(b.toString()==='large-session'?'会话内容'.repeat(300000):b,{binary}));});
 let cookie;
 const api=async(path,method='GET',body,auth=true,origin='http://localhost')=>fetch(url+path,{method,headers:{origin,...(auth&&cookie?{cookie}:{}),'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
 try{
   assert.equal((await api('/center/devices')).status,401);
   assert.equal((await api('/center/login','POST',{password:'a-long-test-password'},false,'https://evil.test')).status,403);
   assert.equal((await api('/center/login','POST',{password:'wrong'})).status,401);
   const login=await api('/center/login','POST',{password:'a-long-test-password'});assert.equal(login.status,200);cookie=login.headers.get('set-cookie').split(';')[0];
   const pair=async name=>{const{code}=await(await api('/center/codes','POST',{})).json();const r=await api('/center/pair','POST',{code,name},false);assert.equal(r.status,200);assert.equal((await api('/center/pair','POST',{code,name},false)).status,401);return{...await r.json(),server:url};};
   const a=await pair('A'),b=await pair('B');
   assert.equal((await api('/center/host-devices')).status,401);
   const hostDevices=await(await fetch(url+'/center/host-devices',{headers:{authorization:`Bearer ${a.token}`}})).json();
   assert.equal((await api('/center/devices/'+a.id+'/remark','PUT',{remark:'家里电脑'},false)).status,401);
   assert.equal((await api('/center/devices/'+a.id+'/remark','PUT',{remark:'家里电脑'},true,'https://evil.test')).status,403);
   assert.equal((await api('/center/devices/'+a.id+'/remark','PUT',{remark:'家里电脑'})).status,200);
   const renamed=await(await fetch(url+'/center/host-devices',{headers:{authorization:`Bearer ${a.token}`}})).json();
   assert.equal(renamed.devices.find(d=>d.id===a.id).name,'家里电脑');assert.equal(renamed.devices.find(d=>d.id===a.id).originalName,'A');
   assert.equal(JSON.parse(await (await import('node:fs/promises')).readFile(join(dir,'devices.json'),'utf8'))[a.id].remark,'家里电脑');
   assert.equal((await api('/center/devices/'+a.id+'/remark','PUT',{remark:'x'.repeat(61)})).status,400);
   assert.equal((await api('/center/devices/'+a.id+'/remark','PUT',{remark:'  '})).status,200);
   assert.equal((await(await api('/center/devices')).json()).devices.find(d=>d.id===a.id).name,'A');
   assert.equal(hostDevices.devices.length,2);assert.ok(!JSON.stringify(hostDevices).includes('token'));
   stopA=connectHost(a,async()=>({origin:local,cookie:'local-secret'}),{retryMs:30});
   stopB=connectHost(b,async()=>({origin:local,cookie:'local-secret'}),{retryMs:30});
   for(let i=0;i<40;i++){const d=await(await api('/center/devices')).json();if(d.devices.every(x=>x.online))break;await wait(25);}
   const d=await(await api('/center/devices')).json();assert.equal(d.devices.filter(x=>x.online).length,2);assert.ok(!JSON.stringify(d).includes('tokenHash'));
   assert.equal((await api('/d/'+a.id+'/hello','GET',undefined,false)).status,401);
   assert.match(await(await api('/d/'+a.id+'/')).text(),/__DSH_TRANSPORT__=\{ownsHost:true\}/);
   assert.equal((await api('/d/'+a.id+'/center-host/setup')).status,403);
   const asset=await fetch(url+'/d/'+a.id+'/assets/test-abcdef.js',{headers:{cookie,'accept-encoding':'gzip'}});
   assert.equal(asset.headers.get('content-encoding'),'gzip');assert.match(asset.headers.get('cache-control'),/private/);
   assert.equal(await asset.text(),'/* representative script */\n'.repeat(100000));
   assert.equal(await(await api('/d/'+a.id+'/hello?q=1','POST',{hello:'world'})).text(),'/hello?q=1:{"hello":"world"}');
   const stream=await api('/d/'+b.id+'/stream');const reader=stream.body.getReader();const first=await reader.read();assert.match(new TextDecoder().decode(first.value),/first/);let rest='';for(;;){const x=await reader.read();if(x.done)break;rest+=new TextDecoder().decode(x.value);}assert.match(rest,/second/);
   const ws=new WebSocket(url.replace('http:','ws:')+'/d/'+a.id+'/echo',{headers:{origin:'http://localhost',cookie}});
   await new Promise((resolve,reject)=>{ws.once('open',()=>ws.send('roundtrip'));ws.once('message',b=>{assert.equal(b.toString(),'roundtrip');ws.close();resolve();});ws.once('error',reject);});
   const large=new WebSocket(url.replace('http:','ws:')+'/d/'+a.id+'/echo',{headers:{origin:'http://localhost',cookie}});
   await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{large.terminate();reject(Error('large session timed out'));},3000);large.once('open',()=>large.send('large-session'));large.once('message',data=>{clearTimeout(timer);assert.equal(data.toString(),'会话内容'.repeat(300000));large.close();resolve();});large.once('close',code=>{clearTimeout(timer);reject(Error('session transfer closed: '+code));});large.once('error',reject);});
   assert.equal((await(await api('/center/devices')).json()).devices.find(x=>x.id===a.id).online,true);
   const oversized=new WebSocket(url.replace('http:','ws:')+'/d/'+a.id+'/echo',{headers:{origin:'http://localhost',cookie}});
   await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{oversized.terminate();reject(Error('oversized request not rejected'));},2000);oversized.once('open',()=>oversized.send(Buffer.alloc(1100000)));oversized.once('close',code=>{clearTimeout(timer);assert.equal(code,1009);resolve();});oversized.once('error',reject);});
   assert.equal((await(await api('/center/devices')).json()).devices.find(x=>x.id===a.id).online,true);
   const active=new WebSocket(url.replace('http:','ws:')+'/d/'+b.id+'/echo',{headers:{origin:'http://localhost',cookie}});
   await new Promise((resolve,reject)=>{active.once('open',resolve);active.once('error',reject);});
   const closed=new Promise((resolve,reject)=>{const timer=setTimeout(()=>{active.terminate();reject(Error('logout did not close existing socket'));},2000);active.once('close',()=>{clearTimeout(timer);resolve();});});
   assert.equal((await api('/center/logout','POST',{})).status,200);await closed;
   assert.equal((await api('/center/devices')).status,401);
   const again=await api('/center/login','POST',{password:'a-long-test-password'});cookie=again.headers.get('set-cookie').split(';')[0];
   assert.equal((await api('/center/devices/'+a.id,'DELETE')).status,200);await wait(50);assert.equal((await api('/d/'+a.id+'/hello')).status,404);
   stopB();await wait(50);assert.equal((await api('/d/'+b.id+'/hello')).status,503);
 }finally{stopA();stopB();echo.close();await new Promise(r=>upstream.close(r));await center.close();await rm(dir,{recursive:true,force:true});}
});


test('host reconnects when center stops sending heartbeats without closing TCP', async()=>{
 const server=http.createServer();const url=await listen(server);
 const wss=new WebSocketServer({server});let connections=0;const statuses=[];
 wss.on('connection',ws=>{connections++;ws.on('error',()=>{});});
 const stop=connectHost({server:url,token:'test'},async()=>({origin:url,cookie:'test'}),{heartbeatTimeoutMs:80,retryMs:10,onStatus:s=>statuses.push(s)});
 try{
  for(let i=0;i<100&&connections<2;i++)await wait(25);
  assert.ok(connections>=2,'silent connection must reconnect');
  assert.ok(statuses.some(s=>s.includes('心跳超时')));
  assert.ok(statuses.some(s=>s.includes('已断开')));
 }finally{stop();for(const ws of wss.clients)ws.terminate();await new Promise(r=>wss.close(r));await new Promise(r=>server.close(r));}
});


test('browser login survives restart, logout persists, password change revokes sessions', async()=>{
 const dir=await mkdtemp(join(tmpdir(),'center-auth-test-'));let center;
 const boot=async(password='a-long-test-password')=>{center=await createCenter({password,publicUrl:'http://localhost',dataDir:dir,secure:false});return listen(center.server);};
 const login=async url=>{const r=await fetch(url+'/center/login',{method:'POST',headers:{origin:'http://localhost','content-type':'application/json'},body:JSON.stringify({password:'a-long-test-password'})});assert.equal(r.status,200);assert.match(r.headers.get('set-cookie'),/Max-Age=2592000/);return r.headers.get('set-cookie').split(';')[0];};
 const check=(url,cookie)=>fetch(url+'/center/devices',{headers:{cookie}});
 try{
  let url=await boot();let cookie=await login(url);await center.close();
  url=await boot();assert.equal((await check(url,cookie)).status,200);
  assert.equal((await fetch(url+'/center/logout',{method:'POST',headers:{cookie,origin:'http://localhost'}})).status,200);await center.close();
  url=await boot();assert.equal((await check(url,cookie)).status,401);cookie=await login(url);await center.close();
  url=await boot('a-different-long-password');assert.equal((await check(url,cookie)).status,401);
 }finally{await center.close();await rm(dir,{recursive:true,force:true});}
});
