import { safeJsonParse } from "./protocol.js";

function cmpEvent(a, b) {
  // Deterministic ordering: created_at, then id.
  const at = Number(a?.created_at) || 0;
  const bt = Number(b?.created_at) || 0;
  if (at !== bt) return at - bt;
  const ai = String(a?.id ?? "");
  const bi = String(b?.id ?? "");
  return ai < bi ? -1 : ai > bi ? 1 : 0;
}

function getRoomIdFromPayload(payload) {
  const roomId = payload?.roomId;
  return typeof roomId === "string" && roomId.length > 0 ? roomId : null;
}

/**
 * Reduce a list of Nostr events into a best-effort issue state.
 *
 * Notes:
 * - This is an off-chain coordination state machine. It is not canonical.
 * - We assume each "transition" is a Nostr-signed JSON payload in event.content.
 * - For automation, consumers should use this reducer + their own policies.
 */
export function reduceIssueState({ roomId, events }) {
  const out = {
    roomId,
    state: "OPEN",
    openerPubkey: null,
    claimedBy: null,
    lastSubmission: null, // { eventId, pubkey, artifact, summary, created_at }
    accepted: null, // { eventId, pubkey(opener), solver, submissionEventId, created_at }
    dispute: null, // { eventId, pubkey, reason, created_at, resolvedBy, resolution }
    signals: { claims: 0, submissions: 0, accepts: 0, disputes: 0, resolves: 0 },
    warnings: []
  };

  const evts = Array.isArray(events) ? Array.from(events) : [];
  evts.sort(cmpEvent);

  // First pass: find opener if the issue is echoed into the room.
  for (const evt of evts) {
    const parsed = safeJsonParse(evt?.content ?? "");
    if (!parsed.ok) continue;
    const payload = parsed.value;
    if (payload?.type !== "issue_opened") continue;
    const rid = getRoomIdFromPayload(payload);
    if (rid && roomId && rid !== roomId) continue;
    out.openerPubkey = String(evt.pubkey || "") || null;
    break;
  }

  for (const evt of evts) {
    const parsed = safeJsonParse(evt?.content ?? "");
    if (!parsed.ok) continue;
    const payload = parsed.value;
    const type = payload?.type;
    if (typeof type !== "string") continue;

    const rid = getRoomIdFromPayload(payload);
    if (rid && roomId && rid !== roomId) continue;

    if (type === "issue_claimed") {
      out.signals.claims += 1;
      // Claim is signed by claimant; prefer payload.solver, else event.pubkey.
      out.claimedBy = payload?.solver ?? `nostr:${evt.pubkey}`;
      if (!out.openerPubkey && typeof payload?.openerPubkey === "string") out.openerPubkey = payload.openerPubkey;
      continue;
    }

    if (type === "solution_submitted") {
      out.signals.submissions += 1;
      out.lastSubmission = {
        eventId: evt.id,
        pubkey: evt.pubkey,
        artifact: payload?.artifact ?? null,
        summary: payload?.summary ?? null,
        created_at: evt.created_at
      };
      if (!out.openerPubkey && typeof payload?.openerPubkey === "string") out.openerPubkey = payload.openerPubkey;
      continue;
    }

    if (type === "solution_accepted") {
      out.signals.accepts += 1;
      // Acceptance should be signed by opener; we can't enforce that on-chain here.
      out.accepted = {
        eventId: evt.id,
        pubkey: evt.pubkey,
        solver: payload?.solver ?? null,
        submissionEventId: payload?.submissionEventId ?? payload?.submission ?? null,
        created_at: evt.created_at
      };
      if (!out.openerPubkey) out.openerPubkey = evt.pubkey;
      continue;
    }

    if (type === "dispute_opened") {
      out.signals.disputes += 1;
      out.dispute = {
        eventId: evt.id,
        pubkey: evt.pubkey,
        reason: payload?.reason ?? null,
        created_at: evt.created_at,
        resolvedBy: null,
        resolution: null
      };
      continue;
    }

    if (type === "dispute_resolved") {
      out.signals.resolves += 1;
      if (!out.dispute) {
        out.dispute = {
          eventId: null,
          pubkey: null,
          reason: null,
          created_at: null,
          resolvedBy: evt.pubkey,
          resolution: payload?.resolution ?? null
        };
      } else {
        out.dispute.resolvedBy = evt.pubkey;
        out.dispute.resolution = payload?.resolution ?? null;
      }
      continue;
    }
  }

  if (out.dispute && !out.dispute.resolvedBy) out.state = "DISPUTED";
  else if (out.accepted) out.state = "ACCEPTED";
  else if (out.lastSubmission) out.state = "SUBMITTED";
  else if (out.claimedBy) out.state = "CLAIMED";
  else out.state = "OPEN";

  if (out.accepted && out.openerPubkey && out.accepted.pubkey !== out.openerPubkey) {
    out.warnings.push("acceptance_pubkey_mismatch");
  }

  return out;
}

