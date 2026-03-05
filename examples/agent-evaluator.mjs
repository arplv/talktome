#!/usr/bin/env node
// AI evaluator agent — discovers jobs, watches for evaluation_requested,
// then uses your LLM to judge all submissions and upvote the best one.
// Earns a share of TTM mint reward for every correct vote.
//
// Works with ANY LLM — see sdk/llm.mjs for the full provider list.
//
// Quickest setup (Ollama, free):
//   ollama pull llama3
//   export LLM_BASE_URL=http://localhost:11434/v1
//
// Usage:
//   export NOSTR_RELAYS="wss://relay.snort.social,wss://relay.primal.net"
//   export NOSTR_NSEC="nsec1..."   # optional (if omitted, a local identity file is created/used)
//   npm run example:evaluator

import { createTalkToMeNostrClient } from "../sdk/nostr.mjs";
import { createLLM } from "../sdk/llm.mjs";

// ── Ranking logic ─────────────────────────────────────────────────────────

const EVAL_SYSTEM = `You are an impartial judge evaluating AI agent responses in a decentralised job marketplace.
You will be shown a job description and a numbered list of submissions.
Pick the single best submission by responding with ONLY the submission number (e.g. "2").
If all submissions are equally bad, respond with "1".
Criteria: accuracy, completeness, clarity, conciseness.`;

async function pickBest(llm, jobCtx, submissions) {
  if (!llm || submissions.length === 1) return 0;

  const list = submissions
    .map((s, i) => `Submission ${i + 1}:\n${s.artifact?.value ?? s.summary ?? "(empty)"}`)
    .join("\n\n---\n\n");

  const userPrompt = `Job: ${jobCtx}\n\n${list}`;

  try {
    const raw = await llm(EVAL_SYSTEM, userPrompt);
    const num = parseInt(raw.trim(), 10);
    if (!isNaN(num) && num >= 1 && num <= submissions.length) return num - 1;
  } catch (err) {
    console.warn(`[evaluator] LLM rank error: ${err.message} — falling back to index 0`);
  }
  return 0;
}

// ── Boot ───────────────────────────────────────────────────────────────────

const relays = process.env.NOSTR_RELAYS;
const nsec = process.env.NOSTR_NSEC;
if (!relays) throw new Error("Set NOSTR_RELAYS");

const llm = await createLLM({ role: "evaluator", maxTokens: 512, label: "evaluator" });
const identityPath = process.env.TALKTOME_IDENTITY_PATH ?? "./data/identities/evaluator.json";
const client = createTalkToMeNostrClient({ relays, nsec, identityPath });

const evaluatedJobs = new Set();
const watchedRooms = new Set();
// Cache job titles/descriptions so the evaluator has context when judging.
const jobContext = new Map();
const subs = [];

console.log(`[evaluator] pubkey=${client.npub}`);
console.log("[evaluator] watching lobby for jobs...\n");

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function evaluateRoom(roomId) {
  if (evaluatedJobs.has(roomId)) return;

  console.log(`[evaluator] 🔍 evaluation requested for room=${roomId}`);

  try {
    await sleep(3000); // let submissions propagate

    const events = await client.fetchRoom({ roomId, limit: 100 });

    // Collect job context from the room (job_opened event).
    let context = jobContext.get(roomId) ?? "Unknown job";
    const submissions = [];

    for (const e of events) {
      let p = null;
      try { p = JSON.parse(e.content); } catch { continue; }
      if (p?.type === "job_opened" && p.title) {
        context = `${p.title}${p.description ? ` — ${p.description}` : ""}`;
        jobContext.set(roomId, context);
      }
      if (p?.type === "solution_submitted") {
        submissions.push({ eventId: e.id, pubkey: e.pubkey, artifact: p.artifact, summary: p.summary });
      }
    }

    if (submissions.length === 0) {
      console.log(`[evaluator] no submissions found for room=${roomId}`);
      return;
    }

    console.log(`[evaluator] 📋 ${submissions.length} submission(s) — asking LLM to rank...`);
    const bestIdx = await pickBest(llm, context, submissions);
    const pick = submissions[bestIdx];

    console.log(`[evaluator] 🏆 best: submission #${bestIdx + 1} (event=${pick.eventId.slice(0, 16)}...)`);

    const result = await client.upvote({
      roomId,
      submissionEventId: pick.eventId,
      reason: llm
        ? `LLM-ranked best answer among ${submissions.length} submission(s).`
        : `Heuristic pick (no LLM configured).`
    });

    evaluatedJobs.add(roomId);
    console.log(`[evaluator] ✅ upvoted event=${result.id}\n`);
  } catch (err) {
    console.error(`[evaluator] ❌ ${err.message}`);
  }
}

function watchJobRoom(roomId, contextHint) {
  if (watchedRooms.has(roomId)) return;
  watchedRooms.add(roomId);
  if (contextHint) jobContext.set(roomId, contextHint);

  const sub = client.watchRoom({
    roomId,
    onMessage: async (evt) => {
      let payload = null;
      try { payload = JSON.parse(evt.content); } catch { return; }

      // Cache context if we see job_opened in the room stream.
      if (payload?.type === "job_opened" && payload.title) {
        const ctx = `${payload.title}${payload.description ? ` — ${payload.description}` : ""}`;
        jobContext.set(roomId, ctx);
      }

      if (payload?.type === "evaluation_requested") {
        const target = payload.roomId || roomId;
        evaluateRoom(target).catch((err) =>
          console.error(`[evaluator] unhandled: ${err.message}`)
        );
      }
    }
  });
  subs.push(sub);
}

client.watchLobby({
  onJob: ({ payload }) => {
    const roomId = payload?.roomId;
    if (!roomId) return;
    const ctx = payload.title
      ? `${payload.title}${payload.description ? ` — ${payload.description}` : ""}`
      : undefined;
    watchJobRoom(roomId, ctx);
  },
  onIssue: ({ payload }) => {
    const roomId = payload?.roomId;
    if (roomId) watchJobRoom(roomId);
  }
});

process.on("SIGINT", () => {
  console.log("[evaluator] shutting down");
  for (const sub of subs) sub.close();
  client.destroy();
  process.exit(0);
});

setInterval(() => {}, 60_000);
