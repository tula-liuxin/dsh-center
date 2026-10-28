import http from 'node:http';
import https from 'node:https';
import WebSocket from 'ws';

const MAX_QUEUE = 16 * 1024 * 1024;
export function connectHost(config, getLocal, {retryMs = 3000, heartbeatTimeoutMs = 70000, onStatus = () => {}} = {}) {
  const endpoint = new URL('/center/host', config.server);
  if (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && ['127.0.0.1','localhost'].includes(endpoint.hostname))) throw Error('Center must use HTTPS');
  endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:';
  let stopped = false, ws, timer, heartbeat;
  function armHeartbeat(socket) {
    clearTimeout(heartbeat);
    heartbeat = setTimeout(() => { onStatus("连接心跳超时，正在重连"); socket.terminate(); }, heartbeatTimeoutMs);
    heartbeat.unref?.();
  }
  const active = new Map();
  function send(m) {
    if (ws?.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > MAX_QUEUE) { ws.terminate(); return; }
    ws.send(JSON.stringify(m));
  }
  async function dial() {
    if (stopped) return;
    let local;
    try { local = await getLocal(); } catch(e) { if(!stopped){onStatus('本机 DSH 连接中断，正在重试'); timer = setTimeout(dial, retryMs);} return; }
    if (stopped) return;
    // Compress tunnel frames: assets and session JSON are highly compressible and
    // the home uplink is usually the slowest hop of the chain.
    ws = new WebSocket(endpoint, {headers: {authorization: `Bearer ${config.token}`}, maxPayload: 2 * 1024 * 1024, handshakeTimeout: 15000, perMessageDeflate: {threshold: 1024, clientNoContextTakeover: true, zlibDeflateOptions: {level: 3}}});
    const socket = ws;
    ws.on('open', () => { onStatus('online'); armHeartbeat(socket); });
    ws.on('ping', () => armHeartbeat(socket));
    ws.on('error', e => {if(!stopped)onStatus('中心连接中断，正在重连：'+e.message);});
    ws.on('close', () => {
      clearTimeout(heartbeat);
      if (!stopped) onStatus('连接已断开，正在重连');
      for (const r of active.values()) { r.destroy?.(); r.terminate?.(); }
      active.clear();
      if (!stopped) timer = setTimeout(dial, retryMs + Math.random() * 1000);
    });
    ws.on('message', async raw => {
      if(stopped || ws!==socket)return;
      try {
        const m = JSON.parse(raw);
        if (m.t === 'cancel') { active.get(m.id)?.destroy?.(); active.get(m.id)?.terminate?.(); active.delete(m.id); return; }
        if (m.t === 'data') { active.get(m.id)?.write?.(Buffer.from(m.data, 'base64')); return; }
        if (m.t === 'end') { active.get(m.id)?.end?.(); return; }
        if (m.t === 'ws-data') { const s = active.get(m.id); if (s?.readyState === WebSocket.OPEN) s.send(Buffer.from(m.data,'base64'), {binary: m.binary}); return; }
        if (!['request', 'ws-open'].includes(m.t)) return;
        // Remote callers never choose the upstream host or forward credentials.
        if (typeof m.path !== 'string' || !m.path.startsWith('/') || m.path.startsWith('//')) throw Error('Invalid path');
        const target = new URL(local.origin); target.pathname = m.path.split('?')[0]; target.search = m.path.includes('?') ? m.path.slice(m.path.indexOf('?')) : '';
        if(decodeURIComponent(target.pathname).startsWith('/center-host/')){send({t:'headers',id:m.id,status:403,headers:{}});send({t:'end',id:m.id});return;}
        const headers = {cookie: local.cookie, origin: local.origin};
        for (const key of ['content-type','accept','range','last-event-id']) if (typeof m.headers?.[key] === 'string') headers[key] = m.headers[key];
        if (m.t === 'ws-open') {
          // Refresh local authentication for each reconnect; desktop cookies can expire.
          const fresh=await getLocal();
          if(stopped || ws!==socket || socket.readyState!==WebSocket.OPEN)return;
          headers.cookie=fresh.cookie;
          target.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:';
          const s = new WebSocket(target, m.protocols || [], {headers, maxPayload: MAX_QUEUE}); active.set(m.id,s);
          s.on('open', () => send({t:'ws-open',id:m.id}));
          s.on('message', (data,binary) => send({t:'ws-data',id:m.id,data:data.toString('base64'),binary}));
          s.on('error', e => {if(!stopped)onStatus('本机会话连接重试：'+e.message);});
          s.on('close', () => {active.delete(m.id);send({t:'ws-close',id:m.id});});
          return;
        }
        const r = (target.protocol === 'https:' ? https : http).request(target, {method:m.method,headers}, res => {
          const h = {};
          for (const k of ['content-type','content-range','accept-ranges','content-disposition','etag','last-modified']) if (res.headers[k]) h[k]=res.headers[k];
          send({t:'headers',id:m.id,status:res.statusCode,headers:h});
          // This authenticated portal is an owner surface, using DSH's transport
          // composition seam. Without ownsHost the non-loopback UI uses memory
          // settings instead of this Host's model/plugin settings.
          const index = ['/', '/index.html'].includes(target.pathname) && String(res.headers['content-type']).includes('text/html');
          const parts=[];let size=0;
          res.on('data', b => {
            if(index){size+=b.length;if(size>2*1024*1024){r.destroy();return;}parts.push(b);}
            else {
              // Pause disk/HTTP reads until this chunk has left the tunnel queue.
              // Large scripts must not fill the shared queue and disconnect every session.
              res.pause();
              if(socket.readyState===WebSocket.OPEN)socket.send(JSON.stringify({t:'chunk',id:m.id,data:b.toString('base64')}),error=>{if(error)r.destroy();else res.resume();});
              else r.destroy();
            }
          });
          res.on('end', () => {
            if(index){const marker='<script>globalThis.__DSH_TRANSPORT__={ownsHost:true};globalThis.__DSH_CENTER_PORTAL__=true;</script><style>#dsh-center-dock{display:none!important}</style>';const html=Buffer.concat(parts).toString('utf8').replace(/<head(?:\s[^>]*)?>/i,open=>open+marker);send({t:'chunk',id:m.id,data:Buffer.from(html).toString('base64')});}
            active.delete(m.id);send({t:'end',id:m.id});
          });
          res.on('error', () => send({t:'error',id:m.id}));
        });
        active.set(m.id,r); r.on('error', () => {active.delete(m.id);send({t:'error',id:m.id});});
      } catch { ws.close(1008, 'Invalid tunnel message'); }
    });
  }
  dial();
  return () => { stopped=true;clearTimeout(timer);clearTimeout(heartbeat);ws?.terminate();for(const r of active.values()){r.destroy?.();r.terminate?.();}active.clear(); };
}
