# CF 多人白板（Workers + Durable Objects）

架构：`/room/<name>` 路由到同名 Durable Object（一个 DO = 一个房间，全球单实例强一致），
WebSocket 用 Hibernation API（空房间不占 CPU 时间，hibernated 免费），笔画历史存 DO 内置 SQLite。

## 部署

```bash
cd cf-whiteboard
npm install -g wrangler     # 已有可跳过
wrangler login              # 浏览器授权 CF 账号
wrangler deploy             # 输出形如 https://cf-whiteboard.<subdomain>.workers.dev
```

### 绑定自己的域名（可选，大陆访问建议）

大陆直连 `*.workers.dev` 不稳定，建议绑定一个自己接入 Cloudflare 的域名。
**不要把真实域名提交到公开仓库**——复制 `wrangler.jsonc` 为 `wrangler.local.jsonc`（已被 .gitignore 排除），
在里加一段：

```jsonc
"routes": [
  { "pattern": "board.yourdomain.com", "custom_domain": true }
]
```

然后用 `wrangler deploy -c wrangler.local.jsonc` 部署，DNS 记录与证书会自动创建。

## 使用

- 打开 `https://<你的域>/#房间名`，同一个 `#房间名` 即同一个白板
- 把链接发给对方即可同画；换房间改 hash 就行
- 「一边倾一边画」：先用 Teams/企微/Google Meet 开通话，再共享白板链接（WebRTC 语音可后续在 `sig` 信令通道上加）

## 本地调试

```bash
wrangler dev    # http://localhost:8787
```

## 已知设计取舍

- 笔画历史存 DO SQLite，每笔落盘；超过 2000 笔自动丢弃最旧（贴图随淘汰/清空一并删除）
- 清空是广播式的：任何人按清空，全房清掉；「撤销」可回退最后一个操作
- 支持截图粘贴（Ctrl+V）与拖拽图片：客户端压缩后存 DO SQLite（单图 ≤2MB），可拖动位置
- 手指/鼠标坐标是视口坐标，不同屏幕分辨率下看到的画面比例可能不同（缩放适配留给后续）
- 语音走 WebRTC P2P：DO 只转发 SDP/ICE（`sig` 消息），媒体流不过 CF，零成本
