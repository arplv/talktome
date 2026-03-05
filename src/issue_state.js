import { safeJsonParse } from "./protocol.js";

function cmpEvent(a, b) {
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
 * Reduce a list of Nostr events into a best-effort issue/job state.
 *
 * Supports both the legacy issue lifecycle (issue_opened → issue_claimed →
 * solution_submitted → solution_accepted) and the new job lifecycle
 * (job_opened → solution_submitted → evaluation_requested → upvote).
 *
 * This is an off-chain coordination state machine — it is not canonical.
 */
export function reduceIssueState({ roomId, events }) {
  const out = {
    roomId,
    state: "OPEN",
    openerPubkey: null,
    claimedBy: null,
    complexity: null,
    lastSubmission: null,
    accepted: null,
    dispute: null,
    evaluationRequested: null,
    votes: [],
    voteTally: {},
    winner: null,
    signals: { claims: 0, submissions: 0, accepts: 0, disputes: 0, resolves: 0, evaluations: 0, upvotes: 0 },
    warnings: []
  };

  const evts = Array.isArray(events) ? Array.from(events) : [];
  evts.sort(cmpEvent);

  // First pass: find opener from either job_opened or issue_opened.
  for (const evt of evts) {
    const parsed = safeJsonParse(evt?.content ?? "");
    if (!parsed.ok) continue;
    const payload = parsed.value;
    if (payload?.type !== "issue_opened" && payload?.type !== "job_opened") continue;
    const rid = getRoomIdFromPayload(payload);
    if (rid && roomId && rid !== roomId) continue;
    out.openerPubkey = String(evt.pubkey || "") || null;
    if (payload.complexity != null) out.complexity = Number(payload.complexity) || null;
    break;
  }

  const seenVoters = new Set();

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

    if (type === "evaluation_requested") {
      out.signals.evaluations += 1;
      out.evaluationRequested = {
        eventId: evt.id,
        pubkey: evt.pubkey,
        submissionCount: payload?.submissionCount ?? null,
        deadline_unix: payload?.deadline_unix ?? null,
        created_at: evt.created_at
      };
      continue;
    }

    if (type === "upvote") {
      out.signals.upvotes += 1;
      const voter = evt.pubkey;
      if (seenVoters.has(voter)) {
        out.warnings.push(`duplicate_vote:${voter}`);
        continue;
      }
      seenVoters.add(voter);
      const submissionId = payload?.submissionEventId;
      if (submissionId) {
        out.votes.push({ voter, submissionEventId: submissionId, eventId: evt.id, created_at: evt.created_at });
        out.voteTally[submissionId] = (out.voteTally[submissionId] || 0) + 1;
      }
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
          eventId: null, pubkey: null, reason: null, created_at: null,
          resolvedBy: evt.pubkey, resolution: payload?.resolution ?? null
        };
      } else {
        out.dispute.resolvedBy = evt.pubkey;
        out.dispute.resolution = payload?.resolution ?? null;
      }
      continue;
    }
  }

  // Derive winner from vote tally.
  if (Object.keys(out.voteTally).length > 0) {
    let topId = null;
    let topCount = 0;
    for (const [sid, count] of Object.entries(out.voteTally)) {
      if (count > topCount) { topId = sid; topCount = count; }
    }
    if (topId) out.winner = { submissionEventId: topId, votes: topCount };
  }

  // Derive state from signals (new lifecycle takes precedence when present).
  if (out.dispute && !out.dispute.resolvedBy) {
    out.state = "DISPUTED";
  } else if (out.accepted) {
    out.state = "SETTLED";
  } else if (out.winner) {
    out.state = "VOTING";
  } else if (out.evaluationRequested) {
    out.state = "EVALUATING";
  } else if (out.signals.submissions > 0) {
    out.state = "COMPETING";
  } else if (out.claimedBy) {
    out.state = "CLAIMED";
  } else {
    out.state = "OPEN";
  }

  if (out.accepted && out.openerPubkey && out.accepted.pubkey !== out.openerPubkey) {
    out.warnings.push("acceptance_pubkey_mismatch");
  }

  return out;
}
