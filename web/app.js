function alignDeviceDock(button, menu, doc, frame=null) {
  let timer=0, stopped=false;
  const win=doc.defaultView;
  const update=()=>{
    timer=0;if(stopped)return;
    const candidates=[...doc.querySelectorAll('button,[role="button"],span')].filter(el=>/^(?:[⋯…]\s*)?(?:更多|More)$/.test(el.textContent.trim())).map(el=>el.closest('button,[role="button"]')||el.parentElement).filter(Boolean);
    const rows=candidates.map(el=>el.getBoundingClientRect()).filter(r=>r.width>70&&r.width<500&&r.height>15&&r.height<80&&r.left<100&&r.top>win.innerHeight*.6);
    rows.sort((a,b)=>b.bottom-a.bottom);const row=rows[0];
    if(!row){button.style.removeProperty('top');button.style.removeProperty('left');button.style.removeProperty('bottom');menu.style.removeProperty('bottom');return;}
    const offset=frame?frame.getBoundingClientRect():{left:0,top:0};
    const x=offset.left+row.right-30, y=offset.top+row.top+(row.height-26)/2;
    button.style.left=x+'px';button.style.top=y+'px';button.style.bottom='auto';
    menu.style.bottom=Math.max(12,window.innerHeight-y+8)+'px';
  };
  const schedule=()=>{if(!timer&&!stopped)timer=setTimeout(update,80);};
  const observer=new MutationObserver(schedule);observer.observe(doc.body,{childList:true,subtree:true});
  const resize=new ResizeObserver(schedule);resize.observe(doc.documentElement);
  window.addEventListener('resize',schedule);doc.addEventListener('scroll',schedule,true);update();
  return ()=>{stopped=true;clearTimeout(timer);observer.disconnect();resize.disconnect();window.removeEventListener('resize',schedule);doc.removeEventListener('scroll',schedule,true);};
}
const $=id=>document.getElementById(id);
// Prefer the device's own origin (the center assigns one per device); it keeps
// every root-absolute URL, cookie and WebSocket of the DSH app working unchanged.
const frameUrl=d=>d?.portal||('/d/'+d.id+'/');
// Warm DNS/TCP/TLS to the device origin before the iframe asks for it.
const preconnected=new Set();
const preconnect=url=>{if(!url||preconnected.has(url))return;preconnected.add(url);for(const rel of ['preconnect','dns-prefetch']){const link=document.createElement('link');link.rel=rel;link.href=url;if(rel==='preconnect')link.crossOrigin='anonymous';document.head.append(link);}};
let settingsRequested=new URLSearchParams(location.search).has('settings');
let selected=new URLSearchParams(location.search).get('device')||localStorage.getItem('dsh-center-device')||'', loaded='',previousOnline=false,loadingSince=0,lastFrameAttempt=0;
async function api(path,options={}){const r=await fetch('/center/'+path,{cache:'no-store',signal:AbortSignal.timeout(8000),...options,headers:{'content-type':'application/json',...options.headers}});const b=await r.json();if(!r.ok)throw Object.assign(Error(b.error||'请求失败'),{status:r.status});return b;}
function signedIn(value){$('login').hidden=value;$('deviceDock').hidden=!value;if(!value)$('deviceMenu').hidden=true;for(const id of ['devices','manage','logout','reload'])$(id).hidden=!value;if(!value){$('dialog').close();$('view').hidden=true;$('view').src='about:blank';loaded='';loadingSince=0;$('empty').hidden=true;}}
let refreshing=false,lastDevices=[],migrating=false;
const scopedSession=()=>document.cookie.split(';').some(x=>x.trim()==='center_scope=1');
const connectionNotice=text=>{const el=$('connectionNotice');el.textContent=text;el.hidden=!text;};
async function refresh(){if(refreshing)return;refreshing=true;try{const{devices}=await api('devices');lastDevices=devices;signedIn(true);
 // Sessions created before device origins are host-only and would never reach
 // <id>.<domain>. Log out once so the browser re-logs in with a scoped cookie.
 if(!scopedSession()&&!migrating){migrating=true;connectionNotice('登录状态升级中，正在重新登录…');try{await api('relogin',{method:'POST',body:'{}'});}catch{}location.reload();return;}
 if(settingsRequested){settingsRequested=false;$('dialog').showModal();}$('devices').replaceChildren(new Option('选择电脑',''),...devices.map(d=>{const o=new Option(`${d.name}${d.online?'':' · 未连接中心'}`,d.id);return o;}));$('devices').value=selected;
 const d=devices.find(d=>d.id===selected);$('status').textContent=d?`${d.name} · ${d.online?(loadingSince?(Date.now()-loadingSince>20000?'在线 · 加载较慢，可重新连接':'在线 · 页面加载中'):'在线'):'未连接中心'}`:'尚未选择';
 if(d?.online){connectionNotice('');$('empty').hidden=true;$('view').hidden=false;try{preconnect(new URL(frameUrl(d)).origin);}catch{}if(loaded!==d.id){loadingSince=Date.now();lastFrameAttempt=Date.now();$('status').textContent=d.name+' · 在线 · 页面加载中';$('view').src=frameUrl(d);loaded=d.id;}}
 else{const keep=!!d&&loaded===d.id;$('view').hidden=!keep;$('empty').hidden=keep;const message=d?'设备与中心的连接已中断，正在等待自动重连。电脑可能仍在运行。':'选择一台已连接的电脑，或点击左下角图标 → 设置，添加电脑';$('empty').textContent=message;connectionNotice(keep?message:'');}
 $('settingsStatus').textContent=$('status').textContent;
 $('deviceDock').title=d?('设备中心 · '+d.name+(d.online?' · 在线':' · 未连接中心')):'设备中心';
 $('menuDevices').replaceChildren(...devices.map(device=>{const b=document.createElement('button');b.textContent=(device.id===selected?'✓ ':'')+device.name+(device.online?' · 在线':' · 未连接中心');b.onclick=async()=>{if(!device.online){const feedback=$('deviceFeedback');feedback.hidden=false;feedback.textContent='正在检查连接…';try{const latest=await api('devices');if(!latest.devices.find(x=>x.id===device.id)?.online){feedback.textContent='该设备尚未连接中心，请检查那台电脑的 DSH 和网络。';return;}}catch{feedback.textContent='无法连接中心，请稍后再试';return;}feedback.hidden=true;}selected=device.id;localStorage.setItem('dsh-center-device',selected);$('deviceMenu').hidden=true;refresh();};return b;}));
 if(d?.online&&loaded===d.id&&Date.now()-lastFrameAttempt>30000){try{const doc=$('view').contentDocument;if(doc){const text=doc.body?.innerText?.trim()||'';const failed=!text||(/^\{/.test(text)&&text.includes('error'));if(failed){loadingSince=Date.now();lastFrameAttempt=Date.now();$('view').src=frameUrl(d);connectionNotice('页面加载未完成，正在重新连接…');}}}catch{}}
 previousOnline=!!d?.online;
 $('deviceList').replaceChildren(...devices.map(d=>{const row=document.createElement('div');row.className='device';const label=document.createElement('span');label.textContent=`${d.name} · ${d.online?'在线':'未连接中心'}`;const b=document.createElement('button');b.textContent='撤销';b.onclick=async()=>{if(confirm('撤销这台电脑的接入权限？')){await api('devices/'+d.id,{method:'DELETE'});refresh();}};const rename=document.createElement('button');rename.textContent=d.remark?'修改备注':'添加备注';rename.onclick=async()=>{const remark=prompt(`给 ${d.originalName||d.name} 添加备注名（留空恢复电脑名）：`,d.remark||'');if(remark===null)return;try{await api('devices/'+d.id+'/remark',{method:'PUT',body:JSON.stringify({remark})});await refresh();}catch(e){alert(e.message);}};label.title='电脑名：'+(d.originalName||d.name);const actions=document.createElement('span');actions.style.cssText='display:flex;gap:6px;flex-wrap:wrap;flex-shrink:0';actions.append(rename,b);row.append(label,actions);return row;}));
 }catch(e){if(e.status===401){signedIn(false);connectionNotice('登录已过期，请重新登录');}else{const message=navigator.onLine?'浏览器与中心连接中断，正在自动重连；设备状态暂时未知':'浏览器网络已断开，恢复网络后将自动重连';$('status').textContent=message;$('settingsStatus').textContent=message;connectionNotice(message);for(const b of $('menuDevices').children)b.textContent=b.textContent.replace(/ · (在线|未连接中心)$/,' · 状态待更新');}}finally{refreshing=false;}}
$('login').onsubmit=async e=>{e.preventDefault();try{await api('login',{method:'POST',body:JSON.stringify({password:$('password').value})});$('password').value='';$('error').textContent='';refresh();}catch(e){$('error').textContent=e.message;}};
$('devices').onchange=()=>{selected=$('devices').value;localStorage.setItem('dsh-center-device',selected);refresh();};
let detachFrame=()=>{};
const collapseMenu=()=>{$('deviceMenu').hidden=true;};
$('view').onload=()=>{loadingSince=0;detachFrame();try{const doc=$('view').contentDocument;if(doc){const stopAlign=alignDeviceDock($('deviceDock'),$('deviceMenu'),doc,$('view'));doc.addEventListener('pointerdown',collapseMenu,true);doc.addEventListener('keydown',frameKey,true);detachFrame=()=>{stopAlign();doc.removeEventListener('pointerdown',collapseMenu,true);doc.removeEventListener('keydown',frameKey,true);};}}catch{}};
function frameKey(e){if(e.key==='Escape')collapseMenu();}
window.addEventListener('blur',()=>{setTimeout(()=>{if(document.activeElement===$('view'))collapseMenu();},0);});
$('reload').onclick=()=>{loaded='';refresh();};
$('manage').onclick=()=>$('dialog').showModal();$('close').onclick=()=>$('dialog').close();
$('pair').onclick=async()=>{try{const b=await api('codes',{method:'POST',body:'{}'});$('code').textContent=b.code;}catch(e){$('code').textContent=e.message;}};
$('logout').onclick=async()=>{await api('logout',{method:'POST',body:'{}'});signedIn(false);};
refresh();setInterval(refresh,5000);
window.addEventListener('online',refresh);window.addEventListener('offline',()=>connectionNotice('浏览器网络已断开，恢复网络后将自动重连'));
window.addEventListener('focus',refresh);document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh();});

$('settingsActions').append($('reload'),$('logout'));
$('deviceDock').onclick=()=>{$('deviceMenu').hidden=!$('deviceMenu').hidden;if(!$('deviceMenu').hidden){$('deviceFeedback').hidden=true;refresh();}};
$('settings').onclick=()=>{$('deviceMenu').hidden=true;$('dialog').showModal();};
document.addEventListener('pointerdown',e=>{if(!e.target.closest('#deviceDock,#deviceMenu'))collapseMenu();},true);
document.addEventListener('keydown',e=>{if(e.key==='Escape')$('deviceMenu').hidden=true;});
// The framed device page is cross-origin, so it reports where its sidebar footer
// row sits instead of the center measuring the iframe's DOM.
window.addEventListener('message',e=>{
  const d=lastDevices.find(x=>x.id===selected);
  if(!d||!d.portal)return;
  let origin='';try{origin=new URL(d.portal).origin;}catch{return;}
  if(e.origin!==origin)return;
  const m=e.data;if(!m||m.type!=='dsh-center:dock')return;
  const frame=$('view').getBoundingClientRect();
  const x=Math.min(Math.max(8,frame.left+m.right-30),window.innerWidth-34);
  const y=Math.min(Math.max(8,frame.top+m.top+(m.height-26)/2),window.innerHeight-34);
  $('deviceDock').style.left=x+'px';$('deviceDock').style.top=y+'px';$('deviceDock').style.bottom='auto';
  $('deviceMenu').style.bottom=Math.max(12,window.innerHeight-y+8)+'px';
});

