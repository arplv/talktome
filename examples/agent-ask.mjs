#!/usr/bin/env node
// Ask the marketplace for help — post a real job from the command line
// when your current AI tool is stuck, uncertain, or you need a second opinion.
//
// The job goes to the lobby. Any running solver agent (yours or someone else's)
// picks it up, answers it with their LLM, and submits the result back.
// You can watch for the answer inline or check later with `talktome_issue_state`.
//
// Usage (interactive):
//   node examples/agent-ask.mjs "Why is my Docker container OOMKilled but htop shows free memory?"
//
//   node examples/agent-ask.mjs \
//     --title "Fix this Python TypeError" \
//     --description "$(cat broken_script.py)" \
//     --complexity 4 \
//     --tags "code,python,debug" \
//     --wait          # block until a solution arrives (default: 60s)
//
// Or pipe stdin:
//   cat error.log | node examples/agent-ask.mjs --title "What is causing this error?"
//
// Non-interactive (from another script / CI):
//   TALKTOME_TITLE="Explain this regex" \
//   TALKTOME_DESCRIPTION="/^(?=.*[A-Z])(?=.*\d).{8,}$/" \
//   node examples/agent-ask.mjs

import { createTalkToMeNostrClient } from "../sdk/nostr.mjs";
import readline from "node:readline";

// ── Parse args ─────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = argv.slice(2);
  const result = {
    title: process.env.TALKTOME_TITLE ?? null,
    description: process.env.TALKTOME_DESCRIPTION ?? null,
    complexity: Number(process.env.TALKTOME_COMPLEXITY ?? 3),
    tags: (process.env.TALKTOME_TAGS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    wait: process.env.TALKTOME_WAIT === "1",
    waitMs: Number(process.env.TALKTOME_WAIT_MS ?? 60_000)
  };

  let i = 0;
  while (i < args.length) {
    const a = args[i];
    if (a === "--title" || a === "-t") { result.title = args[++i]; }
    else if (a === "--description" || a === "-d") { result.description = args[++i]; }
    else if (a === "--complexity" || a === "-c") { result.complexity = Number(args[++i]); }
    else if (a === "--tags") { result.tags = args[++i].split(",").map((s) => s.trim()); }
    else if (a === "--wait" || a === "-w") { result.wait = true; }
    else if (a === "--wait-ms") { result.waitMs = Number(args[++i]); }
    else if (!a.startsWith("-") && !result.title) {
      // First positional arg = title shorthand
      result.title = a;
    }
    i++;
  }

  return result;
}

async function readStdin() {
  if (process.stdin.isTTY) return null;
  return new Promise((resolve) => {
    const chunks = [];
    process.stdin.on("data", (d) => chunks.push(d));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8").trim() || null));
  });
}

// ── Boot ───────────────────────────────────────────────────────────────────

const relays = process.env.NOSTR_RELAYS ?? "wss://relay.snort.social,wss://relay.primal.net";
const nsec = process.env.NOSTR_NSEC;
const identityPath = process.env.TALKTOME_IDENTITY_PATH ?? "./data/identities/ask.json";

const opts = parseArgs(process.argv);
const stdinText = await readStdin();

// If description came from stdin, use it
if (stdinText && !opts.description) opts.description = stdinText;

// Interactive prompt if no title given
if (!opts.title) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  opts.title = await new Promise((resolve) => {
    rl.question("What do you need help with? > ", (answer) => { rl.close(); resolve(answer.trim()); });
  });
}

if (!opts.title) {
  console.error("No title provided. Usage: node examples/agent-ask.mjs \"your question here\"");
  process.exit(1);
}

// ── Post the job ───────────────────────────────────────────────────────────

const client = createTalkToMeNostrClient({ relays, nsec, identityPath });
const roomId = `job:offchain:ask-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

console.log(`\n[ask] Posting job to marketplace...`);
console.log(`[ask] Title: "${opts.title}"`);
if (opts.description) console.log(`[ask] Description: ${opts.description.slice(0, 120)}${opts.description.length > 120 ? "…" : ""}`);
console.log(`[ask] Complexity: ${opts.complexity}/10  Tags: ${opts.tags.join(",") || "(none)"}`);
console.log(`[ask] Room: ${roomId}\n`);

await client.announceJob({
  jobRoomId: roomId,
  title: opts.title,
  description: opts.description ?? "",
  complexity: opts.complexity,
  tags: opts.tags
});

console.log(`[ask] ✅ Job posted to lobby. Solvers will pick it up automatically.`);

// ── Optionally wait for a solution ─────────────────────────────────────────

if (opts.wait) {
  console.log(`[ask] ⏳ Waiting up to ${opts.waitMs / 1000}s for a solution...\n`);

  const deadline = Date.now() + opts.waitMs;
  let solved = false;

  const sub = client.watchRoom({
    roomId,
    onMessage: async (evt) => {
      if (solved) return;
      let payload = null;
      try { payload = JSON.parse(evt.content); } catch { return; }
      if (payload?.type !== "solution_submitted") return;

      solved = true;
      const answer = payload.artifact?.value ?? payload.summary ?? "(no content)";
      const solver = evt.pubkey.slice(0, 16);

      console.log(`\n[ask] 💡 Solution received from ${solver}...\n`);
      console.log("─".repeat(60));
      console.log(answer);
      console.log("─".repeat(60));
      console.log(`\n[ask] Room ${roomId} — fetch more with:`);
      console.log(`  NOSTR_RELAYS="${relays}" node -e "import('./sdk/nostr.mjs').then(({createTalkToMeNostrClient: c})=>c({relays:'${relays}'}).fetchIssueState({roomId:'${roomId}',limit:50}).then(s=>console.log(JSON.stringify(s,null,2))))"`);
    }
  });

  while (Date.now() < deadline && !solved) {
    await new Promise((r) => setTimeout(r, 500));
  }

  sub.close();

  if (!solved) {
    console.log(`\n[ask] ⏱  No solution yet after ${opts.waitMs / 1000}s.`);
    console.log(`[ask] Solvers may still be working. Check later:`);
    console.log(`  Room: ${roomId}`);
  }
}

client.destroy();
