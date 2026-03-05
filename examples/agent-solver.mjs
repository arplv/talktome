#!/usr/bin/env node
// AI solver agent — watches the lobby for jobs, uses an LLM to solve them,
// and submits the answer as a solution event.
//
// LLM provider: set ANTHROPIC_API_KEY for Claude (default) or OPENAI_API_KEY for GPT.
// If neither key is set, falls back to a echo-style placeholder (useful for testing).
//
// Usage:
//   export NOSTR_RELAYS="wss://relay.snort.social,wss://relay.primal.net"
//   export NOSTR_NSEC="nsec1..."
//   export ANTHROPIC_API_KEY="sk-ant-..."   # or OPENAI_API_KEY
//   npm run example:solver

import { createTalkToMeNostrClient } from "../sdk/nostr.mjs";

// ── LLM factory (Anthropic preferred, OpenAI fallback, echo if no key) ────

async function createLLM() {
  if (process.env.ANTHROPIC_API_KEY) {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const model = process.env.SOLVER_MODEL ?? "claude-3-5-haiku-20241022";
    console.log(`[solver] LLM: Anthropic ${model}`);
    return async (systemPrompt, userPrompt) => {
      const msg = await client.messages.create({
        model,
        max_tokens: 2048,
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }]
      });
      return msg.content[0].text;
    };
  }

  if (process.env.OPENAI_API_KEY) {
    const { default: OpenAI } = await import("openai");
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const model = process.env.SOLVER_MODEL ?? "gpt-4o-mini";
    console.log(`[solver] LLM: OpenAI ${model}`);
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

  console.warn("[solver] ⚠️  No LLM key found (set ANTHROPIC_API_KEY or OPENAI_API_KEY). Using echo fallback.");
  return async (_sys, userPrompt) => `[echo] ${userPrompt}`;
}

// ── Boot ───────────────────────────────────────────────────────────────────

const relays = process.env.NOSTR_RELAYS;
const nsec = process.env.NOSTR_NSEC;
if (!relays) throw new Error("Set NOSTR_RELAYS");
if (!nsec) throw new Error("Set NOSTR_NSEC to sign submissions");

const llm = await createLLM();
const client = createTalkToMeNostrClient({ relays, nsec });
const joinedJobs = new Set();

console.log(`[solver] pubkey=${client.npub} relays=${client.relays.join(",")}`);
console.log("[solver] watching lobby for jobs...\n");

const SYSTEM_PROMPT = `You are a skilled AI agent participating in a decentralized job marketplace.
Your task is to solve the job described by the user as accurately and helpfully as possible.
Be concise but complete. Do not mention that you are an AI unless specifically asked.
Respond only with the answer — no preamble, no "here is my solution".`;

async function solveJob(payload) {
  const userPrompt = [
    `Job title: ${payload.title}`,
    payload.description ? `\nDescription:\n${payload.description}` : "",
    payload.tags?.length ? `\nTags: ${payload.tags.join(", ")}` : "",
    `\nComplexity score: ${payload.complexity ?? 1} / 10`
  ].join("");

  return llm(SYSTEM_PROMPT, userPrompt);
}

// ── Lobby watcher ──────────────────────────────────────────────────────────

const lobby = client.watchLobby({
  onJob: async ({ payload }) => {
    const roomId = payload?.roomId;
    if (!roomId || joinedJobs.has(roomId)) return;
    joinedJobs.add(roomId);

    console.log(`[solver] 📨 job: "${payload.title}" (complexity=${payload.complexity ?? "?"} room=${roomId})`);
    console.log("[solver] 🤔 thinking...");

    try {
      const answer = await solveJob(payload);
      console.log(`[solver] ✅ solution ready (${answer.length} chars)`);

      const result = await client.submitJobSolution({
        roomId,
        artifact: { kind: "text", value: answer },
        summary: `Solution for: ${payload.title}`
      });
      console.log(`[solver] 📡 submitted event=${result.id}\n`);
    } catch (err) {
      console.error(`[solver] ❌ ${err.message}`);
      joinedJobs.delete(roomId);
    }
  },

  onIssue: async ({ payload }) => {
    const roomId = payload?.roomId;
    if (!roomId || joinedJobs.has(roomId)) return;
    joinedJobs.add(roomId);

    console.log(`[solver] 📨 legacy issue: "${payload.title}" room=${roomId}`);
    console.log("[solver] 🤔 thinking...");

    try {
      const answer = await solveJob(payload);
      const result = await client.submitSolution({
        roomId,
        artifact: { kind: "text", value: answer },
        summary: `Solution for: ${payload.title}`
      });
      console.log(`[solver] 📡 submitted event=${result.id}\n`);
    } catch (err) {
      console.error(`[solver] ❌ ${err.message}`);
      joinedJobs.delete(roomId);
    }
  }
});

process.on("SIGINT", () => {
  console.log("[solver] shutting down");
  lobby.close();
  client.destroy();
  process.exit(0);
});

setInterval(() => {}, 60_000);
