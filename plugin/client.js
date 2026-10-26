window.__ModuleLoader__.load({id:'dsh-center-host',factory(require){
  const React=require('react'),h=React.createElement;
  return {inject:['slots'],apply(ctx){
    if(location.pathname.startsWith('/d/'))return;
    function Setup(){
      const[open,setOpen]=React.useState(false),[server,setServer]=React.useState('https://dsh.agencyarche.com'),[name,setName]=React.useState(''),[code,setCode]=React.useState(''),[status,setStatus]=React.useState(''),[busy,setBusy]=React.useState(false);
      const load=async()=>{setOpen(true);try{const r=await fetch('center-host/setup');const b=await r.json();setServer(b.server);setName(b.name);setStatus(b.status==='online'?'已连接':b.status);}catch{setStatus('无法读取接入状态');}};
      const pair=async e=>{e.preventDefault();setBusy(true);try{const r=await fetch('center-host/setup',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({server,name,code})});const b=await r.json();if(!r.ok)throw Error(b.error);setCode('');setStatus('配对成功，正在连接');}catch(e){setStatus(e.message);}finally{setBusy(false);}};
      const style={font:'13px system-ui',padding:'8px 10px',border:'1px solid #d8dce3',borderRadius:8};
      return h(React.Fragment,null,h('button',{type:'button',title:'设备接入', 'aria-label':'设备接入',onClick:load,style:{border:0,background:'transparent',cursor:'pointer',color:'inherit'}},'⇄'),open?h('div',{style:{position:'fixed',inset:0,zIndex:2147483645,display:'grid',placeItems:'center',background:'#0004'},onClick:()=>setOpen(false)},h('form',{onSubmit:pair,onClick:e=>e.stopPropagation(),style:{background:'#fff',color:'#18202e',padding:24,borderRadius:14,width:'min(440px,94vw)',display:'grid',gap:12}},h('strong',null,'接入我的设备中心'),h('label',null,'中心地址',h('input',{value:server,onChange:e=>setServer(e.target.value),required:true,style:{...style,width:'100%'}})),h('label',null,'电脑名称',h('input',{value:name,onChange:e=>setName(e.target.value),required:true,maxLength:60,style:{...style,width:'100%'}})),h('label',null,'一次性配对码',h('input',{value:code,onChange:e=>setCode(e.target.value),required:true,autoComplete:'off',style:{...style,width:'100%'}})),h('div',{role:'status'},status),h('small',null,'配对码在设备中心的「设备」菜单生成。只连接你信任的中心。'),h('div',null,h('button',{disabled:busy,style},busy?'连接中…':'配对'),h('button',{type:'button',onClick:()=>setOpen(false),style:{...style,marginLeft:8}},'关闭')))):null);
    }
    ctx.slots.inject('conversation.input.left',()=>ctx.slots.register({name:'conversation.input.left',id:'dsh-center-pair',order:30},Setup));
  }};
}});
