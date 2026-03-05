import WebSocket from "ws";
import { SimplePool, useWebSocketImplementation } from "nostr-tools/pool";
import { finalizeEvent, getPublicKey, validateEvent, verifyEvent } from "nostr-tools/pure";
import * as nip19 from "nostr-tools/nip19";

import { reduceIssueState } from "../src/issue_state.js";

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
  const pubkey = sk ? getPublicKey(sk) : null;
  const npub = pubkey ? nip19.npubEncode(pubkey) : null;
  const pool = new SimplePool({ enableReconnect, enablePing });

  function signable() {
    if (!sk) throw new Error("signing_not_configured");
    return sk;
  }

  return {
    relays: relayList,
    pubkey,
    npub,

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

      const lobby = await this.publish({
        roomId: "lobby",
        content: JSON.stringify(payload),
        extraTags: [
          ["x", "issue_opened"],
          ["d2", String(issueRoomId)]
        ].concat(metadataHash ? [["m", String(metadataHash)]] : [])
      });

      // Echo issue context into the issue room so agents can reconstruct state from the room alone.
      const room = await this.publish({
        roomId: issueRoomId,
        content: JSON.stringify(payload),
        extraTags: [["x", "issue_context"]]
      });

      return { ok: true, lobbyEventId: lobby.id, roomEventId: room.id, issueRoomId };
    },

    async claimIssue({ roomId, note = null } = {}) {
      if (!pubkey) throw new Error("signing_not_configured");
      const payload = { type: "issue_claimed", roomId, solver: `nostr:${pubkey}`, note };
      return this.publish({ roomId, content: JSON.stringify(payload), extraTags: [["x", "issue_claimed"]] });
    },

    async submitSolution({ roomId, artifact, summary = null } = {}) {
      if (!pubkey) throw new Error("signing_not_configured");
      const payload = { type: "solution_submitted", roomId, solver: `nostr:${pubkey}`, artifact, summary };
      return this.publish({ roomId, content: JSON.stringify(payload), extraTags: [["x", "solution_submitted"]] });
    },

    async acceptSolution({ roomId, solver, submissionEventId = null } = {}) {
      if (!pubkey) throw new Error("signing_not_configured");
      const payload = { type: "solution_accepted", roomId, solver, submissionEventId };
      return this.publish({ roomId, content: JSON.stringify(payload), extraTags: [["x", "solution_accepted"]] });
    },

    async openDispute({ roomId, reason = null } = {}) {
      if (!pubkey) throw new Error("signing_not_configured");
      const payload = { type: "dispute_opened", roomId, reason };
      return this.publish({ roomId, content: JSON.stringify(payload), extraTags: [["x", "dispute_opened"]] });
    },

    async resolveDispute({ roomId, resolution = null } = {}) {
      if (!pubkey) throw new Error("signing_not_configured");
      const payload = { type: "dispute_resolved", roomId, resolution };
      return this.publish({ roomId, content: JSON.stringify(payload), extraTags: [["x", "dispute_resolved"]] });
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

    async fetchIssueState({ roomId, limit = 200 } = {}) {
      const events = await this.fetchRoom({ roomId, limit });
      return reduceIssueState({ roomId, events });
    },

    destroy() {
      pool.destroy();
    }
  };
}
