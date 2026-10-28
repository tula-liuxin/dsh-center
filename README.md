# DSH 我的设备中心

一个入口，多台独立 DSH，浏览器随时切换。

电脑安装 `dsh-center-host`，主动连接自己部署的中心。手机和平板只需要浏览器。选择设备后，访问该设备正在运行的 DSH 后端；不会启动第二份 DSH，不迁移会话，也不共享不同电脑的文件。

这是独立项目，不依赖 `dsh-conversation-companion` 或 co-align。已有 Caddy 可作为反向代理使用；也可以使用自己的 HTTPS 代理。

## 架构与边界

浏览器 → HTTPS 中心 → WebSocket 隧道 → 本机回环 DSH 服务。

每台设备有自己的 origin（`<设备ID>.中心域名`），DSH 就挂在 `/` 上，所以插件里写死的根路径（`/leo-status/api/...`、`/assets/...`、`new WebSocket('/...')`）原样可用，不需要为隧道做任何适配。中心的 `<域名>/d/<设备ID>/` 旧前缀仍然保留，老链接和旧版插件继续可用。

- 会话、文件、模型密钥和执行保留在 Host。
- 中心保存设备名称和设备凭据的哈希；登录会话和配对码在内存中，中心重启后浏览器重新登录。
- 每条请求绑定设备 ID，切换设备不改变已有请求的执行位置。
- 离线明确报错，不自动切换或重新发送任务。
- HTTPS/WSS 保护两段网络传输。**不是端到端加密：中心进程能读取转发内容**，请只连接自己的可信中心。中心不主动持久化或记录会话内容。
- 同一账号下的所有电脑和插件视为可信设备。不是面向互不信任租户的平台。
- 不提供远程桌面画面或控制任意原生窗口；DSH 中需要本机窗口的能力可能仍需回到电脑操作。
- 本版本精确适配 DSH `0.2.1-rc.3`，升级 DSH 前需验证。

## 安装电脑端

在 DSH 插件市场安装「我的设备中心」。插件启用后，左侧栏底部出现 `⇄`「设备接入」按钮。

1. 在网页中心登录，打开「设备」，生成一次性配对码。
2. 在本机 DSH 点击 `⇄` → 设置，填写中心 HTTPS 地址、电脑名称、配对码。
3. 配对后自动上线。中心地址可以是任何自托管域名。

配对码十分钟有效，使用一次即失效。设备凭据保存在 `~/.dsh-center/host.json`，不要分享。可通过 `DSH_CENTER_CONFIG` 指定不同路径；同一电脑同时运行多个 DSH 实例时，每个实例需要独立凭据和配对。

无 GUI 时运行 `node <插件目录>/pair.js` 完成配对。中心「设备 → 撤销」立即断开并撤销该电脑的凭据。

## 自托管中心

需要 Node.js 24 或 Docker。服务器的模型、会话和工具不是中心运行依赖。

```sh
npm ci --omit=dev --ignore-scripts
export CENTER_PUBLIC_URL=https://dsh.example.com
export CENTER_PASSWORD_FILE=/secure/path/password
export CENTER_DATA=/var/lib/dsh-center
# 可选：设备 origin 的父域，默认取 CENTER_PUBLIC_URL 的主机名
export CENTER_DEVICE_DOMAIN=dsh.example.com
node server.js
```

密码至少 16 个字符，推荐随机生成。默认只监听 `127.0.0.1:4320`。HTTPS 代理需要转发 WebSocket Upgrade，不缓存响应。不要将未经 HTTPS 保护的 HTTP 端口发布到公网。

设备 origin 需要一条泛解析 DNS：`*.dsh.example.com` 与 `dsh.example.com` 指向同一台机器。示例 Caddy 站点用按需签发的证书，不必手工为每台设备申请：

```caddy
{
    email you@example.com
    on_demand_tls {
        ask http://127.0.0.1:4320/center/tls-ask
    }
}

dsh.example.com, *.dsh.example.com {
    reverse_proxy 127.0.0.1:4320 {
        flush_interval -1
    }
}
```

`/center/tls-ask` 只对真实设备 origin 返回 200，其他域名不会拿到证书。登录 cookie 会带 `Domain=<父域>`，因此中心页面和设备 origin 共用一次登录。

`CENTER_DEVICE_ORIGINS=0` 可关闭设备 origin 的对外宣告（接口不再返回 `portal`，页面回落到 `/d/<设备ID>/` 前缀），便于在 DNS 或证书就绪前先升级中心。

仓库 `compose.yml` 是当前部署实例：连接已有 `co-align-v2_default` 边缘代理网络，容器名别名为 `dsh-center`。独立部署时更换网络名称或使用回环端口反代。目录 `data` 必须允许容器 UID 1000 写入，密码文件只允许可信用户读取。

## 验证

```sh
npm ci --ignore-scripts
npm test
npm audit --omit=dev
```

测试包含认证、Origin 校验、一次性配对、隧道 HTTP/SSE/WebSocket、撤销和离线行为。实际手机网络、休眠恢复和长时间运行需要单独验收；测试结果不等于这些场景已验证。

## 运行限制

单中心账号，最多 512 个同时转发请求/流；上传上限 32 MiB。慢连接队列有上限，超限断开以防止拖垮设备。首次响应超时 45 秒。大附件和高速批量传输不是第一版优化目标。

MIT License · Leo / tula-liuxin

## 0.2.4 浏览器侧 WebSocket 压缩

- 切换 session 时浏览器↔中心那条常连 WebSocket 会推几 MB 的 JSON（实测 25 秒窗口 5–7 MB），而它此前不压缩。
- 现在给浏览器侧 WebSocket 开 `permessage-deflate`（无损），并保留 1 MiB 单帧上限；压缩只影响浏览器↔中心这一段，中心↔电脑本来就压过。
- 观测：`CENTER_MUX_STATS=1` 时打印 `[mux]` 逻辑字节和 `[mux-wire]` 实际线上字节（含 `permessage-deflate` 标记），可对比压缩率。

## 0.2.3 缓存改为边发边存

- 冷加载和 0.2.1 一样快（首个字节不被缓冲拖慢），资源仍一边发一边留一份在中心；gzip 在响应结束时截获，第二次请求直接拿压缩副本。
- 命中缓存的资源从 ~140 ms 降到 ~8 ms（本机到中心的一次连接内测量，已含 TLS 复用）。

## 0.2.2 加载与切换提速

- 中心的静态资源缓存：`/assets`、`/plugins`、`/dsh-client-modules` 的 200 响应在中心进程内按「设备 + 路径」缓存（LRU，默认 192 MiB，`CENTER_ASSET_CACHE_MB` 可调），命中时不再经过隧道，电脑离线也能打开；gzip 只算一次。
- 带内容哈希的资源改成 `private, max-age=31536000, immutable`，浏览器一年内不再回源；未带 rev 的静态资源保持 5 分钟短缓存。命中缓存时顺带处理 `If-None-Match` 返回 304。
- 隧道启用 `permessage-deflate`：会话历史、轨迹这类 JSON 走隧道时先压缩，家用上行是整条链路最慢的一跳。
- 中心页在打开设备前对设备 origin 做 `preconnect`/`dns-prefetch`，省掉一次 DNS+TLS 握手。
- 设备上线或配对后，中心主动请求一次 `portal/health`，让 Caddy 提前签发按需证书，第一次打开不再等 ACME。
- 新增可选的按请求耗时日志：`CENTER_TIMING=1` 时每请求打印 `[timing] 状态 路径 字节 毫秒`，用来定位慢请求。

## 0.2.1 门户里的设备切换按钮重新对齐

- 设备页现在跑在自己的 origin 上，中心页无法再读取 iframe 的 DOM 来测量侧栏「更多」行的位置，⇄ 按钮会掉回左上角。
- 宿主插件在门户页里把「更多」行的几何位置 `postMessage` 给中心页，中心页据此摆放自己的 ⇄ 按钮；两边都只属于设备中心，第三方插件不需要知道这件事。
- 只接受当前设备 origin 发来的消息，其他来源一律忽略。

## 0.2.0 每台设备一个 origin

- 中心按 Host 把 `<设备ID>.<父域>` 路由到对应设备的隧道，DSH 直接挂在根路径。
- 插件里写死的根路径、cookie、WebSocket 地址不再需要为隧道适配；新插件的作者无需了解设备中心。
- 登录 cookie 带 `Domain=<父域>`，中心页面与设备 origin 共用一次登录。
- 升级前登录的浏览器（旧 cookie 只对中心域名生效）会在打开中心页时自动轮换一次会话、拿到带 Domain 的 cookie，不需要重新输密码；`center_scope` 这个 JS 可读的同款 cookie 用来判断是否需要迁移。
- `/d/<设备ID>/` 旧前缀保留；`CENTER_DEVICE_ORIGINS=0` 可在 DNS/证书就绪前关闭新入口的宣告。
- 新增 `/center/tls-ask`，供 Caddy 按需签发证书时校验域名。

## 0.1.7 连接恢复

- 浏览器与中心、设备与中心分开报告连接状态；网络恢复、切回页面、打开菜单时自动检查。
- 短暂中断保留已打开的界面和草稿，原生会话连接自动重试；初始页面加载失败时自动重载。
- 浏览器与设备两段 WebSocket 都有心跳；设备连接替换后立即关闭旧会话通道，让浏览器重新建立。
- 大文件按隧道发送速度读取，避免页面加载挤爆共享队列；重连时刷新本机认证。
- 插件卸载时清理隧道、计时器与文件监听，避免残留连接互相替换。
