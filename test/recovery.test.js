import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {WebSocketServer,WebSocket} from 'ws';
import {createCenter} from '../server.js';
import {connectHost} from '../plugin/tunnel.js';
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const listen=s=>new Promise(r=>s.listen(0,'127.0.0.1',()=>r(`http://127.0.0.1:${s.address().port}`)));
const opened=ws=>new Promise((yes,no)=>{ws.once('open',yes);ws.once('error',no)});
test('large concurrent assets preserve tunnel; replaced host closes old streams; browser heartbeat stays alive',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'center-recovery-'));
 const center=await createCenter({password:'a-long-test-password',publicUrl:'http://localhost',dataDir:dir,secure:false,heartbeatMs:1000});
 const url=await listen(center.server);let stop=()=>{},replacement;
 const upstream=http.createServer((req,res)=>{res.setHeader('content-type','text/javascript');res.end('x'.repeat(24*1024*1024));});
 const local=await listen(upstream);const echo=new WebSocketServer({server:upstream});echo.on('connection',s=>{s.on('error',()=>{});s.on('message',b=>s.send(b));});
 const login=await fetch(url+'/center/login',{method:'POST',headers:{origin:'http://localhost','content-type':'application/json'},body:JSON.stringify({password:'a-long-test-password'})});const cookie=login.headers.get('set-cookie').split(';')[0];
 const api=async(path,method='GET',body)=>fetch(url+path,{method,headers:{cookie,origin:'http://localhost','content-type':'application/json'},body:body&&JSON.stringify(body)});
 let browser;
 try{
  const {code}=await(await api('/center/codes','POST',{})).json();const device=await(await api('/center/pair','POST',{code,name:'test'})).json();
  let authCalls=0;stop=connectHost({...device,server:url},async()=>{authCalls++;return{origin:local,cookie:'test'}},{retryMs:10});
  for(let i=0;i<50;i++){if((await(await api('/center/devices')).json()).devices[0].online)break;await wait(20);}
  await Promise.all([1,2,3].map(async i=>{const r=await api('/d/'+device.id+'/assets/large-'+i+'.js');assert.equal((await r.arrayBuffer()).byteLength,24*1024*1024);}));
  const state=(await(await api('/center/devices')).json()).devices[0];assert.equal(state.connection,'connected');assert.ok(state.lastSeen);
  browser=new WebSocket(url.replace('http','ws')+'/d/'+device.id+'/echo',{headers:{cookie,origin:'http://localhost'}});await opened(browser);
  await wait(2500);assert.equal(browser.readyState,WebSocket.OPEN);assert.ok(authCalls>=2,'fresh auth for websocket');
  const closed=new Promise((yes,no)=>{const timer=setTimeout(()=>no(Error('old browser socket stranded')),1500);browser.once('close',code=>{clearTimeout(timer);assert.equal(code,1011);yes();});});
  replacement=new WebSocket(url.replace('http','ws')+'/center/host',{headers:{authorization:'Bearer '+device.token}});await opened(replacement);await closed;
 }finally{stop();browser?.terminate();replacement?.terminate();for(const s of echo.clients)s.terminate();echo.close();await new Promise(r=>upstream.close(r));await center.close();await rm(dir,{recursive:true,force:true});}
});
test('dispose during pending auth prevents stale retry/status updates',async()=>{
 let reject,calls=0;const states=[];
 const stop=connectHost({server:'http://127.0.0.1:1',token:'test'},()=>{calls++;return new Promise((_yes,no)=>reject=no);},{retryMs:5,onStatus:s=>states.push(s)});
 stop();reject(Error('disposed'));await wait(30);assert.equal(calls,1);assert.deepEqual(states,[]);
});

