const $=id=>document.getElementById(id);
let settingsRequested=new URLSearchParams(location.search).has('settings');
let selected=new URLSearchParams(location.search).get('device')||localStorage.getItem('dsh-center-device')||'', loaded='',previousOnline=false,loadingSince=0;
async function api(path,options={}){const r=await fetch('/center/'+path,{...options,headers:{'content-type':'application/json',...options.headers}});const b=await r.json();if(!r.ok)throw Object.assign(Error(b.error||'请求失败'),{status:r.status});return b;}
function signedIn(value){$('login').hidden=value;$('deviceDock').hidden=!value;if(!value)$('deviceMenu').hidden=true;for(const id of ['devices','manage','logout','reload'])$(id).hidden=!value;if(!value){$('dialog').close();$('view').hidden=true;$('view').src='about:blank';loaded='';loadingSince=0;$('empty').hidden=true;}}
async function refresh(){try{const{devices}=await api('devices');signedIn(true);if(settingsRequested){settingsRequested=false;$('dialog').showModal();}$('devices').replaceChildren(new Option('选择电脑',''),...devices.map(d=>{const o=new Option(`${d.name}${d.online?'':' · 离线'}`,d.id);return o;}));$('devices').value=selected;
 const d=devices.find(d=>d.id===selected);$('status').textContent=d?`${d.name} · ${d.online?(loadingSince?(Date.now()-loadingSince>20000?'在线 · 加载较慢，可重新连接':'在线 · 页面加载中'):'在线'):'离线'}`:'尚未选择';
 if(d?.online){$('empty').hidden=true;$('view').hidden=false;if(loaded!==d.id||!previousOnline){loadingSince=Date.now();$('status').textContent=d.name+' · 在线 · 页面加载中';$('view').src='/d/'+d.id+'/';loaded=d.id;}}
 else{$('view').hidden=true;$('empty').hidden=false;$('empty').textContent=d?'这台电脑已离线。可手动切换其他设备，原任务不会迁移。':'选择一台在线电脑，或点击左下角图标 → 设置，添加电脑';}
 $('settingsStatus').textContent=$('status').textContent;
 $('deviceDock').title=d?('设备中心 · '+d.name+(d.online?' · 在线':' · 离线')):'设备中心';
 $('menuDevices').replaceChildren(...devices.map(device=>{const b=document.createElement('button');b.textContent=(device.id===selected?'✓ ':'')+device.name+(device.online?' · 在线':' · 离线');b.disabled=!device.online;b.onclick=()=>{selected=device.id;localStorage.setItem('dsh-center-device',selected);$('deviceMenu').hidden=true;refresh();};return b;}));
 previousOnline=!!d?.online;
 $('deviceList').replaceChildren(...devices.map(d=>{const row=document.createElement('div');row.className='device';const label=document.createElement('span');label.textContent=`${d.name} · ${d.online?'在线':'离线'}`;const b=document.createElement('button');b.textContent='撤销';b.onclick=async()=>{if(confirm('撤销这台电脑的接入权限？')){await api('devices/'+d.id,{method:'DELETE'});refresh();}};row.append(label,b);return row;}));
 }catch(e){if(e.status===401)signedIn(false);else $('status').textContent='中心连接中断，正在重试';}}
$('login').onsubmit=async e=>{e.preventDefault();try{await api('login',{method:'POST',body:JSON.stringify({password:$('password').value})});$('password').value='';$('error').textContent='';refresh();}catch(e){$('error').textContent=e.message;}};
$('devices').onchange=()=>{selected=$('devices').value;localStorage.setItem('dsh-center-device',selected);refresh();};
$('view').onload=()=>{loadingSince=0;};
$('reload').onclick=()=>{loaded='';refresh();};
$('manage').onclick=()=>$('dialog').showModal();$('close').onclick=()=>$('dialog').close();
$('pair').onclick=async()=>{try{const b=await api('codes',{method:'POST',body:'{}'});$('code').textContent=b.code;}catch(e){$('code').textContent=e.message;}};
$('logout').onclick=async()=>{await api('logout',{method:'POST',body:'{}'});signedIn(false);};
refresh();setInterval(refresh,5000);

$('settingsActions').append($('reload'),$('logout'));
$('deviceDock').onclick=()=>{$('deviceMenu').hidden=!$('deviceMenu').hidden;};
$('settings').onclick=()=>{$('deviceMenu').hidden=true;$('dialog').showModal();};
document.addEventListener('click',e=>{if(!e.target.closest('#deviceDock,#deviceMenu'))$('deviceMenu').hidden=true;});
document.addEventListener('keydown',e=>{if(e.key==='Escape')$('deviceMenu').hidden=true;});

