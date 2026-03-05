import WebSocket from "ws";
import { SimplePool, useWebSocketImplementation } from "nostr-tools/pool";
import { finalizeEvent } from "nostr-tools/pure";
import * as nip19 from "nostr-tools/nip19";

useWebSocketImplementation(WebSocket);

function decodeSecretKey(value) {
  const v = String(value || "").trim();
  if (!v) throw new Error("Set NOSTR_NSEC or NOSTR_SK_HEX");
  if (v.startsWith("nsec")) {
    const decoded = nip19.decode(v);
    if (decoded.type !== "nsec") throw new Error("Invalid nsec");
    return decoded.data;
  }
  if (!/^[0-9a-fA-F]{64}$/.test(v)) throw new Error("Invalid secret key hex");
  return Uint8Array.from(Buffer.from(v, "hex"));
}

const relays = (process.env.NOSTR_RELAYS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
if (relays.length === 0) throw new Error("Set NOSTR_RELAYS (comma-separated wss://...)");

const sk = decodeSecretKey(process.env.NOSTR_NSEC ?? process.env.NOSTR_SK_HEX);
const roomId = process.env.TALKTOME_ROOM_ID ?? "lobby";
const content = process.env.TALKTOME_CONTENT ?? "hello";

const event = finalizeEvent(
  {
    kind: 1,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ["t", "talktome"],
      ["t", `room:${roomId}`],
      ["d", roomId]
    ],
    content
  },
  sk
);

const pool = new SimplePool();
await Promise.allSettled(pool.publish(relays, event));
pool.destroy();

console.log(JSON.stringify({ ok: true, id: event.id, roomId }, null, 2));
