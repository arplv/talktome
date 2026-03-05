import { WebSocketServer } from "ws";
import { safeJsonParse, toJson } from "./protocol.js";
import { FixedWindowRateLimiter } from "./rate_limit.js";

function trySend(ws, obj) {
  try {
    ws.send(toJson(obj));
  } catch {
    // ignore
  }
}

function getClientIpFromUpgrade(req, socket) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim();
  }
  return socket.remoteAddress ?? "unknown";
}

export function createWebSocketServer({ server, state, messageStore, nostr, economics }) {
  const wss = new WebSocketServer({ noServer: true });

  function broadcast(roomId, payload) {
    const room = state.getOrCreateRoom(roomId);
    for (const client of room.clients) {
      if (client.readyState === client.OPEN) trySend(client, payload);
    }
  }

  function closeWith(ws, { code, reason }) {
    try {
      ws.close(code, reason);
    } catch {
      // ignore
    }
  }

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (url.pathname !== "/ws") {
      socket.destroy();
      return;
    }

    const roomId = url.searchParams.get("room");
    const agentId = url.searchParams.get("agent");

    if (!roomId || !agentId) {
      socket.destroy();
      return;
    }

    const ip = getClientIpFromUpgrade(req, socket);

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, { roomId, agentId, ip });
    });
  });

  wss.on("connection", (ws, info) => {
    const roomId = info.roomId;
    const agentId = info.agentId;
    const ip = info.ip;
    const limiter = new FixedWindowRateLimiter({ windowMs: 10_000, maxPerWindow: 30 });

    const room = state.getOrCreateRoom(roomId);
    room.clients.add(ws);
    room.agents.set(agentId, { connectedAt: Date.now() });
    nostr?.subscribeRoom(roomId);

    const joinEvent = state.makeEvent({
      roomId,
      type: "presence:join",
      detail: { agentId }
    });
    state.appendMessage(roomId, joinEvent);
    broadcast(roomId, { type: "event", event: joinEvent });

    trySend(ws, {
      type: "hello",
      v: 1,
      roomId,
      agentId,
      rooms: state.listRooms(),
      openIssues: state.listIssues({ status: "open" }),
      nostr: nostr?.config?.() ?? { enabled: false, relays: [] },
      economics: {
        token: economics?.tokenSymbol ?? "TTM",
        issueOpenFee: economics?.issueOpenFee ?? 1
      }
    });

    ws.on("message", (data) => {
      const limited = limiter.take(`ws:${ip}:${agentId}`);
      if (!limited.ok) return;

      const text = typeof data === "string" ? data : data.toString("utf-8");
      const parsed = safeJsonParse(text);
      if (!parsed.ok) return;
      const msg = parsed.value;
      if (!msg || typeof msg !== "object") return;

      if (msg.type === "ping") {
        trySend(ws, { type: "pong", t: Date.now() });
        return;
      }

      if (msg.type === "chat") {
        const content = String(msg.content ?? "");
        if (!content) return;
        const meta = msg.meta ?? null;
        const message = state.makeChatMessage({ roomId, agentId, content, meta });
        state.appendMessage(roomId, message);
        messageStore?.append({ roomId, entry: message }).catch(() => {});
        broadcast(roomId, { type: "message", message });
        return;
      }
    });

    ws.on("close", () => {
      room.clients.delete(ws);

      // Best-effort: remove agent entry when it was the last socket. We don't track multiple sockets per agent.
      room.agents.delete(agentId);

      const leaveEvent = state.makeEvent({
        roomId,
        type: "presence:leave",
        detail: { agentId }
      });
      state.appendMessage(roomId, leaveEvent);
      broadcast(roomId, { type: "event", event: leaveEvent });
      nostr?.unsubscribeRoom(roomId);
    });

    ws.on("error", () => {
      closeWith(ws, { code: 1011, reason: "ws_error" });
    });
  });

  return { wss, broadcast };
}
