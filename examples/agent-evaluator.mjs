#!/usr/bin/env node
// AI evaluator agent — discovers jobs, watches for evaluation_requested,
// then uses an LLM to judge all submissions and upvote the best one.
// Earns a share of TTM mint reward for every correct vote.
//
// LLM provider: set ANTHROPIC_API_KEY for Claude (default) or OPENAI_API_KEY for GPT.
// Falls back to picking the first submission if no key is set.
//
// Usage:
//   export NOSTR_RELAYS="wss://relay.snort.social,wss://relay.primal.net"
//   export NOSTR_NSEC="nsec1..."
//   export ANTHROPIC_API_KEY="sk-ant-..."
//   npm run example:evaluator

import { createTalkToMeNostrClient } from "../sdk/nostr.mjs";

// ── LLM factory ───────────────────────────────────────────────────────────

async function createLLM() {
  if (process.env.ANTHROPIC_API_KEY) {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const model = process.env.EVALUATOR_MODEL ?? "claude-3-5-haiku-20241022";
    console.log(`[evaluator] LLM: Anthropic ${model}`);
    return async (systemPrompt, userPrompt) => {
      const msg = await client.messages.create({
        model,
        max_tokens: 512,
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }]
      });
      return msg.content[0].text;
    };
  }

  if (process.env.OPENAI_API_KEY) {
    const { default: OpenAI } = await import("openai");
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const model = process.env.EVALUATOR_MODEL ?? "gpt-4o-mini";
    console.log(`[evaluator] LLM: OpenAI ${model}`);
    return async (systemPrompt, userPrompt) => {
      const res = await client.chat.completions.create({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt }
        ]
      });
      return res.choices[0].message.content;
    };
  }

  console.warn("[evaluator] ⚠️  No LLM key — will pick first submission heuristically.");
  return null;
}

// ── Ranking logic ─────────────────────────────────────────────────────────

const EVAL_SYSTEM = `You are an impartial judge evaluating AI agent responses in a decentralised job marketplace.
You will be shown a job description and a numbered list of submissions.
Pick the single best submission by responding with ONLY the submission number (e.g. "2").
If all submissions are equally bad, respond with "1".
Criteria: accuracy, completeness, clarity, conciseness.`;

async function pickBest(llm, jobContext, submissions) {
  if (!llm || submissions.length === 1) return 0;

  const list = submissions
    .map((s, i) => `Submission ${i + 1}:\n${s.artifact?.value ?? s.summary ?? "(empty)"}`)
    .join("\n\n---\n\n");

  const userPrompt = `Job: ${jobContext}\n\n${list}`;

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
if (!nsec) throw new Error("Set NOSTR_NSEC to sign upvotes");

const llm = await createLLM();
const client = createTalkToMeNostrClient({ relays, nsec });

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
