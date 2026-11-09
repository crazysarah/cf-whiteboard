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

## 使用

- 打开 `https://<你的域>/#房间名`，同一个 `#房间名` 即同一个白板
- 把链接发给对方即可同画；换房间改 hash 就行
- 「一边倾一边画」：先用 Teams/企微/Google Meet 开通话，再共享白板链接（WebRTC 语音可后续在 `sig` 信令通道上加）

## 本地调试

```bash
wrangler dev    # http://localhost:8787
```

## 已知设计取舍

- 笔画历史存 DO SQLite，每 20 笔落盘；超过 5000 笔自动丢弃最旧
- 清空是广播式的：任何人按清空，全房清掉（如需撤销再加 undo 栈）
- 手指/鼠标坐标是视口坐标，不同屏幕分辨率下看到的画面比例可能不同（缩放适配留给后续）
- 语音走 WebRTC P2P：DO 只转发 SDP/ICE（`sig` 消息），媒体流不过 CF，零成本
