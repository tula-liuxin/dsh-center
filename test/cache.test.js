import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createCenter} from '../server.js';
import {connectHost} from '../plugin/tunnel.js';
const listen=s=>new Promise(r=>s.listen(0,'127.0.0.1',()=>r(`http://127.0.0.1:${s.address().port}`)));
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const request=(url,{host='localhost',path='/',method='GET',headers={},body}={})=>new Promise((resolve,reject)=>{
  const u=new URL(url);
  const req=http.request({host:'127.0.0.1',port:u.port,path,method,headers:{host,...headers}},res=>{
    const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks)}));
  });
  req.on('error',reject);if(body!==undefined)req.write(body);req.end();
});
test('static assets are cached in the center and served without the device',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'center-cache-test-'));
  const center=await createCenter({password:'a-long-test-password',publicUrl:'http://localhost',dataDir:dir,secure:false});
  const url=await listen(center.server);
  const asset='/* representative asset */\n'.repeat(5000);
  let assetHits=0;
  const upstream=http.createServer((req,res)=>{
    if(req.url==='/assets/app-abcdef.js'){assetHits++;res.setHeader('content-type','text/javascript');res.setHeader('etag','"v1"');res.end(asset);return;}
    if(req.url==='/api/session'){res.setHeader('content-type','application/json');res.end('{"ok":true}');return;}
    res.statusCode=404;res.end('missing');
  });
  const local=await listen(upstream);
  let stop=()=>{};
  try{
    const login=await request(url,{path:'/center/login',method:'POST',headers:{origin:'http://localhost','content-type':'application/json'},body:JSON.stringify({password:'a-long-test-password'})});
    assert.equal(login.status,200);
    const cookie=login.headers['set-cookie'][0].split(';')[0];
    const {code}=JSON.parse((await request(url,{path:'/center/codes',method:'POST',headers:{origin:'http://localhost',cookie,'content-type':'application/json'},body:'{}'})).body.toString());
    const pair=await request(url,{path:'/center/pair',method:'POST',headers:{origin:'http://localhost','content-type':'application/json'},body:JSON.stringify({code,name:'A'})});
    const device=JSON.parse(pair.body.toString());
    stop=connectHost({...device,server:url},async()=>({origin:local,cookie:'local-secret'}),{retryMs:30});
    for(let i=0;i<40;i++){const d=JSON.parse((await request(url,{path:'/center/devices',headers:{cookie}})).body.toString());if(d.devices.every(x=>x.online))break;await wait(25);}
    const path='/d/'+device.id+'/assets/app-abcdef.js';
    const first=await request(url,{path,headers:{cookie,origin:'http://localhost','accept-encoding':'gzip'}});
    assert.equal(first.status,200);
    assert.equal(assetHits,1);
    assert.equal(first.headers['cache-control'],'private, max-age=31536000, immutable');
    assert.ok(first.headers.vary.includes('Accept-Encoding'));
    const gzipAccept=first.headers['content-encoding']==='gzip';
    assert.equal(gzipAccept,true);
    const second=await request(url,{path,headers:{cookie,origin:'http://localhost','accept-encoding':'gzip'}});
    assert.equal(second.status,200);
    assert.equal(assetHits,1,'second hit must come from the center cache');
    assert.equal(second.body.toString(),first.body.toString());
    const revalidate=await request(url,{path,headers:{cookie,origin:'http://localhost','if-none-match':'"v1"'}});
    assert.equal(revalidate.status,304);
    // A cache hit must survive the device going offline.
    stop();stop=()=>{};
    for(let i=0;i<40;i++){const d=JSON.parse((await request(url,{path:'/center/devices',headers:{cookie}})).body.toString());if(d.devices.every(x=>!x.online))break;await wait(25);}
    const offlineAsset=await request(url,{path,headers:{cookie,origin:'http://localhost','accept-encoding':'gzip'}});
    assert.equal(offlineAsset.status,200,'cached asset must be served while the device is offline');
    assert.equal((await request(url,{path:'/d/'+device.id+'/api/session',headers:{cookie,origin:'http://localhost'}})).status,503);
  }finally{stop();await new Promise(r=>upstream.close(r));await center.close();await rm(dir,{recursive:true,force:true});}
});
