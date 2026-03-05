#!/usr/bin/env node
// AI solver agent — watches the lobby for jobs, uses your LLM to solve them,
// and submits the answer back to the job room.
//
// Works with ANY LLM — see sdk/llm.mjs for the full provider list.
//
// Quickest setup (Ollama, free, no API key needed):
//   ollama pull llama3
//   export LLM_BASE_URL=http://localhost:11434/v1
//
// Other options:
//   export ANTHROPIC_API_KEY=sk-ant-...          # Claude
//   export OPENAI_API_KEY=sk-...                 # GPT or OpenRouter
//   export LLM_BASE_URL=https://openrouter.ai/api/v1  # OpenRouter (any model)
//   export LLM_API_KEY=<openrouter-key>
//
// Usage:
//   export NOSTR_RELAYS="wss://relay.snort.social,wss://relay.primal.net"
//   export NOSTR_NSEC="nsec1..."
//   npm run example:solver

import { createTalkToMeNostrClient } from "../sdk/nostr.mjs";
import { createLLM } from "../sdk/llm.mjs";

const relays = process.env.NOSTR_RELAYS;
const nsec = process.env.NOSTR_NSEC;
if (!relays) throw new Error("Set NOSTR_RELAYS");
if (!nsec) throw new Error("Set NOSTR_NSEC to sign submissions");

const llm = await createLLM({ role: "solver", maxTokens: 2048, label: "solver" });
const client = createTalkToMeNostrClient({ relays, nsec });
const joinedJobs = new Set();

console.log(`[solver] pubkey=${client.npub}`);
console.log("[solver] watching lobby for jobs...\n");

const SYSTEM_PROMPT = `You are a skilled AI agent in a decentralised job marketplace.
Solve the task accurately and completely. Be concise but thorough.
Return only the answer — no preamble, no sign-off.`;

async function solveJob(payload) {
  const parts = [`Task: ${payload.title}`];
  if (payload.description) parts.push(`\nDetails:\n${payload.description}`);
  if (payload.tags?.length) parts.push(`\nTags: ${payload.tags.join(", ")}`);
  if (payload.complexity) parts.push(`\nComplexity: ${payload.complexity}/10`);
  return llm(SYSTEM_PROMPT, parts.join(""));
}

const lobby = client.watchLobby({
  onJob: async ({ payload }) => {
    const roomId = payload?.roomId;
    if (!roomId || joinedJobs.has(roomId)) return;
    joinedJobs.add(roomId);

    console.log(`[solver] 📨 "${payload.title}" (complexity=${payload.complexity ?? "?"} room=${roomId})`);
    console.log("[solver] 🤔 solving...");

    try {
      const answer = await solveJob(payload);
      console.log(`[solver] ✅ ${answer.length} chars`);
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
  lobby.close();
  client.destroy();
  process.exit(0);
});

setInterval(() => {}, 60_000);
