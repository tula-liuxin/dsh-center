window.__ModuleLoader__.load({id:'dsh-center-host',factory(){
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
  return {apply(ctx){
    if(location.pathname.startsWith('/d/'))return;
    const root=document.createElement('div');root.id='dsh-center-dock';
    root.innerHTML=`<style>
#dsh-center-dock{font:13px system-ui;color:#18202e}#dsh-center-dock button,#dsh-center-dock input{font:inherit;border:1px solid #d8dce3;border-radius:8px;padding:8px;background:white;color:inherit}#dsh-center-dock button{cursor:pointer}#dsh-center-dock [hidden]{display:none!important}#dsh-center-dock .dock{position:fixed;left:240px;bottom:10px;width:26px;height:26px;padding:0;z-index:2147483600;background:#f7f8fa;font-size:16px;line-height:1;display:grid;place-items:center;box-sizing:border-box;color:#596579}#dsh-center-dock .menu{position:fixed;left:12px;bottom:52px;width:260px;max-height:65vh;overflow:auto;z-index:2147483601;background:white;border:1px solid #e2e5ea;border-radius:12px;padding:6px;box-shadow:0 8px 28px #0002}#dsh-center-dock .menu button{display:block;width:100%;border:0;text-align:left;padding:10px}#dsh-center-dock .menu button:hover{background:#f1f4fa}#dsh-center-dock dialog{border:1px solid #e2e5ea;border-radius:14px;padding:24px;width:min(440px,85vw);color:#18202e;background:white}#dsh-center-dock dialog::backdrop{background:#0004}#dsh-center-dock form{display:grid;gap:12px}#dsh-center-dock input{display:block;width:100%;box-sizing:border-box;margin-top:4px}#dsh-center-dock .hint{color:#667085;line-height:1.6}@media(max-width:600px){#dsh-center-dock .dock{left:12px;bottom:12px}}
</style><button class="dock" title="设备中心" aria-label="设备中心">⇄</button><div class="menu" hidden><button data-action="settings">⚙ 设置</button><div class="devices"></div><div class="feedback" role="status" style="padding:4px 10px;color:#667085" hidden></div></div><dialog><h3>设备中心设置</h3><form><label>中心地址<input name="server" type="url" required></label><label>电脑名称<input name="name" required maxlength="60"></label><label>一次性配对码<input name="code" required autocomplete="off"></label><div class="status" role="status"></div><button type="submit">配对</button></form><p class="hint">配对码在网页设备中心的设置中生成。</p><button data-action="manage">设备管理、重新连接与退出登录 ↗</button><button data-action="close">关闭</button></dialog>`;
    document.body.append(root);
    const $=q=>root.querySelector(q), menu=$('.menu'), dialog=$('dialog'),form=$('form');let config={server:'https://dsh.agencyarche.com',devices:[]};
    function openCenter(id,settings=false){const url=new URL(config.server);if(id)url.searchParams.set('device',id);if(settings)url.searchParams.set('settings','1');window.open(url.href,'_blank','noopener,noreferrer');}
    let loading=false, disposed=false;
    async function load(){if(loading||disposed)return;loading=true;try{const r=await fetch('center-host/setup',{cache:'no-store',signal:AbortSignal.timeout(8000)});if(!r.ok)throw Error('无法读取接入状态');config=await r.json();if(disposed)return;if(!dialog.open){form.elements.server.value=config.server;form.elements.name.value=config.name;}$('.status').textContent=config.status==='online'?'已连接':config.status;
      $('.devices').replaceChildren(...(config.devices||[]).map(d=>{const b=document.createElement('button');b.textContent=(d.id===config.id?'✓ ':'')+d.name+(d.online?' · 在线':' · 离线');b.onclick=async()=>{const feedback=$('.feedback');if(!d.online){feedback.hidden=false;feedback.textContent='正在检查连接…';await load();const fresh=config.devices?.find(x=>x.id===d.id);if(!fresh?.online){feedback.textContent='该设备尚未连接中心，请检查那台电脑的 DSH 和网络。';return;}}feedback.hidden=true;menu.hidden=true;if(d.id!==config.id)openCenter(d.id);};return b;}));
      if(!config.devices?.length){const b=document.createElement('button');b.textContent='打开设备中心 ↗';b.onclick=()=>openCenter();$('.devices').append(b);}
    }catch(e){$('.status').textContent=e.message;$('.devices').textContent='状态暂不可用，正在重试';}finally{loading=false;}}
    $('.dock').onclick=()=>{menu.hidden=!menu.hidden;if(!menu.hidden){$('.feedback').hidden=true;load();}};
    $('[data-action=settings]').onclick=()=>{menu.hidden=true;dialog.showModal();load();};
    $('[data-action=close]').onclick=()=>dialog.close();
    $('[data-action=manage]').onclick=()=>openCenter(null,true);
    form.onsubmit=async e=>{e.preventDefault();const button=form.querySelector('button');button.disabled=true;try{const r=await fetch('center-host/setup',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({server:form.elements.server.value,name:form.elements.name.value,code:form.elements.code.value})});const b=await r.json();if(!r.ok)throw Error(b.error);form.elements.code.value='';$('.status').textContent='配对成功';}catch(e){$('.status').textContent=e.message;}finally{button.disabled=false;}};
    const refreshTimer=setInterval(()=>{if(!menu.hidden&&!document.hidden)load();},5000);
    const stopAlign=alignDeviceDock($('.dock'),menu,document);
    const outside=e=>{if(!root.contains(e.target))menu.hidden=true;};const key=e=>{if(e.key==='Escape')menu.hidden=true;};const blur=()=>{setTimeout(()=>{if(document.activeElement?.tagName==='IFRAME')menu.hidden=true;},0);};window.addEventListener('blur',blur);document.addEventListener('pointerdown',outside,true);document.addEventListener('keydown',key);
    ctx.on('dispose',()=>{disposed=true;clearInterval(refreshTimer);stopAlign();root.remove();window.removeEventListener('blur',blur);document.removeEventListener('pointerdown',outside,true);document.removeEventListener('keydown',key);});
  }};
}});
