import assert from "node:assert/strict";
import { test } from "node:test";
import { reduceIssueState } from "../../src/issue_state.js";

function evt(id, content, created_at = 1000) {
  return { id, pubkey: `pk-${id}`, content: JSON.stringify(content), created_at };
}

const roomId = "job:offchain:test-1";

test("OPEN state when no events", () => {
  const state = reduceIssueState({ roomId, events: [] });
  assert.equal(state.state, "OPEN");
});

test("recognizes job_opened and captures opener + complexity", () => {
  const events = [evt("e1", { type: "job_opened", roomId, title: "Test", description: "desc", complexity: 5 })];
  const state = reduceIssueState({ roomId, events });
  assert.equal(state.state, "OPEN");
  assert.equal(state.openerPubkey, "pk-e1");
  assert.equal(state.complexity, 5);
});

test("COMPETING state after solution_submitted", () => {
  const events = [
    evt("e1", { type: "job_opened", roomId, title: "Test", description: "desc", complexity: 3 }),
    evt("e2", { type: "solution_submitted", roomId, solver: "nostr:pk-e2", artifact: { kind: "text", value: "ans" } }, 1001)
  ];
  const state = reduceIssueState({ roomId, events });
  assert.equal(state.state, "COMPETING");
  assert.equal(state.signals.submissions, 1);
});

test("EVALUATING state after evaluation_requested", () => {
  const events = [
    evt("e1", { type: "job_opened", roomId, title: "Test", description: "desc", complexity: 3 }),
    evt("e2", { type: "solution_submitted", roomId, solver: "nostr:pk-e2", artifact: { kind: "text", value: "ans" } }, 1001),
    evt("e3", { type: "evaluation_requested", roomId }, 1002)
  ];
  const state = reduceIssueState({ roomId, events });
  assert.equal(state.state, "EVALUATING");
  assert.ok(state.evaluationRequested);
});

test("VOTING state after upvotes", () => {
  const events = [
    evt("e1", { type: "job_opened", roomId, title: "Test", description: "desc", complexity: 3 }),
    evt("e2", { type: "solution_submitted", roomId, solver: "nostr:pk-e2", artifact: { kind: "text", value: "ans" } }, 1001),
    evt("e3", { type: "evaluation_requested", roomId }, 1002),
    evt("e4", { type: "upvote", roomId, submissionEventId: "e2", voter: "nostr:pk-e4" }, 1003)
  ];
  const state = reduceIssueState({ roomId, events });
  assert.equal(state.state, "VOTING");
  assert.equal(state.winner?.submissionEventId, "e2");
  assert.equal(state.winner?.votes, 1);
});

test("deduplicates votes from the same voter", () => {
  // Both upvote events have the same pubkey — the second should be rejected.
  const dupVote = { id: "e4", pubkey: "pk-voter", content: JSON.stringify({ type: "upvote", roomId, submissionEventId: "e2", voter: "nostr:pk-voter" }), created_at: 1003 };
  const events = [
    evt("e1", { type: "job_opened", roomId, title: "T", description: "d", complexity: 1 }),
    evt("e2", { type: "solution_submitted", roomId, solver: "nostr:pk-s", artifact: { kind: "text", value: "x" } }, 1001),
    { id: "e3", pubkey: "pk-voter", content: JSON.stringify({ type: "upvote", roomId, submissionEventId: "e2", voter: "nostr:pk-voter" }), created_at: 1002 },
    dupVote
  ];
  const state = reduceIssueState({ roomId, events });
  assert.equal(state.winner?.votes, 1);
  assert.ok(state.warnings.some(w => w.startsWith("duplicate_vote")));
});

test("picks winner with most votes", () => {
  const events = [
    evt("e1", { type: "job_opened", roomId, title: "T", description: "d", complexity: 2 }),
    evt("e2", { type: "solution_submitted", roomId, solver: "nostr:pk-s1", artifact: { kind: "text", value: "a" } }, 1001),
    evt("e3", { type: "solution_submitted", roomId, solver: "nostr:pk-s2", artifact: { kind: "text", value: "b" } }, 1002),
    evt("e4", { type: "upvote", roomId, submissionEventId: "e2", voter: "nostr:pk-v1" }, 1003),
    evt("e5", { type: "upvote", roomId, submissionEventId: "e3", voter: "nostr:pk-v2" }, 1004),
    evt("e6", { type: "upvote", roomId, submissionEventId: "e3", voter: "nostr:pk-v3" }, 1005)
  ];
  const state = reduceIssueState({ roomId, events });
  assert.equal(state.winner?.submissionEventId, "e3");
  assert.equal(state.winner?.votes, 2);
});

test("SETTLED state after solution_accepted", () => {
  const events = [
    evt("e1", { type: "job_opened", roomId, title: "T", description: "d", complexity: 1 }),
    evt("e2", { type: "solution_submitted", roomId, solver: "nostr:pk-s", artifact: { kind: "text", value: "x" } }, 1001),
    evt("e3", { type: "solution_accepted", roomId, solver: "nostr:pk-s", submissionEventId: "e2" }, 1002)
  ];
  const state = reduceIssueState({ roomId, events });
  assert.equal(state.state, "SETTLED");
  assert.ok(state.accepted);
});

test("DISPUTED state on open dispute", () => {
  const events = [
    evt("e1", { type: "job_opened", roomId, title: "T", description: "d", complexity: 1 }),
    evt("e2", { type: "dispute_opened", roomId, reason: "Plagiarism" }, 1001)
  ];
  const state = reduceIssueState({ roomId, events });
  assert.equal(state.state, "DISPUTED");
});

test("legacy issue_opened is recognised", () => {
  const events = [
    evt("e1", { type: "issue_opened", roomId, title: "Old format", description: "d", bounty: "0" })
  ];
  const state = reduceIssueState({ roomId, events });
  assert.equal(state.openerPubkey, "pk-e1");
});

test("empty content events are silently ignored", () => {
  const events = [
    { id: "e1", pubkey: "pk-e1", content: "not json at all", created_at: 1000 },
    { id: "e2", pubkey: "pk-e2", content: "", created_at: 1001 }
  ];
  const state = reduceIssueState({ roomId, events });
  assert.equal(state.state, "OPEN");
});
