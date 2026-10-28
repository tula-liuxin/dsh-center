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
/** Talks to the center exactly like a browser that resolved <id>.center.test to this box. */
const request=(url,{host,path='/',method='GET',headers={},body}={})=>new Promise((resolve,reject)=>{
  const u=new URL(url);
  const req=http.request({host:'127.0.0.1',port:u.port,path,method,headers:{host,...headers}},res=>{
    const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks).toString('utf8')}));
  });
  req.on('error',reject);if(body!==undefined)req.write(body);req.end();
});
test('each device gets its own origin, so the app lives at the real root path',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'center-origin-test-'));
  const center=await createCenter({password:'a-long-test-password',publicUrl:'https://center.test',deviceDomain:'center.test',dataDir:dir,secure:true});
  const url=await listen(center.server);
  const upstream=http.createServer((req,res)=>{
    if(req.url==='/'){res.setHeader('content-type','text/html');res.end('<html><head></head><body>DSH</body></html>');return;}
    if(req.url==='/assets/app-abcdef.js'){res.setHeader('content-type','text/javascript');res.end('console.log(1)');return;}
    if(req.url==='/leo-status/api/todos'){res.setHeader('content-type','application/json');res.end('{"ok":true}');return;}
    let b='';req.on('data',c=>b+=c);req.on('end',()=>res.end(req.url+':'+b+':'+req.method));
  });
  const local=await listen(upstream);
  const echo=new WebSocketServer({server:upstream});
  echo.on('connection',ws=>{ws.on('error',()=>{});ws.on('message',(b,binary)=>ws.send(b.toString(),{binary}));});
  let stop=()=>{};
  try{
    const login=await request(url,{host:'center.test',path:'/center/login',method:'POST',headers:{origin:'https://center.test','content-type':'application/json'},body:JSON.stringify({password:'a-long-test-password'})});
    assert.equal(login.status,200);
    assert.match(login.headers['set-cookie'][0],/Domain=center\.test/);
    assert.match(login.headers['set-cookie'][0],/Secure/);
    const cookie=login.headers['set-cookie'][0].split(';')[0];
    const {code}=JSON.parse((await request(url,{host:'center.test',path:'/center/codes',method:'POST',headers:{origin:'https://center.test',cookie,'content-type':'application/json'},body:'{}'})).body);
    const pair=await request(url,{host:'center.test',path:'/center/pair',method:'POST',headers:{origin:'https://center.test','content-type':'application/json'},body:JSON.stringify({code,name:'A'})});
    assert.equal(pair.status,200);
    const device=JSON.parse(pair.body);
    assert.equal(device.portal,`https://${device.id}.center.test/`);
    stop=connectHost({...device,server:url},async()=>({origin:local,cookie:'local-secret'}),{retryMs:30});
    for(let i=0;i<40;i++){const d=JSON.parse((await request(url,{host:'center.test',path:'/center/devices',headers:{cookie}})).body);if(d.devices.every(x=>x.online))break;await wait(25);}
    const devices=JSON.parse((await request(url,{host:'center.test',path:'/center/devices',headers:{cookie}})).body);
    assert.equal(devices.devices.find(x=>x.id===device.id).portal,`https://${device.id}.center.test/`);
    const hostDevices=JSON.parse((await request(url,{host:'center.test',path:'/center/host-devices',headers:{authorization:`Bearer ${device.token}`}})).body);
    assert.ok(!JSON.stringify(hostDevices).includes(device.token));
    assert.equal(hostDevices.devices.find(x=>x.id===device.id).portal,`https://${device.id}.center.test/`);
    const host=`${device.id}.center.test`,origin='https://'+host;
    assert.equal((await request(url,{host,path:'/'})).status,401);
    const index=await request(url,{host,path:'/',headers:{cookie,origin}});
    assert.equal(index.status,200);
    assert.match(index.body,/__DSH_TRANSPORT__=\{ownsHost:true\}/);
    assert.match(index.body,/__DSH_CENTER_PORTAL__=true/);
    assert.equal((await request(url,{host,path:'/assets/app-abcdef.js',headers:{cookie,origin}})).body,'console.log(1)');
    assert.equal((await request(url,{host,path:'/leo-status/api/todos',headers:{cookie,origin}})).body,'{"ok":true}');
    assert.equal((await request(url,{host,path:'/echo',method:'POST',headers:{cookie,origin},body:'hi'})).status,200);
    assert.equal((await request(url,{host,path:'/echo',method:'POST',headers:{cookie,origin:'https://evil.test'},body:'hi'})).status,403);
    assert.equal((await request(url,{host:'0123456789abcdef01234567.center.test',path:'/',headers:{cookie}})).status,404);
    assert.equal((await request(url,{host:'center.test',path:'/d/'+device.id+'/',headers:{cookie,origin:'https://center.test'}})).status,200);
    assert.equal((await request(url,{host:'center.test',path:`/center/tls-ask?domain=${host}`})).status,200);
    assert.equal((await request(url,{host:'center.test',path:'/center/tls-ask?domain=foo.center.test'})).status,403);
    assert.equal((await request(url,{host:'center.test',path:'/center/tls-ask?domain=evil.test'})).status,403);
    const ws=new WebSocket(url.replace('http:','ws:')+'/echo',{headers:{host,origin,cookie}});
    await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{ws.terminate();reject(Error('device origin websocket timed out'));},3000);ws.once('open',()=>ws.send('roundtrip'));ws.once('message',b=>{clearTimeout(timer);assert.equal(b.toString(),'roundtrip');ws.close();resolve();});ws.once('error',e=>{clearTimeout(timer);reject(e);});});
  }finally{stop();echo.close();await new Promise(r=>upstream.close(r));await center.close();await rm(dir,{recursive:true,force:true});}
});
