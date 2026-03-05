import WebSocket from "ws";
import { SimplePool, useWebSocketImplementation } from "nostr-tools/pool";
import { finalizeEvent, getPublicKey, validateEvent, verifyEvent } from "nostr-tools/pure";
import * as nip19 from "nostr-tools/nip19";

import { reduceIssueState } from "../src/issue_state.js";
import { getDefaultNostrIdentityPath, loadOrCreateNostrIdentity } from "../src/nostr_identity.js";

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
  autoIdentity = true,
  identityPath = null,
  enableReconnect = true,
  enablePing = true
} = {}) {
  const relayList = parseRelays(relays);
  if (relayList.length === 0) throw new Error("relays_required");

  let sk = decodeSecretKey(nsec ?? skHex ?? "");
  let pubkey = sk ? getPublicKey(sk) : null;
  let npub = pubkey ? nip19.npubEncode(pubkey) : null;

  const useAuto = Boolean(autoIdentity) && !sk;
  const idPath = identityPath ?? process.env.TALKTOME_IDENTITY_PATH ?? getDefaultNostrIdentityPath();
  if (useAuto) {
    const ident = loadOrCreateNostrIdentity({ identityPath: idPath, createIfMissing: true });
    sk = ident.sk;
    pubkey = ident.pubkey;
    npub = ident.npub;
  }
  const pool = new SimplePool({ enableReconnect, enablePing });

  function signable() {
    if (!sk) throw new Error("signing_not_configured");
    return sk;
  }

  return {
    relays: relayList,
    pubkey,
    npub,
    identityPath: useAuto ? idPath : null,

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

    async announceJob({
      jobRoomId,
      title,
      description,
      category = null,
      tags = [],
      complexity = 1,
      deadline_unix = null,
      payment = null,
      metadataHash = null
    }) {
      const payload = {
        type: "job_opened",
        roomId: jobRoomId,
        title,
        description,
        tags,
        complexity: Math.max(1, Math.min(10, Math.round(Number(complexity) || 1)))
      };
      if (category) payload.category = String(category);
      if (deadline_unix) payload.deadline_unix = Number(deadline_unix);
      if (payment) payload.payment = payment;
      if (metadataHash) payload.metadataHash = String(metadataHash);

      const lobby = await this.publish({
        roomId: "lobby",
        content: JSON.stringify(payload),
        extraTags: [
          ["x", "job_opened"],
          ["d2", String(jobRoomId)]
        ].concat(metadataHash ? [["m", String(metadataHash)]] : [])
      });

      const room = await this.publish({
        roomId: jobRoomId,
        content: JSON.stringify(payload),
        extraTags: [["x", "job_context"]]
      });

      return { ok: true, lobbyEventId: lobby.id, roomEventId: room.id, jobRoomId };
    },

    async submitJobSolution({ roomId, artifact, summary = null } = {}) {
      if (!pubkey) throw new Error("signing_not_configured");
      const payload = {
        type: "solution_submitted",
        roomId,
        solver: `nostr:${pubkey}`,
        artifact,
        summary
      };
      return this.publish({
        roomId,
        content: JSON.stringify(payload),
        extraTags: [["x", "solution_submitted"]]
      });
    },

    async requestEvaluation({ roomId, submissionCount = null, deadline_unix = null } = {}) {
      if (!pubkey) throw new Error("signing_not_configured");
      const payload = { type: "evaluation_requested", roomId };
      if (submissionCount != null) payload.submissionCount = Number(submissionCount);
      if (deadline_unix != null) payload.deadline_unix = Number(deadline_unix);
      return this.publish({
        roomId,
        content: JSON.stringify(payload),
        extraTags: [["x", "evaluation_requested"]]
      });
    },

    async upvote({ roomId, submissionEventId, reason = null } = {}) {
      if (!pubkey) throw new Error("signing_not_configured");
      const payload = {
        type: "upvote",
        roomId,
        submissionEventId,
        voter: `nostr:${pubkey}`
      };
      if (reason) payload.reason = String(reason);
      return this.publish({
        roomId,
        content: JSON.stringify(payload),
        extraTags: [["x", "upvote"]]
      });
    },

    watchEvaluation({ roomId, sinceSeconds = Math.floor(Date.now() / 1000) - 60 * 30, onVote } = {}) {
      const since = Number(sinceSeconds) || 0;
      const sub = pool.subscribeMany(
        relayList,
        { kinds: [1], "#t": [roomTopic(roomId)], since },
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
            if (payload?.type !== "upvote") return;
            onVote?.({ event: evt, payload });
          }
        }
      );
      return { close: () => sub?.close?.("client_close") };
    },

    async offerService({ title, description, categories = [], price = null } = {}) {
      if (!pubkey) throw new Error("signing_not_configured");
      const serviceId = `svc:${pubkey}:${Date.now().toString(36)}`;
      const payload = {
        type: "service_offered",
        serviceId,
        provider: `nostr:${pubkey}`,
        title,
        description,
        categories
      };
      if (price) payload.price = price;
      const result = await this.publish({
        roomId: "services",
        content: JSON.stringify(payload),
        extraTags: [["x", "service_offered"]]
      });
      return { ...result, serviceId };
    },

    async requestService({ serviceId, jobRoomId, details } = {}) {
      if (!pubkey) throw new Error("signing_not_configured");
      const payload = {
        type: "service_request",
        serviceId,
        buyer: `nostr:${pubkey}`,
        jobRoomId,
        details
      };
      return this.publish({
        roomId: "services",
        content: JSON.stringify(payload),
        extraTags: [["x", "service_request"]]
      });
    },

    async proposeBarter({ offer, want, categories = [] } = {}) {
      if (!pubkey) throw new Error("signing_not_configured");
      const barterId = `barter:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const payload = {
        type: "service_barter",
        barterId,
        proposer: `nostr:${pubkey}`,
        offer,
        want,
        categories
      };
      const result = await this.publish({
        roomId: "services",
        content: JSON.stringify(payload),
        extraTags: [["x", "service_barter"]]
      });
      return { ...result, barterId };
    },

    async acceptBarter({ barterId } = {}) {
      if (!pubkey) throw new Error("signing_not_configured");
      const payload = {
        type: "barter_accepted",
        barterId,
        accepter: `nostr:${pubkey}`
      };
      return this.publish({
        roomId: "services",
        content: JSON.stringify(payload),
        extraTags: [["x", "barter_accepted"]]
      });
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

    watchLobby({ sinceSeconds = Math.floor(Date.now() / 1000) - 60 * 30, onIssue, onJob } = {}) {
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
            if (payload?.type === "issue_opened") {
              onIssue?.({ event: evt, payload });
            }
            if (payload?.type === "job_opened") {
              onJob?.({ event: evt, payload });
            }
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
