import WebSocket from "ws";
import { SimplePool, useWebSocketImplementation } from "nostr-tools/pool";
import { finalizeEvent, validateEvent, verifyEvent } from "nostr-tools/pure";
import * as nip19 from "nostr-tools/nip19";

useWebSocketImplementation(WebSocket);

function parseRelays(relays) {
  if (Array.isArray(relays)) return relays.map((r) => String(r).trim()).filter(Boolean);
  return String(relays ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function decodeSecretKey(value) {
  const v = String(value || "").trim();
  if (!v) return null;
  if (v.startsWith("nsec")) {
    const decoded = nip19.decode(v);
    if (decoded.type !== "nsec") throw new Error("Invalid nsec");
    return decoded.data;
  }
  if (!/^[0-9a-fA-F]{64}$/.test(v)) throw new Error("Invalid secret key hex");
  return Uint8Array.from(Buffer.from(v, "hex"));
}

function roomTopic(roomId) {
  return `room:${roomId}`;
}

function hasTag(tags, name, value) {
  if (!Array.isArray(tags)) return false;
  return tags.some((t) => Array.isArray(t) && t[0] === name && t[1] === value);
}

function isTalkToMeEvent(evt) {
  return evt?.kind === 1 && hasTag(evt.tags, "t", "talktome");
}

export function createTalkToMeNostrClient({
  relays,
  nsec,
  skHex,
  enableReconnect = true,
  enablePing = true
} = {}) {
  const relayList = parseRelays(relays);
  if (relayList.length === 0) throw new Error("relays_required");

  const sk = decodeSecretKey(nsec ?? skHex ?? "");
  const pool = new SimplePool({ enableReconnect, enablePing });

  function signable() {
    if (!sk) throw new Error("signing_not_configured");
    return sk;
  }

  return {
    relays: relayList,

    async publish({ roomId, content, extraTags = [] }) {
      const tags = [
        ["t", "talktome"],
        ["t", roomTopic(roomId)],
        ["d", roomId]
      ];
      for (const t of extraTags) {
        if (Array.isArray(t) && t.length >= 2 && typeof t[0] === "string" && typeof t[1] === "string") {
          tags.push([t[0], t[1]]);
        }
      }

      const event = finalizeEvent(
        {
          kind: 1,
          created_at: Math.floor(Date.now() / 1000),
          tags,
          content: String(content ?? "")
        },
        signable()
      );

      await Promise.allSettled(pool.publish(relayList, event));
      return { ok: true, id: event.id, roomId };
    },

    async announceIssue({
      issueRoomId,
      title,
      description,
      tags = [],
      bounty = "0",
      metadataHash = null,
      chain = null
    }) {
      const payload = {
        type: "issue_opened",
        roomId: issueRoomId,
        title,
        description,
        tags,
        bounty: String(bounty)
      };
      if (metadataHash) payload.metadataHash = String(metadataHash);
      if (chain) payload.chain = chain;

      return this.publish({
        roomId: "lobby",
        content: JSON.stringify(payload),
        extraTags: [
          ["x", "issue_opened"],
          ["d2", String(issueRoomId)]
        ].concat(metadataHash ? [["m", String(metadataHash)]] : [])
      });
    },

    watchLobby({ sinceSeconds = Math.floor(Date.now() / 1000) - 60 * 30, onIssue } = {}) {
      const since = Number(sinceSeconds) || 0;
      const sub = pool.subscribeMany(
        relayList,
        { kinds: [1], "#t": [roomTopic("lobby")], since },
        {
          onevent: (evt) => {
            if (!validateEvent(evt) || !verifyEvent(evt)) return;
            if (!isTalkToMeEvent(evt)) return;
            let payload = null;
            try {
              payload = JSON.parse(evt.content);
            } catch {
              return;
            }
            if (payload?.type !== "issue_opened") return;
            onIssue?.({ event: evt, payload });
          }
        }
      );
      return { close: () => sub?.close?.("client_close") };
    },

    watchRoom({ roomId, sinceSeconds = Math.floor(Date.now() / 1000) - 60 * 30, onMessage } = {}) {
      const since = Number(sinceSeconds) || 0;
      const sub = pool.subscribeMany(
        relayList,
        { kinds: [1], "#t": [roomTopic(roomId)], since },
        {
          onevent: (evt) => {
            if (!validateEvent(evt) || !verifyEvent(evt)) return;
            if (!isTalkToMeEvent(evt)) return;
            onMessage?.(evt);
          }
        }
      );
      return { close: () => sub?.close?.("client_close") };
    },

    async fetchRoom({ roomId, limit = 50 } = {}) {
      const lim = Math.max(1, Math.min(200, Number(limit) || 50));
      const events = await pool.querySync(relayList, { kinds: [1], "#t": [roomTopic(roomId)], limit: lim });
      return events
        .filter((evt) => validateEvent(evt) && verifyEvent(evt) && isTalkToMeEvent(evt))
        .sort((a, b) => a.created_at - b.created_at);
    },

    destroy() {
      pool.destroy();
    }
  };
}

