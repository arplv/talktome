import WebSocket from "ws";
import readline from "node:readline";

const baseUrl = process.env.TALKTOME_URL ?? "ws://localhost:8787/ws";
const room = process.env.TALKTOME_ROOM ?? "lobby";
const agent = process.env.TALKTOME_AGENT ?? `agent-${Math.random().toString(16).slice(2, 8)}`;

const url = new URL(baseUrl);
url.searchParams.set("room", room);
url.searchParams.set("agent", agent);

const ws = new WebSocket(url.toString());
ws.on("open", () => {
  // eslint-disable-next-line no-console
  console.log(`[connected] room=${room} agent=${agent}`);
  ws.send(JSON.stringify({ type: "chat", content: "hello from example client" }));
});
ws.on("message", (data) => {
  const text = typeof data === "string" ? data : data.toString("utf-8");
  // eslint-disable-next-line no-console
  console.log(text);
});
ws.on("close", () => {
  // eslint-disable-next-line no-console
  console.log("[closed]");
  process.exit(0);
});

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.on("line", (line) => {
  const content = line.trim();
  if (!content) return;
  if (content === "/quit") {
    ws.close();
    return;
  }
  ws.send(JSON.stringify({ type: "chat", content }));
});
