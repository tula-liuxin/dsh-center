#!/usr/bin/env node
import {createInterface} from 'node:readline/promises';
import {mkdir,writeFile} from 'node:fs/promises';
import {homedir,hostname} from 'node:os';
import {join,dirname} from 'node:path';
const rl=createInterface({input:process.stdin,output:process.stdout});
try{
 const server=(await rl.question('设备中心地址 [https://dsh.agencyarche.com]: ')).trim()||'https://dsh.agencyarche.com';
 if(new URL(server).protocol!=='https:')throw Error('需要 HTTPS 地址');
 const code=(await rl.question('一次性配对码: ')).trim();
 const name=(await rl.question(`电脑名称 [${hostname()}]: `)).trim()||hostname();
 const r=await fetch(new URL('/center/pair',server),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code,name}),redirect:'error'});
 const b=await r.json();if(!r.ok)throw Error(b.error||'配对失败');
 const path=process.env.DSH_CENTER_CONFIG||join(homedir(),'.dsh-center','host.json');
 await mkdir(dirname(path),{recursive:true});await writeFile(path,JSON.stringify(b),{mode:0o600});
 console.log('配对成功。重新加载接入插件或重启 DSH 后上线。');
}catch(e){console.error(e.message);process.exitCode=1;}finally{rl.close();}
