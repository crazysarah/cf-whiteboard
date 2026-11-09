/**
 * cf-whiteboard — Durable Objects 多人白板
 * 架构：/room/<name> → 同名 DO 单实例，WebSocket Hibernation API 广播笔画
 * 图片：/room/<name>/upload POST 二进制（≤2MB）→ 存 DO SQLite；GET /room/<name>/img/<key> 读图
 * 消息协议（JSON）：
 *   client → server:
 *     { t: "stroke", pts: [[x,y],...], c: "#rrggbb", w: 3 }   新笔画
 *     { t: "img", key, x, y, w, h }                            贴图（图已先经 /upload 传好）
 *     { t: "clear" }                                          清空白板
 *     { t: "sig", to: peerId, data: {...} }                   WebRTC 信令转发（语音用）
 *   server → client:
 *     { t: "hello", id: peerId, history: [...], peers: n }    加入后的初始状态
 *     { t: "stroke" | "img" | "clear", ... }                  他人操作（广播）
 *     { t: "peer-join" | "peer-leave", id, peers }            在线人数变化
 *     { t: "sig", from: peerId, data }                        信令转发
 */

const MAX_HISTORY = 2000;      // 单房间最多保留操作数
const MAX_IMG_BYTES = 2000000; // 单张图上限（DO SQLite 单值 2MB 限制）

export class Whiteboard {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.peers = new Set(); // 在线 peerId
    this.history = [];      // 操作历史

    // 从持久存储恢复历史（DO 休眠后重开不丢）
    this.state.blockConcurrencyWhile(async () => {
      const saved = await this.state.storage.get("history");
      if (saved) this.history = saved;
    });
  }

  async fetch(request) {
    const url = new URL(request.url);

    // POST /room/<name>/upload — 接收图片二进制，存 DO 存储
    if (url.pathname.endsWith("/upload") && request.method === "POST") {
      const body = await request.arrayBuffer();
      if (body.byteLength === 0) return new Response("empty body", { status: 400 });
      if (body.byteLength > MAX_IMG_BYTES) {
        return new Response("image too large (max 2MB)", { status: 413 });
      }
      const key = crypto.randomUUID().replace(/-/g, "") + ".jpg";
      await this.state.storage.put("img:" + key, body);
      return Response.json({ key });
    }

    // GET /room/<name>/img/<key> — 读图（浏览器缓存一年，key 不可变）
    const imgMatch = url.pathname.match(/\/img\/([\w-]+\.jpg)$/);
    if (imgMatch && request.method === "GET") {
      const val = await this.state.storage.get("img:" + imgMatch[1]);
      if (!val) return new Response("not found", { status: 404 });
      return new Response(val, {
        headers: {
          "content-type": "image/jpeg",
          "cache-control": "public, max-age=31536000, immutable",
        },
      });
    }

    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected websocket", { status: 400 });
    }

    // 升级 WebSocket
    const pair = new WebSocketPair();
    const peerId = crypto.randomUUID();
    this.peers.add(peerId);

    this.state.acceptWebSocket(pair[1]);
    pair[1].serializeAttachment({ peerId }); // close 时识别离开者

    pair[1].send(JSON.stringify({
      t: "hello", id: peerId,
      history: this.history.slice(-MAX_HISTORY),
      peers: this.peers.size,
    }));
    this.broadcast({ t: "peer-join", id: peerId, peers: this.peers.size }, peerId);

    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(ws, message) {
    if (message === "ping") { try { ws.send("pong"); } catch {} return; } // NAT 保活
    let msg;
    try { msg = JSON.parse(message); } catch { return; }

    switch (msg.t) {
      case "stroke":
      case "img":
        if (msg.t === "img" && !/^[\w-]+\.jpg$/.test(msg.key)) return; // key 白名单
        this.history.push(msg);
        if (this.history.length > MAX_HISTORY) {
          // 淘汰最旧操作；被淘汰的贴图顺手删存储，防孤儿膨胀
          const dropped = this.history.slice(0, this.history.length - MAX_HISTORY);
          for (const d of dropped) {
            if (d.t === "img") this.state.storage.delete("img:" + d.key);
          }
          this.history = this.history.slice(-MAX_HISTORY);
        }
        this.state.storage.put("history", this.history);
        this.broadcast(msg, null);
        break;
      case "clear":
        for (const m of this.history) {
          if (m.t === "img") this.state.storage.delete("img:" + m.key);
        }
        this.history = [];
        this.state.storage.delete("history");
        this.broadcast(msg, null);
        break;
      case "sig": // WebRTC 信令：{ to, data } — 语音/视频协商用
        this.broadcast(
          { t: "sig", from: msg.from || "?", data: msg.data }, null, msg.to
        );
        break;
    }
  }

  async webSocketClose(ws) {
    const peerId = ws.deserializeAttachment()?.peerId;
    if (peerId) {
      this.peers.delete(peerId);
      this.broadcast({ t: "peer-leave", id: peerId, peers: this.peers.size }, null);
    }
  }

  broadcast(msg, excludeId, onlyId = null) {
    for (const ws of this.state.getWebSockets()) {
      if (excludeId && ws.deserializeAttachment()?.peerId === excludeId) continue;
      if (onlyId && ws.deserializeAttachment()?.peerId !== onlyId) continue;
      try { ws.send(JSON.stringify(msg)); } catch { /* 连接已死，等 close 事件清理 */ }
    }
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // /room/<name>[/upload|/img/<key>] → 路由到同名 DO（同名即同房间，图随房间存取）
    const roomMatch = url.pathname.match(/^\/room\/([\w-]+)(\/.*)?$/);
    if (roomMatch) {
      const id = env.WHITEBOARD.idFromName(roomMatch[1]);
      const stub = env.WHITEBOARD.get(id);
      return stub.fetch(request);
    }

    // 其余路径走静态资源（public/index.html）
    return env.ASSETS.fetch(request);
  },
};
