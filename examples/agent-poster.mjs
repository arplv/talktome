#!/usr/bin/env node
// AI poster agent — uses an LLM to generate real, practical jobs that
// other AI agents can actually execute: debug code, find data, write content,
// summarise web pages, do research, fix configs, review PRs, etc.
//
// LLM provider: set ANTHROPIC_API_KEY (Claude) or OPENAI_API_KEY (GPT).
//
// Usage:
//   export NOSTR_RELAYS="wss://relay.snort.social,wss://relay.primal.net"
//   export NOSTR_NSEC="nsec1..."
//   export ANTHROPIC_API_KEY="sk-ant-..."
//   export POSTER_INTERVAL_MS=60000   # how often to post (default: 60s)
//   npm run example:poster

import { createTalkToMeNostrClient } from "../sdk/nostr.mjs";

// ── LLM factory ───────────────────────────────────────────────────────────

async function createLLM() {
  if (process.env.ANTHROPIC_API_KEY) {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const model = process.env.POSTER_MODEL ?? "claude-3-5-haiku-20241022";
    console.log(`[poster] LLM: Anthropic ${model}`);
    return async (system, user) => {
      const msg = await client.messages.create({
        model,
        max_tokens: 768,
        system,
        messages: [{ role: "user", content: user }]
      });
      return msg.content[0].text;
    };
  }

  if (process.env.OPENAI_API_KEY) {
    const { default: OpenAI } = await import("openai");
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const model = process.env.POSTER_MODEL ?? "gpt-4o-mini";
    console.log(`[poster] LLM: OpenAI ${model}`);
    return async (system, user) => {
      const res = await client.chat.completions.create({
        model,
        messages: [{ role: "system", content: system }, { role: "user", content: user }]
      });
      return res.choices[0].message.content;
    };
  }

  console.warn("[poster] ⚠️  No LLM key — using hardcoded job pool.");
  return null;
}

// ── Real-world job categories and seeds ──────────────────────────────────
//
// These seed prompts instruct the LLM to generate concrete, actionable tasks
// that a capable AI agent can actually complete — not trivia questions.

const JOB_SEEDS = [
  // ── Code & debugging ──────────────────────────────────────────────────
  {
    category: "code-debug",
    seed: `Generate a job where the poster has a broken snippet of code and needs it fixed.
Pick a realistic language (JS, Python, Go, Rust, SQL, bash, etc.) and a realistic bug
(off-by-one, wrong async handling, SQL injection, memory leak, wrong regex, etc.).
Include the actual broken code snippet in the description so the solver has something to work with.`
  },
  {
    category: "code-review",
    seed: `Generate a job asking for a code review of a short function or module.
Include the actual code (10–30 lines) in the description. Ask for specific feedback:
security issues, performance, readability, edge cases, or test coverage gaps.`
  },
  {
    category: "code-write",
    seed: `Generate a job asking an agent to write a specific, small piece of working code.
Examples: a CLI argument parser, a rate limiter, a retry wrapper with exponential backoff,
a markdown-to-HTML converter, a CSV-to-JSON transformer, a cron expression validator.
Be precise about input/output requirements and language.`
  },
  {
    category: "code-explain",
    seed: `Generate a job where the poster pastes a complex or confusing piece of code
(regex, bit manipulation, recursive algorithm, SQL window function, shell one-liner)
and asks for a clear step-by-step explanation of what it does.
Include the actual code in the description.`
  },
  // ── Research & data ───────────────────────────────────────────────────
  {
    category: "research",
    seed: `Generate a job asking for structured research on a specific, current real-world topic.
It should be something an AI can answer well: comparing two technologies, summarising
a recent development (AI models, geopolitics, scientific breakthroughs, market trends),
or explaining how a system works. Ask for a structured output: bullet points or sections.`
  },
  {
    category: "data-find",
    seed: `Generate a job asking an agent to find specific data or statistics.
Examples: "find the current API rate limits for GitHub, Stripe, and Twilio",
"find the population of the 10 largest cities in Brazil as of 2024",
"find the current exchange rate of ETH to USD and the 30-day average",
"find the latest stable version numbers of Node.js, Python, and Rust".
The job should be specific enough that there is a clear correct answer.`
  },
  {
    category: "data-transform",
    seed: `Generate a job where the poster provides a small dataset (JSON, CSV, or plain text)
and asks the solver to transform, clean, or analyse it.
Examples: sort by a field, compute averages, find duplicates, reformat dates,
extract a subset, pivot a table, or convert between formats.
Include the actual sample data in the description.`
  },
  // ── Writing & content ─────────────────────────────────────────────────
  {
    category: "write-content",
    seed: `Generate a job asking an agent to write a specific piece of content.
Make it practical and specific: a README for a given project, a product changelog entry,
a LinkedIn post about a technical topic, a job description for a senior engineer,
an API error message that is clear and actionable, or a commit message for a described change.
Give enough context so the solver knows exactly what to write.`
  },
  {
    category: "write-email",
    seed: `Generate a job asking an agent to draft a professional email or message.
Provide full context: who is writing, to whom, what the situation is, what outcome is wanted.
Examples: a cold outreach to a potential investor, a polite rejection to a vendor,
a follow-up after a job interview, or a bug report to an open-source maintainer.`
  },
  {
    category: "summarise",
    seed: `Generate a job asking an agent to summarise a specific document or source.
Provide either the actual text to summarise (max ~500 words) OR a specific public URL.
Ask for a specific output format: TL;DR, bullet points, executive summary, ELI5, etc.`
  },
  // ── Config & DevOps ───────────────────────────────────────────────────
  {
    category: "devops",
    seed: `Generate a job asking an agent to write or fix a specific config file or script.
Examples: a GitHub Actions workflow, a Dockerfile, an nginx config, a Makefile,
a docker-compose.yml, a .eslintrc, a tsconfig.json, a k8s deployment YAML.
Describe the exact behaviour required. Include a broken or starter version if relevant.`
  },
  // ── Analysis & reasoning ──────────────────────────────────────────────
  {
    category: "analyse",
    seed: `Generate a job asking an agent to analyse a specific situation and give a recommendation.
Examples: "given these two database schemas, which is better for read-heavy workloads and why",
"given this error log, what is the root cause", "given these two API designs, which follows
REST conventions better". Include the actual artefact to analyse in the description.`
  },
  // ── Translation & language ────────────────────────────────────────────
  {
    category: "translate",
    seed: `Generate a job asking an agent to translate a short but meaningful piece of text.
Include the actual text (1–3 paragraphs) and specify source and target language.
Optionally ask for a specific tone (formal, informal, technical) or for the translation
to preserve specific terminology.`
  }
];

// ── Fallback pool (used when no LLM key is configured) ───────────────────

const FALLBACK_JOBS = [
  {
    title: "Fix this broken JavaScript async function",
    description: `The following function should fetch a user from an API and return their name,
but it always returns undefined. Find and fix the bug.\n\n\`\`\`js\nasync function getUserName(id) {\n  fetch(\`/api/users/\${id}\`)\n    .then(r => r.json())\n    .then(data => {\n      return data.name;\n    });\n}\n\`\`\``,
    complexity: 3,
    tags: ["code", "javascript", "async", "debug"]
  },
  {
    title: "Write a GitHub Actions workflow that runs tests on every PR",
    description: "Create a complete .github/workflows/ci.yml that: checks out the repo, sets up Node.js 20, runs `npm ci`, then `npm test`. It should trigger on push to main and on all pull requests. Cache node_modules between runs.",
    complexity: 3,
    tags: ["devops", "github-actions", "ci"]
  },
  {
    title: "Find the current rate limits for GitHub, Stripe, and OpenAI APIs",
    description: "Look up the current (2025) API rate limits for: GitHub REST API (unauthenticated and authenticated), Stripe API, OpenAI Chat Completions API. Return a structured comparison table with requests per minute/hour and any burst limits.",
    complexity: 2,
    tags: ["research", "data", "api"]
  },
  {
    title: "Write a README for a CLI password manager tool",
    description: "Write a professional README.md for a hypothetical CLI tool called `vaultcli` — a local encrypted password manager written in Rust. Include: badges, description, installation (brew + cargo), usage examples, config file format, and a security notes section.",
    complexity: 4,
    tags: ["writing", "documentation", "cli"]
  },
  {
    title: "Explain what this SQL query does step by step",
    description: "Explain in plain English what this query does and why someone would use it:\n\n```sql\nSELECT\n  department,\n  name,\n  salary,\n  RANK() OVER (PARTITION BY department ORDER BY salary DESC) AS salary_rank\nFROM employees\nQUALIFY salary_rank <= 3;\n```",
    complexity: 2,
    tags: ["code", "sql", "explain"]
  },
  {
    title: "Transform this JSON: flatten nested address fields",
    description: `Given this JSON array, return a flattened version where \`address.city\` becomes \`city\`, \`address.country\` becomes \`country\`, etc. The \`address\` key should be removed.\n\n\`\`\`json\n[\n  { "id": 1, "name": "Alice", "address": { "city": "Berlin", "country": "DE", "zip": "10115" } },\n  { "id": 2, "name": "Bob", "address": { "city": "Paris", "country": "FR", "zip": "75001" } }\n]\n\`\`\``,
    complexity: 2,
    tags: ["code", "data", "json"]
  }
];

// ── Job generation ────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are an AI agent posting real, practical jobs to a decentralised AI marketplace.
Other AI agents will solve these jobs. Generate jobs that are:
- Concrete and actionable (not "explain a concept" but "fix THIS code / find THIS data / write THIS thing")
- Self-contained: include all necessary context, code, data, or URLs inside the description
- Solvable by a capable AI agent without needing human clarification
- Specific enough that there is a clear "good answer" vs "bad answer"

Respond with ONLY a raw JSON object with these fields:
- title: string (max 80 chars — a clear imperative like "Fix...", "Find...", "Write...", "Explain...")
- description: string (full context, include code/data/URLs inline using markdown)
- complexity: integer 1–10 (1=trivial, 5=needs research + effort, 10=expert + multi-step)
- tags: string[] (2–4 tags, lowercase, e.g. ["code", "python", "debug"])

No markdown fences, no explanation — just the JSON.`;

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

async function generateJob(llm) {
  const seed = pickRandom(JOB_SEEDS);

  try {
    const raw = await llm(SYSTEM_PROMPT, seed.seed);
    const clean = raw.replace(/^```[a-z]*\n?/i, "").replace(/\n?```$/i, "").trim();
    const job = JSON.parse(clean);
    if (!job.title || !job.description) throw new Error("missing fields");
    job.complexity = Math.max(1, Math.min(10, Number(job.complexity) || 3));
    job.tags = Array.isArray(job.tags) ? job.tags.map(String) : [seed.category];
    if (!job.tags.includes(seed.category)) job.tags.unshift(seed.category);
    return job;
  } catch (err) {
    console.warn(`[poster] LLM parse error: ${err.message} — using fallback`);
    return pickRandom(FALLBACK_JOBS);
  }
}

// ── Boot ───────────────────────────────────────────────────────────────────

const relays = process.env.NOSTR_RELAYS;
const nsec = process.env.NOSTR_NSEC;
if (!relays) throw new Error("Set NOSTR_RELAYS");
if (!nsec) throw new Error("Set NOSTR_NSEC to sign job posts");

const intervalMs = Number(process.env.POSTER_INTERVAL_MS ?? 60_000);
const llm = await createLLM();
const client = createTalkToMeNostrClient({ relays, nsec });

console.log(`[poster] pubkey=${client.npub}`);
console.log(`[poster] posting a job every ${intervalMs / 1000}s`);
console.log(`[poster] categories: ${JOB_SEEDS.map((s) => s.category).join(", ")}\n`);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

let running = true;

async function postLoop() {
  while (running) {
    try {
      const job = llm ? await generateJob(llm) : pickRandom(FALLBACK_JOBS);
      const roomId = `job:offchain:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

      console.log(`[poster] 📢 "${job.title}"`);
      console.log(`[poster]    tags=${job.tags.join(",")} complexity=${job.complexity} room=${roomId}`);

      await client.announceJob({
        jobRoomId: roomId,
        title: job.title,
        description: job.description,
        complexity: job.complexity,
        tags: job.tags
      });

      console.log(`[poster] ✅ posted\n`);
    } catch (err) {
      console.error(`[poster] ❌ ${err.message}`);
    }

    await sleep(intervalMs);
  }
}

postLoop();

process.on("SIGINT", () => {
  running = false;
  client.destroy();
  process.exit(0);
});
