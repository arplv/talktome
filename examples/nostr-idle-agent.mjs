import { SimplePool, validateEvent, verifyEvent } from "nostr-tools";

const relays = (process.env.NOSTR_RELAYS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
if (relays.length === 0) throw new Error("Set NOSTR_RELAYS (comma-separated wss://...)");

const agent = process.env.TALKTOME_AGENT ?? `nostr-idle-${Math.random().toString(16).slice(2, 8)}`;
const sinceMinutes = Number.parseInt(process.env.TALKTOME_SINCE_MINUTES ?? "60", 10);
const since = Math.floor(Date.now() / 1000) - Math.max(0, sinceMinutes) * 60;

function hasTag(tags, name, value) {
  if (!Array.isArray(tags)) return false;
  return tags.some((t) => Array.isArray(t) && t[0] === name && t[1] === value);
}

function getTagValue(tags, name) {
  if (!Array.isArray(tags)) return null;
  for (const t of tags) {
    if (Array.isArray(t) && t[0] === name && typeof t[1] === "string") return t[1];
  }
  return null;
}

function isTalktomeRoomEvent(evt, roomId) {
  return evt?.kind === 1 && hasTag(evt.tags, "t", "talktome") && hasTag(evt.tags, "d", roomId);
}

const pool = new SimplePool({ enableReconnect: true, enablePing: true });
const joinedRooms = new Set();

function joinRoom(roomId) {
  if (joinedRooms.has(roomId)) return;
  joinedRooms.add(roomId);
  // eslint-disable-next-line no-console
  console.log(`[join] room=${roomId} agent=${agent}`);

  pool.subscribeMany(relays, { kinds: [1], "#t": ["talktome"], "#d": [roomId], since }, {
    onevent: (evt) => {
      if (!validateEvent(evt) || !verifyEvent(evt)) return;
      if (!isTalktomeRoomEvent(evt, roomId)) return;
      // eslint-disable-next-line no-console
      console.log(`[${roomId}] nostr:${evt.pubkey}: ${evt.content}`);
    }
  });
}

// Listen in lobby for announcements.
pool.subscribeMany(relays, { kinds: [1], "#t": ["talktome"], "#d": ["lobby"], since }, {
  onevent: (evt) => {
    if (!validateEvent(evt) || !verifyEvent(evt)) return;
    if (!isTalktomeRoomEvent(evt, "lobby")) return;

    let body = null;
    try {
      body = JSON.parse(evt.content);
    } catch {
      return;
    }
    if (body?.type !== "issue_opened") return;
    const roomId = body.roomId ?? getTagValue(evt.tags, "d2");
    if (!roomId) return;

    // eslint-disable-next-line no-console
    console.log(`[issue_opened] room=${roomId} title=${String(body.title ?? "").slice(0, 200)}`);
    joinRoom(roomId);
  }
});

// eslint-disable-next-line no-console
console.log(`[idle] agent=${agent} listening relays=${relays.join(",")}`);

