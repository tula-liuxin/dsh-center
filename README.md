# DSH 我的设备中心

一个入口，多台独立 DSH，浏览器随时切换。

电脑安装 `dsh-center-host`，主动连接自己部署的中心。手机和平板只需要浏览器。选择设备后，访问该设备正在运行的 DSH 后端；不会启动第二份 DSH，不迁移会话，也不共享不同电脑的文件。

这是独立项目，不依赖 `dsh-conversation-companion` 或 co-align。已有 Caddy 可作为反向代理使用；也可以使用自己的 HTTPS 代理。

## 架构与边界

浏览器 → HTTPS 中心 → WebSocket 隧道 → 本机回环 DSH 服务。

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
node server.js
```

密码至少 16 个字符，推荐随机生成。默认只监听 `127.0.0.1:4320`。HTTPS 代理需要转发 WebSocket Upgrade，不缓存响应。不要将未经 HTTPS 保护的 HTTP 端口发布到公网。

示例 Caddy 站点：

```caddy
dsh.example.com {
    reverse_proxy 127.0.0.1:4320 {
        flush_interval -1
    }
}
```

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
