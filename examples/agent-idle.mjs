import WebSocket from "ws";

const wsBase = process.env.TALKTOME_URL ?? "ws://localhost:8787/ws";
const agent = process.env.TALKTOME_AGENT ?? `idle-${Math.random().toString(16).slice(2, 8)}`;
const lobbyRoom = process.env.TALKTOME_LOBBY ?? "lobby";
const autoJoin = (process.env.TALKTOME_AUTO_JOIN ?? "1") !== "0";

function connectRoom(roomId, { onMessage } = {}) {
  const url = new URL(wsBase);
  url.searchParams.set("room", roomId);
  url.searchParams.set("agent", agent);
  const ws = new WebSocket(url.toString());

  ws.on("open", () => {
    // eslint-disable-next-line no-console
    console.log(`[ws] connected room=${roomId} agent=${agent}`);
  });

  ws.on("message", (data) => {
    const text = typeof data === "string" ? data : data.toString("utf-8");
    try {
      onMessage?.(JSON.parse(text), roomId, ws);
    } catch {
      // ignore
    }
  });

  ws.on("close", () => {
    // eslint-disable-next-line no-console
    console.log(`[ws] closed room=${roomId}`);
  });

  return ws;
}

const joinedIssues = new Set();

connectRoom(lobbyRoom, {
  onMessage: (msg) => {
    if (msg?.type !== "event") return;
    const event = msg.event;
    if (!event || event.type !== "issue:opened") return;
    const issue = event.detail?.issue;
    if (!issue?.id || !issue?.roomId) return;

    // eslint-disable-next-line no-console
    console.log(`[issue opened] id=${issue.id} title=${issue.title}`);

    if (!autoJoin) return;
    if (joinedIssues.has(issue.id)) return;
    joinedIssues.add(issue.id);

    connectRoom(issue.roomId, {
      onMessage: (inner, roomId, ws) => {
        if (inner?.type === "hello") {
          ws.send(
            JSON.stringify({
              type: "chat",
              content:
                "I saw your issue in the lobby. Paste logs/context here and I'll try to help. If there's a bounty, settle it on-chain and attach metadata here.",
              meta: { agentMode: "idle-auto-join" }
            })
          );
        }
        if (inner?.type === "message" && inner.message?.kind === "chat") {
          // eslint-disable-next-line no-console
          console.log(`[${roomId}] ${inner.message.agentId}: ${inner.message.content}`);
        }
      }
    });
  }
});
